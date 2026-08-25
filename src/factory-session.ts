import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome } from './config.ts';

const FACTORY_SESSION_COOKIE_NAMES = new Set([
  'wos-session',
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
  '__Secure-authjs.session-token',
  '__Host-authjs.csrf-token',
  'authjs.session-token',
  'session',
  'access-token',
  '__recent_auth',
]);

export interface FactoryBrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface FactoryBrowserSession {
  cookieHeader: string;
  bearerToken: string | null;
  workosAccessToken: string | null;
  workosRefreshToken: string | null;
  workosRefreshTokenFallback: string | null;
  organizationId: string | null;
  workosCookieHeader: string | null;
  source: string;
}

let currentSession: FactoryBrowserSession | null = null;
// 多账号:按 slug 隔离的内存会话(默认 factory 保持单例语义)
const sessionsBySlug = new Map<string, FactoryBrowserSession>();

interface PersistedFactorySession {
  refreshToken: string;
  organizationId: string | null;
  cookieFingerprint: string | null;
  userSub?: string | null;
}

function persistedSessionPath(slug = 'factory'): string {
  // 多账号:非默认 slug 用独立会话文件
  return join(ensureHome(), slug === 'factory' ? 'factory-session.json' : `factory-session-${slug}.json`);
}

function cookieFingerprint(cookieHeader: string): string | null {
  const value = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join('; ');
  return value ? createHash('sha256').update(value).digest('hex') : null;
}

/** WorkOS / Factory access token 都是 JWT；读取 sub 用作账号锚点，避免 Cookie 轮换误判换号。 */
function jwtSubject(token: string | null | undefined): string | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

function readPersistedSession(slug = 'factory'): PersistedFactorySession | null {
  try {
    const raw = JSON.parse(readFileSync(persistedSessionPath(slug), 'utf8')) as Partial<PersistedFactorySession>;
    if (typeof raw.refreshToken !== 'string' || !raw.refreshToken.trim()) return null;
    return {
      refreshToken: raw.refreshToken.trim(),
      organizationId: typeof raw.organizationId === 'string' ? raw.organizationId : null,
      cookieFingerprint: typeof raw.cookieFingerprint === 'string' ? raw.cookieFingerprint : null,
      userSub: typeof raw.userSub === 'string' ? raw.userSub : null,
    };
  } catch {
    return null;
  }
}

function persistRefreshToken(
  refreshToken: string,
  organizationId: string | null,
  cookieHeader: string,
  userSub: string | null,
  slug = 'factory',
): void {
  const file = persistedSessionPath(slug);
  writeFileSync(file, JSON.stringify({
    refreshToken,
    organizationId,
    cookieFingerprint: cookieFingerprint(cookieHeader),
    ...(userSub ? { userSub } : {}),
  }) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function acceptFactoryBrowserCookies(
  cookies: FactoryBrowserCookie[],
  source: string,
  workos?: { accessToken?: string | null; refreshToken?: string | null },
  organizationId?: string | null,
  workosCookies?: FactoryBrowserCookie[],
  slug = 'factory',
): boolean {
  const selected = cookies.filter((cookie) =>
    FACTORY_SESSION_COOKIE_NAMES.has(cookie.name) && cookie.value.trim());
  const workosAccessToken = workos?.accessToken?.trim() || null;
  const workosRefreshToken = workos?.refreshToken?.trim() || null;
  const selectedOrganizationId = organizationId?.trim() || null;
  const workosCookieHeader = workosCookies?.filter((cookie) => cookie.value.trim())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ') || null;
  const selectedCookieHeader = selected.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const persisted = readPersistedSession(slug);
  const persistedMatches = persisted != null
    && (!persisted.cookieFingerprint || persisted.cookieFingerprint === cookieFingerprint(selectedCookieHeader));
  // WorkOS refresh token 一次性轮换：daemon 兑换会消耗浏览器 localStorage 里的 token。
  // Cookie 值本身高频轮换（access-token 等），fingerprint 失配不代表换号；只要
  // access-token cookie 的 JWT sub 与持久化 userSub 一致，就保留持久化轮换链做兜底，
  // 浏览器 token 失效（已被上次兑换消耗）时仍能恢复。
  const browserAccessToken = selected.find((cookie) => cookie.name === 'access-token')?.value ?? null;
  const sameAccountFallback = persisted != null
    && !persistedMatches
    && !!persisted.userSub
    && jwtSubject(browserAccessToken) === persisted.userSub;
  const persistedForSession = persistedMatches ? persisted : null;
  const persistedRefreshToken = persistedForSession?.refreshToken ?? null;
  const browserRefreshToken = workos?.refreshToken?.trim() || null;
  if (selected.length === 0 && !workosAccessToken && !workosRefreshToken) return false;

  const primaryRefreshToken = persistedRefreshToken ?? browserRefreshToken;
  const fallbackRefreshToken = [
    sameAccountFallback ? persisted!.refreshToken : null,
    browserRefreshToken,
  ]
    .find((token): token is string => !!token?.trim() && token.trim() !== primaryRefreshToken) ?? null;

  currentSession = {
    cookieHeader: selectedCookieHeader,
    bearerToken: browserAccessToken,
    workosAccessToken,
    workosRefreshToken: primaryRefreshToken,
    workosRefreshTokenFallback: fallbackRefreshToken,
    organizationId: persistedForSession?.organizationId ?? selectedOrganizationId,
    workosCookieHeader,
    source,
  };
  sessionsBySlug.set(slug, currentSession);
  return true;
}

export function updateFactoryWorkOSSession(tokens: {
  accessToken?: string | null;
  refreshToken?: string | null;
  refreshTokenFallback?: string | null;
  organizationId?: string | null;
  workosCookie?: string | null;
  sessionSlug?: string | null;
}, slug?: string): void {
  const effectiveSlug = slug ?? tokens.sessionSlug ?? 'factory';
  const session = sessionsBySlug.get(effectiveSlug) ?? currentSession;
  if (!session) return;
  sessionsBySlug.set(effectiveSlug, {
    ...session,
    workosAccessToken: tokens.accessToken?.trim() || session.workosAccessToken,
    workosRefreshToken: tokens.refreshToken?.trim() || session.workosRefreshToken,
    workosRefreshTokenFallback: tokens.refreshTokenFallback?.trim() || session.workosRefreshTokenFallback,
    organizationId: tokens.organizationId?.trim() || session.organizationId,
    workosCookieHeader: tokens.workosCookie?.trim() || session.workosCookieHeader,
  });
  if (effectiveSlug === 'factory') currentSession = sessionsBySlug.get('factory') ?? currentSession;
  // WorkOS refresh token 一次性轮换。这里必须无条件回写：从持久化恢复的会话
  // （source='persisted'，即 daemon 重启后的唯一形态）兑换会消耗文件里的 token，
  // 新 token 只存在于内存；若不回写，daemon 一旦再重启就拿着已消耗的 token
  // 永久 400。手动 API key 凭据不带 refreshToken，不会走到这里。
  const rotated = tokens.refreshToken?.trim();
  if (rotated) {
    const session = sessionsBySlug.get(effectiveSlug) ?? currentSession;
    if (session) {
      const userSub = jwtSubject(tokens.accessToken) ?? readPersistedSession(effectiveSlug)?.userSub ?? null;
      persistRefreshToken(rotated, session.organizationId, session.cookieHeader, userSub, effectiveSlug);
    }
  }
}

export function getFactoryBrowserSession(slug = 'factory'): FactoryBrowserSession | null {
  if (slug !== 'factory') {
    if (!sessionsBySlug.has(slug)) {
      const persisted = readPersistedSession(slug);
      if (persisted) {
        sessionsBySlug.set(slug, {
          cookieHeader: '',
          bearerToken: null,
          workosAccessToken: null,
          workosRefreshToken: persisted.refreshToken,
          workosRefreshTokenFallback: null,
          organizationId: persisted.organizationId,
          workosCookieHeader: null,
          source: 'persisted',
        });
      }
    }
    return sessionsBySlug.get(slug) ?? null;
  }
  if (!currentSession) {
    const persisted = readPersistedSession();
    if (persisted) {
      currentSession = {
        cookieHeader: '',
        bearerToken: null,
        workosAccessToken: null,
        workosRefreshToken: persisted.refreshToken,
        workosRefreshTokenFallback: null,
        organizationId: persisted.organizationId,
        workosCookieHeader: null,
        source: 'persisted',
      };
    }
  }
  return currentSession;
}

export function clearFactoryBrowserSession(slug = 'factory'): void {
  sessionsBySlug.delete(slug);
  if (slug === 'factory') currentSession = null;
}

export function isFactorySessionCookieName(name: string): boolean {
  return FACTORY_SESSION_COOKIE_NAMES.has(name);
}
