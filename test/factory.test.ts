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

  test('accepts only recognized Factory session cookies and keeps them in memory', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    try {
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
    } finally {
      clearFactoryBrowserSession();
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('uses a browser WorkOS refresh token before Factory billing calls', async () => {
    // 轮换持久化会写 factory-session.json，必须隔离 PLANOFPPLAN_HOME，
    // 否则测试夹具会覆盖真实 daemon 的会话链。
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      cookie: string | null;
      body: string;
    }> = [];
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
      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'browser-session' }],
        'Comet',
        { refreshToken: 'workos-refresh-token' },
        'org_123',
      )).toBe(true);
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
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('falls back to Factory cookies when the browser WorkOS refresh token is rejected', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string | null; cookie: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization'), cookie: headers.get('cookie') });
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
      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'browser-session' }],
        'Comet',
        { refreshToken: 'stale-workos-refresh-token' },
      )).toBe(true);
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
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
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

  test('persists rotations restored from disk so a second restart survives', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    try {
      // 第一次导入（menubar native 读取）并轮换。
      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'browser-session' }],
        'Comet (native)',
        { refreshToken: 'browser-refresh-token' },
      )).toBe(true);
      updateFactoryWorkOSSession({
        accessToken: 'rotated-access-token',
        refreshToken: 'first-rotated-token',
      });

      // 真实 daemon 重启：进程内存清空，仅从 factory-session.json 恢复（source='persisted'）。
      clearFactoryBrowserSession();
      const restored = getFactoryBrowserSession();
      expect(restored).toMatchObject({ source: 'persisted', workosRefreshToken: 'first-rotated-token' });

      // 重启后的第一次兑换必须把新 token 回写文件，否则再次重启就是已消耗的死 token。
      updateFactoryWorkOSSession({
        accessToken: 'rotated-access-token-2',
        refreshToken: 'second-rotated-token',
      });
      clearFactoryBrowserSession();
      expect(getFactoryBrowserSession()).toMatchObject({
        source: 'persisted',
        workosRefreshToken: 'second-rotated-token',
      });
    } finally {
      clearFactoryBrowserSession();
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('clears the in-memory browser session when the whole chain is rejected', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url === 'https://api.workos.com/user_management/authenticate') {
        return new Response('invalid_grant', { status: 400 });
      }
      if (url === 'https://api.factory.ai/api/billing/limits') {
        return new Response('expired', { status: 401 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      clearFactoryBrowserSession();
      acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'dead-session' }],
        'Comet (native)',
        { refreshToken: 'dead-refresh-token' },
      );
      expect(getFactoryBrowserSession()).not.toBeNull();
      await expect(factoryAdapter.fetchUsage({} as never, {
        kind: 'bearer',
        value: '',
        cookie: 'session=dead-session',
        refreshToken: 'dead-refresh-token',
        source: 'browser:Comet (native)',
      })).rejects.toThrow();
      // 整链被拒后内存副本必须丢弃，下次 detectCredentials 重新读磁盘上的
      // factory-session.json（外部导入的新链无需重启 daemon 即可生效）。
      expect(getFactoryBrowserSession()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      clearFactoryBrowserSession();
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('keeps the persisted refresh token as fallback after cookie rotation on the same account', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    try {
      function fakeJwt(sub: string): string {
        const part = (value: unknown) =>
          Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${part({ alg: 'HS256' })}.${part({ sub })}.signature`;
      }
      clearFactoryBrowserSession();
      // 第一次导入并轮换，持久化 userSub 锚点。
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'session-one' }],
        'Comet (native)',
        { refreshToken: 'browser-refresh-token' },
      )).toBe(true);
      updateFactoryWorkOSSession({
        accessToken: fakeJwt('user_1'),
        refreshToken: 'rotated-refresh-token',
      });

      // Cookie 已轮换（fingerprint 失配），但 access-token cookie 仍是同一账号：
      // 浏览器 localStorage 的旧 token 已被上次兑换消耗，持久化轮换链必须保留为兜底。
      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [
          { name: 'session', value: 'session-two' },
          { name: 'access-token', value: fakeJwt('user_1') },
        ],
        'Comet (native)',
        { refreshToken: 'stale-browser-token' },
      )).toBe(true);
      expect(getFactoryBrowserSession()).toMatchObject({
        workosRefreshToken: 'stale-browser-token',
        workosRefreshTokenFallback: 'rotated-refresh-token',
      });
    } finally {
      clearFactoryBrowserSession();
      if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
      else process.env.PLANOFPPLAN_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('discards the persisted refresh token when the browser account changed', async () => {
    const home = await Bun.$`mktemp -d`.text();
    const previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home.trim();
    try {
      function fakeJwt(sub: string): string {
        const part = (value: unknown) =>
          Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${part({ alg: 'HS256' })}.${part({ sub })}.signature`;
      }
      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [{ name: 'session', value: 'session-one' }],
        'Comet (native)',
        { refreshToken: 'browser-refresh-token' },
      )).toBe(true);
      updateFactoryWorkOSSession({
        accessToken: fakeJwt('user_1'),
        refreshToken: 'rotated-refresh-token',
      });

      clearFactoryBrowserSession();
      expect(acceptFactoryBrowserCookies(
        [
          { name: 'session', value: 'session-two' },
          { name: 'access-token', value: fakeJwt('user_2') },
        ],
        'Comet (native)',
        { refreshToken: 'new-account-browser-token' },
      )).toBe(true);
      expect(getFactoryBrowserSession()).toMatchObject({
        workosRefreshToken: 'new-account-browser-token',
        workosRefreshTokenFallback: null,
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
