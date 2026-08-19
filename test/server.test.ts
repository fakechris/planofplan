import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

function app() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
}

describe('Kimi browser policy', () => {
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
