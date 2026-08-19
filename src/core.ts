import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import { getAdapter } from './adapters/index.ts';
import type { AdapterContext, PlanConfig, QuotaWindow } from './types.ts';
import { AdapterError, AUTH_STATUS } from './types.ts';

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
  credentialHint: string | null;
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
  // plans 以 db 为准（启动时已 sync；运行时启停/授权写这里）
  const dbPlans = store.listPlans();
  const bySlug = new Map(configPlans.map((p) => [p.slug, p]));
  const plans = dbPlans.map((plan) => {
    const cfg = bySlug.get(plan.slug) ?? plan;
    const effective: PlanConfig = {
      ...cfg,
      enabled: plan.enabled,
      credRef: plan.credRef,
      extra: plan.extra,
    };
    return buildPlanOverview(store, effective);
  });
  return { generatedAt: now, plans };
}

function buildPlanOverview(store: Store, plan: PlanConfig): OverviewPlan {
  const adapter = getAdapter(plan.adapter);
  const state = store.getState(plan.slug);
  const windows = store.latestByPlan(plan.slug);

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

  return {
    slug: plan.slug,
    name: plan.name,
    adapter: plan.adapter,
    enabled: plan.enabled,
    status,
    authStatus,
    windows,
    lastFetchedAt: state?.last_success_at ?? null,
    lastAttemptAt: state?.last_attempt_at ?? null,
    lastError: state?.last_error ?? null,
    browser: plan.extra.browser ?? null,
    browserSupported: plan.adapter === 'kimi',
    credentialHint: adapter?.credentialHint ?? null,
  };
}

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

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
      void this.refreshPlan(plan.slug);
      const t = setInterval(() => {
        void this.maybePoll(plan.slug);
      }, intervalSec * 1000);
      this.timers.set(plan.slug, t);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  private async maybePoll(slug: string): Promise<void> {
    const state = this.store.getState(slug);
    if (state?.paused_until != null && state.paused_until > Date.now()) return; // 退避中
    await this.refreshPlan(slug);
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
