import { describe, expect, test } from 'bun:test';
import {
  applyQuotaProxy,
  fetchQuota,
  normalizeQuotaProxy,
  withQuotaProxy,
} from '../src/adapters/http.ts';
import { Scheduler } from '../src/core.ts';
import { registry } from '../src/adapters/index.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { PlanConfig } from '../src/types.ts';

const PROXY_A = 'http://user:secret@127.0.0.1:7890';
const PROXY_B = 'http://other:pw@10.0.0.2:1080';

describe('normalizeQuotaProxy（INV-2015）', () => {
  test('合法 http/https（含内嵌凭据）原样保留；空/非法/非串 → null', () => {
    expect(normalizeQuotaProxy(PROXY_A)).toBe(PROXY_A);
    expect(normalizeQuotaProxy('  https://p.example.com:8443 ')).toBe('https://p.example.com:8443');
    expect(normalizeQuotaProxy('')).toBeNull();
    expect(normalizeQuotaProxy('   ')).toBeNull();
    expect(normalizeQuotaProxy('socks5://h:1')).toBeNull();
    expect(normalizeQuotaProxy('not a url')).toBeNull();
    expect(normalizeQuotaProxy(null)).toBeNull();
    expect(normalizeQuotaProxy(undefined)).toBeNull();
  });
});

describe('withQuotaProxy → fetchQuota 注入（INV-2015）', () => {
  const previousFetch = globalThis.fetch;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  test('上下文内 fetchQuota 的 fetch 调用携带 init.proxy；上下文外不带', async () => {
    const seen: Array<string | undefined> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit & { proxy?: string }) => {
      seen.push(init?.proxy);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    try {
      await withQuotaProxy(PROXY_A, () => fetchQuota('https://api.example.com/v1/usage'));
      expect(seen.at(-1)).toBe(PROXY_A);
      // 上下文外：直连，无 proxy 字段
      await fetchQuota('https://api.example.com/v1/usage');
      expect(seen.at(-1)).toBeUndefined();
      // 非法代理值按直连
      await withQuotaProxy('garbage', () => fetchQuota('https://api.example.com/v1/usage'));
      expect(seen.at(-1)).toBeUndefined();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('并发上下文互不串扰：两个代理各自看到自己的值', async () => {
    const seen: Array<{ proxy: string | undefined; tag: string }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit & { proxy?: string; tag?: string }) => {
      seen.push({ proxy: init?.proxy, tag: (init as { tag?: string } | undefined)?.tag ?? '?' });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    try {
      // 交错 await：A 先发起、让出事件循环、B 发起并完成、A 才完成——
      // ALS 保证各自上下文的代理不漂移
      await Promise.all([
        withQuotaProxy(PROXY_A, async () => {
          await new Promise((r) => setTimeout(r, 30));
          await fetchQuota('https://a.example.com', { method: 'GET', ...({ tag: 'A' } as object) } as RequestInit);
        }),
        withQuotaProxy(PROXY_B, async () => {
          await new Promise((r) => setTimeout(r, 5));
          await fetchQuota('https://b.example.com', { method: 'GET', ...({ tag: 'B' } as object) } as RequestInit);
        }),
      ]);
      const a = seen.find((s) => s.tag === 'A')!;
      const b = seen.find((s) => s.tag === 'B')!;
      expect(a.proxy).toBe(PROXY_A);
      expect(b.proxy).toBe(PROXY_B);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('applyQuotaProxy：裸 fetch 路径（claude OAuth refresh）同享注入', () => {
    expect(withQuotaProxy(PROXY_A, () => applyQuotaProxy({ method: 'POST' }))).toMatchObject({
      method: 'POST',
      proxy: PROXY_A,
    });
    // 上下文外原样返回
    expect(applyQuotaProxy({ method: 'POST' })).not.toHaveProperty('proxy');
  });
});

describe('Scheduler.refreshPlan 代理解析（INV-2015：extra > env）', () => {
  const original = registry.minimax;

  function planWith(extra: Record<string, string>): PlanConfig {
    const base = DEFAULT_PLANS.find((item) => item.slug === 'minimax')!;
    return { ...base, extra: { ...base.extra, ...extra } };
  }

  async function refreshWithPlan(plan: PlanConfig): Promise<string | null | undefined> {
    const store = openMemoryDb();
    store.syncPlan(plan);
    let seen: string | null | undefined = 'unset';
    registry.minimax = {
      slug: 'minimax',
      detectCredentials: async () => ({ kind: 'bearer', value: 't', source: 'manual' }),
      fetchUsage: async () => {
        seen = applyQuotaProxy({}).proxy ?? null;
        return [];
      },
    };
    try {
      const scheduler = new Scheduler(store, { port: 9291, plans: [plan] });
      await scheduler.refreshPlan('minimax');
      return seen;
    } finally {
      registry.minimax = original!;
    }
  }

  test('extra.proxy 注入到 adapter 的出站上下文', async () => {
    expect(await refreshWithPlan(planWith({ proxy: PROXY_A }))).toBe(PROXY_A);
  });

  test('无 extra 时回落 env PLANOFPPLAN_HTTP_PROXY；extra 优先于 env', async () => {
    const prev = process.env.PLANOFPPLAN_HTTP_PROXY;
    try {
      process.env.PLANOFPPLAN_HTTP_PROXY = PROXY_B;
      expect(await refreshWithPlan(planWith({}))).toBe(PROXY_B);
      expect(await refreshWithPlan(planWith({ proxy: PROXY_A }))).toBe(PROXY_A);
    } finally {
      if (prev === undefined) delete process.env.PLANOFPPLAN_HTTP_PROXY;
      else process.env.PLANOFPPLAN_HTTP_PROXY = prev;
    }
  });

  test('未配置任何层：直连（无 proxy）', async () => {
    const prev = process.env.PLANOFPPLAN_HTTP_PROXY;
    delete process.env.PLANOFPPLAN_HTTP_PROXY;
    try {
      expect(await refreshWithPlan(planWith({}))).toBeNull();
    } finally {
      if (prev !== undefined) process.env.PLANOFPPLAN_HTTP_PROXY = prev;
    }
  });
});
