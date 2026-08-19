import { describe, expect, test } from 'bun:test';
import { buildOverview } from '../src/core.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { AUTH_STATUS, type QuotaWindow } from '../src/types.ts';

describe('buildOverview auth state', () => {
  test('旧额度快照加当前缺凭据不能继续显示 ok', () => {
    const store = openMemoryDb();
    const plan = DEFAULT_PLANS.find((item) => item.slug === 'kimi')!;
    store.syncPlan(plan);
    const window: QuotaWindow = {
      window: 'rolling_5h',
      label: '5H',
      used: 10,
      total: 100,
      unit: 'requests',
      percentage: 10,
      resetAt: Date.now() + 3_600_000,
      note: null,
    };
    store.insertWindows(plan.slug, [window], 100);
    store.setState(plan.slug, {
      last_success_at: 100,
      last_attempt_at: 200,
      auth_status: AUTH_STATUS.MISSING,
      last_error: '没有有效 Kimi 会话',
    });

    const overview = buildOverview(store, [plan], 300);
    expect(overview.plans[0]!.status).toBe('stale');
  });

  test('鉴权失败时不展示旧额度快照', () => {
    const store = openMemoryDb();
    const plan = DEFAULT_PLANS.find((item) => item.slug === 'kimi')!;
    store.syncPlan(plan);
    store.insertWindows(
      plan.slug,
      [{
        window: 'rolling_5h',
        label: '5H',
        used: 10,
        total: 100,
        unit: 'requests',
        percentage: 10,
        resetAt: Date.now() + 3_600_000,
        note: null,
      }],
      100,
    );
    store.setState(plan.slug, {
      last_success_at: 100,
      last_attempt_at: 200,
      auth_status: AUTH_STATUS.INVALID,
      last_error: 'Kimi 网页会话过期(HTTP 401)',
    });

    const overview = buildOverview(store, [plan], 300);
    expect(overview.plans[0]!.status).toBe('auth_error');
    expect(overview.plans[0]!.windows).toEqual([]);
    expect(overview.plans[0]!.lastFetchedAt).toBe(100);
  });
});

describe('buildOverview plan filtering', () => {
  test('传入单个 plan 时只返回该 plan，不再泄漏全量列表', () => {
    const store = openMemoryDb();
    const kimi = DEFAULT_PLANS.find((item) => item.slug === 'kimi')!;
    const grok = DEFAULT_PLANS.find((item) => item.slug === 'grok')!;
    store.syncPlan(kimi);
    store.syncPlan(grok);

    const overview = buildOverview(store, [grok], Date.now());
    expect(overview.plans.map((p) => p.slug)).toEqual(['grok']);

    const all = buildOverview(store, DEFAULT_PLANS, Date.now());
    expect(all.plans.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildOverview current snapshot batch', () => {
  test('does not merge an old Codex 5H row into a weekly-only refresh', () => {
    const store = openMemoryDb();
    const codex = DEFAULT_PLANS.find((item) => item.slug === 'codex')!;
    store.syncPlan(codex);
    store.insertWindows(codex.slug, [{
      window: 'rolling_5h',
      label: '5小时限额',
      used: null,
      total: null,
      unit: 'percent',
      percentage: 94,
      resetAt: 1_800_000_000_000,
      note: null,
    }], 100);
    store.insertWindows(codex.slug, [{
      window: 'weekly',
      label: '周限额',
      used: null,
      total: null,
      unit: 'percent',
      percentage: 94,
      resetAt: 1_800_000_000_000,
      note: null,
    }], 200);

    const overview = buildOverview(store, [codex], 300);
    expect(overview.plans[0]!.windows.map((window) => window.window)).toEqual(['weekly']);
  });
});
