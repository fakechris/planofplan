/**
 * OpenCode 2 (v2.0.x) storage, as defined in its source at tag v2.0.21:
 * packages/core/src/session/sql.ts (session_v2, session_message) and
 * packages/schema/src/session-message.ts (message data shapes). The v1→v2
 * migration copies old sessions into session_v2 with INSERT OR IGNORE and
 * leaves the legacy tables in place.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  extractOpencodeDb,
  messagesFromOpencodeDb,
  touchesFromOpencodeDb,
  turnsFromOpencodeDb,
} from '../src/opencode-session.ts';

const SESSION_COLUMNS = `
  id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT,
  title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER,
  tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0`;

function seedV2(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (${SESSION_COLUMNS});
    CREATE TABLE session_v2 (${SESSION_COLUMNS});
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL
    );
  `);
  const insert = (table: string, row: unknown[]) =>
    db.query(`INSERT INTO ${table} (id, parent_id, directory, title, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...(row as never[]));
  // ses_old was migrated: the legacy row is stale, session_v2 holds the current one.
  insert('session', ['ses_old', null, '/w/old', 'Old title', 1, 2, 1, 1, 0]);
  insert('session_v2', ['ses_old', null, '/w/old', 'Fix the parser', 1, 50, 100, 40, 10]);
  // ses_new only exists in v2; a v2 title may be null.
  insert('session_v2', ['ses_new', null, '/w/repo', null, 10, 90, 7, 3, 0]);

  const message = (seq: number, type: string, data: unknown, created: number) =>
    db.query('INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`msg_${seq}`, 'ses_new', type, seq, created, JSON.stringify(data));
  // time_created deliberately out of seq order: seq is the session's order.
  message(1, 'user', { text: 'Rename the config loader', files: [], time: { created: 30 } }, 30);
  message(2, 'assistant', {
    agent: 'build',
    model: { id: 'm', providerID: 'p' },
    content: [
      { type: 'reasoning', text: 'private chain of thought' },
      { type: 'text', text: 'I will edit the loader.' },
      {
        type: 'tool', id: 't1', name: 'edit',
        state: { status: 'completed', input: { filePath: 'src/loader.ts', oldString: 'a', newString: 'b' }, content: [{ type: 'text', text: 'ok' }] },
        time: { created: 21 },
      },
    ],
    tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
    time: { created: 20 },
  }, 20);
  message(3, 'system', { text: '<system-reminder>context</system-reminder>', time: { created: 10 } }, 10);
  message(4, 'shell', { shellID: 'sh1', command: 'bun test', status: 'completed', output: 'pass', time: { created: 40 } }, 40);
  db.close();
}

describe('OpenCode 2 (session_v2 / session_message)', () => {
  test('sessions come from session_v2, which wins over a stale legacy row', () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-opencode-v2-'));
    const dbPath = join(root, 'opencode.db');
    try {
      seedV2(dbPath);
      const rows = extractOpencodeDb(dbPath, Date.now());
      expect(rows.map((row) => row.nativeId).sort()).toEqual(['ses_new', 'ses_old']);
      const old = rows.find((row) => row.nativeId === 'ses_old');
      expect(old?.title).toBe('Fix the parser');
      expect(old?.totalTokens).toBe(150);
      expect(old?.updatedAt).toBe(50);
      const fresh = rows.find((row) => row.nativeId === 'ses_new');
      expect(fresh?.title).toBeNull();
      expect(fresh?.cwd).toBe('/w/repo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('messages follow seq; assistant text and tool calls are indexed, reasoning and system text are not', () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-opencode-v2-'));
    const dbPath = join(root, 'opencode.db');
    try {
      seedV2(dbPath);
      const rows = messagesFromOpencodeDb(dbPath, 'ses_new', 'opencode:ses_new');
      expect(rows.map((row) => [row.role, row.kind, row.toolName ?? null, row.text])).toEqual([
        ['user', 'text', null, 'Rename the config loader'],
        ['assistant', 'text', null, 'I will edit the loader.'],
        ['tool', 'tool_use', 'edit', expect.stringContaining('src/loader.ts')],
        ['tool', 'tool_use', 'bash', 'bun test'],
      ]);
      expect(rows.some((row) => row.text.includes('private chain of thought'))).toBe(false);
      expect(rows.some((row) => row.text.includes('system-reminder'))).toBe(false);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('file touches and transcript turns are read from session_message too', () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-opencode-v2-'));
    const dbPath = join(root, 'opencode.db');
    try {
      seedV2(dbPath);
      const touches = touchesFromOpencodeDb(dbPath, 'ses_new', 'opencode:ses_new', '/w/repo');
      expect(touches.map((touch) => [touch.toolName, touch.filePath])).toEqual([['edit', '/w/repo/src/loader.ts']]);

      const turns = turnsFromOpencodeDb(dbPath, 'ses_new');
      expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
      expect(turns[0]?.text).toBe('Rename the config loader');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a session whose v2 rows are all filtered does not fall back to legacy parts', () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-opencode-v2-'));
    const dbPath = join(root, 'opencode.db');
    try {
      seedV2(dbPath);
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `);
      db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run('m_old', 'ses_old', 1, JSON.stringify({ role: 'user' }));
      db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p_old', 'm_old', 'ses_old', 1, JSON.stringify({ type: 'text', text: 'legacy copy' }));
      db.query('INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('msg_sys', 'ses_old', 'system', 1, 1, JSON.stringify({ text: 'injected' }));
      db.close();

      expect(messagesFromOpencodeDb(dbPath, 'ses_old', 'opencode:ses_old')).toEqual([]);
      expect(turnsFromOpencodeDb(dbPath, 'ses_old')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
