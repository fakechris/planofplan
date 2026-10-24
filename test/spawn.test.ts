import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { childProcessArgs, childEnv } from '../src/spawn.ts';

describe('childProcessArgs（daemon 重执行本 CLI 的 spawn 参数）', () => {
  test('解释模式（bun test 运行，src/cli.ts 在旁边）：带上脚本路径', () => {
    const args = childProcessArgs(['tokens', '--days', '30']);
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toBe(join(import.meta.dir, '..', 'src', 'cli.ts'));
    expect(args.slice(2)).toEqual(['tokens', '--days', '30']);
    // dev 判定的前提：入口脚本真实存在
    expect(existsSync(args[1]!)).toBe(true);
  });

  test('参数原样透传，不吞不重排', () => {
    const args = childProcessArgs(['sessions', '--refresh', '--days', '90']);
    expect(args.slice(2)).toEqual(['sessions', '--refresh', '--days', '90']);
  });

  test('spawn 出的命令真实可执行且命令分发正确（编译态回归的代理验证）', async () => {
    // 用只读且秒回的 pricing status 做代理:2026-09-11 线上事故里,编译态
    // 误判塞入 cli.ts 路径后子进程落进 help 分支秒退(exit 0,stdout 是用法
    // 帮助)。真实命令分发则输出价格快照状态文案。
    const args = childProcessArgs(['pricing', 'status']);
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).not.toContain('用法');
    expect(stdout).toContain('价格快照');
  }, 30_000);
});

describe('子进程环境下发(INV-1329)', () => {
  test('childEnv 快照包含运行时注入的变量,显式 env 让子进程可见', async () => {
    // 事故实录:Bun.spawn 不传 env 时,preload 运行时注入的
    // PLANOFPPLAN_HOME(临时隔离 home)不下发,扫描子进程落回真实
    // ~/.planofplan,全量测试把真实库顺带扫描了一轮。
    process.env.PLANOFPLAN_TEST_PROBE = 'runtime-injected';
    try {
      expect(childEnv().PLANOFPLAN_TEST_PROBE).toBe('runtime-injected');
      const child = Bun.spawn(
        [process.execPath, '-e', 'console.log(process.env.PLANOFPLAN_TEST_PROBE ?? "MISSING")'],
        { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: childEnv() },
      );
      const stdout = await new Response(child.stdout).text();
      expect(stdout.trim()).toBe('runtime-injected');
    } finally {
      delete process.env.PLANOFPLAN_TEST_PROBE;
    }
  }, 30_000);
});
