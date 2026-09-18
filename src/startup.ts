import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { homeDir } from './config.ts';
import { appDataDir } from './platform.ts';

export const LAUNCH_AGENT_LABEL = 'local.planofplan.daemon';
export const WINDOWS_STARTUP_SCRIPT = 'planofplan-daemon.cmd';

/** ~/Library/LaunchAgents，可用 PLANOFPPLAN_LAUNCH_AGENTS_DIR 覆盖（测试用）。 */
export function launchAgentsDir(): string {
  return process.env.PLANOFPPLAN_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents');
}

export function launchAgentPlistPath(): string {
  return join(launchAgentsDir(), `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * Windows「启动」文件夹，可用 PLANOFPPLAN_STARTUP_DIR 覆盖（测试用）。
 * 自启落点为其中的 planofplan-daemon.cmd（等价 launchd LaunchAgent 的最小实现）。
 */
export function windowsStartupDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform !== 'win32') return null;
  const override = env.PLANOFPPLAN_STARTUP_DIR?.trim();
  if (override) return override;
  const appData = appDataDir(env, platform);
  if (!appData) return null;
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function windowsStartupScriptPath(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = windowsStartupDir(platform, env);
  return dir ? join(dir, WINDOWS_STARTUP_SCRIPT) : null;
}

export function isLaunchOnStartupSupported(platform: string = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * 开机自启注册状态:
 * - darwin = launchd LaunchAgent 已注册（plist 存在）
 * - win32  = 启动文件夹存在 planofplan-daemon.cmd
 * 默认不注册；dashboard 的「开机自启」开关负责安装/删除注册。
 */
export function isLaunchOnStartupEnabled(platform: string = process.platform): boolean {
  if (platform === 'win32') {
    const script = windowsStartupScriptPath(platform);
    return script != null && existsSync(script);
  }
  return existsSync(launchAgentPlistPath());
}

export function getStartupSettings(platform: string = process.platform): {
  launchOnStartup: { available: boolean; enabled: boolean };
} {
  const available = isLaunchOnStartupSupported(platform);
  return {
    launchOnStartup: {
      available,
      enabled: available && isLaunchOnStartupEnabled(platform),
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

function windowsStartupScriptContent(): string {
  // execPath/cli 路径在安装时定格,避免依赖登录 shell 的 PATH;
  // start 的第一个引号参数是窗口标题,路径含空格也安全。
  const cli = join(import.meta.dir, 'cli.ts');
  return [
    '@echo off',
    'rem planofplan daemon 自启脚本（由 dashboard「开机自启」开关生成）',
    `start "planofplan" /min "${process.execPath}" "${cli}" serve`,
    '',
  ].join('\r\n');
}

export function setLaunchOnStartup(
  enabled: boolean,
  platform: string = process.platform,
): LaunchOnStartupResult {
  if (!isLaunchOnStartupSupported(platform)) {
    throw new Error('仅 macOS / Windows 支持开机自启');
  }
  if (platform === 'win32') {
    const script = windowsStartupScriptPath(platform);
    if (!script) throw new Error('无法定位 Windows 启动文件夹（%APPDATA% 未设置）');
    if (enabled) {
      writeFileSync(script, windowsStartupScriptContent(), { encoding: 'utf8' });
      return {
        ok: true,
        enabled: true,
        restarting: false,
        note: '已写入启动文件夹，下次登录 Windows 时自动启动 daemon',
      };
    }
    rmSync(script, { force: true });
    return {
      ok: true,
      enabled: false,
      restarting: false,
      note: '下次登录 Windows 不再自动启动；当前 daemon 不受影响',
    };
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
