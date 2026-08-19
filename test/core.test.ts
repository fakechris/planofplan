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
