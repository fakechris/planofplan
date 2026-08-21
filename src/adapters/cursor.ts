/**
 * Cursor adapter（M2.6）—— legacy request-count 500/月 双轨
 *
 * 规格出处：CodexBar docs/cursor.md + Sources/.../CursorAppAuth.swift、Tendo33/cursor-usage-tracker
 * - 凭据：Cursor.app 本地会话——state.vscdb ItemTable key 'cursorAuth/accessToken'（只读，
 *   WAL 处理参照 CodexBar：普通只读失败且无 wal/shm 时 immutable 只读）；
 *   userId = JWT sub 取 '|' 后段（如 github|8452 → 8452）
 * - Cookie：WorkosCursorSessionToken={userId}%3A%3A{accessToken}
 * - 请求（legacy-first，Tendo33 策略）：
 *   ① GET https://cursor.com/api/usage?user={userId}（Cookie）→ gpt-4.maxRequestUsage/numRequests
 *     → legacy 请求数模型（月重置 startOfMonth+1 月 UTC）
 *   ② 兜底 POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *     （Bearer + Connect-Protocol-Version: 1）→ planUsage{limit/remaining/used/totalPercentUsed}
 *     → USD credit 模型
 * - 注意：内部端点非官方契约，需 401 重试与 partial 降级
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { clampPct } from './util.ts';

const LEGACY_URL = 'https://cursor.com/api/usage';
const USD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

function cursorDbPath(): string | null {
  const home = homedir();
  const candidates =
    process.platform === 'darwin'
      ? [join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
      : [join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function readAccessTokenFromDb(): string | null {
  const dbPath = cursorDbPath();
  if (!dbPath) return null;
  for (const mode of ['ro', 'immutable'] as const) {
    try {
      const uri =
        mode === 'immutable'
          ? `file:${dbPath}?mode=ro&immutable=1`
          : `file:${dbPath}?mode=ro`;
      const db = new Database(uri, { readonly: true });
      try {
        const row = db
          .query(`SELECT value FROM ItemTable WHERE key = ? LIMIT 1`)
          .get('cursorAuth/accessToken') as { value: string | Uint8Array | null } | null;
        if (row?.value == null) return null;
        const raw =
          typeof row.value === 'string'
            ? row.value
            : new TextDecoder('utf-8').decode(row.value as Uint8Array);
        // seed 值可能是 JSON 包裹
        try {
          const parsed = JSON.parse(raw) as { accessToken?: string; token?: string };
          if (typeof parsed.accessToken === 'string') return parsed.accessToken;
          if (typeof parsed.token === 'string') return parsed.token;
        } catch {
          /* raw 即 token */
        }
        return raw;
      } finally {
        db.close();
      }
    } catch {
      if (mode === 'immutable') return null;
      // 普通只读失败 → immutable 重试（仅当无 WAL 侧文件由调用方决定，这里直接试）
      continue;
    }
  }
  return null;
}

interface TokenInfo {
  token: string;
  userId: string | null;
  exp: number | null;
}

function parseToken(token: string): TokenInfo {
  let payload: Record<string, unknown> = {};
  try {
    const part = token.split('.')[1];
    if (part) {
      const padded = part + '='.repeat((-part.length % 4 + 4) % 4);
      payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  // userID = sub 取 '|' 后段，需 alphanumerics + ._-
  let userId: string | null = null;
  if (sub) {
    const candidate = sub.split('|').pop()?.toLowerCase() ?? '';
    if (/^[a-z0-9._-]+$/.test(candidate)) userId = candidate;
  }
  const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  return { token, userId, exp };
}

interface LegacyUsageRaw {
  'gpt-4'?: { maxRequestUsage?: number; numRequests?: number };
  startOfMonth?: string;
}

function legacyReset(startOfMonth: string | undefined): number | null {
  if (!startOfMonth) return null;
  const d = new Date(startOfMonth);
  if (Number.isNaN(d.getTime())) return null;
  const next = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  );
  return next;
}

export function normalizeCursorLegacy(raw: unknown): QuotaWindow | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as LegacyUsageRaw;
  const gpt4 = r['gpt-4'];
  if (!gpt4 || typeof gpt4 !== 'object') return null;
  const max = gpt4.maxRequestUsage;
  const used = gpt4.numRequests;
  if (typeof max !== 'number' || max <= 0 || typeof used !== 'number') return null;
  return {
    window: 'requests',
    label: 'Requests',
    used,
    total: max,
    unit: 'requests',
    percentage: clampPct((used / max) * 100),
    resetAt: legacyReset(r.startOfMonth),
    note: 'legacy 请求数',
  };
}

interface PlanUsage {
  limit?: number;
  remaining?: number;
  used?: number;
  totalPercentUsed?: number;
}

export function normalizeCursorUsd(raw: unknown): QuotaWindow | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as { planUsage?: PlanUsage; billingCycleEnd?: string | number };
  const pu = r.planUsage;
  if (!pu || typeof pu !== 'object') return null;
  const limit = typeof pu.limit === 'number' && Number.isFinite(pu.limit) ? pu.limit : null;
  const remaining = typeof pu.remaining === 'number' && Number.isFinite(pu.remaining) ? pu.remaining : null;
  const explicitUsed = typeof pu.used === 'number' && Number.isFinite(pu.used) ? pu.used : null;
  const pct = typeof pu.totalPercentUsed === 'number' && Number.isFinite(pu.totalPercentUsed) ? pu.totalPercentUsed : null;

  let usedCents: number | null = null;
  if (explicitUsed != null) usedCents = explicitUsed;
  else if (limit != null && remaining != null) usedCents = limit - remaining;
  else if (limit != null && pct != null) usedCents = Math.round((limit * pct) / 100);

  const percent = pct ?? (limit != null && limit > 0 && usedCents != null ? (usedCents / limit) * 100 : null);
  if (percent == null && usedCents == null) return null;

  let resetAt: number | null = null;
  const end = r.billingCycleEnd;
  if (typeof end === 'number') resetAt = end;
  else if (typeof end === 'string') {
    const n = Number(end);
    resetAt = Number.isFinite(n) ? n : Date.parse(end) || null;
  }

  return {
    window: 'monthly',
    label: 'Plan',
    used: usedCents,
    total: limit,
    unit: 'usd',
    percentage: percent != null ? clampPct(percent) : null,
    resetAt,
    note: 'USD credit',
  };
}

export const cursorAdapter: PlanAdapter = {
  slug: 'cursor',
  credentialHint:
    '缺少凭据：请登录 Cursor 桌面端，或运行 planofplan auth set cursor --key "WorkosCursorSessionToken=<userId>%3A%3A<token>"',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) {
        // 手动模式：值即完整 Cookie 头（如 "WorkosCursorSessionToken=xxx%3A%3Ayyy"）
        return { kind: 'bearer', value: stored.value, cookie: stored.value, source: 'manual' };
      }
    }
    const token = readAccessTokenFromDb();
    if (!token) return null;
    const info = parseToken(token);
    if (info.exp != null && info.exp < Date.now() + 60_000) {
      return null; // JWT 过期 → 重新登录 Cursor
    }
    if (!info.userId) return null;
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(info.userId)}%3A%3A${info.token}`;
    return { kind: 'bearer', value: info.token, cookie, accountId: info.userId, source: 'auto' };
  },

  async fetchUsage(_ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    const cookie = cred.cookie;
    const userId = cred.accountId;
    if (!cookie) {
      throw new AdapterError('auth', 'Cursor cookie 缺失（自动检测失败请登录 Cursor 或手动粘贴 Cookie 头）');
    }
    const baseHeaders: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'planofplan/0.1',
    };
    if (cookie) baseHeaders.Cookie = cookie;

    // ① legacy usage（request-count）
    const url = userId ? `${LEGACY_URL}?user=${encodeURIComponent(userId)}` : LEGACY_URL;
    let legacyWin: QuotaWindow | null = null;
    try {
      const res = await fetch(url, { method: 'GET', headers: baseHeaders, signal: AbortSignal.timeout(12_000) });
      if (res.status === 401 || res.status === 403) {
        // 整体鉴权失败 → 试 USD 再定
        throw new AdapterError('auth', `Cursor 鉴权失败(HTTP ${res.status})：请重新登录 Cursor`);
      }
      if (res.ok) {
        legacyWin = normalizeCursorLegacy(await res.json().catch(() => null));
      }
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      // network/其他 → 落到 USD 兜底
    }

    if (legacyWin) return [legacyWin];

    // ② USD credit 兜底
    try {
      const res = await fetch(USD_URL, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          Authorization: `Bearer ${cred.value}`,
          'Connect-Protocol-Version': '1',
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new AdapterError('auth', `Cursor 鉴权失败(HTTP ${res.status})：请重新登录 Cursor`);
      }
      if (!res.ok) {
        if (res.status === 429) throw new AdapterError('api', 'Cursor 请求被限流(HTTP 429)');
        throw new AdapterError('api', `Cursor API 错误(HTTP ${res.status})`);
      }
      const usdWin = normalizeCursorUsd(await res.json().catch(() => null));
      if (usdWin) return [usdWin];
      throw new AdapterError('parse', 'Cursor 两个端点都没有可解析数据');
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new AdapterError('network', 'Cursor 请求超时');
      }
      throw new AdapterError('network', `Cursor 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }
  },
};
