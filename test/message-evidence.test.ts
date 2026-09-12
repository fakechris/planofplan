import { describe, expect, test } from 'bun:test';
import { openDb, openMemoryDb } from '../src/db.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { messagesFromRecords } from '../src/transcript.ts';
import { createServer } from '../src/server.ts';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = 'claude:evidence';
const TEXT = '保留换行\n```ts\n' + 'x'.repeat(12500) + '\n```\n关键尾部🙂';
function fixture() {
  const store = openMemoryDb();
  const ts = Date.now() - 1000;
  store.upsertSessions([{ id: SID, provider: 'claude', nativeId: 'evidence', cwd: '/repo/alpha', title: 'evidence', sourceFile: null, startedAt: ts, updatedAt: ts, seenAt: ts, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null }]);
  store.upsertSessionMessages(messagesFromRecords('claude', SID, [{ type: 'assistant', uuid: 'long', timestamp: new Date(ts).toISOString(), message: { content: [{ type: 'text', text: TEXT }] } }], 42));
  return store;
}
function call(store: ReturnType<typeof openMemoryDb>, name: string, args: Record<string, unknown>) {
  const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (!response || Array.isArray(response)) throw new Error('Expected one response');
  expect(response.error).toBeUndefined();
  const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text);
}

describe('message evidence public interfaces', () => {
  test('legacy schema migration preserves user metadata and reports excerpt completeness honestly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'message-evidence-v12-'));
    const path = join(dir, 'index.db');
    const original = fixture();
    let store = openDb(path);
    try {
      store.upsertSessions([original.getSession(SID)!]);
      store.upsertSessionMessages([{ id: 'legacy', sessionId: SID, seq: 8, role: 'user', kind: 'text', toolName: null, text: 'legacy searchable excerpt…', timestamp: null, model: null, inputTokens: null, outputTokens: null }]);
      store.setSessionStar(SID, true);
      store.db.exec('ALTER TABLE session_messages DROP COLUMN full_text');
      store.db.exec('ALTER TABLE session_messages DROP COLUMN parser_version');
      store.setUserVersion(12);
      store.close();
      store = openDb(path);
      expect(store.getSessionUserMetaMap().get(SID)?.starred).toBe(true);
      const ref = call(store, 'message_search', { q: 'searchable' }).items[0].source_ref;
      expect(ref.parser_version).toBeNull();
      const result = call(store, 'read_message', { source_ref: ref });
      expect(result.content_complete).toBe(false);
      expect(result.warnings.join(' ')).toContain('excerpt');
      expect(result.text).toBe('legacy searchable excerpt…');
    } finally { original.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('missing original logs require explicit archived-snapshot reading and never mutate L0', async () => {
    const store = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'message-evidence-source-'));
    try {
      const path = join(dir, 'source.jsonl');
      writeFileSync(path, 'immutable original source');
      store.upsertSessions([{ ...store.getSession(SID)!, sourceFile: path }]);
      const ref = call(store, 'message_search', { q: '保留换行' }).items[0].source_ref;
      expect(call(store, 'read_message', { source_ref: ref }).source_status).toBe('present_unverified');
      expect(readFileSync(path, 'utf8')).toBe('immutable original source');
      const stat = statSync(path);
      store.upsertSessionIndexState({ path, size: stat.size, mtimeMs: stat.mtimeMs, parsedBytes: stat.size, lines: 1, parserVersion: 8 });
      expect(call(store, 'read_message', { source_ref: ref }).source_status).toBe('indexed_metadata_matches');
      writeFileSync(path, 'changed externally after indexing');
      const changed = call(store, 'read_message', { source_ref: ref });
      expect(changed.source_status).toBe('changed_since_index');
      expect(changed.source_ref).toEqual(ref);
      expect(changed.warnings.join(' ')).toContain('not a fresh read');
      rmSync(path);
      const app = createServer(store, {} as never, { port: 9291, plans: [] });
      const read = await app.request('http://localhost/api/messages/read?source_ref=' + encodeURIComponent(JSON.stringify(ref)));
      expect(read.status).toBe(404);
      expect((await read.json() as any).error.code).toBe('SOURCE_MISSING');
      const archived = call(store, 'read_message', { source_ref: ref, allow_archived: true });
      expect(archived.source_status).toBe('missing');
      expect(call(store, 'read_message', { cursor: archived.next_cursor }).text).toBe(TEXT.slice(4000, 8000));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('HTTP search and read share references, filtering and stale-version errors with MCP', async () => {
    const store = fixture();
    try {
      const app = createServer(store, {} as never, { port: 9291, plans: [] });
      const search = await app.request('http://localhost/api/messages/search?q=' + encodeURIComponent('保留换行'));
      expect(search.status).toBe(200);
      const ref = (await search.json() as any).items[0].source_ref;
      const read = await app.request('http://localhost/api/messages/read?source_ref=' + encodeURIComponent(JSON.stringify(ref)));
      expect(read.status).toBe(200);
      expect((await read.json() as any).text).toContain('保留换行\n```ts');
      store.upsertSessionMessages(messagesFromRecords('claude', SID, [{ type: 'assistant', uuid: 'long', message: { content: [{ type: 'text', text: 'a different message after source replacement' }] } }], 42));
      const stale = await app.request('http://localhost/api/messages/read?source_ref=' + encodeURIComponent(JSON.stringify(ref)));
      expect(stale.status).toBe(409);
      expect((await stale.json() as any).error.code).toBe('STALE_SOURCE');
      store.setSessionHidden(SID, true);
      expect((await app.request('http://localhost/api/messages/read?source_ref=' + encodeURIComponent(JSON.stringify(ref)))).status).toBe(404);
    } finally { store.close(); }
  });
  test('legacy session_search adds message references and respects project filters for metadata hits', () => {
    const store = fixture();
    try {
      store.upsertSessions([{ ...store.getSession(SID)!, id: 'claude:beta', nativeId: 'beta', cwd: '/repo/beta', title: '保留换行 beta' }]);
      const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_search', arguments: { q: '保留换行', project: '/repo/alpha', role: 'assistant' } } }) as any;
      const text = response.result.content[0].text as string;
      expect(text).not.toContain('claude:beta');
      expect(text).toContain('source_ref=');
      expect(text).toContain(`${SID}:long`);
    } finally { store.close(); }
  });
  test('existing read_session exposes the same source reference regardless of role pagination', () => {
    const store = fixture();
    try {
      store.upsertSessionMessages(messagesFromRecords('claude', SID, [{ type: 'user', uuid: 'before', message: { content: [{ type: 'text', text: 'user message' }] } }], 1));
      const read = (args: Record<string, unknown>) => {
        const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_session', arguments: { session_id: SID, ...args } } }) as any;
        return response.result.content[0].text as string;
      };
      const text = read({ role: 'assistant' });
      expect(text).toContain('filtered ordinal');
      const refs = (s: string) => [...s.matchAll(/source_ref=(\{[^\n]+\})/g)].map((m) => JSON.parse(m[1]!));
      const ref = refs(text)[0];
      expect(ref.source_seq).toBe(42);
      expect(ref).toEqual(refs(read({})).find((r) => r.message_id === ref.message_id));
      expect(call(store, 'read_message', { source_ref: ref, char_start: 12500 }).text).toContain('关键尾部');
    } finally { store.close(); }
  });
  test('search reports FTS versus short-query fallback and supports message-level continuation', () => {
    const store = fixture();
    try {
      store.upsertSessionMessages(messagesFromRecords('claude', SID, [{ type: 'user', uuid: 'second', message: { content: [{ type: 'text', text: '保留换行 second hit' }] } }], 80));
      const first = call(store, 'message_search', { q: '保留换行', limit: 1 });
      expect(first.search_mode).toBe('fts5');
      expect(first.truncated).toBe(true);
      const second = call(store, 'message_search', { q: '保留换行', limit: 1, offset: first.next_offset });
      expect(second.items[0].source_ref.message_id).not.toBe(first.items[0].source_ref.message_id);
      expect(second.next_offset).toBeNull();
      expect(call(store, 'message_search', { q: '保留' }).search_mode).toBe('like_short_query');
    } finally { store.close(); }
  });
  test('project/provider/role/time/exclude filters apply before limiting hits and also during read', () => {
    const store = fixture();
    try {
      const target = store.getSession(SID)!;
      const other = 'codex:other';
      store.upsertSessions([{ ...target, id: other, nativeId: 'other', provider: 'codex', cwd: '/repo/beta' }]);
      store.upsertSessionMessages(Array.from({ length: 110 }, (_, i) => ({ id: `${other}:${i}`, sessionId: other, seq: i, role: 'user' as const, kind: 'text' as const, toolName: null, text: '保留换行', fullText: '保留换行', timestamp: Date.now(), model: null, inputTokens: null, outputTokens: null })));
      const filters = { project: '/repo/alpha', provider: 'claude', role: 'assistant', since: target.updatedAt - 1000, until: target.updatedAt + 1, exclude: other };
      const hits = call(store, 'message_search', { q: '保留换行', ...filters, limit: 1 });
      expect(hits.items).toHaveLength(1);
      expect(hits.items[0].source_ref.session_id).toBe(SID);
      expect(hits.truncated).toBe(false);
      const ref = hits.items[0].source_ref;
      for (const wrong of [{ project: '/repo/beta' }, { provider: 'codex' }, { role: 'user' }, { since: Date.now() + 1000 }, { exclude: SID }]) {
        expect(call(store, 'message_search', { q: '保留换行', ...filters, ...wrong }).items).toEqual([]);
        const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_message', arguments: { source_ref: ref, ...wrong } } }) as any;
        expect(response.result.isError).toBe(true);
      }
    } finally { store.close(); }
  });
  test('hidden messages cannot be searched or recovered with a previously issued reference', () => {
    const store = fixture();
    try {
      const ref = call(store, 'message_search', { q: '保留换行' }).items[0].source_ref;
      const cursor = call(store, 'read_message', { source_ref: ref }).next_cursor;
      store.setSessionHidden(SID, true);
      expect(call(store, 'message_search', { q: '保留换行' }).items).toEqual([]);
      const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_message', arguments: { source_ref: ref } } }) as any;
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).not.toContain('关键尾部');
      store.setSessionHidden(SID, false);
      store.tombstoneSession(SID, null);
      const deleted = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_message', arguments: { cursor, allow_archived: true } } }) as any;
      expect(deleted.result.isError).toBe(true);
      expect(deleted.result.content[0].text).not.toContain('关键尾部');
      expect(call(store, 'message_search', { q: '保留换行' }).items).toEqual([]);
    } finally { store.close(); }
  });
  test('search reference recovers a complete long message, including newlines and the tail', () => {
    const store = fixture();
    try {
      const hits = call(store, 'message_search', { q: '保留换行' });
      const ref = hits.items[0].source_ref;
      expect(ref.message_id).toBe(`${SID}:long`);
      expect(ref.source_seq).toBe(42);
      expect(ref.provider).toBe('claude');
      expect(ref.source_revision).toMatch(/^sha256:/);
      expect(ref.parser_version).toBeGreaterThan(7);
      let result = call(store, 'read_message', { source_ref: ref, char_limit: 2000 });
      let text = result.text;
      while (result.next_cursor) {
        result = call(store, 'read_message', { cursor: result.next_cursor, char_limit: 2000 });
        text += result.text;
      }
      expect(text).toBe(TEXT);
      expect(result.content_complete).toBe(true);
      expect(result.truncated).toBe(false);
    } finally { store.close(); }
  });
});
