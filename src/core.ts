import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import { getAdapter } from './adapters/index.ts';
import type { AdapterContext, PlanConfig, QuotaWindow } from './types.ts';
import { AdapterError, AUTH_STATUS } from './types.ts';
import { annotateWindowsWithTier, getTier, isTierPricingEnabled, planWantsTierPricing, type TierState } from './tier.ts';

/** 指数退避：1min 起步，封顶 30min */
function backoffSec(failures: number): number {
  return Math.min(30 * 60, 60 * 2 ** Math.min(failures - 1, 8));
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm > 0 ? `${h} 小时 ${mm} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh > 0 ? `${d} 天 ${hh} 小时` : `${d} 天`;
}

export function formatResetCountdown(resetAt: number | null, now: number): string | null {
  if (resetAt == null) return null;
  const diff = resetAt - now;
  if (diff <= 0) return '已重置';
  return `重置 ${formatDuration(diff)}后`;
}

/** 按窗口类型估算开始时间，用于时间进度参考线。 */
function estimateWindowStart(windowId: string, resetAt: number | null): number | null {
  if (resetAt == null) return null;
  const id = windowId.toLowerCase();
  if (id.includes('5h') || id.includes('session')) return resetAt - 5 * 3_600_000;
  if (id.includes('week')) return resetAt - 7 * 86_400_000;
  if (id.includes('month') || id.includes('credit') || id.includes('request')) return resetAt - 30 * 86_400_000;
  return null;
}

/** 闲置阈值：Claude Code 超过这个时长没用 `claude-fable-5`，UI 显示醒目 badge。 */
export const FABLE_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // TODO: 配置化

export function isFableIdle(plan: OverviewPlan, now: number): boolean {
  return plan.fableLastUsedAt == null
    || (now - plan.fableLastUsedAt) >= FABLE_IDLE_THRESHOLD_MS;
}

export type PlanStatus = 'ok' | 'stale' | 'error' | 'not_configured' | 'auth_error' | 'unavailable';

export interface OverviewPlan {
  slug: string;
  name: string;
  adapter: string;
  enabled: boolean;
  status: PlanStatus;
  authStatus: string;
  windows: QuotaWindow[];
  lastFetchedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  browser: string | null;
  browserSupported: boolean;
  /** 是否提供手动 API key/token 配置入口（adapter 能力，默认支持）。 */
  manualKey: boolean;
  credentialHint: string | null;
  /** 高峰/低谷注解：仅当 plan 启用 peakPricing 时存在；UI 用来渲染轻量 pill。 */
  tier?: TierState | null;
  /** 上次在本地 Claude Code 下使用 `claude-fable-5` 的 epoch ms；null 表示从未用过。 */
  fableLastUsedAt: number | null;
}

export interface Overview {
  generatedAt: number;
  plans: OverviewPlan[];
}

export interface RefreshResult {
  ok: boolean;
  slug: string;
  windows?: QuotaWindow[];
  error?: string;
  auth?: boolean;
}

export function buildOverview(store: Store, configPlans: PlanConfig[], now: number): Overview {
  // plans 以 db 为准（启动时已 sync；运行时启停/授权写这里）。
  // configPlans 同时是过滤器：/api/plans/:slug 只传单个 plan，不应返回全量列表。
  const dbPlans = store.listPlans();
  const wanted = new Set(configPlans.map((p) => p.slug));
  const bySlug = new Map(configPlans.map((p) => [p.slug, p]));
  const plans = dbPlans
    .filter((plan) => wanted.size === 0 || wanted.has(plan.slug))
    .map((plan) => {
      const cfg = bySlug.get(plan.slug) ?? plan;
      const effective: PlanConfig = {
        ...cfg,
        enabled: plan.enabled,
        credRef: plan.credRef,
        extra: plan.extra,
      };
      return buildPlanOverview(store, effective, now);
    });
  return { generatedAt: now, plans };
}

function buildPlanOverview(store: Store, plan: PlanConfig, now: number): OverviewPlan {
  const adapter = getAdapter(plan.adapter);
  const state = store.getState(plan.slug);
  // A successful provider poll is one snapshot batch. Do not merge a new
  // weekly-only Codex response with an older 5H row from a previous schema.
  const windows = store.latestByPlan(plan.slug, true);

  let status: PlanStatus;
  let authStatus = state?.auth_status ?? AUTH_STATUS.UNKNOWN;

  if (!adapter) {
    status = 'unavailable';
  } else if (state?.auth_status === AUTH_STATUS.INVALID) {
    status = 'auth_error';
  } else if (
    state?.auth_status === AUTH_STATUS.MISSING
    && (state.last_attempt_at ?? 0) > (state.last_success_at ?? 0)
  ) {
    status = state.last_success_at == null ? 'not_configured' : 'stale';
  } else if (windows.length === 0) {
    // 从未成功抓取
    if (!state || state.last_error === null) {
      status = 'not_configured';
      if (authStatus === AUTH_STATUS.UNKNOWN) authStatus = AUTH_STATUS.MISSING;
    } else {
      status = 'error';
    }
  } else if ((state?.consecutive_failures ?? 0) > 0 && (state?.last_attempt_at ?? 0) > (state?.last_success_at ?? 0)) {
    status = state?.last_success_at == null ? 'error' : 'stale';
  } else {
    status = 'ok';
  }

  // An auth failure invalidates the credential, so cached quota values must
  // not be presented as current usage. They remain available through history.
  const visibleWindows = status === 'auth_error' ? [] : windows;

  // 为每个窗口估算 startedAt，供前端渲染时间进度参考线（WTD/MTD）。
  // provider 未返回时按窗口类型近似：5h→-5h，week→-7d，month/credits→-30d。
  // 若窗口已到达或超过 resetAt（已恢复），历史额度已失效，动态重置为 0%（防轮询间隔内旧额度倒挂）。
  const withStart = visibleWindows.map((window) => {
    const isReset = window.resetAt != null && window.resetAt <= now;
    return {
      ...window,
      percentage: isReset && window.percentage != null ? 0 : window.percentage,
      used: isReset && window.used != null ? 0 : window.used,
      startedAt: window.startedAt ?? estimateWindowStart(window.window, window.resetAt),
    };
  });

  // 高峰/低谷注解：仅在「全局开关 + per-plan 开关」都打开时打。
  // tier 是「当前时间」的属性，db 不持久化，每次 buildOverview 重算。
  const tierEnabled = isTierPricingEnabled() && planWantsTierPricing(plan.extra, plan.adapter);
  const tier = tierEnabled ? getTier(plan.adapter, now) : null;
  const annotated = tierEnabled
    ? annotateWindowsWithTier(plan.adapter, withStart, now)
    : withStart;

  return {
    slug: plan.slug,
    name: plan.name,
    adapter: plan.adapter,
    enabled: plan.enabled,
    status,
    authStatus,
    windows: annotated,
    lastFetchedAt: state?.last_success_at ?? null,
    lastAttemptAt: state?.last_attempt_at ?? null,
    lastError: state?.last_error ?? null,
    browser: plan.extra.browser ?? null,
    browserSupported: plan.adapter === 'kimi' || plan.adapter === 'factory',
    manualKey: adapter != null && adapter.manualKey !== false,
    credentialHint: adapter?.credentialHint ?? null,
    tier,
    fableLastUsedAt: plan.adapter === 'claude' ? store.lastModelUsed('claude', 'claude-fable-5') : null,
  };
}

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private resetTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private store: Store,
    private cfg: AppConfig,
  ) {}

  start(): void {
    const plans = this.store.listPlans();
    for (const plan of plans) {
      if (!plan.enabled) continue;
      const adapter = getAdapter(plan.adapter);
      if (!adapter) continue;
      const intervalSec = plan.pollIntervalSec > 0 ? plan.pollIntervalSec : 60;
      void this.safeRefresh(plan.slug);
      const t = setInterval(() => {
        void this.maybePoll(plan.slug);
      }, intervalSec * 1000);
      this.timers.set(plan.slug, t);

      // 若库中已有未来重置时间，预约重置时刻抓取
      const windows = this.store.latestByPlan(plan.slug, true);
      this.scheduleNextResetPoll(plan.slug, windows);
    }
  }

  /** 调度器入口必须吞错:refreshPlan 的未捕获拒绝(SQLITE_BUSY 等)会把整个 daemon 带崩。 */
  private async safeRefresh(slug: string): Promise<void> {
    try {
      await this.refreshPlan(slug);
    } catch {
      /* 记录在 plan state 里,不冒泡 */
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    for (const t of this.resetTimers.values()) clearTimeout(t);
    this.resetTimers.clear();
  }

  private scheduleNextResetPoll(slug: string, windows: QuotaWindow[]): void {
    const existing = this.resetTimers.get(slug);
    if (existing) {
      clearTimeout(existing);
      this.resetTimers.delete(slug);
    }
    const now = Date.now();
    const futureResets = windows
      .map((w) => w.resetAt)
      .filter((t): t is number => t != null && t > now);
    if (futureResets.length === 0) return;
    const nextReset = Math.min(...futureResets);
    // 窗口重置时刻后延 2 秒抓取，确保 provider 端已完成额度翻转
    const delayMs = Math.max(1000, nextReset - now + 2000);
    // 超过 24 小时的重置时间不必常驻 setTimeout（由常规周期轮询接管）
    if (delayMs > 24 * 3600 * 1000) return;
    const t = setTimeout(() => {
      this.resetTimers.delete(slug);
      void this.maybePoll(slug);
    }, delayMs);
    this.resetTimers.set(slug, t);
  }

  private async maybePoll(slug: string): Promise<void> {
    const state = this.store.getState(slug);
    if (state?.paused_until != null && state.paused_until > Date.now()) return; // 退避中
    await this.safeRefresh(slug);
  }

  async refreshPlan(slug: string): Promise<RefreshResult> {
    const plan = this.store.getPlan(slug) ?? this.cfg.plans.find((p) => p.slug === slug);
    if (!plan) return { ok: false, slug, error: `未知 plan: ${slug}` };
    const now = Date.now();

    const adapter = getAdapter(plan.adapter);
    if (!adapter) {
      this.store.setState(slug, {
        last_attempt_at: now,
        last_error: `adapter 未接入: ${plan.adapter}`,
      });
      return { ok: false, slug, error: `adapter 未接入: ${plan.adapter}` };
    }

    const ctx: AdapterContext = {
      plan,
      now: () => Date.now(),
      log: (msg) => console.log(`[${plan.slug}] ${msg}`),
    };

    this.store.setState(slug, { last_attempt_at: now });
    const cred = await adapter.detectCredentials(ctx);

    if (!cred) {
      const message =
        adapter.credentialHint ??
        `缺少凭据：请设置对应 API Key，或运行 planofplan auth set ${slug} --key <key>`;
      this.store.setState(slug, {
        auth_status: AUTH_STATUS.MISSING,
        last_error: message,
      });
      return { ok: false, slug, error: message };
    }

    try {
      const windows = await adapter.fetchUsage(ctx, cred);
      this.store.insertWindows(slug, windows, Date.now());
      this.store.setState(slug, {
        last_success_at: Date.now(),
        last_error: null,
        consecutive_failures: 0,
        paused_until: null,
        auth_status: cred.source === 'manual' ? AUTH_STATUS.MANUAL : AUTH_STATUS.AUTO,
      });
      this.scheduleNextResetPoll(slug, windows);
      return { ok: true, slug, windows };
    } catch (e) {
      const err = e instanceof AdapterError ? e : new AdapterError('unknown', String(e instanceof Error ? e.message : e));
      const state = this.store.getState(slug);
      const failures = (state?.consecutive_failures ?? 0) + 1;
      this.store.setState(slug, {
        consecutive_failures: failures,
        last_error: err.message,
        paused_until: Date.now() + backoffSec(failures) * 1000,
        auth_status: err.kind === 'auth' || err.kind === 'unknown' ? AUTH_STATUS.INVALID : state?.auth_status ?? AUTH_STATUS.UNKNOWN,
      });
      return { ok: false, slug, error: err.message, auth: err.kind === 'auth' };
    }
  }
}

export { formatDuration };
