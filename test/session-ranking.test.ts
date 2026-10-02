import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { searchSessionsByContent } from '../src/message-evidence.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

// INV-901: sessions are ranked by how well they match, not by how recently they were touched.
const now = Date.now() - 60_000;

function session(id: string, updatedAt: number, title: string | null = null): SessionRecord {
  return { id, provider: 'claude', nativeId: id, cwd: '/tmp', title, sourceFile: null, startedAt: updatedAt, updatedAt,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: updatedAt };
}

function msg(sessionId: string, seq: number, text: string, timestamp: number): SessionMessageRow {
  return { id: `${sessionId}:${seq}`, sessionId, seq, role: 'assistant', kind: 'text', toolName: null, text, fullText: text,
    parserVersion: 12, timestamp, model: null, inputTokens: null, outputTokens: null };
}

function seeded() {
  const store = openMemoryDb();
  store.upsertSessions([
    session('claude:noisy', now), // most recent, mentions the term in passing hundreds of times
    session('claude:focused', now - 5 * 86_400_000), // older, the actual deployment write-up
    session('claude:titled', now - 9 * 86_400_000, 'involute deployment runbook'), // matched by title only
  ]);
  const noisy = Array.from({ length: 150 }, (_, i) => msg('claude:noisy', i, `filler line ${i} with a long tail of unrelated words and one involute mention`, now - i));
  store.upsertSessionMessages([
    ...noisy,
    msg('claude:focused', 1, 'involute deployment: bump INVOLUTE_IMAGE_TAG, pull, up -d — the involute deployment steps', now - 5 * 86_400_000),
  ]);
  return store;
}

function sessionSearch(store: ReturnType<typeof seeded>, args: Record<string, unknown>): string {
  const response = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_search', arguments: args } });
  if (!response || Array.isArray(response)) throw new Error('one response');
  return (response.result as { content: Array<{ text: string }> }).content[0]!.text;
}

function order(text: string): string[] {
  return [...text.matchAll(/\((claude:[a-z]+)\) —/g)].map((m) => m[1]!);
}

describe('session_search ranks by relevance (INV-901)', () => {
  test('a session with 150 passing mentions does not crowd out the focused one, which ranks first', () => {
    const text = sessionSearch(seeded(), { q: 'involute deployment' });
    expect(order(text)[0]).toBe('claude:focused');
    expect(order(text)).toContain('claude:titled'); // title/project matches take part
    expect(text).toContain('Ranked by the best-matching message');
  });

  test('every matching message counts: the long session reports all its hits', () => {
    const { sessions } = searchSessionsByContent(seeded(), {}, 'involute');
    const noisy = sessions.find((hit) => hit.sessionId === 'claude:noisy');
    expect(noisy?.hits).toBe(150);
    expect(sessions.map((hit) => hit.sessionId)).toContain('claude:focused');
  });

  test('a title match adds weight on top of content', () => {
    const store = seeded();
    store.upsertSessions([session('claude:focused', now - 5 * 86_400_000, 'involute deployment write-up')]);
    expect(order(sessionSearch(store, { q: 'involute deployment' }))[0]).toBe('claude:focused');
  });

  test('exclude still removes the caller from both sides', () => {
    const text = sessionSearch(seeded(), { q: 'involute deployment', exclude: 'claude:focused' });
    expect(order(text)).not.toContain('claude:focused');
  });

  test('short terms rank by hit count and still match every term', () => {
    const store = openMemoryDb();
    store.upsertSessions([session('claude:a', now), session('claude:b', now - 1000)]);
    store.upsertSessionMessages([msg('claude:a', 1, '部署 一次', now), msg('claude:b', 1, '部署 脚本', now), msg('claude:b', 2, '部署 脚本 再来', now)]);
    const text = sessionSearch(store, { q: '部署 脚本' });
    expect(order(text)).toEqual(['claude:b']);
  });
});
