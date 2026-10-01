import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { checkQuotaAlerts, evaluateQuotaAlerts, type AlertPlan } from '../src/quota-alerts.ts';

function plan(partial: Partial<AlertPlan> & { windows: AlertPlan['windows'] }): AlertPlan {
  return { slug: 'glm', name: 'GLM', enabled: true, status: 'ok', ...partial };
}
const usage = (percentage: number | null, extra: Partial<AlertPlan['windows'][number]> = {}) => ({
  window: 'rolling_5h', label: '5H', unit: 'percent', used: null, total: null, percentage, resetAt: null, ...extra,
});
const balance = (amount: number) => ({
  window: 'credits_period', label: 'Balance', unit: 'CNY', used: amount, total: amount, percentage: null, resetAt: null,
});
const ON = { usagePercent: 80, balance: 5 };

describe('evaluateQuotaAlerts', () => {
  test('raises once when a window crosses the threshold, not again while it stays above', () => {
    const first = evaluateQuotaAlerts([plan({ windows: [usage(93)] })], ON, new Set());
    expect(first.raise.map((a) => a.key)).toEqual(['glm|rolling_5h|usage']);
    expect(first.raise[0]!.message).toContain('93%');
    const again = evaluateQuotaAlerts([plan({ windows: [usage(95)] })], ON, new Set(['glm|rolling_5h|usage']));
    expect(again.raise).toEqual([]);
    expect(again.clear).toEqual([]);
  });

  test('re-arms after a fresh reading falls back below the threshold (window reset)', () => {
    const reset = evaluateQuotaAlerts([plan({ windows: [usage(2)] })], ON, new Set(['glm|rolling_5h|usage']));
    expect(reset.clear).toEqual(['glm|rolling_5h|usage']);
    expect(reset.raise).toEqual([]);
  });

  test('stale, failed, auth-errored or disabled plans neither alert nor re-arm', () => {
    for (const p of [
      plan({ status: 'stale', windows: [usage(99)] }),
      plan({ status: 'error', windows: [usage(1)] }),
      plan({ status: 'auth_error', windows: [usage(99)] }),
      plan({ enabled: false, windows: [usage(99)] }),
    ]) {
      const decision = evaluateQuotaAlerts([p], ON, new Set(['glm|rolling_5h|usage']));
      expect(decision).toEqual({ raise: [], clear: [] });
    }
  });

  test('unknown percentage is not treated as zero or full', () => {
    expect(evaluateQuotaAlerts([plan({ windows: [usage(null, { unit: 'prompts' })] })], ON, new Set(['glm|rolling_5h|usage'])))
      .toEqual({ raise: [], clear: [] });
  });

  test('balance alerts when it falls to the threshold and re-arms once topped up', () => {
    const low = evaluateQuotaAlerts([plan({ slug: 'deepseek', name: 'DeepSeek', windows: [balance(4.5)] })], ON, new Set());
    expect(low.raise.map((a) => a.key)).toEqual(['deepseek|credits_period|balance']);
    expect(low.raise[0]!.message).toContain('4.5');
    const topped = evaluateQuotaAlerts([plan({ slug: 'deepseek', windows: [balance(50)] })], ON, new Set(['deepseek|credits_period|balance']));
    expect(topped.clear).toEqual(['deepseek|credits_period|balance']);
  });

  test('a threshold set to off raises nothing', () => {
    const off = { usagePercent: null, balance: null };
    expect(evaluateQuotaAlerts([plan({ windows: [usage(99), balance(0)] })], off, new Set())).toEqual({ raise: [], clear: [] });
  });
});

describe('checkQuotaAlerts (persisted state)', () => {
  test('pending until acknowledged, and not repeated after a restart', () => {
    const store = openMemoryDb();
    try {
      const plans = [plan({ windows: [usage(93)] })];
      const first = checkQuotaAlerts(store, plans, ON, 1_000);
      expect(first.map((a) => a.key)).toEqual(['glm|rolling_5h|usage']);
      // not acknowledged yet: still pending, still only one
      expect(checkQuotaAlerts(store, plans, ON, 2_000).map((a) => a.key)).toEqual(['glm|rolling_5h|usage']);
      store.ackQuotaAlerts(['glm|rolling_5h|usage'], 3_000);
      expect(checkQuotaAlerts(store, plans, ON, 4_000)).toEqual([]);
      // the state lives in the database: a reopened store (restart) does not alert again
      expect(store.quotaAlertKeys()).toEqual(['glm|rolling_5h|usage']);
      // reset → re-armed → alerts again next time it crosses
      checkQuotaAlerts(store, [plan({ windows: [usage(1)] })], ON, 5_000);
      expect(store.quotaAlertKeys()).toEqual([]);
      expect(checkQuotaAlerts(store, plans, ON, 6_000).map((a) => a.key)).toEqual(['glm|rolling_5h|usage']);
    } finally { store.close(); }
  });
});

describe('alert endpoints', () => {
  test('check returns pending alerts and records notifier status; ack stops repeats; settings validate', async () => {
    const { createServer } = await import('../src/server.ts');
    const store = openMemoryDb();
    try {
      const glm = { slug: 'glm', name: 'GLM', adapter: 'glm', enabled: true, pollIntervalSec: 300, credRef: null, extra: {} };
      store.syncPlan(glm as never);
      store.insertWindows('glm', [{ window: 'rolling_5h', label: '5H', used: null, total: null, unit: 'percent', percentage: 93, resetAt: null, note: null }], Date.now());
      store.setState('glm', { last_success_at: Date.now(), last_attempt_at: Date.now(), consecutive_failures: 0, last_error: null, auth_status: 'auto' });
      const app = createServer(store, { refreshPlan: async () => ({ ok: true, slug: 'glm', windows: [] }) } as never,
        { port: 9291, plans: [glm], alerts: { usagePercent: 80, balance: null } } as never);
      const post = (path: string, body: unknown) => app.request(`http://localhost${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });

      const checked = await (await post('/api/alerts/check', { notifier: 'authorized' })).json() as { pending: Array<{ key: string; message: string }> };
      expect(checked.pending.map((a) => a.key)).toEqual(['glm|rolling_5h|usage']);
      expect((await post('/api/alerts/ack', { keys: ['glm|rolling_5h|usage'] })).status).toBe(200);
      const again = await (await post('/api/alerts/check', { notifier: 'authorized' })).json() as { pending: unknown[] };
      expect(again.pending).toEqual([]);

      const status = await (await app.request('http://localhost/api/alerts')).json() as { notifier: { status: string }; settings: { usagePercent: number } };
      expect(status.notifier.status).toBe('authorized');
      expect(status.settings.usagePercent).toBe(80);
      expect((await post('/api/alerts/check', { notifier: 'bogus' })).status).toBe(400);
      const bad = await app.request('http://localhost/api/alerts/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usagePercent: 150, balance: null }),
      });
      expect(bad.status).toBe(400);
    } finally { store.close(); }
  });
});
