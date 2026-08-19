const FACTORY_SESSION_COOKIE_NAMES = new Set([
  'wos-session',
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
  '__Secure-authjs.session-token',
  '__Host-authjs.csrf-token',
  'authjs.session-token',
  'session',
  'access-token',
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
  source: string;
}

let currentSession: FactoryBrowserSession | null = null;

export function acceptFactoryBrowserCookies(
  cookies: FactoryBrowserCookie[],
  source: string,
  workos?: { accessToken?: string | null; refreshToken?: string | null },
): boolean {
  const selected = cookies.filter((cookie) =>
    FACTORY_SESSION_COOKIE_NAMES.has(cookie.name) && cookie.value.trim());
  const workosAccessToken = workos?.accessToken?.trim() || null;
  const workosRefreshToken = workos?.refreshToken?.trim() || null;
  if (selected.length === 0 && !workosAccessToken && !workosRefreshToken) return false;

  currentSession = {
    cookieHeader: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    bearerToken: selected.find((cookie) => cookie.name === 'access-token')?.value ?? null,
    workosAccessToken,
    workosRefreshToken,
    source,
  };
  return true;
}

export function updateFactoryWorkOSSession(tokens: {
  accessToken?: string | null;
  refreshToken?: string | null;
}): void {
  if (!currentSession) return;
  currentSession = {
    ...currentSession,
    workosAccessToken: tokens.accessToken?.trim() || currentSession.workosAccessToken,
    workosRefreshToken: tokens.refreshToken?.trim() || currentSession.workosRefreshToken,
  };
}

export function getFactoryBrowserSession(): FactoryBrowserSession | null {
  return currentSession;
}

export function clearFactoryBrowserSession(): void {
  currentSession = null;
}

export function isFactorySessionCookieName(name: string): boolean {
  return FACTORY_SESSION_COOKIE_NAMES.has(name);
}
