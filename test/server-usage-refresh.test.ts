import { expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { createServer, usageRefreshIntervalMs } from '../src/server.ts';

// INV-1355:usage_records 此前只有 daemon 启动一次自动刷新,长驻 daemon 下
// fable 空闲 badge 随存活时长误报(实测 28h)。周期补一轮小窗口增量刷新。

test('startup and HTTP refresh use the same scanner queue; periodic timer adds trailing usage refreshes', async () => {
  const store = openMemoryDb();
  const calls: string[][] = [];
  const finish: Array<(code: number) => void> = [];
  createServer(store, {} as never, { port: 9291, plans: [] }, {
    startupScan: true,
    usageRefreshIntervalMs: 5,
    spawnScan: (args) => { calls.push(args); return { exited: new Promise<number>((resolve) => finish.push(resolve)) }; },
  });
  try {
    expect(calls).toEqual([['sessions', '--refresh', '--days', '90']]);
    // 启动时 enqueue 的 usage 排在首个 sessions 扫描之后串行执行
    finish.shift()!(0); await Bun.sleep(10);
    expect(calls[1]).toEqual(['tokens', '--days', '3', '--no-official']);
    finish.shift()!(0);
    // 定时器按注入的短间隔补轮;pending 按 kind 去重,同一时刻至多一个 trailing
    let periodic: string[] | undefined;
    for (let i = 0; i < 100 && !periodic; i++) {
      await Bun.sleep(5);
      periodic = calls.slice(2).find((args) => args[0] === 'tokens');
    }
    expect(periodic).toEqual(['tokens', '--days', '3', '--no-official']);
  } finally {
    // 放行未决 spawn,避免扫描队列悬挂在假 promise 上
    for (const resolve of finish) resolve(0);
    await Bun.sleep(10);
    store.close();
  }
});

test('usageRefreshIntervalMs: PLANOFPLAN_USAGE_REFRESH_MINUTES overrides, ≤0 disables, bad input falls back', () => {
  expect(usageRefreshIntervalMs({})).toBe(30 * 60_000);
  expect(usageRefreshIntervalMs({ PLANOFPLAN_USAGE_REFRESH_MINUTES: '15' })).toBe(15 * 60_000);
  expect(usageRefreshIntervalMs({ PLANOFPLAN_USAGE_REFRESH_MINUTES: '0' })).toBe(0);
  expect(usageRefreshIntervalMs({ PLANOFPLAN_USAGE_REFRESH_MINUTES: '-3' })).toBe(0);
  expect(usageRefreshIntervalMs({ PLANOFPLAN_USAGE_REFRESH_MINUTES: 'abc' })).toBe(30 * 60_000);
  expect(usageRefreshIntervalMs({ PLANOFPLAN_USAGE_REFRESH_MINUTES: '' })).toBe(30 * 60_000);
});
