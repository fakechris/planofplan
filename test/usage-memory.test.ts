import { expect, test } from 'bun:test';
import { join } from 'node:path';

// macOS Bun reports maxRSS in bytes; verify the real usage parser in an isolated process.
test.skipIf(process.platform !== 'darwin')('384MiB usage transcript streams below 640MiB and preserves unterminated final usage', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/usage-memory.ts')], { stdout: 'pipe', stderr: 'pipe' });
  const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, error + output).toBe(0);
  const result = JSON.parse(output.trim());
  expect(result.records).toBe(1);
  expect(result.inputTokens).toBe(10);
  expect(result.peakBytes).toBeLessThan(640 * 1024 * 1024);
}, 30_000);
