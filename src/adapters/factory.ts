import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { getFactoryBrowserSession, updateFactoryWorkOSSession } from '../factory-session.ts';

const API_BASE = 'https://api.factory.ai';
const APP_BASES = ['https://api.factory.ai', 'https://app.factory.ai', 'https://auth.factory.ai'];
const WORKOS_AUTH_BASE = 'https://api.workos.com';
const WORKOS_AUTH_PATH = '/user_management/authenticate';
const WORKOS_CLIENT_IDS = [
  'client_01HXRMBQ9BJ3E7QSTQ9X2PHVB7',
  'client_01HNM792M5G5G1A2THWPXKFMXB',
];
const AUTH_PATH = '/api/app/auth/me';
const BILLING_LIMITS_PATH = '/api/billing/limits';
const SUBSCRIPTION_USAGE_PATH = '/api/organization/subscription/usage';
const FACTORY_API_KEY = 'FACTORY_API_KEY';

interface FactoryBillingWindow {
  usedPercent?: unknown;
  windowEnd?: unknown;
  secondsRemaining?: unknown;
}

interface FactoryLimitPool {
  fiveHour?: FactoryBillingWindow;
  weekly?: FactoryBillingWindow;
  monthly?: FactoryBillingWindow;
}

interface FactoryBillingLimits {
  usesTokenRateLimitsBilling?: unknown;
  limits?: {
    standard?: FactoryLimitPool;
    core?: FactoryLimitPool;
  };
  extraUsageBalanceCents?: unknown;
}

interface FactoryUsagePool {
  userTokens?: unknown;
  totalAllowance?: unknown;
  usedRatio?: unknown;
}

interface FactoryUsageResponse {
  usage?: {
    startDate?: unknown;
    endDate?: unknown;
    standard?: FactoryUsagePool;
    premium?: FactoryUsagePool;
  };
  userId?: unknown;
}

interface FactoryAuthResponse {
  userProfile?: { id?: unknown };
  organization?: {
    name?: unknown;
    subscription?: {
      factoryTier?: unknown;
      orbSubscription?: { plan?: { name?: unknown } };
    };
  };
}

interface WorkOSAuthResponse {
  access_token?: unknown;
  refresh_token?: unknown;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseDateMs(value: unknown): number | null {
  const numeric = numberValue(value) ?? (typeof value === 'string' && value.trim() ? Number(value) : null);
  if (numeric != null && Number.isFinite(numeric)) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resetAtForWindow(window: FactoryBillingWindow, now: number): number | null {
  const seconds = numberValue(window.secondsRemaining);
  if (seconds != null && seconds > 0) return now + seconds * 1000;
  const windowEnd = parseDateMs(window.windowEnd);
  return windowEnd != null && windowEnd > now ? windowEnd : null;
}

function normalizeBillingWindow(
  window: FactoryBillingWindow | undefined,
  id: string,
  label: string,
  now: number,
): QuotaWindow | null {
  if (!window) return null;
  const rawPercent = numberValue(window.usedPercent);
  const resetAt = resetAtForWindow(window, now);
  const expired = window.windowEnd != null && resetAt == null && window.secondsRemaining == null;
  return {
    window: id,
    label,
    used: null,
    total: null,
    unit: 'percent',
    percentage: clampPercent(expired ? 0 : rawPercent ?? 0),
    resetAt,
    note: null,
  };
}

function normalizePool(
  pool: FactoryLimitPool | undefined,
  prefix: string,
  labels: { fiveHour: string; weekly: string; monthly: string },
  now: number,
): QuotaWindow[] {
  if (!pool) return [];
  return [
    normalizeBillingWindow(pool.fiveHour, `${prefix}_5h`, labels.fiveHour, now),
    normalizeBillingWindow(pool.weekly, `${prefix}_weekly`, labels.weekly, now),
    normalizeBillingWindow(pool.monthly, `${prefix}_monthly`, labels.monthly, now),
  ].filter((window): window is QuotaWindow => window != null);
}

export function normalizeFactoryBillingLimits(raw: unknown, now = Date.now()): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Factory billing limits 响应不是 JSON 对象');
  }
  const root = raw as FactoryBillingLimits;
  if (root.usesTokenRateLimitsBilling !== true || !root.limits?.standard) {
    throw new AdapterError('parse', 'Factory billing limits 没有 token-rate-limits 数据');
  }

  const standard = normalizePool(root.limits.standard, 'standard', {
    fiveHour: 'Standard 5H',
    weekly: 'Standard Week',
    monthly: 'Standard Month',
  }, now);
  const core = normalizePool(root.limits.core, 'core', {
    fiveHour: 'Core 5H',
    weekly: 'Core Week',
    monthly: 'Core Month',
  }, now);
  const windows = [...standard, ...core];
  if (windows.length === 0) {
    throw new AdapterError('parse', 'Factory billing limits 没有可用窗口');
  }
  return windows;
}

function usagePercent(pool: FactoryUsagePool | undefined): number | null {
  if (!pool) return null;
  const ratio = numberValue(pool.usedRatio);
  if (ratio != null && Number.isFinite(ratio)) {
    if (ratio >= 0 && ratio <= 1.001) return clampPercent(ratio * 100);
    if (ratio > 1 && ratio <= 100.1) return clampPercent(ratio);
  }
  const used = numberValue(pool.userTokens);
  const allowance = numberValue(pool.totalAllowance);
  if (used == null || allowance == null || allowance <= 0) return null;
  if (allowance > 1_000_000_000_000) {
    return clampPercent((used / 100_000_000) * 100);
  }
  return clampPercent((used / allowance) * 100);
}

export function normalizeFactoryUsage(raw: unknown, now = Date.now()): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Factory subscription usage 响应不是 JSON 对象');
  }
  const usage = (raw as FactoryUsageResponse).usage;
  if (!usage || typeof usage !== 'object') {
    throw new AdapterError('parse', 'Factory subscription usage 缺少 usage');
  }
  const resetAt = parseDateMs(usage.endDate);
  const windows: QuotaWindow[] = [];
  for (const [id, label, pool] of [
    ['standard', 'Standard', usage.standard],
    ['premium', 'Premium', usage.premium],
  ] as const) {
    const percentage = usagePercent(pool);
    if (percentage == null) continue;
    windows.push({
      window: id,
      label,
      used: numberValue(pool?.userTokens),
      total: numberValue(pool?.totalAllowance),
      unit: 'tokens',
      percentage,
      resetAt: resetAt != null && resetAt > now ? resetAt : null,
      note: null,
    });
  }
  if (windows.length === 0) {
    throw new AdapterError('parse', 'Factory subscription usage 没有可用窗口');
  }
  return windows;
}

function readFactoryDotEnv(): string | null {
  const file = join(homedir(), '.factory', '.env');
  if (!existsSync(file)) return null;
  try {
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) line = line.slice('export '.length).trim();
      const separator = line.indexOf('=');
      if (separator < 0 || line.slice(0, separator).trim() !== FACTORY_API_KEY) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value.trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

function apiKeyFromEnvironment(): string | null {
  const value = process.env[FACTORY_API_KEY]?.trim() || readFactoryDotEnv();
  return value || null;
}

function bearerSubject(token: string): string | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown };
    return stringValue(payload.sub);
  } catch {
    return null;
  }
}

function headers(credential: Credential): Record<string, string> {
  const result: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: 'https://app.factory.ai',
    referer: 'https://app.factory.ai/',
    'x-factory-client': 'web-app',
  };
  if (credential.cookie) result.Cookie = credential.cookie;
  if (credential.value.trim()) result.Authorization = `Bearer ${credential.value}`;
  return result;
}

async function getJSONAt(base: string, path: string, credential: Credential): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: headers(credential),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new AdapterError('network', `Factory 请求超时：${path}`);
    }
    throw new AdapterError('network', `Factory 网络错误：${String(error instanceof Error ? error.message : error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new AdapterError('auth', `Factory 鉴权失败(HTTP ${response.status})：请登录 app.factory.ai 或更新 FACTORY_API_KEY`);
  }
  if (!response.ok) {
    if (response.status === 429) throw new AdapterError('api', 'Factory 请求被限流(HTTP 429)');
    throw new AdapterError('api', `Factory API 错误(HTTP ${response.status})`);
  }
  try {
    return await response.json();
  } catch {
    throw new AdapterError('parse', `Factory 响应不是合法 JSON：${path}`);
  }
}

async function getJSON(path: string, credential: Credential): Promise<unknown> {
  return getJSONAt(API_BASE, path, credential);
}

async function getJSONFromBases(path: string, credential: Credential): Promise<unknown> {
  let lastError: unknown = null;
  let authError: AdapterError | null = null;
  for (const base of APP_BASES) {
    try {
      return await getJSONAt(base, path, credential);
    } catch (error) {
      lastError = error;
      if (error instanceof AdapterError && error.kind === 'auth') authError = error;
    }
  }
  if (authError) throw authError;
  throw lastError instanceof Error ? lastError : new AdapterError('network', `Factory 请求失败：${path}`);
}

async function exchangeWorkOSRefreshToken(
  refreshToken: string,
  organizationId?: string | null,
): Promise<WorkOSAuthResponse> {
  let lastError: unknown = null;
  for (const clientId of WORKOS_CLIENT_IDS) {
    try {
      const response = await fetch(`${WORKOS_AUTH_BASE}${WORKOS_AUTH_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...(organizationId ? { organization_id: organizationId } : {}),
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        lastError = new AdapterError(
          response.status === 400 || response.status === 401 ? 'auth' : 'api',
          `WorkOS 鉴权失败(HTTP ${response.status})${body.includes('invalid_grant') ? '：refresh token 已失效' : ''}`,
        );
        continue;
      }
      const payload = await response.json() as WorkOSAuthResponse;
      const accessToken = stringValue(payload.access_token);
      if (!accessToken) {
        lastError = new AdapterError('parse', 'WorkOS 鉴权响应缺少 access_token');
        continue;
      }
      return {
        access_token: accessToken,
        refresh_token: stringValue(payload.refresh_token),
      };
    } catch (error) {
      lastError = new AdapterError('network', `WorkOS 网络错误：${String(error instanceof Error ? error.message : error)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new AdapterError('auth', 'WorkOS 鉴权失败');
}

async function credentialWithWorkOSAccessToken(credential: Credential): Promise<Credential> {
  if (!credential.refreshToken || credential.value.trim()) return credential;
  const tokens = await exchangeWorkOSRefreshToken(credential.refreshToken, credential.organizationId);
  const accessToken = stringValue(tokens.access_token);
  if (!accessToken) throw new AdapterError('auth', 'WorkOS 鉴权响应缺少 access_token');
  updateFactoryWorkOSSession({
    accessToken,
    refreshToken: stringValue(tokens.refresh_token),
    organizationId: credential.organizationId,
  });
  return {
    ...credential,
    value: accessToken,
    refreshToken: stringValue(tokens.refresh_token) ?? credential.refreshToken,
    organizationId: credential.organizationId,
  };
}

export const factoryAdapter: PlanAdapter = {
  slug: 'factory',
  credentialHint:
    '缺少凭据：设置 FACTORY_API_KEY、运行 `planofplan auth set factory --key <Factory API key>`，或在 app.factory.ai 登录后从 menubar 读取浏览器会话',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const apiKey = apiKeyFromEnvironment();
    if (apiKey) return { kind: 'bearer', value: apiKey, source: 'env' };
    const session = getFactoryBrowserSession();
    if (session) {
      return {
        kind: 'bearer',
        value: session.workosAccessToken
          ?? (session.workosRefreshToken ? '' : session.bearerToken ?? ''),
        cookie: session.cookieHeader,
        refreshToken: session.workosRefreshToken,
        organizationId: session.organizationId,
        source: `browser:${session.source}`,
      };
    }
    return null;
  },

  async fetchUsage(_ctx: AdapterContext, credential: Credential): Promise<QuotaWindow[]> {
    let activeCredential = credential;
    if (!activeCredential.value.trim() && activeCredential.refreshToken) {
      try {
        activeCredential = await credentialWithWorkOSAccessToken(activeCredential);
      } catch (error) {
        // WorkOS refresh tokens rotate. If a previous process redeemed the
        // browser token, the browser cookie remains an independent auth path.
        if (
          !activeCredential.cookie ||
          !(error instanceof AdapterError) ||
          error.kind !== 'auth'
        ) {
          throw error;
        }
        activeCredential = { ...activeCredential, value: '' };
      }
    }
    try {
      return await fetchFactoryUsage(activeCredential);
    } catch (error) {
      if (!(error instanceof AdapterError) || error.kind !== 'auth') throw error;

      if (activeCredential.refreshToken && activeCredential.value.trim()) {
        try {
          activeCredential = await credentialWithWorkOSAccessToken({
            ...activeCredential,
            value: '',
          });
          return fetchFactoryUsage(activeCredential);
        } catch (refreshError) {
          if (!activeCredential.cookie || !(refreshError instanceof AdapterError) || refreshError.kind !== 'auth') {
            throw refreshError;
          }
        }
      }

      if (activeCredential.cookie && activeCredential.value.trim()) {
        return fetchFactoryUsage({ ...activeCredential, value: '' });
      }
      throw error;
    }
  },
};

async function fetchFactoryUsage(credential: Credential): Promise<QuotaWindow[]> {
    let billing: unknown;
    try {
      billing = await getJSON(BILLING_LIMITS_PATH, credential);
      const billingRoot = billing as FactoryBillingLimits;
      if (billingRoot.usesTokenRateLimitsBilling === true && billingRoot.limits?.standard) {
        return normalizeFactoryBillingLimits(billing);
      }
    } catch (error) {
      // Older accounts do not expose billing limits. Continue to the legacy endpoint.
      if (error instanceof AdapterError && error.kind === 'auth') throw error;
    }

    const auth = await getJSONFromBases(AUTH_PATH, credential) as FactoryAuthResponse;
    const userId = stringValue(auth.userProfile?.id) ?? bearerSubject(credential.value);
    const query = userId ? `?useCache=true&userId=${encodeURIComponent(userId)}` : '?useCache=true';
    const usage = await getJSONFromBases(`${SUBSCRIPTION_USAGE_PATH}${query}`, credential);
    return normalizeFactoryUsage(usage);
}
