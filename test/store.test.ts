import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import type { PlanConfig, QuotaWindow } from '../src/types.ts';

const plan: PlanConfig = {
  slug: 'minimax',
  name: 'MiniMax legacy',
  adapter: 'minimax',
  enabled: true,
  pollIntervalSec: 60,
  credRef: null,
  extra: { region: 'cn' },
};

function win(used: number, fetchedAt: number): QuotaWindow {
  return {
    window: 'rolling_5h',
    label: '5H',
    used,
    total: 1000,
    unit: 'prompts',
    percentage: used / 10,
    resetAt: fetchedAt + 3_600_000,
    note: null,
  };
}

describe('Store', () => {
  test('syncPlan 后 latestByPlan 返回最新窗口；多窗口分组正确', () => {
    const store = openMemoryDb();
    store.syncPlan(plan);
    const t0 = 1_770_000_000_000;
    store.insertWindows('minimax', [win(100, t0), { ...win(100, t0), window: 'weekly', label: 'Week', total: 4000, percentage: 2.5 }], t0);
    store.insertWindows('minimax', [win(300, t0 + 60_000)], t0 + 60_000);

    const latest = store.latestByPlan('minimax');
    expect(latest).toHaveLength(2);
    const five = latest.find((w) => w.window === 'rolling_5h')!;
    expect(five.used).toBe(300); // 最新一次覆盖旧一次
    const weekly = latest.find((w) => w.window === 'weekly')!;
    expect(weekly.total).toBe(4000);
  });

  test('稳定窗口改名后不会保留旧标签的重复行', () => {
    const store = openMemoryDb();
    store.syncPlan({ ...plan, slug: 'codex', adapter: 'codex', name: 'OpenAI Codex' });
    const t0 = 1_770_000_000_000;
    store.insertWindows(
      'codex',
      [{ ...win(10, t0), label: '5H' }],
      t0,
    );
    store.insertWindows(
      'codex',
      [{ ...win(20, t0 + 60_000), label: '5小时限额' }],
      t0 + 60_000,
    );

    const latest = store.latestByPlan('codex');
    expect(latest).toHaveLength(1);
    expect(latest[0]!.label).toBe('5小时限额');
    expect(latest[0]!.used).toBe(20);
  });

  test('Factory Standard/Core windows render in 5H, week, month order', () => {
    const store = openMemoryDb();
    store.syncPlan({ ...plan, slug: 'factory', adapter: 'factory', name: 'Factory Droid' });
    const t0 = 1_770_000_000_000;
    store.insertWindows('factory', [
      { ...win(10, t0), window: 'core_monthly', label: 'Core Month' },
      { ...win(20, t0), window: 'standard_weekly', label: 'Standard Week' },
      { ...win(30, t0), window: 'core_5h', label: 'Core 5H' },
      { ...win(40, t0), window: 'standard_5h', label: 'Standard 5H' },
      { ...win(50, t0), window: 'standard_monthly', label: 'Standard Month' },
      { ...win(60, t0), window: 'core_weekly', label: 'Core Week' },
    ], t0);

    expect(store.latestByPlan('factory').map((window) => window.label)).toEqual([
      'Standard 5H',
      'Standard Week',
      'Standard Month',
      'Core 5H',
      'Core Week',
      'Core Month',
    ]);
  });

  test('history 只返回窗口内、since 之后的数据', () => {
    const store = openMemoryDb();
    store.syncPlan(plan);
    const t0 = 1_770_000_000_000;
    store.insertWindows('minimax', [win(100, t0)], t0);
    store.insertWindows('minimax', [win(200, t0 + 60_000)], t0 + 60_000);
    const rows = store.history('minimax', 'rolling_5h', t0 + 30_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.used).toBe(200);
  });

  test('setState 合并更新（连败计数、暂停时间）', () => {
    const store = openMemoryDb();
    store.syncPlan(plan);
    store.setState('minimax', { consecutive_failures: 1, paused_until: 123, last_error: 'x' });
    store.setState('minimax', { consecutive_failures: 2 });
    const state = store.getState('minimax')!;
    expect(state.consecutive_failures).toBe(2);
    expect(state.paused_until).toBe(123);
    expect(state.last_error).toBe('x');
  });

  test('provider 级 extra 配置持久化且不会被启动同步覆盖', () => {
    const store = openMemoryDb();
    store.syncPlan(plan);
    store.updatePlanExtra('minimax', { browser: 'safari' });
    expect(store.getPlan('minimax')?.extra.browser).toBe('safari');

    store.syncPlan({ ...plan, extra: { region: 'cn' } });
    expect(store.getPlan('minimax')?.extra.browser).toBe('safari');

    store.updatePlanExtra('minimax', { browser: null });
    expect(store.getPlan('minimax')?.extra.browser).toBeUndefined();
  });

  test('同步新 GLM plan 时迁移并清理 legacy/current plan', () => {
    const store = openMemoryDb();
    const legacy = { ...plan, slug: 'glm_legacy', name: 'GLM legacy', adapter: 'glm', credRef: 'glm_legacy' };
    const current = { ...plan, slug: 'glm_current', name: 'GLM current', adapter: 'glm', credRef: 'glm_current' };
    store.syncPlan(legacy);
    store.syncPlan(current);
    store.insertWindows('glm_current', [win(42, Date.now())], Date.now());

    const migrated = store.migrateLegacyGlmPlans();
    store.syncPlan({ ...plan, slug: 'glm', name: 'GLM', adapter: 'glm', credRef: null, extra: {} });

    expect(store.getPlan('glm')?.credRef).toBe('glm_current');
    expect(migrated.credentialRefs).toEqual(['glm_current', 'glm_legacy']);
    expect(migrated.sourceCredentialRef).toBe('glm_current');
    expect(store.getPlan('glm_legacy')).toBeNull();
    expect(store.getPlan('glm_current')).toBeNull();
    expect(store.latestByPlan('glm')).toHaveLength(1);
  });

  test('latestBatchOnly excludes windows omitted by the newest poll', () => {
    const store = openMemoryDb();
    store.syncPlan({ ...plan, slug: 'codex', adapter: 'codex', name: 'OpenAI Codex' });
    const fiveHour = { ...win(94, 100), window: 'rolling_5h', label: '5小时限额' };
    const weekly = { ...win(94, 200), window: 'weekly', label: '周限额' };
    store.insertWindows('codex', [fiveHour], 100);
    store.insertWindows('codex', [weekly], 200);

    expect(store.latestByPlan('codex').map((window) => window.window)).toEqual([
      'rolling_5h',
      'weekly',
    ]);
    expect(store.latestByPlan('codex', true).map((window) => window.window)).toEqual(['weekly']);
  });

  test('prune 删除早于保留期的快照', () => {
    const store = openMemoryDb();
    store.syncPlan(plan);
    const now = Date.now();
    store.insertWindows('minimax', [win(100, now - 40 * 86_400_000)], now - 40 * 86_400_000);
    store.insertWindows('minimax', [win(100, now)], now);
    const deleted = store.prune(30 * 86_400_000);
    expect(deleted).toBe(1);
    expect(store.latestByPlan('minimax')).toHaveLength(1);
  });
});
