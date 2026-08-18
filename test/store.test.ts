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
