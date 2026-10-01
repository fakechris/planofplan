import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { wholeMtimeMs } from '../src/mtime.ts';
import { collectSessionCatalog } from '../src/sessions.ts';

const UUID = '0d4c1f6e-0000-4000-8000-00000000abcd';

describe('file mtime precision', () => {
  test('wholeMtimeMs drops the sub-millisecond part Bun 1.4 reports', () => {
    expect(wholeMtimeMs({ mtimeMs: 1790856630202.5386 })).toBe(1790856630202);
    expect(wholeMtimeMs({ mtimeMs: 1790856630202 })).toBe(1790856630202);
  });

  test('an unchanged file with a sub-millisecond mtime is skipped on the next scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-mtime-'));
    try {
      const dir = join(root, 'claude', 'projects', '-Users-test-demo');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${UUID}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'mtime precision' }] } })}\n`);
      // utimes takes seconds; .2025386 s puts a fractional millisecond on the file.
      const seconds = Math.floor(Date.now() / 1000) - 60 + 0.2025386;
      utimesSync(file, seconds, seconds);

      const store = openMemoryDb();
      const roots = {
        claudeRoots: [join(root, 'claude', 'projects')],
        codexRoot: join(root, 'codex'),
        grokRoot: join(root, 'grok'),
        dshRoot: join(root, 'dsh'),
        kimiRoot: join(root, 'kimi'),
        droidRoot: join(root, 'factory'),
        zcodeRoot: join(root, 'zcode'),
        antigravityRoot: join(root, 'antigravity'),
        opencodeRoot: join(root, 'opencode'),
        ampRoot: join(root, 'amp'),
        since: Date.now() - 86_400_000,
        until: Date.now() + 86_400_000,
      };
      await collectSessionCatalog(store, roots);
      const state = store.getSessionIndexState(file);
      expect(Number.isInteger(state?.mtimeMs)).toBe(true);

      let rewrites = 0;
      const upsert = store.upsertSessionMessages.bind(store);
      store.upsertSessionMessages = (rows) => {
        rewrites += rows.length;
        return upsert(rows);
      };
      await collectSessionCatalog(store, roots);
      expect(rewrites).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('src reads file mtimes only through wholeMtimeMs', () => {
    const raw = /statSync\([^)]*\)\.mtimeMs|\b\w*[sS]tat\.mtimeMs\b|\bst\.mtimeMs\b/;
    const offenders = [...new Bun.Glob('src/**/*.ts').scanSync('.')]
      .filter((file) => file !== 'src/mtime.ts')
      .filter((file) => raw.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
