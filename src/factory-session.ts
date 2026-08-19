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
  source: string;
}

let currentSession: FactoryBrowserSession | null = null;

export function acceptFactoryBrowserCookies(
  cookies: FactoryBrowserCookie[],
  source: string,
): boolean {
  const selected = cookies.filter((cookie) =>
    FACTORY_SESSION_COOKIE_NAMES.has(cookie.name) && cookie.value.trim());
  if (selected.length === 0) return false;

  currentSession = {
    cookieHeader: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    bearerToken: selected.find((cookie) => cookie.name === 'access-token')?.value ?? null,
    source,
  };
  return true;
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
