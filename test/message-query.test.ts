import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { planMessageQuery } from '../src/message-query.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

// INV-899: under the trigram tokenizer a term shorter than three characters matched
// nothing alone and was silently dropped from a multi-term AND.
const corpus: Array<[string, string]> = [
  ['s1', '这是部署脚本的说明'], // 部署 + 脚本
  ['s2', '只有部署,没有别的'], // 部署 only
  ['s3', '一个脚本文件'], // 脚本 only
  ['s4', 'git 回滚到上一个版本'], // git + 回滚
  ['s5', 'git status 看一下'], // git only
  ['s6', '在 oracle_5 上部署'], // oracle_5 + 部署
  ['s7', 'ssh oracle_5 查看日志'], // oracle_5 only
];

function store() {
  const s = openMemoryDb();
  const sessions: SessionRecord[] = corpus.map(([id]) => ({ id: `claude:${id}`, provider: 'claude', nativeId: id, cwd: '/tmp', title: null,
    sourceFile: null, startedAt: 1, updatedAt: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: 1 }));
  s.upsertSessions(sessions);
  s.upsertSessionMessages(corpus.map(([id, text], i): SessionMessageRow => ({ id: `m-${id}`, sessionId: `claude:${id}`, seq: i, role: 'user',
    kind: 'text', toolName: null, text, fullText: text, parserVersion: 9, timestamp: i + 1, model: null, inputTokens: null, outputTokens: null })));
  return s;
}

/** What "every term present" means, computed without the index. */
function expected(query: string): string[] {
  const terms = query.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  return corpus.filter(([, text]) => terms.every((t) => text.toLowerCase().includes(t))).map(([id]) => `claude:${id}`).sort();
}

function viaMcp(s: ReturnType<typeof store>, q: string): { ids: string[]; mode: string } {
  const response = handleMcpBody(s, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message_search', arguments: { q, limit: 100 } } });
  if (!response || Array.isArray(response)) throw new Error('one response');
  const body = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text);
  return { ids: [...new Set<string>(body.items.map((item: { source_ref: { session_id: string } }) => item.source_ref.session_id))].sort(), mode: body.search_mode };
}

describe('every term of a query is required (INV-899)', () => {
  for (const q of ['部署 脚本', 'git 回滚', 'oracle_5 部署', '部署', 'oracle_5', '回滚 git status']) {
    test(`"${q}" matches exactly the messages containing every term`, () => {
      const s = store();
      expect(viaMcp(s, q).ids).toEqual(expected(q));
      expect(s.searchSessionMessages(q).map((hit) => hit.sessionId).sort()).toEqual(expected(q));
    });
  }

  test('the four reported counterexamples', () => {
    const s = store();
    expect(viaMcp(s, '部署 脚本').ids).toEqual(['claude:s1']); // was 0
    expect(viaMcp(s, 'git 回滚').ids).toEqual(['claude:s4']); // was every "git"
    expect(viaMcp(s, 'oracle_5 部署').ids).toEqual(['claude:s6']); // was every "oracle_5"
    expect(viaMcp(s, '部署').ids).toEqual(['claude:s1', 'claude:s2', 'claude:s6']);
  });

  test('search_mode says how it ran', () => {
    const s = store();
    expect(viaMcp(s, 'oracle_5').mode).toBe('fts5');
    expect(viaMcp(s, 'oracle_5 部署').mode).toBe('fts5+like');
    expect(viaMcp(s, '部署 脚本').mode).toBe('like_short_query');
  });

  test('LIKE metacharacters in a short term are literal', () => {
    expect(planMessageQuery('a% b_').likes).toEqual(['%a\\%%', '%b\\_%']);
  });
});
