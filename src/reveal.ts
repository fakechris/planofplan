/**
 * 在系统文件管理器中定位文件(INV-563 Windows 适配)。
 *
 * 命令选择是纯函数便于单测;执行器处理各平台的退出码怪癖:
 * - darwin: open -R
 * - win32 : explorer /select,(成功时也返回退出码 1,按成功处理)
 * - linux : xdg-open 打开所在目录
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

export interface RevealCommand {
  argv: string[];
  /** 视为成功的 spawnSync 退出码集合。 */
  okStatuses: number[];
}

export function revealCommand(
  sourceFile: string,
  platform: string = process.platform,
): RevealCommand | null {
  if (platform === 'darwin') {
    return { argv: ['open', '-R', sourceFile], okStatuses: [0] };
  }
  if (platform === 'win32') {
    return { argv: ['explorer', `/select,${sourceFile}`], okStatuses: [0, 1] };
  }
  if (platform === 'linux') {
    return { argv: ['xdg-open', dirname(sourceFile)], okStatuses: [0] };
  }
  return null;
}

export function revealInFileManager(
  sourceFile: string,
  platform: string = process.platform,
): { ok: true } | { ok: false; error: string } {
  const command = revealCommand(sourceFile, platform);
  if (!command) {
    return { ok: false, error: '当前平台不支持在文件管理器中显示' };
  }
  const result = spawnSync(command.argv[0]!, command.argv.slice(1), { encoding: 'utf8' });
  if (!command.okStatuses.includes(result.status ?? -1)) {
    return { ok: false, error: result.stderr?.trim() || '文件管理器打开失败' };
  }
  return { ok: true };
}
