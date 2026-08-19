import { describe, expect, test } from 'bun:test';
import {
  kimiAdapter,
  normalizeKimi,
  normalizeKimiMonthly,
  acceptKimiBrowserCookies,
  readKimiAuthToken,
  shouldRefreshCliToken,
} from '../src/adapters/kimi.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { AdapterError } from '../src/types.ts';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

describe('normalizeKimi', () => {
  test('kimi.md 样例：weekly(usage) + 5h(limits[0].detail)，字符串值转数字', () => {
    const raw = {
      usage: {
        limit: '2048',
        used: '214',
        remaining: '1834',
        resetTime: '2026-01-09T15:23:13.716839300Z',
      },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: {
            limit: '200',
            used: '139',
            remaining: '61',
            resetTime: '2026-01-06T13:33:02.717479433Z',
          },
        },
      ],
    };
    const windows = normalizeKimi(raw);
    expect(windows).toHaveLength(2);
    const weekly = windows.find((w) => w.window === 'weekly')!;
    expect(weekly.used).toBe(214);
    expect(weekly.total).toBe(2048);
    expect(weekly.percentage).toBeCloseTo(10.449, 1);
    expect(weekly.resetAt).toBe(Date.parse('2026-01-09T15:23:13.716Z'));
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.used).toBe(139);
    expect(five.total).toBe(200);
    expect(five.percentage).toBe(69.5);
  });

  test('实测（2026-08-18）：5h detail 只有 limit+remaining（无 used）→ 用 remaining 反推', () => {
    const raw = {
      usage: null,
      limits: [
        {
          window: { duration: 300 },
          detail: {
            limit: '100',
            remaining: '3',
            resetTime: '2026-08-18T09:03:40Z',
          },
        },
      ],
    };
    const windows = normalizeKimi(raw);
    expect(windows).toHaveLength(1);
    const five = windows[0]!;
    expect(five.window).toBe('rolling_5h');
    expect(five.used).toBe(97);
    expect(five.total).toBe(100);
    expect(five.percentage).toBe(97);
    expect(five.resetAt).toBe(Date.parse('2026-08-18T09:03:40Z'));
  });

  test('数字类型值也能解析', () => {
    const raw = {
      usage: { limit: 1024, used: 512, resetTime: '2026-01-09T00:00:00Z' },
      limits: [],
    };
    const windows = normalizeKimi(raw);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.percentage).toBe(50);
  });

  test('空响应 → parse 错误', () => {
    expect(() => normalizeKimi({})).toThrow(AdapterError);
    expect(() => normalizeKimi(null)).toThrow(AdapterError);
  });
});

describe('normalizeKimiMonthly（GetSubscriptionStats → subscriptionBalance）', () => {
  test('amountUsedRatio(0-1) + expireTime → Month 窗口（×100）', () => {
    const w = normalizeKimiMonthly({
      subscriptionBalance: {
        feature: 'FEATURE_OMNI',
        type: 'SUBSCRIPTION',
        amountUsedRatio: 0.42,
        expireTime: '2026-09-01T00:00:00Z',
      },
    });
    expect(w).not.toBeNull();
    expect(w!.window).toBe('monthly');
    expect(w!.label).toBe('Month');
    expect(w!.percentage).toBeCloseTo(42, 5);
    expect(w!.resetAt).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(w!.note).toContain('Total usage');
  });

  test('amountUsedRatio 已为百分制（>1.5）→ 不再 ×100', () => {
    const w = normalizeKimiMonthly({ subscriptionBalance: { amountUsedRatio: 42 } });
    expect(w!.percentage).toBe(42);
  });

  test('超界钳制：ratio > 1 或负值 → 0-100', () => {
    expect(normalizeKimiMonthly({ subscriptionBalance: { amountUsedRatio: 1.2 } })!.percentage).toBe(100);
    expect(normalizeKimiMonthly({ subscriptionBalance: { amountUsedRatio: -0.3 } })!.percentage).toBe(0);
  });

  test('非 OMNI 或非 SUBSCRIPTION 订阅池 → null（Code 专属池会重复周额度）', () => {
    expect(
      normalizeKimiMonthly({ subscriptionBalance: { feature: 'FEATURE_CODING', amountUsedRatio: 0.5 } }),
    ).toBeNull();
    expect(normalizeKimiMonthly({ subscriptionBalance: { type: 'CREDIT', amountUsedRatio: 0.5 } })).toBeNull();
  });

  test('无 subscriptionBalance / 非对象响应 → null', () => {
    expect(normalizeKimiMonthly({})).toBeNull();
    expect(normalizeKimiMonthly({ data: {} })).toBeNull();
    expect(normalizeKimiMonthly(null)).toBeNull();
    expect(normalizeKimiMonthly('x')).toBeNull();
  });
});

describe('shouldRefreshCliToken（默认自动刷新，KIMI_USE_REFRESH=0 可关闭）', () => {
  const now = Date.now();
  test('开启且过期 → true', () => {
    const cli = { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(now / 1000) - 100 };
    expect(shouldRefreshCliToken(cli, now, true)).toBe(true);
  });
  test('未启用 → false；token 仍有效 → false', () => {
    const cli = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Math.floor(now / 1000) + 600,
    };
    expect(shouldRefreshCliToken(cli, now, false)).toBe(false);
    expect(shouldRefreshCliToken(cli, now, true)).toBe(false);
  });
  test('无 refresh_token → false', () => {
    expect(shouldRefreshCliToken({ access_token: 'a' }, now, true)).toBe(false);
    expect(shouldRefreshCliToken(null, now, true)).toBe(false);
  });

  test('没有 access_token 但有 refresh_token 且已开启 → true', () => {
    expect(shouldRefreshCliToken({ refresh_token: 'r' }, now, true)).toBe(true);
  });
});

describe('Kimi credential priority', () => {
  test('explicit browser selection does not fall back to stale Kimi Desktop cookies', async () => {
    const root = await Bun.$`mktemp -d`.text();
    const home = root.trim();
    const cookieDb = join(home, 'kimi-desktop', 'Default', 'Cookies');
    await mkdir(join(home, 'kimi-desktop', 'Default'), { recursive: true });
    const db = new Database(cookieDb);
    db.run('CREATE TABLE cookies (name TEXT, host_key TEXT, value TEXT, encrypted_value BLOB)');
    db.query('INSERT INTO cookies (name, host_key, value, encrypted_value) VALUES (?, ?, ?, ?)').run(
      'kimi-auth',
      '.kimi.com',
      'stale-desktop-cookie',
      new Uint8Array(),
    );
    db.close();

    const previousDb = process.env.KIMI_AUTH_COOKIE_DB;
    process.env.KIMI_AUTH_COOKIE_DB = cookieDb;
    const readWithDesktopControl = readKimiAuthToken as unknown as (
      planSlug: string,
      allowCookieFallback: boolean,
      allowDesktopFallback: boolean,
    ) => { token: string; source: string } | null;
    try {
      expect(readWithDesktopControl('kimi-explicit-safari', false, false)).toBeNull();
      expect(readWithDesktopControl('kimi-explicit-safari', true, true)?.token).toBe('stale-desktop-cookie');
    } finally {
      if (previousDb == null) delete process.env.KIMI_AUTH_COOKIE_DB;
      else process.env.KIMI_AUTH_COOKIE_DB = previousDb;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });

  test('native browser payload uses the first kimi-auth cookie like CodexBar', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const makeToken = (exp: number) =>
      `${header}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.test`;
    const planSlug = 'kimi-cookie-test';
    const first = makeToken(Math.floor(Date.now() / 1000) - 60);
    expect(
      acceptKimiBrowserCookies(
        [
          { name: 'kimi-auth', value: first },
          { name: 'other', value: 'ignored' },
          { name: 'kimi-auth', value: makeToken(Math.floor(Date.now() / 1000) + 3600) },
        ],
        'Safari (native)',
        planSlug,
      ),
    ).toBe(true);
    expect(readKimiAuthToken(planSlug, false)?.source).toBe('Safari (native)');
    expect(readKimiAuthToken(planSlug, false)?.token).toBe(first);
  });

  test('native browser payload follows CodexBar and does not reject a cookie by JWT exp', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const expired = `${header}.${Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    ).toString('base64url')}.expired`;
    const planSlug = 'kimi-cookie-expiry-test';
    expect(acceptKimiBrowserCookies([{ name: 'kimi-auth', value: expired }], 'Safari (native)', planSlug)).toBe(true);
    expect(readKimiAuthToken(planSlug, false)?.token).toBe(expired);
  });

  test('有效 KIMI_AUTH_TOKEN 优先走 web，可取月度限额', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const token = `${header}.${payload}.test`;
    const previous = process.env.KIMI_AUTH_TOKEN;
    process.env.KIMI_AUTH_TOKEN = token;
    try {
      const plan = DEFAULT_PLANS.find((p) => p.slug === 'kimi')!;
      const credential = await kimiAdapter.detectCredentials({
        plan,
        now: Date.now,
        log: () => {},
      });
      expect(credential?.source).toBe('web');
      expect(credential?.cookie).toBe(token);
    } finally {
      if (previous == null) delete process.env.KIMI_AUTH_TOKEN;
      else process.env.KIMI_AUTH_TOKEN = previous;
    }
  });
});

describe('Kimi OAuth refresh', () => {
  test('401 refreshes the same kimi-code store and persists rotated tokens', async () => {
    const root = await Bun.$`mktemp -d`.text();
    const home = root.trim();
    const credentialsDir = join(home, 'credentials');
    const credentialsPath = join(credentialsDir, 'kimi-code.json');
    await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        access_token: 'stale-access',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        scope: 'kimi-code',
        expires_at: Math.floor(Date.now() / 1000) + 600,
        expires_in: 900,
      }),
      { mode: 0o600 },
    );

    const usageTokens: string[] = [];
    const refreshBodies: URLSearchParams[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/coding/v1/usages') {
          usageTokens.push(request.headers.get('authorization') ?? '');
          if (request.headers.get('authorization') === 'Bearer stale-access') {
            return new Response('unauthorized', { status: 401 });
          }
          return Response.json({
            usage: { limit: '100', used: '42', remaining: '58' },
            limits: [],
          });
        }
        if (url.pathname === '/api/oauth/token') {
          refreshBodies.push(new URLSearchParams(await request.text()));
          return Response.json({
            access_token: 'fresh-access',
            refresh_token: 'refresh-2',
            token_type: 'Bearer',
            scope: 'kimi-code',
            expires_in: 900,
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const envKeys = ['KIMI_CODE_HOME', 'KIMI_CODE_CREDENTIALS', 'KIMI_CODE_BASE_URL', 'KIMI_CODE_OAUTH_HOST'];
    const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
    process.env.KIMI_CODE_HOME = home;
    delete process.env.KIMI_CODE_CREDENTIALS;
    process.env.KIMI_CODE_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.KIMI_CODE_OAUTH_HOST = `http://127.0.0.1:${server.port}`;
    try {
      const plan = {
        ...DEFAULT_PLANS.find((candidate) => candidate.slug === 'kimi')!,
        extra: { browser: 'safari' },
      };
      const windows = await kimiAdapter.fetchUsage(
        {
          plan,
          now: Date.now,
          log: () => {},
        },
        { kind: 'bearer', value: 'stale-access', source: 'auto' },
      );
      expect(windows.find((window) => window.window === 'weekly')?.percentage).toBe(42);
      expect(usageTokens).toEqual(['Bearer stale-access', 'Bearer fresh-access']);
      expect(refreshBodies).toHaveLength(1);
      expect(refreshBodies[0]?.get('grant_type')).toBe('refresh_token');
      expect(refreshBodies[0]?.get('refresh_token')).toBe('refresh-1');
      expect(refreshBodies[0]?.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');

      const saved = JSON.parse(await readFile(credentialsPath, 'utf8')) as {
        access_token: string;
        refresh_token: string;
      };
      expect(saved.access_token).toBe('fresh-access');
      expect(saved.refresh_token).toBe('refresh-2');
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    } finally {
      for (const key of envKeys) {
        const value = previous.get(key);
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      server.stop(true);
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });
});

describe('Kimi CodexBar web request compatibility', () => {
  test('does not reuse the CLI device_id for a browser cookie session', async () => {
    const root = await Bun.$`mktemp -d`.text();
    const home = root.trim();
    await writeFile(join(home, 'device_id'), 'cli-device-id');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const token = `${header}.${Buffer.from(JSON.stringify({ ssid: 'browser-session' })).toString('base64url')}.sig`;
    const requests: Request[] = [];
    const previousFetch = globalThis.fetch;
    const previousHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
    globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith('/GetUsages')) {
        return Response.json({
          usages: [
            {
              scope: 'FEATURE_CODING',
              detail: { limit: '100', used: '20', remaining: '80' },
              limits: [],
            },
          ],
        });
      }
      return Response.json({
        subscriptionBalance: {
          feature: 'FEATURE_OMNI',
          type: 'SUBSCRIPTION',
          amountUsedRatio: 0.1,
        },
      });
    }) as typeof fetch;
    try {
      const windows = await kimiAdapter.fetchUsage(
        {
          plan: { ...DEFAULT_PLANS.find((plan) => plan.slug === 'kimi')!, extra: {} },
          now: Date.now,
          log: () => {},
        },
        { kind: 'bearer', value: token, source: 'web', cookie: `kimi-auth=${token}; kimi-locale=en-US` },
      );
      expect(windows.find((window) => window.window === 'weekly')?.percentage).toBe(20);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.headers.get('x-msh-device-id')).toBeNull();
      expect(requests[0]?.headers.get('x-msh-session-id')).toBe('browser-session');
      expect(requests[0]?.headers.get('Cookie')).toContain('kimi-locale=en-US');
      expect(requests[1]?.headers.get('x-msh-device-id')).toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousHome == null) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousHome;
      await Bun.$`rm -rf ${home}`.quiet();
    }
  });
});
