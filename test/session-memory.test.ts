import { expect, test } from 'bun:test';
import { join } from 'node:path';

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
}, 30_000);
