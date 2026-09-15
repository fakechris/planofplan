/**
 * 平台判定与目录解析(INV-563 Windows 适配)。
 *
 * 纯函数、平台参数可注入:所有 win32/darwin 分支的解析逻辑集中在这里,
 * 便于在 darwin 开发机上用 platform='win32' 直接单测,不依赖真实 Windows。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type InjectedPlatform = 'darwin' | 'win32' | 'linux' | string;

export function isMac(platform: InjectedPlatform = process.platform): boolean {
  return platform === 'darwin';
}

export function isWindows(platform: InjectedPlatform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * Windows %APPDATA%(Roaming)。env 可注入;未设置时按 USERPROFILE 布局兜底,
 * 与资源管理器里的「漫游」目录一致,供 Cursor 等应用数据路径拼装使用。
 */
export function appDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: InjectedPlatform = process.platform,
  home: string = homedir(),
): string | null {
  if (!isWindows(platform)) return null;
  const appData = env.APPDATA?.trim();
  if (appData) return appData;
  return join(home, 'AppData', 'Roaming');
}
