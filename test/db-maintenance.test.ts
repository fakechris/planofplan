import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, openMemoryDb } from '../src/db.ts';
import { collectSessionCatalog } from '../src/sessions.ts';
import type { SessionMessageRow } from '../src/types.ts';

const UUID = 'abcdef01-2345-6789-abcd-ef0123456789';
const SESSION_ID = `claude:${UUID}`;

function msg(partial: Partial<SessionMessageRow> & Pick<SessionMessageRow, 'id' | 'sessionId' | 'text'>): SessionMessageRow {
  return {
    seq: 1, role: 'user', kind: 'text', toolName: null, timestamp: null,
    model: null, inputTokens: null, outputTokens: null,
    ...partial,
  };
}

describe('FTS 只索引用户可见文本', () => {
  test('tool_use 行不进索引,text 行照常可搜', () => {
    const store = openMemoryDb();
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: SESSION_ID, seq: 1, text: '幂等化部署脚本的正文' }),
      msg({ id: 'm2', sessionId: SESSION_ID, seq: 2, role: 'tool', kind: 'tool_use', toolName: 'Edit', text: '{"file_path":"/tmp/幂等化参数.json","command":"ls"}' }),
    ]);
    const hits = store.searchSessionMessages('幂等化部署');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe(SESSION_ID);
    // 工具入参里的 JSON 噪音不再是命中源
    expect(store.searchSessionMessages('file_path')).toHaveLength(0);
  });

  test('删除 tool_use 行不触发 FTS delete(未索引的 rowid),索引不腐化', () => {
    const store = openMemoryDb();
    store.upsertSessionMessages([
      msg({ id: 't1', sessionId: SESSION_ID, seq: 1, role: 'tool', kind: 'tool_use', toolName: 'Bash', text: '{"command":"echo hi"}' }),
      msg({ id: 'm1', sessionId: SESSION_ID, seq: 2, text: '正文锚点' }),
    ]);
    store.deleteSessionMessages(SESSION_ID);
    store.upsertSessionMessages([msg({ id: 'm2', sessionId: SESSION_ID, seq: 3, text: '重建后的正文' })]);
    expect(store.searchSessionMessages('重建后的正文')).toHaveLength(1);
    expect(store.searchSessionMessages('echo')).toHaveLength(0);
  });
});

describe('v11 FTS 瘦身迁移(模拟旧库)', () => {
  test('旧库(全量索引)升级后:消息清空、user_version=11、新写入只索 text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-v11-'));
    const dbPath = join(dir, 'planofplan.db');
    try {
      // 构造旧库:v10 + 无条件触发器 + 已有消息
      const old = openDb(dbPath);
      old.db.exec('DROP TRIGGER session_messages_fts_ai');
      old.db.exec('DROP TRIGGER session_messages_fts_ad');
      old.db.exec('DROP TRIGGER session_messages_fts_au');
      old.db.exec(`CREATE TRIGGER session_messages_fts_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END`);
      old.upsertSessionMessages([
        msg({ id: 'm1', sessionId: SESSION_ID, seq: 1, text: '旧库正文' }),
        msg({ id: 't1', sessionId: SESSION_ID, seq: 2, role: 'tool', kind: 'tool_use', toolName: 'Bash', text: '{"command":"旧库工具"}' }),
      ]);
      expect(old.searchSessionMessages('旧库工具')).toHaveLength(1); // 旧行为:工具入参可搜
      old.db.exec('PRAGMA user_version = 10');
      old.db.close();

      // 重开:迁移 v11 执行——消息保留,索引只含 text 行
      const upgraded = openDb(dbPath);
      const version = (upgraded.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
      expect(version).toBe(12);
      expect(upgraded.countSessionMessages()).toBe(2); // 消息不清,免重扫
      expect(upgraded.searchSessionMessages('旧库正文')).toHaveLength(1);
      expect(upgraded.searchSessionMessages('旧库工具')).toHaveLength(0); // 工具入参退出索引
      upgraded.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('库维护:孤儿水位与保留期', () => {
  function seed(root: string): { store: ReturnType<typeof openMemoryDb>; file: string } {
    const dir = join(root, 'claude', 'projects', '-Users-test-demo');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${UUID}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: '保留期测试的正文内容' }] } })}\n`);
    return { store: openMemoryDb(), file };
  }

  function makeRoots(root: string, extra: Record<string, unknown> = {}) {
    return {
      claudeRoots: [join(root, 'claude', 'projects')],
      codexRoot: join(root, 'codex'),
      grokRoot: join(root, 'grok'),
      dshRoot: join(root, 'dsh'),
      kimiRoot: join(root, 'kimi'),
      droidRoot: join(root, 'factory'),
      zcodeRoot: join(root, 'zcode'),
      since: Date.now() - 86_400_000,
      until: Date.now() + 86_400_000,
      ...extra,
    };
  }

  test('磁盘上不存在的孤儿水位被清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-orphans-'));
    try {
      const { store, file } = seed(root);
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSessionIndexState(file)).not.toBeNull();
      store.upsertSessionIndexState({
        path: '/nonexistent/gone.jsonl', mtimeMs: Date.now(), size: 10,
        parsedBytes: 10, lines: 1, parserVersion: 99,
      });
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSessionIndexState('/nonexistent/gone.jsonl')).toBeNull();
      expect(store.getSessionIndexState(file)).not.toBeNull(); // 真文件的水位不动
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('保留期外的消息/touch/水位被裁,目录行保留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-prune-'));
    try {
      const { store, file } = seed(root);
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.countSessionMessages(SESSION_ID)).toBeGreaterThan(0);
      // 模拟 session 变旧(复用路径不会用旧 mtime 回写 updated_at,直接老化目录行)
      store.db.exec('UPDATE sessions SET updated_at = ? WHERE id = ?', [Date.now() - 100 * 86_400_000, SESSION_ID]);
      await collectSessionCatalog(store, makeRoots(root, { messageRetentionDays: 30 }));
      expect(store.countSessionMessages(SESSION_ID)).toBe(0);
      expect(store.getSession(SESSION_ID)).not.toBeNull(); // 目录行保留
      expect(store.getSessionIndexState(file)).toBeNull(); // 水位同步清
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('messageRetentionDays=0 关闭清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-noprune-'));
    try {
      const { store } = seed(root);
      await collectSessionCatalog(store, makeRoots(root));
      store.db.exec('UPDATE sessions SET updated_at = ? WHERE id = ?', [Date.now() - 100 * 86_400_000, SESSION_ID]);
      await collectSessionCatalog(store, makeRoots(root, { messageRetentionDays: 0 }));
      expect(store.countSessionMessages(SESSION_ID)).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
