import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateServeLogIfNeeded } from '../src/serve-log.ts';

describe('rotateServeLogIfNeeded', () => {
  test('缺失或未超阈值的日志不动，超过阈值才换代且覆盖 .old', () => {
    const dir = mkdtempSync(join(tmpdir(), 'serve-log-'));
    const logPath = join(dir, 'serve.log');

    // 日志不存在：不轮转
    expect(rotateServeLogIfNeeded(logPath)).toBe(false);

    // 小于阈值：不轮转
    writeFileSync(logPath, 'fresh diagnostics\n');
    expect(rotateServeLogIfNeeded(logPath)).toBe(false);
    expect(existsSync(`${logPath}.old`)).toBe(false);

    // 超过阈值：换代，旧 .old 被覆盖，新日志文件让位给 launchd 的 fd
    writeFileSync(logPath, 'x'.repeat(6 * 1024 * 1024));
    writeFileSync(`${logPath}.old`, 'stale');
    expect(rotateServeLogIfNeeded(logPath)).toBe(true);
    expect(statSync(`${logPath}.old`).size).toBe(6 * 1024 * 1024);
    expect(existsSync(logPath)).toBe(false);
  });
});
