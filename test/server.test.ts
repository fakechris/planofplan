import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { UsageRecord } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

function app() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
}

describe('Kimi browser policy', () => {
  test('usage API returns token aggregates separately from quota overview', async () => {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const timestamp = Date.now() - 60_000;
    const record: UsageRecord = {
      id: 'local:test:usage',
      day: new Date(timestamp).toISOString().slice(0, 10),
      timestamp,
      provider: 'codex',
      model: 'gpt-5',
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 1,
      totalTokens: 15,
      billableTokens: null,
      estimatedCostUsd: 0.01,
      source: 'local',
      confidence: 'measured',
    };
    store.upsertUsageRecords([record]);
    const response = await createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS })
      .request('http://localhost/api/usage?days=7&official=0&scan=0');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      totals: { totalTokens: number };
      models: Array<{ provider: string }>;
      scanStatus: { state: string };
    };
    expect(body.totals.totalTokens).toBe(15);
    expect(body.models.map((model) => model.provider)).toEqual(['codex']);
    expect(body.scanStatus.state).toBe('idle');
  });

  test('refresh all reports failed provider details despite HTTP 200', async () => {
    const plans = [
      { ...DEFAULT_PLANS.find((plan) => plan.slug === 'factory')!, enabled: true },
      { ...DEFAULT_PLANS.find((plan) => plan.slug === 'kimi')!, enabled: true },
    ];
    const store = openMemoryDb();
    for (const plan of plans) store.syncPlan(plan);
    const server = createServer(store, {
      refreshPlan: async (slug: string) =>
        slug === 'factory'
          ? { ok: false, slug, error: 'Factory 鉴权失败(HTTP 401)', auth: true }
          : { ok: true, slug, windows: [] },
    } as never, { port: 9291, plans });

    const response = await server.request('http://localhost/api/refresh', { method: 'POST' });
    const body = await response.json() as { ok?: boolean; error?: string };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('factory: Factory 鉴权失败(HTTP 401)');
  });

  test('Kimi browser selection rejects non-Safari', async () => {
    const response = await app().request('http://localhost/api/plans/kimi/browser', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Kimi 仅支持 Safari 浏览器会话',
    });
  });

  test('native Kimi session rejects non-Safari payloads', async () => {
    const response = await app().request('http://localhost/api/browser-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'kimi',
        browser: 'chrome',
        cookies: [],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      planSlug: 'kimi',
      error: 'Kimi 仅支持 Safari 浏览器会话',
    });
  });

  test('tries each Safari kimi-auth cookie until usage succeeds', async () => {
    const store = openMemoryDb();
    const kimi = DEFAULT_PLANS.find((plan) => plan.slug === 'kimi')!;
    store.syncPlan(kimi);
    let calls = 0;
    const scheduler = {
      refreshPlan: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, slug: 'kimi', error: '旧 Safari 会话' }
          : { ok: true, slug: 'kimi', windows: [] };
      },
    };
    const server = createServer(store, scheduler as never, { port: 9291, plans: [kimi] });

    const response = await server.request('http://localhost/api/browser-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'kimi',
        browser: 'safari',
        cookies: [
          { domain: '.kimi.com', name: 'kimi-auth', value: 'old-session' },
          { domain: 'www.kimi.com', name: 'kimi-auth', value: 'current-session' },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect((await response.json() as { ok?: boolean }).ok).toBe(true);
  });
});
