import { describe, expect, test } from 'bun:test';
import { normalizeFactoryBillingLimits, normalizeFactoryUsage } from '../src/adapters/factory.ts';
import { factoryAdapter } from '../src/adapters/factory.ts';
import { acceptFactoryBrowserCookies, clearFactoryBrowserSession, getFactoryBrowserSession } from '../src/factory-session.ts';

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
    )).toBe(true);

    const requests: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
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
      });
      expect(requests[1]!.authorization).toBe('Bearer workos-access-token');
    } finally {
      globalThis.fetch = originalFetch;
      clearFactoryBrowserSession();
    }
  });
});
