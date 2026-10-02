import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { searchMessageEvidence } from '../src/message-evidence.ts';
import { isFtsQueryError, visibleHighlights } from '../src/message-query.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

// INV-904: what agents read carries no control characters, and only a rejected query falls back.
function seeded() {
  const store = openMemoryDb();
  const now = Date.now() - 1000;
  const session: SessionRecord = { id: 'claude:s1', provider: 'claude', nativeId: 's1', cwd: '/tmp', title: 'deploy notes', sourceFile: null,
    startedAt: now, updatedAt: now, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: 1 };
  store.upsertSessions([session]);
  const row: SessionMessageRow = { id: 'm1', sessionId: 'claude:s1', seq: 1, role: 'user', kind: 'text', toolName: null,
    text: '我们把 involute 部署到 oracle_5 上', fullText: '我们把 involute 部署到 oracle_5 上', parserVersion: 12, timestamp: now, model: null, inputTokens: null, outputTokens: null };
  store.upsertSessionMessages([row]);
  return store;
}

function sessionSearchText(store: ReturnType<typeof seeded>, q: string): string {
  const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_search', arguments: { q } } });
  if (!response || Array.isArray(response)) throw new Error('one response');
  return (response.result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('search output for agents (INV-904)', () => {
  for (const q of ['involute', 'oracle_5 部署', '部署']) {
    test(`"${q}": snippets mark hits «visibly» and carry no control characters`, () => {
      const store = seeded();
      const snippet = searchMessageEvidence(store, { q }).items[0]!.snippet as string;
      expect(snippet).not.toMatch(/[\u0001\u0002]/);
      expect(snippet).toMatch(/«[^»]+»/);
      const text = sessionSearchText(store, q);
      expect(text).not.toMatch(/[\u0001\u0002]/);
      expect(text).toMatch(/content hit: .*«[^»]+»/);
    });
  }

  test('an error that is not the query being rejected is not hidden behind a LIKE scan', () => {
    const store = seeded();
    store.db.exec('DROP TABLE session_messages_fts');
    expect(() => searchMessageEvidence(store, { q: 'involute' })).toThrow(/no such table/);
    expect(() => store.searchSessionMessages('involute')).toThrow(/no such table/);
  });

  test('which errors count as the query being rejected', () => {
    expect(isFtsQueryError(new Error('fts5: syntax error near "AND"'))).toBe(true);
    expect(isFtsQueryError(new Error('unterminated string'))).toBe(true);
    expect(isFtsQueryError(new Error('database is locked'))).toBe(false);
    expect(isFtsQueryError(new Error('no such table: session_messages_fts'))).toBe(false);
    expect(visibleHighlights('a\u0001b\u0002c')).toBe('a«b»c');
  });
});
