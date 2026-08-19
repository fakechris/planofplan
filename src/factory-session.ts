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

interface PersistedFactorySession {
  refreshToken: string;
  organizationId: string | null;
  cookieFingerprint: string | null;
}

function persistedSessionPath(): string {
  return join(ensureHome(), 'factory-session.json');
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

function readPersistedSession(): PersistedFactorySession | null {
  try {
    const raw = JSON.parse(readFileSync(persistedSessionPath(), 'utf8')) as Partial<PersistedFactorySession>;
    if (typeof raw.refreshToken !== 'string' || !raw.refreshToken.trim()) return null;
    return {
      refreshToken: raw.refreshToken.trim(),
      organizationId: typeof raw.organizationId === 'string' ? raw.organizationId : null,
      cookieFingerprint: typeof raw.cookieFingerprint === 'string' ? raw.cookieFingerprint : null,
    };
  } catch {
    return null;
  }
}

function persistRefreshToken(refreshToken: string, organizationId: string | null, cookieHeader: string): void {
  const file = persistedSessionPath();
  writeFileSync(file, JSON.stringify({
    refreshToken,
    organizationId,
    cookieFingerprint: cookieFingerprint(cookieHeader),
  }) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function acceptFactoryBrowserCookies(
  cookies: FactoryBrowserCookie[],
  source: string,
  workos?: { accessToken?: string | null; refreshToken?: string | null },
  organizationId?: string | null,
  workosCookies?: FactoryBrowserCookie[],
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
  const persisted = readPersistedSession();
  const persistedMatches = persisted != null
    && (!persisted.cookieFingerprint || persisted.cookieFingerprint === cookieFingerprint(selectedCookieHeader));
  const persistedForSession = persistedMatches ? persisted : null;
  const persistedRefreshToken = persistedForSession?.refreshToken ?? null;
  const browserRefreshToken = workos?.refreshToken?.trim() || null;
  if (selected.length === 0 && !workosAccessToken && !workosRefreshToken) return false;

  currentSession = {
    cookieHeader: selectedCookieHeader,
    bearerToken: selected.find((cookie) => cookie.name === 'access-token')?.value ?? null,
    workosAccessToken,
    workosRefreshToken: persistedRefreshToken ?? browserRefreshToken,
    workosRefreshTokenFallback: persistedRefreshToken && browserRefreshToken && persistedRefreshToken !== browserRefreshToken
      ? browserRefreshToken
      : null,
    organizationId: persistedForSession?.organizationId ?? selectedOrganizationId,
    workosCookieHeader,
    source,
  };
  return true;
}

export function updateFactoryWorkOSSession(tokens: {
  accessToken?: string | null;
  refreshToken?: string | null;
  refreshTokenFallback?: string | null;
  organizationId?: string | null;
  workosCookie?: string | null;
}): void {
  if (!currentSession) return;
  currentSession = {
    ...currentSession,
    workosAccessToken: tokens.accessToken?.trim() || currentSession.workosAccessToken,
    workosRefreshToken: tokens.refreshToken?.trim() || currentSession.workosRefreshToken,
    workosRefreshTokenFallback: tokens.refreshTokenFallback?.trim() || currentSession.workosRefreshTokenFallback,
    organizationId: tokens.organizationId?.trim() || currentSession.organizationId,
    workosCookieHeader: tokens.workosCookie?.trim() || currentSession.workosCookieHeader,
  };
  const rotated = tokens.refreshToken?.trim();
  if (rotated && (currentSession.source.includes('(native)') || currentSession.source.startsWith('browser:'))) {
    persistRefreshToken(rotated, currentSession.organizationId, currentSession.cookieHeader);
  }
}

export function getFactoryBrowserSession(): FactoryBrowserSession | null {
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

export function clearFactoryBrowserSession(): void {
  currentSession = null;
}

export function isFactorySessionCookieName(name: string): boolean {
  return FACTORY_SESSION_COOKIE_NAMES.has(name);
}
