/**
 * Devin adapter（INV-1959）—— 账户级额度轮询
 *
 * 规格出处：本机勘察 2026-11-20/21（调研附件 devin-research-2026-11-20.md §3）。
 * Devin.app 是 Windsurf IDE fork（Bundle ID com.exafunction.windsurf），会话跑在
 * 云端，额度面板数据来自 app.devin.ai 私有 REST：
 *   - GET /api/users/current-membership → org.org_id（org 发现；无需本地扫库）
 *   - GET /api/<org_id>/billing/quota/usage → 周/日百分比 + 重置时间 + overage 余额
 *
 * 凭据：state.vscdb ItemTable 'windsurfAuthStatus'（JSON .apiKey，明文）＝
 * "devin-session-token$<JWT>"。实测 Bearer 全串（含前缀）对上述端点返回 200；
 * 去前缀裸 JWT 无效。只读读取，WAL 处理参照 cursor.ts（ro → immutable 兜底）。
 *
 * 计量语义：Devin 是 ACU 计费，端点只给百分比与美元余额，无 token 明细。
 * 零捏造原则：used/total/token 一律 null（unknown），严禁 ACU→token 或价格换算。
 *
 * 降级路径：Devin 未安装（无 state.vscdb）→ detectCredentials 返回 null；
 * token 失效 → 401 抛 AdapterError('auth')；org 获取失败 → AdapterError('api')
 * （可经 plan extra.orgId 静态指定 org 跳过 membership 调用）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { fetchQuota } from './http.ts';
import { AdapterError } from '../types.ts';
import { clampPct, round2 } from './util.ts';

const APP_BASE = 'https://app.devin.ai';
const MEMBERSHIP_URL = `${APP_BASE}/api/users/current-membership`;
const REQUEST_TIMEOUT_MS = 12_000;

function devinStateDbPath(): string | null {
  const home = homedir();
  const candidates =
    process.platform === 'darwin'
      ? [join(home, 'Library', 'Application Support', 'Devin', 'User', 'globalStorage', 'state.vscdb')]
      : [join(home, '.config', 'Devin', 'User', 'globalStorage', 'state.vscdb')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** state.vscdb ItemTable 的 value 可能是 string 或 Uint8Array（BLOB），统一解码。 */
function decodeItemValue(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder('utf-8').decode(value);
}

/** windsurfAuthStatus 的 JSON → apiKey。纯函数，测试直接覆盖。 */
export function extractApiKey(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown };
    if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim() !== '') {
      return parsed.apiKey;
    }
  } catch {
    /* 非 JSON：不猜，交由上层按未登录处理 */
  }
  return null;
}

/** 只读打开 state.vscdb 读 apiKey；ro 失败（WAL 锁）时 immutable 重试。 */
export function readDevinApiKey(dbPath = devinStateDbPath()): string | null {
  if (!dbPath) return null;
  for (const mode of ['ro', 'immutable'] as const) {
    try {
      const uri = mode === 'immutable' ? `file:${dbPath}?mode=ro&immutable=1` : `file:${dbPath}?mode=ro`;
      const db = new Database(uri, { readonly: true });
      try {
        const row = db
          .query(`SELECT value FROM ItemTable WHERE key = ? LIMIT 1`)
          .get('windsurfAuthStatus') as { value: string | Uint8Array | null } | null;
        if (row?.value == null) return null;
        return extractApiKey(decodeItemValue(row.value));
      } finally {
        db.close();
      }
    } catch {
      if (mode === 'immutable') return null;
      continue;
    }
  }
  return null;
}

interface QuotaUsageRaw {
  is_quota_plan?: unknown;
  has_quota_allocation?: unknown;
  daily_percentage?: unknown;
  weekly_percentage?: unknown;
  daily_reset_at?: unknown;
  weekly_reset_at?: unknown;
  overage_balance?: unknown;
  hide_daily_quota?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseResetMs(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * billing/quota/usage 响应 → QuotaWindow[]。纯函数。
 *
 * - weekly：百分比窗口（weekly_percentage / weekly_reset_at）
 * - daily：仅 !hide_daily_quota 时返回（语义 id 'daily' 不在
 *   STABLE_SNAPSHOT_WINDOWS 内，db.ts 有 window|label 分区兜底，排序靠后）
 * - overage：On-demand 美元余额（credits_period，惯例同 deepseek：used=total=余额）
 * - 非 quota plan（is_quota_plan=false）：只有 overage 窗口，周/日不虚构
 */
export function normalizeDevinQuota(raw: unknown): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Devin quota/usage 响应不是 JSON 对象');
  }
  const body = raw as QuotaUsageRaw;
  const isQuotaPlan = body.is_quota_plan === true;
  const hideDaily = body.hide_daily_quota === true;
  const windows: QuotaWindow[] = [];

  if (isQuotaPlan) {
    const weeklyPct = num(body.weekly_percentage);
    windows.push({
      window: 'weekly',
      label: 'Week',
      used: null,
      total: null,
      unit: 'percent',
      percentage: weeklyPct == null ? null : clampPct(weeklyPct),
      resetAt: parseResetMs(body.weekly_reset_at),
      startedAt: null,
      note: 'ACU 周额度',
    });
    if (!hideDaily) {
      const dailyPct = num(body.daily_percentage);
      windows.push({
        window: 'daily',
        label: 'Day',
        used: null,
        total: null,
        unit: 'percent',
        percentage: dailyPct == null ? null : clampPct(dailyPct),
        resetAt: parseResetMs(body.daily_reset_at),
        startedAt: null,
        note: 'ACU 日额度',
      });
    }
  }

  const overage = num(body.overage_balance);
  windows.push({
    window: 'credits_period',
    label: 'On-demand',
    used: overage == null ? null : round2(overage),
    total: overage == null ? null : round2(overage),
    unit: 'USD',
    percentage: null,
    resetAt: null,
    startedAt: null,
    note: overage == null ? 'On-demand 余额未知' : 'On-demand 余额（美元）',
  });

  return windows;
}

/** current-membership 响应 → org_id。纯函数。 */
export function normalizeMembershipOrg(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const org = (raw as { org?: { org_id?: unknown } }).org;
  if (org == null || typeof org !== 'object') return null;
  const id = (org as { org_id?: unknown }).org_id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

async function getJson(url: string, token: string, what: string): Promise<unknown> {
  const res = await fetchQuota(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AdapterError('auth', `Devin ${what} 鉴权失败（${res.status}）`);
  }
  if (!res.ok) {
    throw new AdapterError('api', `Devin ${what} 请求失败（${res.status}）`);
  }
  try {
    return await res.json();
  } catch {
    throw new AdapterError('parse', `Devin ${what} 响应不是 JSON`);
  }
}

export const devinAdapter: PlanAdapter = {
  slug: 'devin',

  credentialHint: '未找到 Devin 登录态：请安装并登录 Devin.app（桌面版），或手动配置 token（devin-session-token$…）',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const envKey = process.env.DEVIN_SESSION_TOKEN?.trim();
    if (envKey) return { kind: 'bearer', value: envKey, source: 'env' };
    const apiKey = readDevinApiKey();
    if (apiKey) return { kind: 'bearer', value: apiKey, source: 'auto' };
    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    // org 可经 extra.orgId 静态指定（membership 不可用时的逃生口）
    let orgId = ctx.plan.extra.orgId?.trim() || null;
    if (!orgId) {
      const membership = await getJson(MEMBERSHIP_URL, cred.value, 'membership');
      orgId = normalizeMembershipOrg(membership);
      if (!orgId) {
        throw new AdapterError('parse', 'Devin membership 响应缺少 org.org_id');
      }
    }
    const quota = await getJson(`${APP_BASE}/api/${orgId}/billing/quota/usage`, cred.value, 'quota/usage');
    return normalizeDevinQuota(quota);
  },
};
