import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, openMemoryDb } from '../src/db.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { commandOfToolInput } from '../src/message-query.ts';
import { messagesFromRecords, toolRow } from '../src/transcript.ts';
import type { SessionRecord } from '../src/types.ts';

// INV-900: what ran is searchable; other tool input is not.
function session(id: string): SessionRecord {
  return { id, provider: 'claude', nativeId: id, cwd: '/tmp', title: null, sourceFile: null, startedAt: 1, updatedAt: 1,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: 1 };
}

function call(store: ReturnType<typeof openMemoryDb>, name: string, args: Record<string, unknown>) {
  const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (!response || Array.isArray(response)) throw new Error('one response');
  return JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text);
}

function seeded() {
  const store = openMemoryDb();
  store.upsertSessions([session('claude:s1')]);
  store.upsertSessionMessages(messagesFromRecords('claude', 'claude:s1', [
    { type: 'assistant', uuid: 'a1', timestamp: '2026-09-28T09:00:00Z', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: "ssh oracle_5 'cd /opt/involute && sed -i s/^INVOLUTE_IMAGE_TAG=.*/INVOLUTE_IMAGE_TAG=sha-abc/ .env.production'", description: 'bump tag' } },
      { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/tmp/notes.md', content: 'a long body about INVOLUTE_IMAGE_TAG that is not a command' } },
    ] } },
  ]));
  return store;
}

describe('commands that ran are searchable (INV-900)', () => {
  test('a shell command is found by message_search, labelled tool_use with its tool name', () => {
    const body = call(seeded(), 'message_search', { q: 'INVOLUTE_IMAGE_TAG' });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: 'tool_use', role: 'tool' });
    expect(body.items[0].source_ref.session_id).toBe('claude:s1');
  });

  test('kind=tool_use narrows to commands instead of returning nothing', () => {
    const store = seeded();
    expect(call(store, 'message_search', { q: '/opt/involute', kind: 'tool_use' }).items).toHaveLength(1);
    expect(call(store, 'message_search', { q: '/opt/involute', kind: 'text' }).items).toHaveLength(0);
  });

  test('Write bodies stay out of the index, on the FTS path and the LIKE path', () => {
    const store = seeded();
    expect(call(store, 'message_search', { q: 'not a command' }).items).toHaveLength(0);
    expect(store.searchSessionMessages('not a command')).toHaveLength(0);
    expect(call(store, 'message_search', { q: 'a long' }).items).toHaveLength(0); // all-short-terms LIKE path
  });

  test('the web API finds the command too, and session_search names the session', () => {
    const store = seeded();
    expect(store.searchSessionMessages('opt/involute').map((hit) => hit.sessionId)).toEqual(['claude:s1']);
    expect(call(store, 'message_search', { q: 'sha-abc' }).items[0].source_ref.session_id).toBe('claude:s1');
  });

  test('read_message returns the whole input, not only the command', () => {
    const store = seeded();
    const ref = call(store, 'message_search', { q: 'INVOLUTE_IMAGE_TAG' }).items[0].source_ref;
    const read = call(store, 'read_message', { source_ref: ref });
    expect(JSON.stringify(read)).toContain('bump tag');
  });

  test('the command is extracted from each shape providers use', () => {
    expect(commandOfToolInput({ command: 'ls -la' })).toBe('ls -la');
    expect(commandOfToolInput({ cmd: 'sed -n 1,5p x' })).toBe('sed -n 1,5p x');
    expect(commandOfToolInput({ command: ['git', 'status'] })).toBe('git status');
    expect(commandOfToolInput('{"command":"echo hi"}')).toBe('echo hi'); // opencode passes JSON text
    expect(commandOfToolInput('const p = await tools.exec_command({cmd:"ls"})')).toContain('exec_command'); // codex code mode
    expect(commandOfToolInput({ file_path: '/x' })).toBeNull();
    expect(toolRow('s', 'i', 1, 'exec_command', { cmd: 'ls' }, 1).text).toBe('ls');
    expect(toolRow('s', 'i', 1, 'Edit', { file_path: '/x' }, 1).fullText ?? null).toBeNull();
  });

  test('a database with the old triggers is rebuilt on open: commands become searchable, others stay out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-triggers-'));
    try {
      const path = join(dir, 'planofplan.db');
      const old = openDb(path);
      for (const name of ['ai', 'ad', 'au']) old.db.exec(`DROP TRIGGER session_messages_fts_${name}`);
      old.db.exec(`CREATE TRIGGER session_messages_fts_ai AFTER INSERT ON session_messages WHEN new.kind != 'tool_use' BEGIN
        INSERT INTO session_messages_fts(rowid, text) VALUES (new.rowid, new.text); END`);
      old.db.exec(`INSERT INTO session_messages (id, session_id, seq, role, kind, tool_name, text, timestamp)
        VALUES ('t1', 'claude:s1', 1, 'tool', 'tool_use', 'Bash', 'docker compose pull server', 1),
               ('t2', 'claude:s1', 2, 'tool', 'tool_use', 'Write', 'docker compose notes body', 2)`);
      expect(old.searchSessionMessages('docker compose')).toHaveLength(0);
      old.close();

      const upgraded = openDb(path);
      const hits = upgraded.db.query(`SELECT m.id FROM session_messages_fts f JOIN session_messages m ON m.rowid = f.rowid
        WHERE session_messages_fts MATCH '"docker compose"'`).all() as Array<{ id: string }>;
      expect(hits.map((hit) => hit.id)).toEqual(['t1']);
      expect(upgraded.ensureSearchTriggers()).toBe(false); // already current: no second rebuild
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
