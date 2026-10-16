/**
 * serve.log 按大小轮转（重启时换代）：超 5MB 挪一代。
 * launchd 的 fd 跟随 inode，旧内容继续写 .old 直到下次重启，换代即清。
 *
 * 必须在端口绑定成功之后调用：失败启动（如 launchd KeepAlive 对着被占端口
 * 反复重试）若也轮转，serve.log/.old 会被每次重试互相改名冲刷，adapter
 * 诊断日志（[kimi] 等）全部丢失（INV-1243）。
 */
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';

export function rotateServeLogIfNeeded(logPath: string, maxBytes = 5 * 1024 * 1024): boolean {
  try {
    if (!existsSync(logPath) || statSync(logPath).size <= maxBytes) return false;
    rmSync(`${logPath}.old`, { force: true });
    renameSync(logPath, `${logPath}.old`);
    return true;
  } catch {
    return false; // 轮转失败不影响启动
  }
}
