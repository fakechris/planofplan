import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDb, openMemoryDb, SNAPSHOT_RETENTION_DAYS } from '../src/db.ts';
import type { QuotaWindow, SessionMessageRow, UsageRecord } from '../src/types.ts';

function dbOf(store: unknown): Database {
  return (store as { db: Database }).db;
}

/** FTS 外部内容表的 COUNT(*) 会读穿到内容表,不能用来度量索引条目;
 *  用 MATCH 短语探测某段文本是否真的被索引。 */
function ftsHas(store: unknown, phrase: string): boolean {
  const rows = dbOf(store).query(
    `SELECT rowid FROM session_messages_fts WHERE session_messages_fts MATCH ?`,
  ).all(`"${phrase}"`);
  return rows.length > 0;
}

function msg(partial: Partial<SessionMessageRow> & Pick<SessionMessageRow, 'id' | 'sessionId'>): SessionMessageRow {
  return {
    seq: 1,
    role: 'user',
    kind: 'text',
    toolName: null,
    text: '默认正文',
    timestamp: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    ...partial,
  };
}

const DAY = 86_400_000;

describe('FTS 触发器:kind 迁移保持索引一致', () => {
  test('text→tool_use 退出索引,tool_use→text 进入索引', () => {
    const store = openMemoryDb();
    try {
      store.upsertSessionMessages([msg({ id: 'm1', sessionId: 's1', text: '用户的真实需求正文' })]);
      expect(ftsHas(store, '真实需求正文')).toBe(true);
      // 改判为 tool_use:旧触发器在这里把行留在索引里
      store.upsertSessionMessages([msg({ id: 'm1', sessionId: 's1', kind: 'tool_use', text: '工具入参 JSON 片段' })]);
      expect(ftsHas(store, '真实需求正文')).toBe(false);
      expect(ftsHas(store, '工具入参')).toBe(false);
      // 反向:tool_use 修正回 text,要进索引
      store.upsertSessionMessages([msg({ id: 'm1', sessionId: 's1', kind: 'text', text: '修正回用户正文' })]);
      expect(ftsHas(store, '修正回用户正文')).toBe(true);
      expect(store.searchSessionMessages('修正回用户正文').length).toBe(1);
    } finally { store.close(); }
  });
});

describe('v14 迁移:FTS 重建 + 部分索引', () => {
  test('清除历史泄漏行,只索引非 tool_use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planofplan-v14-'));
    const path = join(dir, 't.db');
    try {
      let store = openDb(path);
      store.upsertSessionMessages([
        msg({ id: 'm1', sessionId: 's1', text: '正常用户正文内容' }),
        msg({ id: 'm2', sessionId: 's1', kind: 'tool_use', text: '工具入参 JSON 噪音数据' }),
      ]);
      // 模拟旧触发器泄漏:tool_use 行被灌进索引(线上低量存在的历史残留)
      dbOf(store).exec(`INSERT INTO session_messages_fts(rowid, text)
        SELECT rowid, text FROM session_messages WHERE kind = 'tool_use'`);
      expect(ftsHas(store, '工具入参')).toBe(true);
      dbOf(store).exec('PRAGMA user_version = 13');
      store.close();

      // 重开触发 v14+v15
      store = openDb(path);
      expect(store.getUserVersion()).toBe(15);
      expect(ftsHas(store, '工具入参')).toBe(false);
      expect(ftsHas(store, '正常用户正文内容')).toBe(true);
      expect(store.searchSessionMessages('工具入参')).toEqual([]);
      expect(store.searchSessionMessages('正常用户正文内容').length).toBe(1);
      const idx = dbOf(store).query(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_messages_user_text'`,
      ).get() as { n: number };
      expect(idx.n).toBe(1);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('重扫去 churn', () => {
  test('内容未变零写,变化才落库', () => {
    const store = openMemoryDb();
    try {
      const rows = [
        msg({ id: 'm1', sessionId: 's1', seq: 1, text: '第一条' }),
        msg({ id: 'm2', sessionId: 's1', seq: 2, text: '第二条' }),
      ];
      expect(store.upsertSessionMessages(rows)).toBe(2);
      // 全量重扫(内容一致):零写
      expect(store.upsertSessionMessages(rows.map((row) => ({ ...row })))).toBe(0);
      // 只有一行变了:只写一行
      const changed = rows.map((row) => ({ ...row }));
      changed[1].text = '第二条改写了';
      expect(store.upsertSessionMessages(changed)).toBe(1);
      const text = dbOf(store).query('SELECT text FROM session_messages WHERE id = ?').get('m2') as { text: string };
      expect(text.text).toBe('第二条改写了');
      // full_text/parser_version 变化也要算变化(分支引入的列)
      const withMeta = changed.map((row) => ({ ...row, parserVersion: 7 }));
      expect(store.upsertSessionMessages(withMeta)).toBe(2);
    } finally { store.close(); }
  });
});

describe('snapshots 保留期', () => {
  test('pruneSnapshotsBefore 只清快照,不动 usage_records', () => {
    const store = openMemoryDb();
    try {
      const win: QuotaWindow = { window: 'rolling_5h', label: '5H', used: 1, total: 100, unit: 'percent', percentage: 1, resetAt: null, note: null };
      store.insertWindows('p', [win], Date.now() - (SNAPSHOT_RETENTION_DAYS + 5) * DAY);
      store.insertWindows('p', [{ ...win }], Date.now());
      const usage: UsageRecord = {
        id: 'u1', day: '2026-09-17', timestamp: Date.now() - 200 * DAY,
        provider: 'claude', model: 'claude-opus-4',
        inputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0,
        outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2, billableTokens: null,
        estimatedCostUsd: null, source: 'local', confidence: 'measured',
      };
      store.upsertUsageRecords([usage]);
      const pruned = store.pruneSnapshotsBefore(Date.now() - SNAPSHOT_RETENTION_DAYS * DAY);
      expect(pruned).toBe(1);
      const snaps = dbOf(store).query('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number };
      expect(snaps.n).toBe(1);
      const usages = dbOf(store).query('SELECT COUNT(*) AS n FROM usage_records').get() as { n: number };
      expect(usages.n).toBe(1);
    } finally { store.close(); }
  });
});

describe('optimizeSearchIndex', () => {
  test('churn 后合并死段,索引仍可用', () => {
    const store = openMemoryDb();
    try {
      store.upsertSessionMessages([msg({ id: 'm1', sessionId: 's1', text: '合并前正文内容' })]);
      for (let i = 0; i < 5; i++) {
        store.upsertSessionMessages([msg({ id: 'm1', sessionId: 's1', text: `合并前正文内容${i}` })]);
      }
      store.optimizeSearchIndex();
      expect(store.searchSessionMessages('合并前正文内容').length).toBe(1);
    } finally { store.close(); }
  });
});
