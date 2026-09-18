import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';
import { createRateGate } from '../src/watcher.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

function sessionRow(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id'>): SessionRecord {
  // 时间往后挪一分钟:列表窗口是 updatedAt < until 的严格判断,
  // 用当下时间会和请求落在同一毫秒,被窗口过滤造成偶发丢行。
  const now = Date.now() - 60_000;
  return {
    provider: partial.id!.split(':')[0],
    nativeId: partial.id!.split(':')[1] ?? partial.id!,
    cwd: null,
    title: null,
    sourceFile: null,
    startedAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: now,
    ...partial,
  };
}

function messageRow(partial: Partial<SessionMessageRow> & Pick<SessionMessageRow, 'id' | 'sessionId' | 'text'>): SessionMessageRow {
  return {
    seq: 1,
    role: 'user',
    kind: 'text',
    toolName: null,
    timestamp: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    ...partial,
  };
}

describe('listSessionUserTextsFor', () => {
  test('只取指定 session 的用户文本,空集零查询', () => {
    const store = openMemoryDb();
    try {
      store.upsertSessions([
        sessionRow({ id: 'claude:aaa1' }),
        sessionRow({ id: 'claude:bbb2' }),
      ]);
      store.upsertSessionMessages([
        messageRow({ id: 'm1', sessionId: 'claude:aaa1', seq: 1, text: '第一个需求' }),
        messageRow({ id: 'm2', sessionId: 'claude:aaa1', seq: 2, text: '补充说明' }),
        // tool_use 即便是 user role 也不算用户文本
        messageRow({ id: 'm3', sessionId: 'claude:aaa1', seq: 3, kind: 'tool_use', text: '工具入参' }),
        messageRow({ id: 'm4', sessionId: 'claude:bbb2', seq: 1, text: '另一个会话的需求' }),
      ]);
      const only = store.listSessionUserTextsFor(['claude:bbb2']);
      expect(only.size).toBe(1);
      expect(only.get('claude:bbb2')).toEqual(['另一个会话的需求']);
      expect(store.listSessionUserTextsFor([]).size).toBe(0);
      const both = store.listSessionUserTextsFor(['claude:aaa1', 'claude:bbb2']);
      expect(both.get('claude:aaa1')).toEqual(['第一个需求', '补充说明']);
      // 与全量版语义一致
      expect(store.listSessionUserTexts().get('claude:aaa1')).toEqual(both.get('claude:aaa1'));
    } finally { store.close(); }
  });
});

describe('/api/sessions 需求兜底', () => {
  test('非 user 来源且无实体的行走按需兜底,user 行保持 null', async () => {
    const store = openMemoryDb();
    try {
      store.upsertSessions([
        sessionRow({ id: 'claude:aaa1' }),
        sessionRow({ id: 'claude:bbb2', origin: 'subagent' }),
      ]);
      store.upsertSessionMessages([
        messageRow({ id: 'm1', sessionId: 'claude:bbb2', seq: 1, text: '派工:修复登录态刷新的回归问题' }),
      ]);
      const app = createServer(store, {} as never, { port: 9291, plans: [] }, { startupScan: false });
      const res = await app.request('http://localhost/api/sessions?subagents=1');
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions: Array<{ id: string; requirement: string | null }> };
      const byId = new Map(body.sessions.map((row) => [row.id, row]));
      expect(body.sessions.map((row) => row.id)).toContain('claude:bbb2');
      expect(byId.get('claude:bbb2')?.requirement).toBe('派工:修复登录态刷新的回归问题');
      expect(byId.get('claude:aaa1')?.requirement).toBeNull();
    } finally { store.close(); }
  });
});

describe('/api/sessions 底料缓存', () => {
  test('TTL 内只查一次,星标写入立即失效', async () => {
    const store = openMemoryDb();
    try {
      store.upsertSessions([sessionRow({ id: 'claude:aaa1' })]);
      let reads = 0;
      const original = store.listSessionRows.bind(store);
      store.listSessionRows = () => { reads++; return original(); };
      const app = createServer(store, {} as never, { port: 9291, plans: [] }, { startupScan: false });
      await app.request('http://localhost/api/sessions');
      await app.request('http://localhost/api/sessions?days=7');
      expect(reads).toBe(1);
      const star = await app.request('http://localhost/api/sessions/claude:aaa1/star', {
        method: 'POST',
        body: JSON.stringify({ starred: true }),
        headers: { 'content-type': 'application/json' },
      });
      expect(star.status).toBe(200);
      const listRes = await app.request('http://localhost/api/sessions');
      const body = await listRes.json() as { sessions: Array<{ id: string; starred?: boolean }> };
      expect(reads).toBe(2);
      expect(body.sessions.find((row) => row.id === 'claude:aaa1')?.starred).toBe(true);
    } finally { store.close(); }
  });
});

describe('createRateGate', () => {
  test('冷启动立即触发,冷却期内合并为一次 trailing,窗口过后放行', async () => {
    let fires = 0;
    const gate = createRateGate(40, () => fires++);
    gate();
    expect(fires).toBe(1);
    gate();
    gate();
    expect(fires).toBe(1);
    await Bun.sleep(70);
    expect(fires).toBe(2);
    await Bun.sleep(60); // 距上次触发(含 trailing)已过一个完整冷却窗
    gate();
    expect(fires).toBe(3);
  });
});
