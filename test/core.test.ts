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

describe('buildOverview tier 注解', () => {
  test('peakPricing=true 的 plan 在高峰时刻返回 tier.label=DeepSeek 高峰', () => {
    const store = openMemoryDb();
    const plan = DEFAULT_PLANS.find((item) => item.slug === 'deepseek')!;
    store.syncPlan(plan);
    store.insertWindows(plan.slug, [{
      window: 'credits_period',
      label: 'Balance',
      used: 0,
      total: 0,
      unit: 'usd',
      percentage: 0,
      resetAt: null,
      note: 'CNY',
    }], 100);
    store.setState(plan.slug, { last_success_at: 100 });

    // 2026-08-19 (Wed) 10:30 Shanghai = UTC 02:30
    const duringPeak = Date.UTC(2026, 7, 19, 2, 30, 0);
    const overview = buildOverview(store, [plan], duringPeak);
    expect(overview.plans[0]!.tier).not.toBeNull();
    expect(overview.plans[0]!.tier?.tier).toBe('peak');
    expect(overview.plans[0]!.tier?.label).toBe('DeepSeek 高峰');
  });

  test('GLM 默认 extra 为空时工作日下午仍显示高峰', () => {
    const store = openMemoryDb();
    const plan = {
      ...DEFAULT_PLANS.find((item) => item.slug === 'glm')!,
      extra: {},
    };
    store.syncPlan(plan);
    store.insertWindows(plan.slug, [{
      window: 'rolling_5h',
      label: '5H',
      used: 0,
      total: 100,
      unit: 'percent',
      percentage: 0,
      resetAt: null,
      note: null,
    }], 100);
    store.setState(plan.slug, { last_success_at: 100 });

    // 2026-08-20 (Thu) 16:00 Shanghai = UTC 08:00
    const duringPeak = Date.UTC(2026, 7, 20, 8, 0, 0);
    const overview = buildOverview(store, [plan], duringPeak);
    expect(overview.plans[0]!.tier?.tier).toBe('peak');
    expect(overview.plans[0]!.tier?.label).toBe('GLM 高峰');
  });

  test('未启用 peakPricing 的 plan tier 为 null', () => {
    const store = openMemoryDb();
    const plan = DEFAULT_PLANS.find((item) => item.slug === 'codex')!;
    store.syncPlan(plan);
    store.insertWindows(plan.slug, [{
      window: 'rolling_5h',
      label: '5小时',
      used: 1,
      total: 100,
      unit: 'percent',
      percentage: 1,
      resetAt: 1_800_000_000_000,
      note: null,
    }], 100);
    store.setState(plan.slug, { last_success_at: 100 });

    const overview = buildOverview(store, [plan], Date.UTC(2026, 7, 19, 2, 30, 0));
    expect(overview.plans[0]!.tier).toBeNull();
    expect(overview.plans[0]!.windows[0]?.tier).toBeUndefined();
  });
});

describe('buildOverview manualKey 入口', () => {
  test('所有默认 plan 都暴露手动 key 入口（防「后端支持、前端漏入口」回归）', () => {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const overview = buildOverview(store, DEFAULT_PLANS, Date.now());
    // 默认支持：adapter 未显式 manualKey:false 时必须为 true，
    // 否则 dashboard 设置弹窗不会渲染 key 表单。
    for (const plan of overview.plans) {
      expect(plan.manualKey).toBeTrue();
    }
    expect(overview.plans.length).toBe(DEFAULT_PLANS.length);
  });

  test('显式 manualKey:false 的 adapter 不给入口', () => {
    const store = openMemoryDb();
    const plan = { ...DEFAULT_PLANS[0]!, adapter: 'nokey-adapter' };
    store.syncPlan(plan);
    const overview = buildOverview(store, [plan], Date.now());
    expect(overview.plans[0]!.manualKey).toBeFalse();
  });
});

describe('buildOverview window reset normalization', () => {
  test('到达或超过 resetAt 的窗口，percentage 和 used 动态重置为 0', () => {
    const store = openMemoryDb();
    const claude = DEFAULT_PLANS.find((item) => item.slug === 'claude')!;
    store.syncPlan(claude);

    // 00:01 抓取到的快照：5H 满额 100%，00:10 重置；Week 14%，14:00 重置
    const fetchTime = 1_000_000;
    const resetTime5h = fetchTime + 9 * 60 * 1000; // 00:10
    const resetTimeWeek = fetchTime + 14 * 3600 * 1000; // 14:00

    store.insertWindows(claude.slug, [
      {
        window: 'rolling_5h',
        label: '5H',
        used: null,
        total: null,
        unit: 'percent',
        percentage: 100,
        resetAt: resetTime5h,
        note: null,
      },
      {
        window: 'weekly',
        label: 'Week',
        used: null,
        total: null,
        unit: 'percent',
        percentage: 14,
        resetAt: resetTimeWeek,
        note: null,
      },
    ], fetchTime);
    store.setState(claude.slug, { last_success_at: fetchTime });

    // 场景 1：在重置前（00:05），5H 仍显示 100%
    const beforeReset = buildOverview(store, [claude], fetchTime + 4 * 60 * 1000);
    const w5hBefore = beforeReset.plans[0]!.windows.find((w) => w.window === 'rolling_5h')!;
    expect(w5hBefore.percentage).toBe(100);

    // 场景 2：在重置时刻及之后（00:10:49），5H 动态归零为 0%，不再显示 100%
    const afterReset = buildOverview(store, [claude], resetTime5h + 49 * 1000);
    const w5hAfter = afterReset.plans[0]!.windows.find((w) => w.window === 'rolling_5h')!;
    expect(w5hAfter.percentage).toBe(0);
    expect(w5hAfter.resetAt).toBe(resetTime5h);

    // Week 窗口尚未到期，百分比保持不变
    const weekAfter = afterReset.plans[0]!.windows.find((w) => w.window === 'weekly')!;
    expect(weekAfter.percentage).toBe(14);
  });
});
