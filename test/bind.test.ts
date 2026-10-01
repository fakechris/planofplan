import { describe, expect, test } from 'bun:test';
import { bearerMatches, BindError, isLoopbackHost, resolveBind } from '../src/bind.ts';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';

// INV-897: the index is every local agent conversation; it listens on loopback unless told otherwise.
describe('where the daemon listens', () => {
  test('defaults to both loopbacks and no token', () => {
    expect(resolveBind({})).toEqual({ hostnames: ['127.0.0.1', '::1'], token: null });
  });

  test('a loopback override needs no token', () => {
    expect(resolveBind({ PLANOFPLAN_BIND: '127.0.0.1' }).hostnames).toEqual(['127.0.0.1']);
  });

  test('a non-loopback address without a token refuses to start', () => {
    for (const bind of ['0.0.0.0', '192.168.0.86', '::', '100.97.55.41']) {
      expect(() => resolveBind({ PLANOFPLAN_BIND: bind })).toThrow(BindError);
    }
  });

  test('a non-loopback address with a long enough token is allowed', () => {
    expect(resolveBind({ PLANOFPLAN_BIND: '0.0.0.0', PLANOFPLAN_TOKEN: 'x'.repeat(32) }))
      .toEqual({ hostnames: ['0.0.0.0'], token: 'x'.repeat(32) });
    expect(() => resolveBind({ PLANOFPLAN_BIND: '0.0.0.0', PLANOFPLAN_TOKEN: 'short' })).toThrow(BindError);
  });

  test('loopback recognition', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.0.86', 'localhost.evil.test', '127.0.0.1.evil.test']) expect(isLoopbackHost(host)).toBe(false);
  });

  test('bearer comparison', () => {
    expect(bearerMatches('Bearer abcdefghijklmnop', 'abcdefghijklmnop')).toBe(true);
    expect(bearerMatches('bearer abcdefghijklmnop', 'abcdefghijklmnop')).toBe(true);
    expect(bearerMatches('Bearer abcdefghijklmnoq', 'abcdefghijklmnop')).toBe(false);
    expect(bearerMatches('Bearer abc', 'abcdefghijklmnop')).toBe(false);
    expect(bearerMatches(undefined, 'abcdefghijklmnop')).toBe(false);
  });
});

describe('a configured token is required on every request', () => {
  const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
  function app(authToken: string | null) {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS }, { authToken });
  }
  const mcp = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) };

  test('without the token: 401 on the API and on MCP, even with a loopback Host', async () => {
    const server = app('t'.repeat(24));
    expect((await server.request('/api/overview', { headers: { host: 'localhost' } })).status).toBe(401);
    expect((await server.request('/mcp', { ...mcp, headers: { ...mcp.headers, host: 'localhost' } })).status).toBe(401);
  });

  test('with the token: served', async () => {
    const server = app('t'.repeat(24));
    const res = await server.request('/mcp', { ...mcp, headers: { ...mcp.headers, authorization: `Bearer ${'t'.repeat(24)}` } });
    expect(res.status).toBe(200);
  });

  test('no token configured: unchanged', async () => {
    expect((await app(null).request('/api/overview')).status).toBe(200);
  });
});
