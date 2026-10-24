import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 构造「重新执行本 CLI」的 spawn 参数。
 *
 * 解释模式（bun src/cli.ts）：process.execPath 是 bun 运行时，必须显式带上
 * cli.ts 脚本路径。编译模式（bun build --compile）：execPath 就是编译二进制
 * 本身，不能再塞脚本路径——多出的 cli.ts 路径会被当成命令/脚本，子进程瞬间
 * 退出且 exit 0，扫描静默空转（2026-08-29 与 2026-09-11 两次踩中；后者因
 * 新版 bun 把编译产物的 import.meta.dir 从 $bunfs 虚拟路径改为真实二进制
 * 目录，旧判定失效，daemon 触发的全部用量/会话扫描空转近一周）。
 *
 * 编译态判定三重兜底：
 * 1. import.meta.dir 是 $bunfs 虚拟路径（旧版 bun）；
 * 2. process.argv[1] 含 $bunfs 入口占位（新版 bun）；
 * 3. cli.ts 不在运行文件旁边（结构性判定，与 bun 版本无关，最稳）。
 */
export function childProcessArgs(cliArgs: string[]): string[] {
  const devEntry = join(import.meta.dir, 'cli.ts');
  const compiled = import.meta.dir.startsWith('$bunfs')
    || (process.argv[1] ?? '').includes('$bunfs')
    || !existsSync(devEntry);
  return [process.execPath, ...(compiled ? [] : [devEntry]), ...cliArgs];
}

/** 子进程环境:Bun.spawn 不传 env 时只继承「进程启动时」的环境快照,
 *  运行时注入的变量(测试 preload 的 PLANOFPLAN_HOME、daemon 运行中的
 *  环境调整)不会下发——实测 bun 1.3.14 上扫描子进程因此落回真实
 *  ~/.planofplan,测试全量跑时真实库被顺带扫描/回收(INV-1329)。 */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** daemon 重执行本 CLI 的统一 spawn:stderr 继承(扫描日志进 serve.log),
 *  环境显式快照(见 childEnv)。 */
export function spawnSelf(cliArgs: string[]): Bun.Subprocess {
  return Bun.spawn(childProcessArgs(cliArgs), {
    stdout: 'ignore',
    stderr: 'inherit',
    stdin: 'ignore',
    env: childEnv(),
  });
}
