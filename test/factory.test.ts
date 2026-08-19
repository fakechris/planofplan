import { describe, expect, test } from 'bun:test';
import { normalizeFactoryBillingLimits, normalizeFactoryUsage } from '../src/adapters/factory.ts';
import { factoryAdapter } from '../src/adapters/factory.ts';
import { openMemoryDb } from '../src/db.ts';
import {
  acceptFactoryBrowserCookies,
  clearFactoryBrowserSession,
  getFactoryBrowserSession,
  updateFactoryWorkOSSession,
} from '../src/factory-session.ts';
import { createServer } from '../src/server.ts';

describe('Factory usage', () => {
  test('normalizes CodexBar token-rate-limit windows', () => {
    const now = Date.parse('2026-08-18T00:00:00Z');
    const windows = normalizeFactoryBillingLimits({
      usesTokenRateLimitsBilling: true,
      limits: {
        standard: {
          fiveHour: { usedPercent: 12, secondsRemaining: 3600 },
          weekly: { usedPercent: 34, secondsRemaining: 86_400 },
          monthly: { usedPercent: 56, secondsRemaining: 604_800 },
        },
        core: {
          fiveHour: { usedPercent: 4, windowEnd: '2026-08-18T02:00:00Z' },
        },
      },
    }, now);

    expect(windows.map((window) => [window.window, window.percentage])).toEqual([
      ['standard_5h', 12],
      ['standard_weekly', 34],
      ['standard_monthly', 56],
      ['core_5h', 4],
    ]);
    expect(windows[0]!.resetAt).toBe(now + 3_600_000);
  });

  test('clears stale billing values after a window expires', () => {
    const windows = normalizeFactoryBillingLimits({
      usesTokenRateLimitsBilling: true,
      limits: {
        standard: {
          fiveHour: { usedPercent: 99, windowEnd: '2026-08-17T23:00:00Z' },
        },
      },
    }, Date.parse('2026-08-18T00:00:00Z'));

    expect(windows[0]!.percentage).toBe(0);
    expect(windows[0]!.resetAt).toBeNull();
  });

  test('normalizes legacy Standard and Premium token usage', () => {
    const windows = normalizeFactoryUsage({
      usage: {
        startDate: 1_754_953_600_000,
        endDate: 1_758_657_600_000,
        standard: { userTokens: 25, totalAllowance: 100 },
        premium: { usedRatio: 0.4, userTokens: 40, totalAllowance: 100 },
      },
    }, 1_754_953_600_000);

    expect(windows.map((window) => [window.window, window.percentage])).toEqual([
      ['standard', 25],
      ['premium', 40],
    ]);
  });

  test('accepts only recognized Factory session cookies and keeps them in memory', () => {
    clearFactoryBrowserSession();
    expect(acceptFactoryBrowserCookies([
      { name: 'irrelevant', value: 'nope' },
      { name: 'wos-session', value: 'session-value' },
      { name: 'access-token', value: 'bearer-value' },
    ], 'Safari')).toBe(true);
    expect(getFactoryBrowserSession()).toEqual({
      cookieHeader: 'wos-session=session-value; access-token=bearer-value',
      bearerToken: 'bearer-value',
      workosAccessToken: null,
      workosRefreshToken: null,
      workosRefreshTokenFallback: null,
      organizationId: null,
      workosCookieHeader: null,
      source: 'Safari',
    });
    clearFactoryBrowserSession();
    expect(getFactoryBrowserSession()).toBeNull();
  });

  test('uses a browser WorkOS refresh token before Factory billing calls', async () => {
    clearFactoryBrowserSession();
    expect(acceptFactoryBrowserCookies(
      [{ name: 'session', value: 'browser-session' }],
      'Comet',
      { refreshToken: 'workos-refresh-token' },
      'org_123',
    )).toBe(true);

    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      cookie: string | null;
      body: string;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        cookie: new Headers(init?.headers).get('cookie'),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if (url === 'https://api.workos.com/user_management/authenticate') {
        return new Response(JSON.stringify({
          access_token: 'workos-access-token',
          refresh_token: 'workos-refresh-token-rotated',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        usesTokenRateLimitsBilling: true,
        limits: {
          standard: {
            fiveHour: { usedPercent: 12, secondsRemaining: 3600 },
          },
        },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const windows = await factoryAdapter.fetchUsage({} as never, {
        kind: 'bearer',
        value: '',
        cookie: 'session=browser-session',
        refreshToken: 'workos-refresh-token',
        organizationId: 'org_123',
        workosCookie: 'wos-session=workos-browser-session',
        source: 'browser:Comet',
      });
      expect(windows[0]?.percentage).toBe(12);
      expect(requests.map((request) => request.url)).toEqual([
        'https://api.workos.com/user_management/authenticate',
        'https://api.factory.ai/api/billing/limits',
      ]);
      expect(JSON.parse(requests[0]!.body)).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'workos-refresh-token',
        organization_id: 'org_123',
        useCookie: true,
      });
      expect(requests[0]!.cookie).toBe('wos-session=workos-browser-session');
      expect(requests[1]!.authorization).toBe('Bearer workos-access-token');
    } finally {
      globalThis.fetch = originalFetch;
      clearFactoryBrowserSession();
    }
  });

  test('falls back to Factory cookies when the browser WorkOS refresh token is rejected', async () => {
    clearFactoryBrowserSession();
    expect(acceptFactoryBrowserCookies(
      [{ name: 'session', value: 'browser-session' }],
      'Comet',
      { refreshToken: 'stale-workos-refresh-token' },
    )).toBe(true);

    const requests: Array<{ url: string; authorization: string | null; cookie: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorization: headers.get('authorization'),
        cookie: headers.get('cookie'),
      });
      if (url === 'https://api.workos.com/user_management/authenticate') {
        return new Response('invalid_grant', { status: 401 });
      }
      if (url === 'https://api.factory.ai/api/billing/limits') {
        if (headers.get('cookie') !== 'session=browser-session') {
          return new Response('missing browser session', { status: 401 });
        }
        return Response.json({
          usesTokenRateLimitsBilling: true,
          limits: { standard: { fiveHour: { usedPercent: 12, secondsRemaining: 3600 } } },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const windows = await factoryAdapter.fetchUsage({} as never, {
        kind: 'bearer',
        value: '',
        cookie: 'session=browser-session',
        refreshToken: 'stale-workos-refresh-token',
        source: 'browser:Comet',
      });
      expect(windows[0]?.percentage).toBe(12);
      expect(requests.at(-1)?.cookie).toBe('session=browser-session');
      expect(requests.at(-1)?.authorization).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      clearFactoryBrowserSession();
    }
  });

  test('drops a rejected stale access-token and retries Factory with cookies', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ authorization: string | null; cookie: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === 'https://api.factory.ai/api/billing/limits') {
        requests.push({
          authorization: headers.get('authorization'),
          cookie: headers.get('cookie'),
        });
        if (headers.get('authorization') === 'Bearer stale-access-token') {
          return new Response('expired bearer', { status: 401 });
        }
        return Response.json({
          usesTokenRateLimitsBilling: true,
          limits: { standard: { fiveHour: { usedPercent: 8, secondsRemaining: 3600 } } },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    try {
      const windows = await factoryAdapter.fetchUsage({} as never, {
        kind: 'bearer',
        value: 'stale-access-token',
        cookie: 'session=browser-session; access-token=stale-access-token',
        source: 'browser:Comet',
      });
      expect(windows[0]?.percentage).toBe(8);
      expect(requests).toEqual([
        { authorization: 'Bearer stale-access-token', cookie: 'session=browser-session; access-token=stale-access-token' },
        { authorization: null, cookie: 'session=browser-session; access-token=stale-access-token' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reuses the rotated WorkOS refresh token after a process restart', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    try {
      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'browser-session' }],
        'Comet (native)',
        { refreshToken: 'browser-refresh-token' },
      )).toBe(true);
      updateFactoryWorkOSSession({
        accessToken: 'rotated-access-token',
        refreshToken: 'rotated-refresh-token',
      });

      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'browser-session' }],
        'Comet (native)',
        { refreshToken: 'browser-refresh-token' },
      )).toBe(true);
      expect(getFactoryBrowserSession()).toMatchObject({
        workosRefreshToken: 'rotated-refresh-token',
        workosRefreshTokenFallback: 'browser-refresh-token',
      });
    } finally {
      clearFactoryBrowserSession();
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('returns a failed status when browser-session refresh cannot fetch usage', async () => {
    const plan = {
      slug: 'factory',
      name: 'Factory Droid',
      adapter: 'factory',
      enabled: true,
      pollIntervalSec: 300,
      credRef: null,
      extra: {},
    } as const;
    const store = openMemoryDb();
    store.syncPlan(plan);
    const scheduler = {
      refreshPlan: async () => ({ ok: false, slug: 'factory', error: 'auth failed' }),
    };
    const app = createServer(store, scheduler as never, { port: 9291, plans: [plan] });
    const response = await app.request('http://localhost/api/browser-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'factory',
        browser: 'comet',
        cookies: [{ name: 'session', value: 'browser-session' }],
      }),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as { ok?: boolean }).ok).toBe(false);
    clearFactoryBrowserSession();
  });
});
