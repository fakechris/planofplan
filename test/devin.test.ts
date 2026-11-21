import { describe, expect, test } from 'bun:test';
import {
  devinAdapter,
  extractApiKey,
  normalizeDevinQuota,
  normalizeMembershipOrg,
  readDevinApiKey,
} from '../src/adapters/devin.ts';
import { AdapterError, type AdapterContext, type PlanConfig } from '../src/types.ts';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 2026-11-20 本机 HTTP 缓存实证的响应形状（数值脱敏）。 */
const LIVE_QUOTA = {
  is_quota_plan: true,
  has_quota_allocation: true,
  daily_percentage: 0.0,
  weekly_percentage: 66.0,
  daily_reset_at: '2026-11-21T00:00:00-08:00',
  weekly_reset_at: '2026-11-22T00:00:00-08:00',
  overage_balance: 21.24924003,
  hide_daily_quota: true,
};

const LIVE_MEMBERSHIP = {
  org: { org_id: 'org-25a8f0c4a6c0405bb69cc974050ab28a', display_name: 'fakechris' },
  user: { id: 'google-oauth2|107707536815486852470', name: 'Chris Song' },
};

function makeCtx(extra: Record<string, string> = {}): AdapterContext {
  const plan: PlanConfig = {
    slug: 'devin',
    name: 'Devin',
    adapter: 'devin',
    enabled: true,
    pollIntervalSec: 300,
    credRef: null,
    extra,
  };
  return { plan, now: () => 1_700_000_000_000, log: () => {} };
}

describe('normalizeDevinQuota', () => {
  test('quota plan + hide_daily：weekly + overage 两窗口，无 daily，ACU 语义零捏造', () => {
    const windows = normalizeDevinQuota(LIVE_QUOTA);
    expect(windows).toHaveLength(2);

    const weekly = windows[0]!;
    expect(weekly.window).toBe('weekly');
    expect(weekly.label).toBe('Week');
    expect(weekly.unit).toBe('percent');
    expect(weekly.percentage).toBe(66);
    // used/total 是 token/ACU 明细——端点不提供，必须 null（零捏造）
    expect(weekly.used).toBeNull();
    expect(weekly.total).toBeNull();
    expect(weekly.resetAt).toBe(Date.parse('2026-11-22T00:00:00-08:00'));

    const overage = windows[1]!;
    expect(overage.window).toBe('credits_period');
    expect(overage.unit).toBe('USD');
    expect(overage.used).toBe(21.25);
    expect(overage.total).toBe(21.25);
    expect(overage.percentage).toBeNull();
    expect(overage.note).toContain('On-demand');
  });

  test('hide_daily_quota=false：补 daily 窗口', () => {
    const windows = normalizeDevinQuota({ ...LIVE_QUOTA, hide_daily_quota: false, daily_percentage: 12.5 });
    expect(windows).toHaveLength(3);
    const daily = windows[1]!;
    expect(daily.window).toBe('daily');
    expect(daily.percentage).toBe(12.5);
    expect(daily.resetAt).toBe(Date.parse('2026-11-21T00:00:00-08:00'));
  });

  test('非 quota plan：只有 overage，不虚构周/日窗口', () => {
    const windows = normalizeDevinQuota({ ...LIVE_QUOTA, is_quota_plan: false });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.window).toBe('credits_period');
  });

  test('overage 缺失：null + 未知 note，不虚构 $0', () => {
    const windows = normalizeDevinQuota({ is_quota_plan: true, weekly_percentage: 50, hide_daily_quota: true });
    const overage = windows.at(-1)!;
    expect(overage.used).toBeNull();
    expect(overage.total).toBeNull();
    expect(overage.note).toContain('未知');
  });

  test('百分比越界 clamp 到 100（clampPct）', () => {
    const windows = normalizeDevinQuota({ ...LIVE_QUOTA, weekly_percentage: 150 });
    expect(windows[0]!.percentage).toBe(100);
  });

  test('weekly_percentage 缺失：percentage=null，窗口保留', () => {
    const windows = normalizeDevinQuota({ is_quota_plan: true, hide_daily_quota: true });
    expect(windows[0]!.percentage).toBeNull();
  });

  test('非对象 → AdapterError(parse)', () => {
    expect(() => normalizeDevinQuota(null)).toThrow(AdapterError);
    expect(() => normalizeDevinQuota('x')).toThrow(AdapterError);
  });
});

describe('normalizeMembershipOrg', () => {
  test('实测形状 → org_id', () => {
    expect(normalizeMembershipOrg(LIVE_MEMBERSHIP)).toBe('org-25a8f0c4a6c0405bb69cc974050ab28a');
  });
  test('缺 org / 空 id / 非对象 → null', () => {
    expect(normalizeMembershipOrg({})).toBeNull();
    expect(normalizeMembershipOrg({ org: { org_id: '  ' } })).toBeNull();
    expect(normalizeMembershipOrg(null)).toBeNull();
  });
});

describe('extractApiKey', () => {
  test('JSON apiKey 原样保留 devin-session-token$ 前缀', () => {
    expect(extractApiKey('{"apiKey":"devin-session-token$eyJhbGciOiJ.fake.sig"}')).toBe(
      'devin-session-token$eyJhbGciOiJ.fake.sig',
    );
  });
  test('无 apiKey / 非 JSON / 空串 → null', () => {
    expect(extractApiKey('{"apiServerUrl":"https://x"}')).toBeNull();
    expect(extractApiKey('not json')).toBeNull();
    expect(extractApiKey('{"apiKey":""}')).toBeNull();
  });
});

describe('readDevinApiKey（临时 state.vscdb）', () => {
  test('写入 windsurfAuthStatus 行 → 读出 token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devin-test-'));
    try {
      const dbPath = join(dir, 'state.vscdb');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      db.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'windsurfAuthStatus',
        '{"apiKey":"devin-session-token$tok"}',
      );
      db.close();
      expect(readDevinApiKey(dbPath)).toBe('devin-session-token$tok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('未安装（路径不存在）→ null；未登录（无该键）→ null', async () => {
    expect(readDevinApiKey(join(tmpdir(), 'definitely-missing-devin', 'state.vscdb'))).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), 'devin-test-'));
    try {
      const dbPath = join(dir, 'state.vscdb');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      db.close();
      expect(readDevinApiKey(dbPath)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('devinAdapter.detectCredentials', () => {
  test('env DEVIN_SESSION_TOKEN 优先；清理后要么 auto 要么 null（不误报）', async () => {
    const prev = process.env.DEVIN_SESSION_TOKEN;
    try {
      process.env.DEVIN_SESSION_TOKEN = 'devin-session-token$from-env';
      const cred = await devinAdapter.detectCredentials(makeCtx());
      expect(cred?.source).toBe('env');
      expect(cred?.value).toBe('devin-session-token$from-env');
      expect(cred?.kind).toBe('bearer');

      delete process.env.DEVIN_SESSION_TOKEN;
      const auto = await devinAdapter.detectCredentials(makeCtx());
      if (auto != null) {
        // 本机装了 Devin 时走 auto；CI/未装机器上应为 null——两种都合法
        expect(auto.source).toBe('auto');
        expect(auto.value).toContain('devin-session-token$');
      }
    } finally {
      if (prev === undefined) delete process.env.DEVIN_SESSION_TOKEN;
      else process.env.DEVIN_SESSION_TOKEN = prev;
    }
  });

  test('credentialHint 引导文案存在', () => {
    expect(devinAdapter.credentialHint).toContain('Devin');
  });
});

describe('devinAdapter.fetchUsage', () => {
  const previousFetch = globalThis.fetch;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  test('extra.orgId 静态指定：只打 quota/usage 一个请求', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(LIVE_QUOTA);
    }) as unknown as typeof fetch;
    try {
      const windows = await devinAdapter.fetchUsage(
        makeCtx({ orgId: 'org-static123' }),
        { kind: 'bearer', value: 'devin-session-token$t', source: 'manual' },
      );
      expect(urls).toEqual(['https://app.devin.ai/api/org-static123/billing/quota/usage']);
      expect(windows).toHaveLength(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('无 orgId：先 membership 发现 org，再 quota/usage；Bearer 带全串 token', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get('authorization') });
      if (url.endsWith('/api/users/current-membership')) return jsonResponse(LIVE_MEMBERSHIP);
      return jsonResponse(LIVE_QUOTA);
    }) as unknown as typeof fetch;
    try {
      await devinAdapter.fetchUsage(
        makeCtx(),
        { kind: 'bearer', value: 'devin-session-token$t', source: 'auto' },
      );
      expect(seen).toHaveLength(2);
      expect(seen[0]!.url).toBe('https://app.devin.ai/api/users/current-membership');
      expect(seen[1]!.url).toBe('https://app.devin.ai/api/org-25a8f0c4a6c0405bb69cc974050ab28a/billing/quota/usage');
      expect(seen.every((r) => r.auth === 'Bearer devin-session-token$t')).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('token 失效（401）→ AdapterError(auth)', async () => {
    globalThis.fetch = (async () => jsonResponse({ detail: 'unauthorized' }, 401)) as unknown as typeof fetch;
    try {
      await expect(
        devinAdapter.fetchUsage(
          makeCtx({ orgId: 'org-x' }),
          { kind: 'bearer', value: 'stale', source: 'auto' },
        ),
      ).rejects.toThrow(AdapterError);
      await expect(
        devinAdapter.fetchUsage(
          makeCtx({ orgId: 'org-x' }),
          { kind: 'bearer', value: 'stale', source: 'auto' },
        ),
      ).rejects.toMatchObject({ kind: 'auth' });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('membership 响应缺 org.org_id → AdapterError(parse)', async () => {
    globalThis.fetch = (async () => jsonResponse({ user: {} })) as unknown as typeof fetch;
    try {
      await expect(
        devinAdapter.fetchUsage(
          makeCtx(),
          { kind: 'bearer', value: 't', source: 'auto' },
        ),
      ).rejects.toMatchObject({ kind: 'parse' });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('quota/usage 服务端 5xx → AdapterError(api)', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('current-membership')) return jsonResponse(LIVE_MEMBERSHIP);
      // retry-after: 0 让 fetchQuota 的重试零等待发生，测试不等指数退避
      return new Response('{}', { status: 503, headers: { 'retry-after': '0' } });
    }) as unknown as typeof fetch;
    try {
      await expect(
        devinAdapter.fetchUsage(
          makeCtx(),
          { kind: 'bearer', value: 't', source: 'auto' },
        ),
      ).rejects.toMatchObject({ kind: 'api' });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
