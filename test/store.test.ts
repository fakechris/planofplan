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

  test('MiniMax 主车道与 video 车道共存（同批 4 车道不被分区去重吞掉）', () => {
    const store = openMemoryDb();
    store.syncPlan(plan);
    const t0 = 1_770_000_000_000;
    // normalizeMiniMax 的真实输出形态：主 5H 纯百分比 + video 计数车道 + 周不限量
    store.insertWindows('minimax', [
      { ...win(1, t0), window: 'rolling_5h', label: '5H', used: null, total: 0, percentage: 1 },
      { ...win(0, t0), window: 'weekly_unlimited', label: 'Week', used: null, total: null, percentage: null, note: '不限量' },
      { ...win(0, t0), window: 'video_rolling_5h', label: '视频·5H', used: 0, total: 3, percentage: 0 },
      { ...win(3, t0), window: 'video_weekly', label: '视频·周', used: 3, total: 21, percentage: 15 },
    ], t0);

    const latest = store.latestByPlan('minimax', true);
    expect(latest).toHaveLength(4);
    expect(latest.find((w) => w.label === '5H')?.window).toBe('rolling_5h');
  });

  test('lastModelUsed 按模型家族前缀匹配（claude-fable 覆盖版本号演进）', () => {
    const store = openMemoryDb();
    store.syncPlan({ ...plan, slug: 'claude', adapter: 'claude', name: 'Claude Code' });
    const t0 = 1_770_000_000_000;
    store.upsertUsageRecords([
      {
        id: 'r1', day: '2026-09-01', timestamp: t0, provider: 'claude', model: 'claude-fable-5',
        inputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1,
        reasoningOutputTokens: 0, totalTokens: 2, billableTokens: null, estimatedCostUsd: null,
        source: 'local', confidence: 'measured',
      },
      {
        id: 'r2', day: '2026-09-11', timestamp: t0 + 10 * 86_400_000, provider: 'claude', model: 'claude-fable-5-1',
        inputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1,
        reasoningOutputTokens: 0, totalTokens: 2, billableTokens: null, estimatedCostUsd: null,
        source: 'local', confidence: 'measured',
      },
      {
        id: 'r3', day: '2026-09-11', timestamp: t0 + 10 * 86_400_000 + 60_000, provider: 'claude', model: 'claude-opus-5',
        inputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1,
        reasoningOutputTokens: 0, totalTokens: 2, billableTokens: null, estimatedCostUsd: null,
        source: 'local', confidence: 'measured',
      },
    ]);

    // fable 家族取最新一条（fable-5-1，而非早 10 天的 fable-5）
    expect(store.lastModelUsed('claude', 'claude-fable')).toBe(t0 + 10 * 86_400_000);
    // 非 fable 模型不计入
    expect(store.lastModelUsed('claude', 'claude-sonnet')).toBeNull();
    // 前缀中的 LIKE 通配符按字面量处理
    expect(store.lastModelUsed('claude', 'claude-fable%')).toBeNull();
  });
});
