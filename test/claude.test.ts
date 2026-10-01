import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { normalizeClaude } from '../src/adapters/claude.ts';
import { AdapterError, type AdapterContext, type Credential } from '../src/types.ts';

describe('normalizeClaude', () => {
  test('本机实测响应形状：five_hour/seven_day utilization', () => {
    const raw = {
      five_hour: {
        utilization: 7,
        resets_at: '2026-08-18T05:00:00.000Z',
        limit_dollars: null,
        used_dollars: null,
      },
      seven_day: {
        utilization: 18,
        resets_at: '2026-08-25T00:00:00.000Z',
        limit_dollars: null,
        used_dollars: null,
      },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    };
    const windows = normalizeClaude(raw);
    expect(windows).toHaveLength(2);
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.percentage).toBe(7);
    expect(five.resetAt).toBe(Date.parse('2026-08-18T05:00:00.000Z'));
    const week = windows.find((w) => w.window === 'weekly')!;
    expect(week.percentage).toBe(18);
    expect(week.resetAt).toBe(Date.parse('2026-08-25T00:00:00.000Z'));
  });

  test('extra_usage 启用且有额定时渲染月度窗口', () => {
    const raw = {
      five_hour: { utilization: 3 },
      seven_day: { utilization: 9 },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100000,
        used_credits: 25000,
        utilization: 25,
      },
    };
    const windows = normalizeClaude(raw);
    expect(windows).toHaveLength(3);
    const month = windows.find((w) => w.window === 'monthly')!;
    expect(month.used).toBe(25000);
    expect(month.total).toBe(100000);
    expect(month.percentage).toBe(25);
    expect(month.unit).toBe('usd');
  });

  test('renders model-scoped weekly Fable limits as a separate window', () => {
    const windows = normalizeClaude({
      five_hour: { utilization: 4 },
      seven_day: { utilization: 20 },
      seven_day_fable: {
        utilization: 38,
        resets_at: '2026-08-25T00:00:00.000Z',
      },
    });

    const fable = windows.find((window) => window.window === 'weekly_fable');
    expect(fable).toMatchObject({
      label: 'Fable Week',
      percentage: 38,
      resetAt: Date.parse('2026-08-25T00:00:00.000Z'),
      note: null,
    });
  });

  test('renders grouped model-scoped weekly limits', () => {
    const windows = normalizeClaude({
      five_hour: { utilization: 4 },
      seven_day: { utilization: 20 },
      weekly_scoped: {
        fable: { utilization: 38, resets_at: '2026-08-25T00:00:00.000Z' },
      },
    });

    expect(windows.find((window) => window.window === 'weekly_fable')?.percentage).toBe(38);
  });

  test('renders limits[] weekly_scoped Fable row without duplicating generic windows', () => {
    const windows = normalizeClaude({
      five_hour: { utilization: 52, resets_at: '2026-08-21T11:40:00.000Z' },
      seven_day: { utilization: 19, resets_at: '2026-08-26T21:00:00.000Z' },
      limits: [
        { kind: 'session', percent: 52, resets_at: '2026-08-21T11:40:00.000Z' },
        { kind: 'weekly_all', percent: 19, resets_at: '2026-08-26T21:00:00.000Z' },
        {
          kind: 'weekly_scoped',
          percent: 17,
          resets_at: '2026-08-26T20:59:59.000Z',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    });

    expect(windows).toHaveLength(3);
    expect(windows.find((window) => window.window === 'rolling_5h')?.percentage).toBe(52);
    expect(windows.find((window) => window.window === 'weekly')?.percentage).toBe(19);
    expect(windows.find((window) => window.window === 'weekly_fable')).toMatchObject({
      label: 'Fable Week',
      percentage: 17,
      resetAt: Date.parse('2026-08-26T20:59:59.000Z'),
    });
  });

  test('空响应 → parse 错误', () => {
    expect(() => normalizeClaude({})).toThrow(AdapterError);
    expect(() => normalizeClaude(null)).toThrow(AdapterError);
  });
});

describe('Claude OAuth lifecycle', () => {
  const ctx = {
    plan: { slug: 'claude', name: 'Claude', adapter: 'claude', enabled: true, pollIntervalSec: 300, extra: {} },
    now: Date.now,
    log: () => {},
  } as AdapterContext;

  async function withFetch<T>(
    handler: (request: Request) => Response | Promise<Response>,
    run: (requests: Array<{ url: string; authorization?: string; body?: string }>) => Promise<T>,
  ): Promise<T> {
    const previousFetch = globalThis.fetch;
    const previousTokenUrl = process.env.CLAUDE_OAUTH_TOKEN_URL;
    const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
    process.env.CLAUDE_OAUTH_TOKEN_URL = 'http://claude.test/oauth/token';
    globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requests.push({
        url: request.url,
        authorization: request.headers.get('authorization') ?? undefined,
        body: request.method === 'POST' ? await request.clone().text() : undefined,
      });
      return handler(request);
    }) as typeof fetch;
    try {
      return await run(requests);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTokenUrl == null) delete process.env.CLAUDE_OAUTH_TOKEN_URL;
      else process.env.CLAUDE_OAUTH_TOKEN_URL = previousTokenUrl;
    }
  }

  const usageOrRefresh = (request: Request): Response => {
    if (request.url.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'fresh-access', refresh_token: 'refresh-2', expires_in: 3600 });
    }
    if (request.headers.get('authorization') === 'Bearer stale-access') {
      return new Response('expired', { status: 401 });
    }
    return Response.json({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } });
  };

  test('an env-supplied refresh token renews in memory on 401 and retries usage', async () => {
    await withFetch(usageOrRefresh, async (requests) => {
      const credential = {
        kind: 'bearer',
        value: 'stale-access',
        source: 'env',
        refreshToken: 'refresh-1',
      } as Credential;

      const { claudeAdapter } = await import('../src/adapters/claude.ts');
      const windows = await claudeAdapter.fetchUsage(ctx, credential);

      expect(windows.find((window) => window.window === 'weekly')?.percentage).toBe(34);
      expect(requests.map((request) => request.authorization)).toEqual([
        'Bearer stale-access',
        undefined,
        'Bearer fresh-access',
      ]);
      expect(new URLSearchParams(requests[1]?.body).get('refresh_token')).toBe('refresh-1');
    });
  });

  test("Claude Code's Keychain login is read-only: no refresh token, nothing to write back", async () => {
    const { keychainCredentialFromBlob } = await import('../src/adapters/claude.ts');
    const blob = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'kc-access',
        refreshToken: 'kc-refresh',
        expiresAt: Date.now() + 3_600_000,
        refreshTokenExpiresAt: Date.now() + 86_400_000,
        scopes: ['user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'tier',
      },
    });
    const credential = keychainCredentialFromBlob(blob);
    expect(credential).toMatchObject({ kind: 'bearer', value: 'kc-access', source: 'auto', expiresAt: expect.any(Number) });
    expect(credential?.refreshToken ?? null).toBeNull();
    expect(Object.keys(credential ?? {})).not.toContain('persist');
  });

  test('a rejected Keychain token reports an auth error without asking for a new token', async () => {
    await withFetch(usageOrRefresh, async (requests) => {
      const credential = { kind: 'bearer', value: 'stale-access', source: 'auto' } as Credential;
      const { claudeAdapter } = await import('../src/adapters/claude.ts');
      await expect(claudeAdapter.fetchUsage(ctx, credential)).rejects.toMatchObject({ kind: 'auth' });
      expect(requests.some((request) => request.url.endsWith('/oauth/token'))).toBe(false);
    });
  });

  test('an expired Keychain token is reported stale before any request is made', async () => {
    await withFetch(usageOrRefresh, async (requests) => {
      const credential = {
        kind: 'bearer',
        value: 'stale-access',
        source: 'auto',
        expiresAt: Date.now() - 1_000,
      } as Credential;
      const { claudeAdapter } = await import('../src/adapters/claude.ts');
      await expect(claudeAdapter.fetchUsage(ctx, credential)).rejects.toMatchObject({ kind: 'auth' });
      expect(requests).toHaveLength(0);
    });
  });

  test('src never writes to the Keychain', () => {
    const offenders = [...new Bun.Glob('src/**/*.ts').scanSync('.')].filter((file) =>
      readFileSync(file, 'utf8').includes('add-generic-password'),
    );
    expect(offenders).toEqual([]);
  });
});
