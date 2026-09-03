/**
 * Moonshot Kimi Code adapter（M2.4，M2.5 增补月限额 + 网页会话兜底）
 *
 * 规格出处：CodexBar docs/kimi.md + KimiUsageFetcher.swift + KimiUsageSnapshot.swift
 * - 凭据优先级（与 CodexBar 一致）：
 *   ① API Key（kimi.com/code/console 创建，KIMI_CODE_API_KEY）→ GET /coding/v1/usages
 *   ② Kimi Code CLI ~/.kimi-code/credentials/kimi-code.json 的 access_token；
 *      access_token 过期时按 onWatch 规则用 refresh_token 刷新并写回同一文件
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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ensureHome } from '../config.ts';
import { Database } from 'bun:sqlite';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { clampPct } from './util.ts';
import {
  readBrowserKimiAuth,
  readSafariKimiWebTokens,
  type BrowserCookieResult,
  type KimiBrowser,
} from '../browser-cookies.ts';

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code');
}

interface CliCredentialFile {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: number | string;
  expires_in?: number | string;
  path?: string;
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function kimiCredentialCandidates(): string[] {
  if (process.env.KIMI_CODE_CREDENTIALS?.trim()) {
    return [expandHomePath(process.env.KIMI_CODE_CREDENTIALS.trim())];
  }
  if (process.env.KIMI_CREDENTIALS?.trim()) {
    return [expandHomePath(process.env.KIMI_CREDENTIALS.trim())];
  }
  const candidates = [
    join(kimiHome(), 'credentials', 'kimi-code.json'),
    join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json'),
  ];
  return [...new Set(candidates.filter((path): path is string => !!path?.trim()).map((path) => expandHomePath(path.trim())))];
}

function kimiCredentialPath(): string {
  const candidates = kimiCredentialCandidates();
  return candidates.find((path) => existsSync(path)) ?? candidates[0] ?? join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
}

function readCliCredential(): CliCredentialFile | null {
  for (const file of kimiCredentialCandidates()) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as CliCredentialFile;
      if (parsed.access_token || parsed.refresh_token) return { ...parsed, path: file };
    } catch {
      // Try the next supported kimi-code candidate.
    }
  }
  return null;
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

// ── CLI OAuth 刷新 ───────────────────────────────────────────────────
// 与 onWatch 一致：只在 access_token 过期时静默刷新，并把 OAuth 轮换后的
// access_token/refresh_token 写回同一个 kimi-code 凭据文件。

const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

function refreshEnabled(): boolean {
  const v = process.env.KIMI_USE_REFRESH;
  return v !== '0' && v !== 'false';
}

/** 判定是否需要触发刷新：已启用、有 refresh_token，且 access_token 缺失或已过期。 */
export function shouldRefreshCliToken(
  cli: CliCredentialFile | null,
  nowMs: number,
  enabled: boolean,
): boolean {
  if (!enabled || !cli?.refresh_token) return false;
  const expSec = toNum(cli.expires_at);
  return !cli.access_token || (expSec != null && expSec * 1000 < nowMs + 60_000);
}

interface KimiOAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  expires_in?: unknown;
}

function persistCliCredential(cli: CliCredentialFile): void {
  const file = cli.path ?? kimiCredentialPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = { ...cli };
  delete payload.path;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** POST {oauthHost}/api/oauth/token and persist the rotated credential file. */
async function refreshCliAccessToken(cli: CliCredentialFile): Promise<CliCredentialFile | null> {
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
    const json = (await res.json()) as KimiOAuthTokenResponse;
    if (typeof json.access_token !== 'string' || !json.access_token) return null;
    const refreshed: CliCredentialFile = {
      ...cli,
      access_token: json.access_token,
      refresh_token:
        typeof json.refresh_token === 'string' && json.refresh_token
          ? json.refresh_token
          : cli.refresh_token,
      token_type:
        typeof json.token_type === 'string' && json.token_type ? json.token_type : cli.token_type ?? 'Bearer',
      scope: typeof json.scope === 'string' && json.scope ? json.scope : cli.scope ?? 'kimi-code',
      expires_in:
        typeof json.expires_in === 'number' || typeof json.expires_in === 'string'
          ? json.expires_in
          : cli.expires_in,
    };
    const expiresIn = toNum(refreshed.expires_in);
    if (expiresIn != null && expiresIn > 0) {
      refreshed.expires_at = Date.now() / 1000 + expiresIn;
    }
    try {
      persistCliCredential(refreshed);
    } catch {
      // Keep using the fresh token for this poll if the CLI store is temporarily locked.
    }
    return refreshed;
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
        percentage: clampPct((used / total) * 100),
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
        percentage: clampPct((used / total) * 100),
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
  const percentage = clampPct(ratio > 1.5 ? ratio : ratio * 100);
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

const browserSessions = new Map<string, { token: string; source: string }>();
const browserCookieHeaders = new Map<string, string>();

function readKimiDesktopAuthToken(): { token: string; source: string } | null {
  const desktopDb = kimiAuthCookieDbs().find((path) => path.includes('/kimi-desktop/'));
  if (!desktopDb) return null;
  const token = queryKimiAuthCookies(desktopDb)[0];
  return token ? { token, source: 'kimi-desktop' } : null;
}

/** 找 kimi-auth 网页会话（指定 provider 的内存会话优先）。 */
export function readKimiAuthToken(
  planSlug = 'kimi',
  allowCookieFallback = true,
  allowDesktopFallback = true,
): { token: string; source: string } | null {
  const env = process.env.KIMI_AUTH_TOKEN;
  if (env && env.trim()) {
    const token = env.trim();
    return { token, source: 'env' };
  }
  const browserSession = browserSessions.get(planSlug);
  if (browserSession) {
    return browserSession;
  }
  // CodexBar checks Kimi Desktop before the generic browser importer.
  if (allowDesktopFallback) {
    const desktop = readKimiDesktopAuthToken();
    if (desktop) return desktop;
  }
  if (!allowCookieFallback) return null;
  const seen = new Set<string>();
  for (const dbPath of kimiAuthCookieDbs()) {
    if (seen.has(dbPath)) continue;
    seen.add(dbPath);
    for (const token of queryKimiAuthCookies(dbPath)) {
      const appName = dbPath.split('/').at(-3) ?? 'cookie';
      return { token, source: `cookie(${appName})` };
    }
  }
  return null;
}

/**
 * 网页会话统一入口（2026-08 起 kimi.com 的 API 凭据在 Safari localStorage）：
 * 1. env；
 * 2. Safari localStorage access_token（读取穿透；页面打开时自己刷新，天然最新）；
 * 3. daemon 自持刷新链（~/.planofplan/kimi-web-session.json，0600）：access 仍新鲜直接用，
 *    否则用 refresh_token 兑换；候选顺序为 localStorage refresh_token 优先、持久化链兜底
 *    （仅当 JWT sub 锚点确认同账号，防止换号后沿用旧链）。RefreshToken 会轮换
 *    refresh_token，daemon 不回写 Safari 存储；页面下次需要刷新时会重新登录，
 *    两链分叉后各自独立，localStorage 出现新鲜 access 时自动回到路径 2。
 * 4. kimi-auth cookie 兜底（旧契约，服务端已改为只认 Bearer）。
 */
export async function readKimiWebSession(
  planSlug = 'kimi',
  allowCookieFallback = true,
  allowDesktopFallback = true,
): Promise<{ token: string; source: string } | null> {
  // 多账号纪律:非默认 slug 的会话只能来自它自己的会话文件/刷新链——
  // env token 与 Safari localStorage 是机器级「默认账号」渠道,第二账号
  // 借道会读到别人的号
  const primary = planSlug === 'kimi';
  const env = process.env.KIMI_AUTH_TOKEN;
  if (primary && env && env.trim()) return { token: env.trim(), source: 'env' };

  let lsRefreshToken: string | null = null;
  let lsSub: string | null = null;
  if (primary) {
    try {
      const tokens = await readSafariKimiWebTokens();
      lsRefreshToken = tokens.refreshToken;
      const claims = tokens.accessToken ? jwtClaims(tokens.accessToken) : {};
      if (typeof claims.exp !== 'number' || claims.exp * 1000 >= Date.now() + 60_000) {
        if (tokens.accessToken) return { token: tokens.accessToken, source: 'safari-localstorage' };
      }
      if (typeof claims.sub === 'string' && claims.sub) lsSub = claims.sub;
    } catch {
      // localStorage 不可读时继续走刷新链/既有路径
    }
  }

  const persisted = readPersistedWebSession(planSlug);
  if (persisted?.accessToken) {
    const claims = jwtClaims(persisted.accessToken);
    const persistedSub = typeof claims.sub === 'string' && claims.sub ? claims.sub : persisted.userSub;
    const sameAccount = persistedSub == null || lsSub == null || persistedSub === lsSub;
    const fresh = typeof claims.exp !== 'number' || claims.exp * 1000 >= Date.now() + 60_000;
    if (fresh && sameAccount) {
      return { token: persisted.accessToken, source: 'kimi-web-session' };
    }
  }

  const anchorMatches = persisted == null
    || persisted.userSub == null
    || lsSub == null
    || persisted.userSub === lsSub;
  const candidates = [lsRefreshToken, anchorMatches ? persisted?.refreshToken ?? null : null]
    .filter((token): token is string => !!token?.trim())
    .filter((token, index, all) => all.indexOf(token) === index);
  for (const candidate of candidates) {
    const refreshed = await refreshKimiWebAccessToken(candidate);
    if (!refreshed) continue;
    const claims = jwtClaims(refreshed.accessToken);
    const userSub = (typeof claims.sub === 'string' && claims.sub) || lsSub;
    persistWebSession({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? candidate,
      userSub,
    }, planSlug);
    return { token: refreshed.accessToken, source: 'kimi-web-session' };
  }

  return readKimiAuthToken(planSlug, allowCookieFallback, allowDesktopFallback);
}

const GET_USAGES_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages';
const SUBSCRIPTION_STATS_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';
// kimi.com 前端（request-*.js）的刷新端点：AUTH_API_HOST=https://auth.kimi.com，
// Connect-JSON 服务 account.gateway.v1.AuthService/RefreshToken，字段 refresh_token。
const KIMI_AUTH_REFRESH_URL =
  'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken';

interface KimiWebSessionFile {
  accessToken: string;
  refreshToken: string;
  userSub: string | null;
}

function kimiWebSessionPath(planSlug = 'kimi'): string {
  // 多账号:非默认 slug 用独立会话文件,避免两个账号互相覆盖刷新链
  return join(ensureHome(), planSlug === 'kimi' ? 'kimi-web-session.json' : `kimi-web-session-${planSlug}.json`);
}

function readPersistedWebSession(planSlug = 'kimi'): KimiWebSessionFile | null {
  try {
    const raw = JSON.parse(readFileSync(kimiWebSessionPath(planSlug), 'utf8')) as Partial<KimiWebSessionFile>;
    if (typeof raw.refreshToken !== 'string' || !raw.refreshToken.trim()) return null;
    return {
      accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : '',
      refreshToken: raw.refreshToken.trim(),
      userSub: typeof raw.userSub === 'string' ? raw.userSub : null,
    };
  } catch {
    return null;
  }
}

function persistWebSession(session: KimiWebSessionFile, planSlug = 'kimi'): void {
  const file = kimiWebSessionPath(planSlug);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(session) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/**
 * 用 refresh_token 换新 access_token（网页前端的 RefreshToken 端点）。
 * 返回 null 表示刷新失败（网络/invalid_grant/响应异常），调用方继续尝试下一候选。
 */
export async function refreshKimiWebAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  let res: Response;
  try {
    res = await fetch(KIMI_AUTH_REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'connect-protocol-version': '1',
        Origin: 'https://www.kimi.com',
        Referer: 'https://www.kimi.com/',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        'x-msh-platform': 'web',
        'x-language': 'en-US',
        'r-timezone': timezoneName(),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const json = (await res.json()) as { access_token?: unknown; accessToken?: unknown; refresh_token?: unknown; refreshToken?: unknown };
    const accessToken =
      typeof json.access_token === 'string' && json.access_token
        ? json.access_token
        : typeof json.accessToken === 'string' && json.accessToken
          ? json.accessToken
          : null;
    if (!accessToken) return null;
    const rotated =
      typeof json.refresh_token === 'string' && json.refresh_token
        ? json.refresh_token
        : typeof json.refreshToken === 'string' && json.refreshToken
          ? json.refreshToken
          : null;
    return { accessToken, refreshToken: rotated };
  } catch {
    return null;
  }
}

/** 用户主动点击“读取浏览器会话”时调用；token 只保存在当前 Bun 进程内存。 */
export async function refreshKimiBrowserSession(
  browser: KimiBrowser = 'safari',
  log: (message: string) => void = console.log,
  planSlug = 'kimi',
): Promise<BrowserCookieResult> {
  const result = await readBrowserKimiAuth(browser);
  for (const warning of result.warnings.slice(0, 8)) log(`浏览器会话：${warning}`);
  if (result.token && result.source) {
    browserSessions.set(planSlug, { token: result.token, source: result.source });
    log(`浏览器会话已读取：${result.source}（token 仅保存在内存）`);
  } else {
    // 读取另一个浏览器失败时，不要清掉已经成功的会话。
    // 例如 Firefox 已成功，用户随后试点 Safari 但没有 Full Disk Access，
    // 后台仍应继续使用 Firefox token，而不是退回 missing。
    log('本次浏览器读取失败，保留当前已成功的网页会话');
  }
  return result;
}

/** 原生 menubar app 已经通过 SweetCookieKit 读取完浏览器后，把 kimi-auth 交给 Bun。 */
export function acceptKimiBrowserToken(token: string, source: string, planSlug = 'kimi'): boolean {
  const value = token.trim();
  if (!value) return false;
  if (!browserCookieHeaders.has(planSlug)) {
    browserCookieHeaders.set(planSlug, `kimi-auth=${value}`);
  }
  browserSessions.set(planSlug, { token: value, source });
  return true;
}

export function acceptKimiBrowserCookies(
  cookies: Array<{ name?: string; value?: string }>,
  source: string,
  planSlug = 'kimi',
): boolean {
  for (const cookie of cookies) {
    if (cookie.name !== 'kimi-auth' || !cookie.value) continue;
    // CodexBar forwards HTTPCookie.value unchanged. Do not decode, strip
    // prefixes, or otherwise reinterpret a browser cookie here.
    const token = cookie.value.trim();
    if (!token) continue;
    const cookieHeader = cookies
      .filter((entry) => typeof entry.name === 'string' && typeof entry.value === 'string' && entry.value.trim())
      .map((entry) => `${entry.name}=${entry.value}`)
      .join('; ');
    // KimiCookieImporter.SessionInfo.authToken uses first(where:), so keep
    // the native importer order instead of re-ranking cookies by JWT claims.
    browserCookieHeaders.set(planSlug, cookieHeader);
    return acceptKimiBrowserToken(token, source, planSlug);
  }
  return false;
}

function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** 401 时若能从 JWT 解出 exp，给出"过期多久"的可操作提示；解析失败返回 null。 */
export function kimiTokenExpiredHint(token: string, nowMs = Date.now()): string | null {
  const claims = jwtClaims(token);
  if (typeof claims.exp !== 'number') return null;
  const expiredForMs = nowMs - claims.exp * 1000;
  if (expiredForMs <= 0) return null;
  const hours = expiredForMs / 3_600_000;
  const age = hours >= 48
    ? `${Math.round(hours / 24)} 天`
    : hours >= 1
      ? `${Math.round(hours * 10) / 10} 小时`
      : `${Math.max(1, Math.round(expiredForMs / 60_000))} 分钟`;
  return `（token 已于约 ${age} 前过期，请在 Safari 重新登录 kimi.com 后再读取会话）`;
}

/** 网页会话请求头（对齐 CodexBar webRequest：cookie + Bearer + 平台/设备头） */
function webHeaders(token: string, cookieHeader?: string | null): Record<string, string> {
  const claims = jwtClaims(token);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    // 2026-08 实测：apiv2 鉴权只看 Authorization Bearer（localStorage access_token），
    // 纯 Cookie 请求返回 REASON_INVALID_AUTH_TOKEN；没有真实浏览器 Cookie 时不再伪造。
    ...(cookieHeader?.includes('=') ? { Cookie: cookieHeader } : {}),
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
  // CodexBar's webRequest only forwards browser JWT identity. Never reuse the
  // kimi-code CLI device_id for a browser session.
  if (claims.device_id) headers['x-msh-device-id'] = claims.device_id;
  if (claims.ssid) headers['x-msh-session-id'] = claims.ssid;
  if (claims.sub) headers['x-traffic-id'] = claims.sub;
  return headers;
}

/** 网页会话拉周+5h：POST GetUsages(scope=FEATURE_CODING)，响应内层结构与 /coding/v1/usages 相同 */
async function fetchWebUsage(
  token: string,
  log: (msg: string) => void,
  cookieHeader?: string | null,
): Promise<QuotaWindow[]> {
  let res: Response;
  try {
    res = await fetch(GET_USAGES_URL, {
      method: 'POST',
      headers: webHeaders(token, cookieHeader),
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
    throw new AdapterError(
      'auth',
      `Kimi 网页会话过期(HTTP ${res.status})：请重新登录 kimi.com${kimiTokenExpiredHint(token) ?? ''}`,
    );
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
  if (!coding) {
    const totalQuota = (json as { totalQuota?: unknown })?.totalQuota;
    if (totalQuota && typeof totalQuota === 'object') {
      // 当前网页接口只返回 totalQuota 时，不猜测它对应周/5H；
      // 继续请求 GetSubscriptionStats，保证月度窗口仍能更新。
      log('Kimi GetUsages 当前只返回 totalQuota，周/5H 保留最近快照，继续读取月限额');
      try {
        return [await fetchSubscriptionStats(token, cookieHeader)];
      } catch (e) {
        log(`月限额获取失败：${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }
    throw new AdapterError('parse', 'Kimi GetUsages 缺少 FEATURE_CODING scope');
  }
  const windows = normalizeKimi({ usage: coding.detail, limits: coding.limits });

  // 月限额：失败只记日志（CodexBar 同为 best-effort enrichment）
  try {
    windows.push(await fetchSubscriptionStats(token, cookieHeader));
  } catch (e) {
    log(`月限额获取失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return windows;
}

/** 用 kimi-auth 网页会话拉月度订阅池；401 说明会话过期，需重新登录 kimi.com */
async function fetchSubscriptionStats(token: string, cookieHeader?: string | null): Promise<QuotaWindow> {
  let res: Response;
  try {
    res = await fetch(SUBSCRIPTION_STATS_URL, {
      method: 'POST',
      headers: webHeaders(token, cookieHeader),
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
    '没有有效 Kimi 会话：请在所选浏览器打开 kimi.com 刷新登录态，再从 menubar 读取浏览器会话；也可运行 kimi-code login 或设置 KIMI_CODE_API_KEY',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const apiKey = process.env.KIMI_CODE_API_KEY;
    if (apiKey && apiKey.trim()) return { kind: 'bearer', value: apiKey.trim(), source: 'env' };

    // 与 CodexBar 一致：auto 模式先 API key，再 kimi-code CLI OAuth，最后网页会话。
    // CLI /coding/v1/usages 没有月度字段，但网页会话是最后兜底，不应抢走 CLI OAuth。
    const configuredBrowser = ctx.plan.extra.browser as KimiBrowser | undefined;
    const cli = readCliCredential();
    const cliExpSec = cli?.access_token ? toNum(cli.expires_at) : null;
    const cliFresh =
      !!cli?.access_token && (cliExpSec == null || cliExpSec * 1000 >= Date.now() + 60_000);
    if (cliFresh) return { kind: 'bearer', value: cli.access_token!, source: 'auto' };
    if (shouldRefreshCliToken(cli, Date.now(), refreshEnabled()) && cli?.refresh_token) {
      const fresh = await refreshCliAccessToken(cli);
      if (fresh?.access_token) return { kind: 'bearer', value: fresh.access_token, source: 'auto' };
      ctx.log('CLI access_token 过期且刷新失败（可能已登出），尝试网页会话兜底');
    }

    // 配置过 provider 浏览器时，首次读取也只读取该浏览器，避免回退到另一浏览器的 cookie。
    if (configuredBrowser && !browserSessions.has(ctx.plan.slug)) {
      await refreshKimiBrowserSession(configuredBrowser, ctx.log, ctx.plan.slug);
    }
    const web = await readKimiWebSession(ctx.plan.slug, !configuredBrowser, !configuredBrowser);
    if (web && web.token) {
      return {
        kind: 'bearer',
        value: web.token,
        source: 'web',
        cookie: web.source === 'safari-localstorage'
          ? null
          : browserCookieHeaders.get(ctx.plan.slug) ?? web.token,
      };
    }

    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    // 网页会话路径：周/5h + 月 全走 www.kimi.com（Auto-cookie 兜底）
    if (cred.source === 'web') {
      return fetchWebUsage(cred.value, (msg) => ctx.log(msg), cred.cookie);
    }

    const base = (process.env.KIMI_CODE_BASE_URL ?? ctx.plan.extra.baseUrl ?? 'https://api.kimi.com').replace(/\/+$/, '');
    const url = `${base}/coding/v1/usages`;

    const requestCodeUsage = async (token: string): Promise<{ response: Response; json?: unknown }> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
      };
      if (cred.source === 'auto') {
        // CLI 凭据：带设备身份头（与官方 CLI 一致）
        const claims = jwtClaims(token);
        const deviceId = claims.device_id ?? deviceIdFile();
        if (deviceId) headers['x-msh-device-id'] = deviceId;
        if (claims.ssid) headers['x-msh-session-id'] = claims.ssid;
        if (claims.sub) headers['x-traffic-id'] = claims.sub;
      }

      let response: Response;
      try {
        response = await fetch(url, {
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
      if (!response.ok) return { response };
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new AdapterError('parse', `Kimi 响应不是合法 JSON：${url}`);
      }
      return { response, json };
    };

    let result = await requestCodeUsage(cred.value);
    if ((result.response.status === 401 || result.response.status === 403) && cred.source === 'auto') {
      // onWatch/CodexBar 兼容：先重新读取 CLI 可能刚轮换的文件，再强制刷新一次。
      const disk = readCliCredential();
      if (disk?.access_token && disk.access_token !== cred.value) {
        result = await requestCodeUsage(disk.access_token);
      }
      if ((result.response.status === 401 || result.response.status === 403) && disk?.refresh_token) {
        const fresh = await refreshCliAccessToken(disk);
        if (fresh?.access_token) result = await requestCodeUsage(fresh.access_token);
      }
    }

    if (result.response.status === 401 || result.response.status === 403) {
      throw new AdapterError(
        'auth',
        `Kimi 鉴权失败(HTTP ${result.response.status})：请重新登录 Kimi Code CLI 或换 KIMI_CODE_API_KEY`,
      );
    }
    if (!result.response.ok) {
      if (result.response.status === 429) throw new AdapterError('api', 'Kimi 请求被限流(HTTP 429)');
      throw new AdapterError('api', `Kimi API 错误(HTTP ${result.response.status})`);
    }

    const json = result.json;
    const windows = normalizeKimi(json);

    // 月限额为第三档：仅网页会话可读；失败只记日志，不影响 周/5h 主数据
    const auth = await readKimiWebSession(ctx.plan.slug, !ctx.plan.extra.browser, !ctx.plan.extra.browser);
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
