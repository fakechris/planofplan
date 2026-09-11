import { afterEach, describe, expect, test } from 'bun:test';
import { fetchQuota, parseRateLimitResetMs, parseRetryAfterMs } from '../src/adapters/http.ts';
import { AdapterError } from '../src/types.ts';

// fetchQuota 的睡眠全部注入:不真实等待,只记录
function harness(responses: Array<() => Response>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return next();
  }) as typeof fetch;
  return {
    calls,
    sleeps,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

afterEach(() => {
  // harness.restore() 由各用例 finally 兜底;这里防御性恢复
});

describe('parseRetryAfterMs', () => {
  test('秒数形态与 HTTP 日期形态', () => {
    const now = Date.now();
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs('1.5', now)).toBe(1500);
    expect(parseRetryAfterMs(new Date(now + 120_000).toUTCString(), now)).toBeGreaterThan(119_000);
    expect(parseRetryAfterMs(new Date(now + 120_000).toUTCString(), now)).toBeLessThan(121_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('not-a-date', now)).toBeNull();
  });
});

describe('parseRateLimitResetMs', () => {
  test('epoch 秒(GitHub 风格)/ms 形态/已过期为 0/非法输入', () => {
    const now = Date.now();
    expect(parseRateLimitResetMs(String(Math.floor(now / 1000) + 300), now)).toBeGreaterThan(299_000);
    expect(parseRateLimitResetMs(String(Math.floor(now / 1000) + 300), now)).toBeLessThan(301_000);
    expect(parseRateLimitResetMs(String(now + 5_000), now)).toBeGreaterThan(4_000);
    expect(parseRateLimitResetMs(String(Math.floor(now / 1000) - 10), now)).toBe(0);
    expect(parseRateLimitResetMs('soon')).toBeNull();
    expect(parseRateLimitResetMs(null)).toBeNull();
  });
});

describe('fetchQuota', () => {
  test('短等待 429 就地重试后成功,睡眠用了服务端提示', async () => {
    const h = harness([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
      () => Response.json({ ok: true }),
    ]);
    try {
      const res = await fetchQuota('https://quota.example/usage', undefined, { sleep: async (ms) => { h.sleeps.push(ms); } });
      expect(res.status).toBe(200);
      expect(h.calls).toHaveLength(2);
      expect(h.sleeps[0]).toBe(2_000);
    } finally {
      h.restore();
    }
  });

  test('长等待 429 不空转:抛 AdapterError 并带 retryAfterSec', async () => {
    const h = harness([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '600' } }),
    ]);
    try {
      await fetchQuota('https://quota.example/usage', undefined, { sleep: async () => {} });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError);
      const err = e as AdapterError;
      expect(err.kind).toBe('api');
      expect(err.retryAfterSec).toBe(600);
      expect(err.message).toContain('限流');
      expect(err.message).toContain('10 分钟');
    } finally {
      h.restore();
    }
  });

  test('x-ratelimit-reset(epoch 秒)优先于指数退避并封顶 10 分钟', async () => {
    const now = Date.now();
    const far = Math.floor(now / 1000) + 3_600; // 1 小时后 → 应封顶 600s
    const h = harness([
      () => new Response('rl', { status: 429, headers: { 'x-ratelimit-reset': String(far) } }),
    ]);
    try {
      await fetchQuota('https://q.example/u', undefined, { sleep: async () => {}, now: () => now });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AdapterError).retryAfterSec).toBe(600);
      expect(h.calls).toHaveLength(1); // 长等待不就地重试
    } finally {
      h.restore();
    }
  });

  test('重试耗尽后的 5xx 原样返回 Response,交还 adapter 处理', async () => {
    const h = harness([
      () => new Response('boom', { status: 503 }),
      () => new Response('boom', { status: 503 }),
      () => new Response('boom', { status: 503 }),
    ]);
    try {
      const res = await fetchQuota('https://q.example/u', undefined, { sleep: async () => {} });
      expect(res.status).toBe(503);
      expect(h.calls).toHaveLength(3);
    } finally {
      h.restore();
    }
  });

  test('401/403/普通 4xx 直接透传,不重试', async () => {
    const h = harness([() => new Response('denied', { status: 401 })]);
    try {
      const res = await fetchQuota('https://q.example/u', undefined, { sleep: async () => {} });
      expect(res.status).toBe(401);
      expect(h.calls).toHaveLength(1);
    } finally {
      h.restore();
    }
  });

  test('网络错误只就地补一次,再失败抛 network', async () => {
    const h = harness([
      () => { throw new TypeError('fetch failed'); },
      () => { throw new TypeError('fetch failed'); },
    ]);
    try {
      await fetchQuota('https://q.example/u', undefined, { sleep: async () => {} });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AdapterError).kind).toBe('network');
      expect(h.calls).toHaveLength(2);
    } finally {
      h.restore();
    }
  });
});
