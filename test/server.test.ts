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
});
