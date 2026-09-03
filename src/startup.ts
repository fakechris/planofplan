import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { homeDir } from './config.ts';

export const LAUNCH_AGENT_LABEL = 'local.planofplan.daemon';

/** ~/Library/LaunchAgents，可用 PLANOFPPLAN_LAUNCH_AGENTS_DIR 覆盖（测试用）。 */
export function launchAgentsDir(): string {
  return process.env.PLANOFPPLAN_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
}

export function launchAgentPlistPath(): string {
  return join(launchAgentsDir(), `${LAUNCH_AGENT_LABEL}.plist`);
}

export function isLaunchOnStartupSupported(): boolean {
  return process.platform === 'darwin';
}

/**
 * 开机自启 = launchd LaunchAgent 已注册（plist 存在）。
 * 默认不注册；dashboard 的「开机自启」开关负责安装/删除注册。
 */
export function isLaunchOnStartupEnabled(): boolean {
  return existsSync(launchAgentPlistPath());
}

export function getStartupSettings(): {
  launchOnStartup: { available: boolean; enabled: boolean };
} {
  const available = isLaunchOnStartupSupported();
  return {
    launchOnStartup: {
      available,
      enabled: available && isLaunchOnStartupEnabled(),
    },
  };
}

export interface LaunchOnStartupResult {
  ok: true;
  enabled: boolean;
  /** true = daemon 即将在 launchd 守护下重启接管，客户端应预期短暂重连。 */
  restarting: boolean;
  note: string;
}

export function setLaunchOnStartup(enabled: boolean): LaunchOnStartupResult {
  if (!isLaunchOnStartupSupported()) {
    throw new Error('仅 macOS 支持开机自启');
  }
  if (enabled) {
    const script = join(import.meta.dir, '..', 'scripts', 'install-daemon.sh');
    if (!existsSync(script)) {
      throw new Error(`安装脚本缺失：${script}`);
    }
    // installer 会接管端口并重启 daemon（被接管的可能就是当前进程）。两个关键点：
    // 1) detached 独立进程组——bootout 触发 launchd 杀旧 job 的整个进程组时，
    //    脚本若还在原组内会被一并带走，留下「plist 在、job 未加载」的僵态；
    // 2) 输出重定向进 serve.log——脚本内置 1s 宽限让 HTTP 响应先落地。
    const logPath = join(homeDir(), 'serve.log');
    Bun.spawn(['/bin/sh', '-c', 'exec "$0" >> "$1" 2>&1', script, logPath], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref();
    return {
      ok: true,
      enabled: true,
      restarting: true,
      note: 'daemon 正在切换到 launchd 守护，页面会短暂重连',
    };
  }
  // 关闭删除自启注册及登录项；launchd 已加载的任务保留到注销/重启，
  // 不打断当前正在服务的 daemon。
  rmSync(launchAgentPlistPath(), { force: true });
  if (process.platform === 'darwin' && !process.env.PLANOFPPLAN_LAUNCH_AGENTS_DIR) {
    try {
      Bun.spawnSync([
        'osascript',
        '-e',
        'tell application "System Events" to delete (every login item whose name is "planofplan" or path is "/Applications/planofplan.app")',
      ]);
    } catch {
      // 忽略非 GUI 环境或测试环境执行失败
    }
  }
  return {
    ok: true,
    enabled: false,
    restarting: false,
    note: '注销/重启后不再自动启动；当前服务继续运行',
  };
}
