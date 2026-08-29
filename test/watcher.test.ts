import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlushScheduler, isRelevantWatchName, startSessionWatcher } from '../src/watcher.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('isRelevantWatchName', () => {
  test('accepts catalog file names', () => {
    expect(isRelevantWatchName('rollout-2026-08-29.jsonl')).toBe(true);
    expect(isRelevantWatchName('session.jsonl.zstd')).toBe(true);
    expect(isRelevantWatchName('state.json')).toBe(true);
    expect(isRelevantWatchName('summary.json')).toBe(true);
    expect(isRelevantWatchName('db.sqlite')).toBe(true);
  });

  test('rejects unrelated noise', () => {
    expect(isRelevantWatchName('todos.json')).toBe(false);
    expect(isRelevantWatchName('screenshot.png')).toBe(false);
    expect(isRelevantWatchName('config.toml')).toBe(false);
    expect(isRelevantWatchName('settings.json')).toBe(false);
  });
});

describe('createFlushScheduler', () => {
  test('coalesces bursts within the quiet window', async () => {
    const flushed: string[][] = [];
    const scheduler = createFlushScheduler((paths) => flushed.push(paths), 60, 1000);
    scheduler.add('/a.jsonl');
    await sleep(20);
    scheduler.add('/b.jsonl');
    await sleep(200);
    scheduler.stop();
    expect(flushed).toEqual([['/a.jsonl', '/b.jsonl']]);
  });

  test('maxWait forces a flush even when writes never go quiet', async () => {
    const flushed: string[][] = [];
    const scheduler = createFlushScheduler((paths) => flushed.push(paths), 500, 120);
    scheduler.add('/a.jsonl');
    for (let i = 0; i < 8; i++) {
      await sleep(30);
      scheduler.add(`/a${i}.jsonl`);
    }
    await sleep(50);
    scheduler.stop();
    // 持续写入等不到静默窗,但 maxWait 到点必须吐出已积压的路径
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed[0].length).toBeGreaterThanOrEqual(2);
  });

  test('stop discards pending paths without flushing', async () => {
    const flushed: string[][] = [];
    const scheduler = createFlushScheduler((paths) => flushed.push(paths), 60, 1000);
    scheduler.add('/a.jsonl');
    scheduler.stop();
    await sleep(150);
    expect(flushed).toEqual([]);
  });
});

describe('startSessionWatcher', () => {
  test('flushes relevant files written under a watched root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-watch-'));
    try {
      const seen: string[] = [];
      const watcher = startSessionWatcher((paths) => seen.push(...paths), [root]);
      if (watcher.roots.length === 0) return; // 平台不支持 recursive watch:降级路径
      expect(watcher.roots).toEqual([root]);
      await sleep(150); // watcher 就绪
      writeFileSync(join(root, 'rollout-1.jsonl'), '{"x":1}\n');
      await sleep(2600); // 静默窗 1.2s + 余量
      watcher.stop();
      expect(seen).toContain(join(root, 'rollout-1.jsonl'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('ignores unrelated file names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-watch-'));
    try {
      let flushed = false;
      const watcher = startSessionWatcher(() => { flushed = true; }, [root]);
      if (watcher.roots.length === 0) return;
      await sleep(150);
      writeFileSync(join(root, 'notes.txt'), 'hi');
      await sleep(1800);
      watcher.stop();
      expect(flushed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
