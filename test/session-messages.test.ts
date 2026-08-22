import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { collectSessionCatalog, sessionKey } from '../src/sessions.ts';
import { messagesFromRecords, messagesFromZcodeDb } from '../src/transcript.ts';
import type { SessionMessageRow } from '../src/types.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-messages-'));
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
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

describe('messagesFromRecords extractors', () => {
  test('claude: uuid 做 id,tool_use 入参入库,tool_result 正文跳过', () => {
    const rows = messagesFromRecords('claude', 'claude:s1', [
      { type: 'user', uuid: 'u1', timestamp: '2026-08-20T01:00:00.000Z', message: { content: [{ type: 'text', text: '修复登录态刷新' }] } },
      {
        type: 'assistant',
        uuid: 'u2',
        message: {
          model: 'claude-opus-4',
          usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
          content: [
            { type: 'text', text: '先看代码' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '很大的文件内容不应该入库' },
          ],
        },
      },
      { type: 'system', subtype: 'turn_duration' },
    ]);
    expect(rows.map((row) => `${row.role}:${row.kind}`)).toEqual(['user:text', 'assistant:text', 'tool:tool_use']);
    expect(rows[0]?.id).toBe('claude:s1:u1');
    expect(rows[0]?.timestamp).toBe(Date.parse('2026-08-20T01:00:00.000Z'));
    expect(rows[1]?.model).toBe('claude-opus-4');
    expect(rows[1]?.inputTokens).toBe(100);
    expect(rows[1]?.outputTokens).toBe(5);
    expect(rows[2]?.id).toBe('claude:s1:u2:toolu_1');
    expect(rows[2]?.toolName).toBe('Read');
    // tool_result 的“很大的文件内容”不应出现在任何行里
    expect(rows.some((row) => row.text.includes('很大的文件内容'))).toBe(false);
  });

  test('claude: tool_use 入参截到 2K,正文截到 10K', () => {
    const rows = messagesFromRecords('claude', 'claude:s1', [
      {
        type: 'assistant',
        uuid: 'u1',
        message: {
          content: [
            { type: 'text', text: 'x'.repeat(20_000) },
            { type: 'tool_use', id: 't1', name: 'Write', input: { content: 'y'.repeat(5_000) } },
          ],
        },
      },
    ]);
    expect(rows[0]?.text.length).toBeLessThanOrEqual(10_001);
    expect(rows[1]?.text.length).toBeLessThanOrEqual(2_001);
  });

  test('codex: 无消息 id 时用行号合成(左补零)', () => {
    const rows = messagesFromRecords('codex', 'codex:t1', [
      { type: 'session_meta', payload: { id: 't1' } },
      { type: 'response_item', timestamp: '2026-08-20T01:00:00.000Z', payload: { role: 'user', content: [{ text: '排查配额接口' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: '不应入库的工具输出' } },
    ], 1);
    expect(rows.map((row) => row.id)).toEqual(['codex:t1:000002', 'codex:t1:000003']);
    expect(rows[0]?.role).toBe('user');
    expect(rows[1]?.toolName).toBe('exec_command');
    expect(rows.some((row) => row.text.includes('不应入库'))).toBe(false);
  });

  test('kimi: wire.jsonl 的 append_message 与 loop_event', () => {
    const rows = messagesFromRecords('kimi', 'kimi:s1', [
      { type: 'metadata', protocol_version: '1.5' },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '整理会话索引' }] } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: '不该入库的思考' } } },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '先扫描目录' } } },
      { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', args: { command: 'ls' } } },
    ]);
    expect(rows.map((row) => `${row.role}:${row.kind}`)).toEqual(['user:text', 'assistant:text', 'tool:tool_use']);
    expect(rows.some((row) => row.text.includes('不该入库'))).toBe(false);
  });

  test('zcode: part id 做消息 id', () => {
    // messagesFromZcodeDb 走真实 sqlite,这里用内存库构造最小 part/message 结构
    const root = tempRoot();
    try {
      const { Database } = require('bun:sqlite');
      const dbPath = join(root, 'db.sqlite');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, time_created INTEGER);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, time_created INTEGER);
        INSERT INTO message VALUES ('m1', 's1', 'user', 100);
        INSERT INTO part (id, message_id, session_id, sequence, time_created) VALUES
          ('p1', 'm1', 's1', 0, 100);
      `);
      db.query('UPDATE part SET id = ? WHERE id = ?').run('p1', 'p1');
      db.close();
      // part.data / message.data 是 JSON 字符串列,重建为真实形态
      const db2 = new Database(dbPath);
      db2.exec('ALTER TABLE part ADD COLUMN data TEXT');
      db2.exec('ALTER TABLE message ADD COLUMN data TEXT');
      db2.query('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify({ type: 'text', text: '查看本地用量' }), 'p1');
      db2.query('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify({ role: 'user' }), 'm1');
      db2.close();
      const rows = messagesFromZcodeDb(dbPath, 's1', 'zcode:s1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('zcode:s1:p1');
      expect(rows[0]?.text).toBe('查看本地用量');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('session message FTS search', () => {
  function storeWithMessages() {
    const store = openMemoryDb();
    store.upsertSessionMessages([
      messageRow({ id: 'claude:s1:u1', sessionId: 'claude:s1', text: '修复登录态刷新的竞态问题' }),
      messageRow({ id: 'claude:s1:u2', sessionId: 'claude:s1', text: '又聊到登录态刷新的重试' }),
      messageRow({ id: 'codex:s2:000001', sessionId: 'codex:s2', text: '调整菜单栏的刷新间隔' }),
    ]);
    return store;
  }

  test('trigram:3 字中文查询命中并带标记片段', () => {
    const store = storeWithMessages();
    const hits = store.searchSessionMessages('登录态刷新');
    const hit = hits.find((row) => row.sessionId === 'claude:s1');
    expect(hit).toBeDefined();
    expect(hit?.count).toBe(2);
    expect(hit?.snippet).toContain('\u0001');
    expect(hits.some((row) => row.sessionId === 'codex:s2')).toBe(false);
  });

  test('2 字查询回退 LIKE 也能命中', () => {
    const store = storeWithMessages();
    const hits = store.searchSessionMessages('登录');
    expect(hits.some((row) => row.sessionId === 'claude:s1')).toBe(true);
  });

  test('FTS 语法坏字符不炸,回退 LIKE', () => {
    const store = storeWithMessages();
    expect(() => store.searchSessionMessages('登录 NEAR/"')).not.toThrow();
  });

  test('deleteSession 级联删除消息', () => {
    const store = storeWithMessages();
    expect(store.countSessionMessages('claude:s1')).toBe(2);
    store.deleteSession('claude:s1');
    expect(store.countSessionMessages('claude:s1')).toBe(0);
    expect(store.searchSessionMessages('登录态刷新')).toHaveLength(0);
  });
});

describe('collectSessionCatalog message indexing', () => {
  const claudeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function makeRoots(root: string) {
    return {
      since: Date.now() - 86_400_000,
      until: Date.now() + 1000,
      claudeRoots: [join(root, 'claude')],
      codexRoot: join(root, 'missing-codex'),
      grokRoot: join(root, 'missing-grok'),
      dshRoot: join(root, 'missing-dsh'),
      kimiRoot: join(root, 'missing-kimi'),
      droidRoot: join(root, 'missing-factory'),
      zcodeRoot: join(root, 'missing-zcode'),
    };
  }

  test('追加行只增量续扫,截断后全量重扫,删文件级联清理', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    const dir = join(root, 'claude');
    const file = join(dir, `${claudeId}.jsonl`);
    const sessionId = sessionKey('claude', claudeId);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, jsonl([
        { type: 'user', uuid: 'u1', timestamp: '2026-08-20T01:00:00.000Z', message: { content: [{ type: 'text', text: '第一版需求:做会话目录' }] }, cwd: '/tmp/demo' },
      ]));
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.countSessionMessages(sessionId)).toBe(1);
      const first = store.getSessionIndexState(file);
      expect(first).not.toBeNull();
      expect(first?.lines).toBe(1);
      expect(first?.parsedBytes).toBeGreaterThan(0);

      // 追加两行:增量续扫,水位前进,老消息不动
      appendFileSync(file, jsonl([
        { type: 'assistant', uuid: 'u2', timestamp: '2026-08-20T01:01:00.000Z', message: { content: [{ type: 'text', text: '开始实现增量索引' }] } },
        { type: 'user', uuid: 'u3', timestamp: '2026-08-20T01:02:00.000Z', message: { content: [{ type: 'text', text: '再加上中文搜索' }] } },
      ]));
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.countSessionMessages(sessionId)).toBe(3);
      const second = store.getSessionIndexState(file);
      expect(second?.lines).toBe(3);
      expect(second!.parsedBytes).toBeGreaterThan(first!.parsedBytes);

      // 文件被截断重写(size 缩小):全量重扫,旧 seq 的消息不残留
      writeFileSync(file, jsonl([
        { type: 'user', uuid: 'v1', timestamp: '2026-08-20T02:00:00.000Z', message: { content: [{ type: 'text', text: '重写后的会话' }] }, cwd: '/tmp/demo' },
      ]));
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.countSessionMessages(sessionId)).toBe(1);
      expect(store.searchSessionMessages('重写后的会话')).toHaveLength(1);
      expect(store.searchSessionMessages('第一版需求')).toHaveLength(0);

      // 源文件删除:session 连带消息清掉
      rmSync(file);
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(sessionId)).toBeNull();
      expect(store.countSessionMessages(sessionId)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mtime 未变时整体跳过(不重建消息)', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    const dir = join(root, 'claude');
    const file = join(dir, `${claudeId}.jsonl`);
    const sessionId = sessionKey('claude', claudeId);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, jsonl([
        { type: 'user', uuid: 'u1', timestamp: '2026-08-20T01:00:00.000Z', message: { content: [{ type: 'text', text: '跳过验证' }] }, cwd: '/tmp/demo' },
      ]));
      const first = await collectSessionCatalog(store, makeRoots(root));
      expect(first).toBe(1);
      const second = await collectSessionCatalog(store, makeRoots(root));
      expect(second).toBe(0);
      expect(store.countSessionMessages(sessionId)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
