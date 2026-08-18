/**
 * Moonshot Kimi Code adapter（M2.4，M2.5 增补月限额 + 网页会话兜底）
 *
 * 规格出处：CodexBar docs/kimi.md + KimiUsageFetcher.swift + KimiUsageSnapshot.swift
 * - 凭据优先级（与 CodexBar 一致）：
 *   ① API Key（kimi.com/code/console 创建，KIMI_CODE_API_KEY）→ GET /coding/v1/usages
 *   ② Kimi Code CLI ~/.kimi-code/credentials/kimi-code.json 的 access_token（只读不刷新；
 *      过期提示重新登录；与 CodexBar 相同策略，不用 refresh_token）
 *   ③ 网页会话 kimi-auth（KIMI_AUTH_TOKEN env / kimi-desktop / Chromium 系明文 / Firefox）：
 *      周/5h 走 POST GetUsages(FEATURE_CODING)，月走 GetSubscriptionStats
 * - 三档限额：
 *   ① 7 天周额度：usage（limit=100）
 *   ② 5h 滑动窗口：limits[0].detail（limit/remaining，无 used；用 remaining 反推）
 *   ③ 月额度（共享订阅池）：不在 usages API（totalQuota 为空占位 {}），仅网页会话
 *      GetSubscriptionStats → subscriptionBalance.amountUsedRatio（0-1 ×100）+ expireTime
 * - CLI/API 凭据需带设备头：x-msh-device-id（JWT device_id 或 ~/.kimi-code/device_id）、
 *   x-msh-session-id（JWT ssid）、x-traffic-id（JWT sub）
 * - 值均为字符串需转数字
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
}

interface CliCredentialFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

function readCliCredential(): CliCredentialFile | null {
  const file = join(kimiHome(), 'credentials', 'kimi-code.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CliCredentialFile;
  } catch {
    return null;
  }
}

interface JwtClaims {
  device_id?: string;
  ssid?: string;
  sub?: string;
  exp?: number;
}

function jwtClaims(token: string): JwtClaims {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    const padded = payload + '='.repeat((-payload.length % 4 + 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return {};
  }
}

function jwtExpiresAtSec(token: string): number | null {
  const claims = jwtClaims(token);
  return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp : null;
}

function deviceIdFile(): string | null {
  const f = join(kimiHome(), 'device_id');
  if (!existsSync(f)) return null;
  try {
    const v = readFileSync(f, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

// ── CLI OAuth 刷新（可选）─────────────────────────────────────────────
// 官方 CLI（moonshotai/kimi-code packages/oauth）设备流端点与 clientId（开源硬编码）。
// 默认不启用：与 CodexBar 一致，把 CLI 凭据当只读；设 KIMI_USE_REFRESH=1 后，
// access_token 过期时用 refresh_token 静默换新（只在内存中使用，不写回凭据文件）。

const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

function refreshEnabled(): boolean {
  const v = process.env.KIMI_USE_REFRESH;
  return v === '1' || v === 'true';
}

/** 判定是否需要触发刷新：开启 && 有 refresh_token && access_token 已过期/临过期 */
export function shouldRefreshCliToken(
  cli: CliCredentialFile | null,
  nowMs: number,
  enabled: boolean,
): boolean {
  if (!enabled || !cli?.refresh_token || !cli.access_token) return false;
  const expSec = toNum(cli.expires_at);
  return expSec == null || expSec * 1000 < nowMs + 60_000;
}

/** POST {oauthHost}/api/oauth/token (grant_type=refresh_token) → 新 access_token；失败返回 null */
async function refreshCliAccessToken(cli: CliCredentialFile): Promise<string | null> {
  const host = (process.env.KIMI_CODE_OAUTH_HOST ?? KIMI_OAUTH_HOST).replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': 'KimiCode/1.0 (planofplan)',
  };
  const deviceId = deviceIdFile();
  if (deviceId) headers['x-msh-device-id'] = deviceId;
  let res: Response;
  try {
    res = await fetch(`${host}/api/oauth/token`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        client_id: KIMI_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: cli.refresh_token!,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const json = (await res.json()) as { access_token?: unknown };
    return typeof json.access_token === 'string' && json.access_token ? json.access_token : null;
  } catch {
    return null;
  }
}

interface StriDetail {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiResponse {
  usage?: StriDetail;
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: StriDetail }>;
}

function toNum(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-01-09T15:23:13.716839300Z" → epoch ms（归一化 9 位小数） */
function parseResetTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const normalized = iso.replace(/\.(\d{3})\d+/, '.$1');
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

export function normalizeKimi(raw: unknown): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Kimi 响应不是 JSON 对象');
  }
  const root = raw as KimiResponse;
  const windows: QuotaWindow[] = [];

  const usage = root.usage;
  if (usage && typeof usage === 'object') {
    const total = toNum(usage.limit);
    const used = toNum(usage.used);
    if (total != null && total > 0 && used != null) {
      windows.push({
        window: 'weekly',
        label: 'Week',
        used,
        total,
        unit: 'requests',
        percentage: Math.min(100, Math.max(0, (used / total) * 100)),
        resetAt: parseResetTime(usage.resetTime),
        note: null,
      });
    }
  }

  const rateLimit = Array.isArray(root.limits) ? root.limits[0] : undefined;
  const detail = rateLimit?.detail;
  if (detail && typeof detail === 'object') {
    const total = toNum(detail.limit);
    // 实测（2026-08-18）：5h 窗口 detail 只有 limit + remaining，无 used → 用 remaining 反推
    const remaining = toNum(detail.remaining);
    const used =
      toNum(detail.used) ?? (total != null && remaining != null ? total - remaining : null);
    if (total != null && total > 0 && used != null) {
      windows.push({
        window: 'rolling_5h',
        label: '5H',
        used,
        total,
        unit: 'requests',
        percentage: Math.min(100, Math.max(0, (used / total) * 100)),
        resetAt: parseResetTime(detail.resetTime),
        note: null,
      });
    }
  }

  if (windows.length === 0) {
    throw new AdapterError('parse', 'Kimi 响应没有可用窗口');
  }
  return windows;
}

// ── 月限额（第三档）：网页会话 ─────────────────────────────────────────
// 不在 /coding/v1/usages（totalQuota 为空占位 {}），参考 CodexBar KimiUsageSnapshot：
// membership GetSubscriptionStats → subscriptionBalance.amountUsedRatio（共享订阅池占比）。

interface KimiSubscriptionBalance {
  feature?: string | null;
  type?: string | null;
  amountUsedRatio?: number | null;
  expireTime?: string | null;
}

export function normalizeKimiMonthly(raw: unknown): QuotaWindow | null {
  if (raw == null || typeof raw !== 'object') return null;
  const root = raw as {
    subscriptionBalance?: KimiSubscriptionBalance;
    data?: { subscriptionBalance?: KimiSubscriptionBalance };
  };
  const balance = root.subscriptionBalance ?? root.data?.subscriptionBalance;
  if (!balance || typeof balance !== 'object') return null;
  // 与 CodexBar 一致：只看共享订阅池（FEATURE_OMNI / SUBSCRIPTION），Code 专属池会重复周额度
  if (balance.feature != null && balance.feature !== 'FEATURE_OMNI') return null;
  if (balance.type != null && balance.type !== 'SUBSCRIPTION') return null;
  const ratio = toNum(balance.amountUsedRatio ?? undefined);
  if (ratio == null) return null;
  // 正常为 0-1 系数 ×100；个别环境直接给百分比（>1.5）时不再放大
  const percentage = Math.min(100, Math.max(0, ratio > 1.5 ? ratio : ratio * 100));
  const resetAt = parseResetTime(balance.expireTime ?? undefined);
  return {
    window: 'monthly',
    label: 'Month',
    used: null,
    total: null,
    unit: 'percent',
    percentage,
    resetAt,
    note: '共享订阅池 Total usage',
  };
}

/** 已知会以明文存 kimi-auth 的 Chromium 系应用目录（kimi-desktop 实测明文在 value 列） */
const KI_AUTH_COOKIE_APPS = [
  'kimi-desktop',
  'Google/Chrome',
  'Google Chrome for Testing',
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
  'Arc',
  'Chromium',
  'Vivaldi',
  'Opera',
  'com.operasoftware.OperaDeveloper',
];

function kimiAuthCookieDbs(): string[] {
  const app = join(homedir(), 'Library', 'Application Support');
  const out: string[] = [];
  const envDb = process.env.KIMI_AUTH_COOKIE_DB;
  if (envDb) out.push(envDb);
  for (const dir of KI_AUTH_COOKIE_APPS) {
    const base = join(app, dir);
    for (const rel of ['Default/Network/Cookies', 'Default/Cookies', 'Cookies']) {
      const p = join(base, rel);
      if (existsSync(p)) out.push(p);
    }
  }
  const ffRoot = join(app, 'Firefox/Profiles');
  if (existsSync(ffRoot)) {
    for (const entry of readdirSync(ffRoot)) {
      const p = join(ffRoot, entry, 'cookies.sqlite');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** 只读扫描单个 cookie 库；只取明文存于 value 列（未加密）的 kimi-auth 值 */
function queryKimiAuthCookies(dbPath: string): string[] {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query('SELECT value, encrypted_value FROM cookies WHERE name = ? AND host_key LIKE ?')
      .all('kimi-auth', '%kimi.com%') as unknown as Array<{
      value: unknown;
      encrypted_value: unknown;
    }>;
    const out: string[] = [];
    for (const row of rows) {
      const enc = row.encrypted_value;
      const encLen =
        enc instanceof Uint8Array
          ? enc.length
          : typeof enc === 'string'
            ? new TextEncoder().encode(enc).length
            : 0;
      const value =
        typeof row.value === 'string'
          ? row.value
          : row.value instanceof Uint8Array
            ? new TextDecoder().decode(row.value)
            : '';
      // 加密 cookie（encrypted_value 非空）需 Keychain 解密，M3 再接；明文存于 value 列
      if (value && encLen === 0) out.push(value);
    }
    return out;
  } catch {
    return []; // 被占用/损坏/加密的库直接跳过
  } finally {
    db?.close();
  }
}

/** 找未过期的 kimi-auth 网页会话（env 优先，其次本机 cookie 存储） */
export function readKimiAuthToken(): { token: string; source: string } | null {
  const env = process.env.KIMI_AUTH_TOKEN;
  if (env && env.trim()) {
    const token = env.trim();
    const exp = jwtExpiresAtSec(token);
    if (exp != null && exp * 1000 > Date.now() + 60_000) return { token, source: 'env' };
  }
  const seen = new Set<string>();
  for (const dbPath of kimiAuthCookieDbs()) {
    if (seen.has(dbPath)) continue;
    seen.add(dbPath);
    for (const token of queryKimiAuthCookies(dbPath)) {
      const exp = jwtExpiresAtSec(token);
      if (exp != null && exp * 1000 > Date.now() + 60_000) {
        const appName = dbPath.split('/').at(-3) ?? 'cookie';
        return { token, source: `cookie(${appName})` };
      }
    }
  }
  return null;
}

const GET_USAGES_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages';
const SUBSCRIPTION_STATS_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';

function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** 网页会话请求头（对齐 CodexBar webRequest：cookie + Bearer + 平台/设备头） */
function webHeaders(token: string): Record<string, string> {
  const claims = jwtClaims(token);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Cookie: `kimi-auth=${token}`,
    Origin: 'https://www.kimi.com',
    Referer: 'https://www.kimi.com/code/console',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    'connect-protocol-version': '1',
    'x-language': 'en-US',
    'x-msh-platform': 'web',
    'r-timezone': timezoneName(),
  };
  const deviceId = claims.device_id ?? deviceIdFile();
  if (deviceId) headers['x-msh-device-id'] = deviceId;
  if (claims.ssid) headers['x-msh-session-id'] = claims.ssid;
  if (claims.sub) headers['x-traffic-id'] = claims.sub;
  return headers;
}

/** 网页会话拉周+5h：POST GetUsages(scope=FEATURE_CODING)，响应内层结构与 /coding/v1/usages 相同 */
async function fetchWebUsage(token: string, log: (msg: string) => void): Promise<QuotaWindow[]> {
  let res: Response;
  try {
    res = await fetch(GET_USAGES_URL, {
      method: 'POST',
      headers: webHeaders(token),
      body: '{"scope":["FEATURE_CODING"]}',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new AdapterError(
      'network',
      `Kimi GetUsages 请求失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new AdapterError('auth', `Kimi 网页会话过期(HTTP ${res.status})：请重新登录 kimi.com`);
  }
  if (!res.ok) throw new AdapterError('api', `Kimi GetUsages 错误(HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AdapterError('parse', 'Kimi GetUsages 响应不是合法 JSON');
  }
  const usages = (json as { usages?: unknown })?.usages;
  const coding = Array.isArray(usages)
    ? (usages as Array<{ scope?: string; detail?: StriDetail; limits?: KimiResponse['limits'] }>).find(
        (u) => u?.scope === 'FEATURE_CODING',
      )
    : undefined;
  if (!coding) throw new AdapterError('parse', 'Kimi GetUsages 缺少 FEATURE_CODING scope');
  const windows = normalizeKimi({ usage: coding.detail, limits: coding.limits });

  // 月限额：失败只记日志（CodexBar 同为 best-effort enrichment）
  try {
    windows.push(await fetchSubscriptionStats(token));
  } catch (e) {
    log(`月限额获取失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return windows;
}

/** 用 kimi-auth 网页会话拉月度订阅池；401 说明会话过期，需重新登录 kimi.com */
async function fetchSubscriptionStats(token: string): Promise<QuotaWindow> {
  let res: Response;
  try {
    res = await fetch(SUBSCRIPTION_STATS_URL, {
      method: 'POST',
      headers: webHeaders(token),
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new AdapterError(
      'network',
      `Kimi 月限额请求失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new AdapterError('auth', `Kimi 网页会话过期(HTTP ${res.status})：请重新登录 kimi.com`);
  }
  if (!res.ok) throw new AdapterError('api', `Kimi 月限额 API 错误(HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AdapterError('parse', 'Kimi 月限额响应不是合法 JSON');
  }
  const window = normalizeKimiMonthly(json);
  if (!window) throw new AdapterError('parse', 'Kimi 月限额响应缺少 subscriptionBalance');
  return window;
}

export const kimiAdapter: PlanAdapter = {
  slug: 'kimi',
  credentialHint:
    '缺少凭据：重新登录 Kimi Code CLI（kimi-code login）或 kimi.com 网页端（自动读 kimi-auth cookie），或设置 KIMI_CODE_API_KEY / KIMI_AUTH_TOKEN',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const apiKey = process.env.KIMI_CODE_API_KEY;
    if (apiKey && apiKey.trim()) return { kind: 'bearer', value: apiKey.trim(), source: 'env' };

    // CLI 凭据：15 分钟短 token，默认只读不刷新（CodexBar 同策略）；
    // KIMI_USE_REFRESH=1 时用 refresh_token 静默换新（不写回凭据文件）
    const cli = readCliCredential();
    const cliExpSec = cli?.access_token ? toNum(cli.expires_at) : null;
    const cliFresh =
      !!cli?.access_token && (cliExpSec == null || cliExpSec * 1000 >= Date.now() + 60_000);
    if (cliFresh) return { kind: 'bearer', value: cli.access_token!, source: 'auto' };
    if (shouldRefreshCliToken(cli, Date.now(), refreshEnabled()) && cli?.refresh_token) {
      const fresh = await refreshCliAccessToken(cli);
      if (fresh) return { kind: 'bearer', value: fresh, source: 'auto' };
      ctx.log('CLI access_token 过期且刷新失败（可能已登出），尝试网页会话兜底');
    }

    // 网页会话兜底：有未过期的 kimi-auth cookie（或 KIMI_AUTH_TOKEN）时，
    // 周/5h 走 GetUsages、月走 GetSubscriptionStats（CodexBar Auto-cookie 同路径）
    const web = readKimiAuthToken();
    if (web && web.token) {
      return { kind: 'bearer', value: web.token, source: 'web', cookie: web.token };
    }
    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    // 网页会话路径：周/5h + 月 全走 www.kimi.com（Auto-cookie 兜底）
    if (cred.source === 'web') {
      return fetchWebUsage(cred.value, (msg) => ctx.log(msg));
    }

    const base = (process.env.KIMI_CODE_BASE_URL ?? ctx.plan.extra.baseUrl ?? 'https://api.kimi.com').replace(/\/+$/, '');
    const url = `${base}/coding/v1/usages`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.value}`,
      accept: 'application/json',
    };
    if (cred.source === 'auto') {
      // CLI 凭据：带设备身份头（与官方 CLI 一致）
      const claims = jwtClaims(cred.value);
      const deviceId = claims.device_id ?? deviceIdFile();
      if (deviceId) headers['x-msh-device-id'] = deviceId;
      if (claims.ssid) headers['x-msh-session-id'] = claims.ssid;
      if (claims.sub) headers['x-traffic-id'] = claims.sub;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new AdapterError('network', `Kimi 请求超时：${url}`);
      }
      throw new AdapterError('network', `Kimi 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterError(
        'auth',
        `Kimi 鉴权失败(HTTP ${res.status})：请重新登录 Kimi Code CLI 或换 KIMI_CODE_API_KEY`,
      );
    }
    if (!res.ok) {
      if (res.status === 429) throw new AdapterError('api', 'Kimi 请求被限流(HTTP 429)');
      throw new AdapterError('api', `Kimi API 错误(HTTP ${res.status})`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', `Kimi 响应不是合法 JSON：${url}`);
    }
    const windows = normalizeKimi(json);

    // 月限额为第三档：仅网页会话可读；失败只记日志，不影响 周/5h 主数据
    const auth = readKimiAuthToken();
    if (!auth) {
      ctx.log(
        '月限额跳过：未找到有效的 kimi.com 网页会话（重新登录 kimi.com 后自动读取 kimi-auth cookie）',
      );
    } else {
      try {
        windows.push(await fetchSubscriptionStats(auth.token));
      } catch (e) {
        ctx.log(`月限额获取失败（${auth.source}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return windows;
  },
};
