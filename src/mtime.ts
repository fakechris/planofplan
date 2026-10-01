/**
 * 文件 mtime 的唯一取值口径:整数毫秒。
 *
 * Bun 1.4 起 statSync().mtimeMs 带亚毫秒小数(1.3.x 是整数)。水位、usage_scan_files
 * (INTEGER 列)和新鲜度判断都按整数存、按相等比,带小数会把未变文件当成已变、每轮
 * 重扫。所有读文件 mtime 的地方都经过这里(test/mtime.test.ts 守卫)。
 */
export function wholeMtimeMs(stat: { mtimeMs: number }): number {
  return Math.floor(stat.mtimeMs);
}
