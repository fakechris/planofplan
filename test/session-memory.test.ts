import { expect, test } from 'bun:test';
import { join } from 'node:path';

// 64MiB 扫描的耗时会随系统负载伸缩（本机负载 ~11 时约 28s，更高负载线性变慢），
// 固定小预算在高负载开发机上会把正常慢速误判成超时（INV-2172）。预算取宽
// （180s），需要收紧/放宽时用环境变量覆盖——bun test 的 --timeout CLI 参数
// 盖不掉测试内声明的值。
const requestedTimeoutMs = Number(process.env.PLANOFPLAN_SESSION_MEMORY_TIMEOUT_MS);
const SCAN_TIMEOUT_MS = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 180_000;

// Bun 1.3.x on macOS reports resourceUsage().maxRSS in bytes. The child keeps
// fixture construction and scanner allocations out of the test runner's heap.
test.skipIf(process.platform !== 'darwin')('64MiB tool-result scan stays below 640MiB peak and retains surrounding messages', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/session-memory.ts')], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error + output).toBe(0);
  const result = JSON.parse(output.trim());
  expect(result.messages).toBe(2);
  expect(result.peakBytes).toBeLessThan(640 * 1024 * 1024);
}, SCAN_TIMEOUT_MS);

// Repeated files expose cumulative native allocation pressure hidden by a one-file test.
test.skipIf(process.platform !== 'darwin')('eight 64MiB files release temporary allocations between scans', async () => {
  const child = Bun.spawn([process.execPath, '--smol', join(import.meta.dir, 'fixtures/session-memory.ts'), '--many-files'], { stdout: 'pipe', stderr: 'pipe' });
  const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, error + output).toBe(0);
  const result = JSON.parse(output.trim());
  expect(result.messages).toBe(2);
  expect(result.peakBytes).toBeLessThan(1024 * 1024 * 1024);
}, SCAN_TIMEOUT_MS);
