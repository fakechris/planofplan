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

  test('空响应 → parse 错误', () => {
    expect(() => normalizeClaude({})).toThrow(AdapterError);
    expect(() => normalizeClaude(null)).toThrow(AdapterError);
  });
});

describe('Claude OAuth lifecycle', () => {
  test('401 refreshes with the rotated token and persists it before retrying usage', async () => {
    const previousFetch = globalThis.fetch;
    const previousTokenUrl = process.env.CLAUDE_OAUTH_TOKEN_URL;
    const requests: Array<{ url: string; authorization?: string; body?: string }> = [];
    const persisted: { value: { accessToken: string; refreshToken: string; expiresAt: number } | null } = {
      value: null,
    };

    process.env.CLAUDE_OAUTH_TOKEN_URL = 'http://claude.test/oauth/token';
    globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      requests.push({
        url: request.url,
        authorization: request.headers.get('authorization') ?? undefined,
        body: request.method === 'POST' ? await request.text() : undefined,
      });
      if (request.url.endsWith('/oauth/token')) {
        return Response.json({
          access_token: 'fresh-access',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (request.headers.get('authorization') === 'Bearer stale-access') {
        return new Response('expired', { status: 401 });
      }
      return Response.json({
        five_hour: { utilization: 12 },
        seven_day: { utilization: 34 },
      });
    }) as typeof fetch;

    try {
      const credential = {
        kind: 'bearer',
        value: 'stale-access',
        source: 'auto',
        refreshToken: 'refresh-1',
        persist: async (token: { accessToken: string; refreshToken: string; expiresAt: number }) => {
          persisted.value = token;
        },
      } as unknown as Credential;
      const ctx = {
        plan: { slug: 'claude', name: 'Claude', adapter: 'claude', enabled: true, pollIntervalSec: 300, extra: {} },
        now: Date.now,
        log: () => {},
      } as AdapterContext;

      const { claudeAdapter } = await import('../src/adapters/claude.ts');
      const windows = await claudeAdapter.fetchUsage(ctx, credential);

      expect(windows.find((window) => window.window === 'weekly')?.percentage).toBe(34);
      expect(requests.map((request) => request.authorization)).toEqual([
        'Bearer stale-access',
        undefined,
        'Bearer fresh-access',
      ]);
      expect(new URLSearchParams(requests[1]?.body).get('grant_type')).toBe('refresh_token');
      expect(new URLSearchParams(requests[1]?.body).get('refresh_token')).toBe('refresh-1');
      expect(new URLSearchParams(requests[1]?.body).get('client_id')).toBe(
        '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      );
      expect(persisted.value).toEqual({
        accessToken: 'fresh-access',
        refreshToken: 'refresh-2',
        expiresAt: expect.any(Number),
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousTokenUrl == null) delete process.env.CLAUDE_OAUTH_TOKEN_URL;
      else process.env.CLAUDE_OAUTH_TOKEN_URL = previousTokenUrl;
    }
  });
});
