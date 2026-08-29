import { afterAll, describe, expect, test } from 'bun:test';
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

// DNS rebinding 防护:外域 Host 一律 403,本机 Host 与缺失 Host 放行
describe('host header validation', () => {
  test('rejects external hostnames', async () => {
    const res = await app().request('/api/overview', { headers: { host: 'evil.example.com' } });
    expect(res.status).toBe(403);
  });

  test('rejects external hostnames with a port', async () => {
    const res = await app().request('/api/overview', { headers: { host: 'evil.example.com:9288' } });
    expect(res.status).toBe(403);
  });

  test('allows loopback hosts', async () => {
    for (const host of ['localhost:9288', '127.0.0.1:9288', '[::1]:9288']) {
      const res = await app().request('/api/overview', { headers: { host } });
      expect(res.status).toBe(200);
    }
  });

  test('allows requests without a host header', async () => {
    const res = await app().request('/api/overview');
    expect(res.status).toBe(200);
  });
});

describe('PLANOFPLAN_ALLOWED_HOSTS override', () => {
  process.env.PLANOFPLAN_ALLOWED_HOSTS = ' forwarded.example.test ';
  afterAll(() => {
    delete process.env.PLANOFPLAN_ALLOWED_HOSTS;
  });

  test('allows the explicitly forwarded host, still rejects others', async () => {
    const server = app();
    const allowed = await server.request('/api/overview', {
      headers: { host: 'forwarded.example.test:18080' },
    });
    expect(allowed.status).toBe(200);
    const denied = await server.request('/api/overview', {
      headers: { host: 'other.example.test' },
    });
    expect(denied.status).toBe(403);
  });
});
