import { expect, test } from 'bun:test';
import { ScanQueue, type ScanRequest } from '../src/scan-queue.ts';

test('startup, usage and repeated watcher requests never overlap and retain trailing work', async () => {
  const starts: ScanRequest[] = [];
  const finish: Array<() => void> = [];
  let active = 0, peak = 0;
  const queue = new ScanQueue(async (request) => {
    starts.push(request); peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => finish.push(resolve));
    active--;
  }, () => { throw new Error('unexpected scan failure'); });
  queue.enqueue({ kind: 'sessions', days: 90, source: 'startup' });
  queue.enqueue({ kind: 'usage', days: 3, source: 'startup' });
  for (let i = 0; i < 100; i++) queue.enqueue({ kind: 'sessions', days: i + 1, source: 'watch' });
  expect(starts).toHaveLength(1);
  finish.shift()!(); await Bun.sleep(0);
  expect(starts.map((r) => r.kind)).toEqual(['sessions', 'usage']);
  finish.shift()!(); await Bun.sleep(0);
  expect(starts[2]?.days).toBe(100);
  finish.shift()!(); await Bun.sleep(0);
  expect(starts).toHaveLength(3);
  expect(peak).toBe(1);
});

test('a failed scanner releases the queue for subsequent work', async () => {
  const seen: string[] = [], errors: unknown[] = [];
  const queue = new ScanQueue(async (r) => { seen.push(r.kind); if (r.kind === 'sessions') throw new Error('failed'); }, (e) => errors.push(e));
  queue.enqueue({ kind: 'sessions', days: 1, source: 'startup' });
  queue.enqueue({ kind: 'usage', days: 1, source: 'page' });
  await Bun.sleep(0);
  expect(seen).toEqual(['sessions', 'usage']);
  expect(errors).toHaveLength(1);
});
