import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  openMemoryDb,
  snapshotRetentionDays,
  SPACE_RECLAIM_THRESHOLD_BYTES,
} from '../src/db.ts';
import { collectSessionCatalog } from '../src/sessions.ts';
import { messagesFromZcodeDb } from '../src/transcript.ts';
import { commitWitnessesFromZcodeDb } from '../src/commit-witness.ts';
import { touchesFromOpencodeDb } from '../src/opencode-session.ts';
import { materializeRequirements } from '../src/requirements.ts';
import type { QuotaWindow, UsageRecord, SessionMessageRow } from '../src/types.ts';

const DAY = 86_400_000;

function win(label: string): QuotaWindow {
  return { window: 'rolling_5h', label, used: 1, total: 100, unit: 'percent', percentage: 1, resetAt: null, note: null };
}

function localUsage(id: string, timestamp: number): UsageRecord {
  return {
    id, day: '2026-10-23', timestamp, provider: 'claude', model: 'claude-opus-4',
    inputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 0,
    outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2, billableTokens: null,
    estimatedCostUsd: null, source: 'local', confidence: 'measured',
  };
}

function msg(partial: Partial<SessionMessageRow> & Pick<SessionMessageRow, 'id' | 'sessionId' | 'text'>): SessionMessageRow {
  return {
    seq: 1, role: 'user', kind: 'text', toolName: null, timestamp: null,
    model: null, inputTokens: null, outputTokens: null,
    ...partial,
  };
}

describe('INV-1329 maintenance_state 键值表', () => {
  test('读写往返;不存在返回 null;upsert 覆盖', () => {
    const store = openMemoryDb();
    try {
      expect(store.getMaintenanceState('db.autovacuum')).toBeNull();
      store.setMaintenanceState('db.autovacuum', 'incremental');
      expect(store.getMaintenanceState('db.autovacuum')).toBe('incremental');
      store.setMaintenanceState('db.autovacuum', 'other');
      expect(store.getMaintenanceState('db.autovacuum')).toBe('other');
    } finally { store.close(); }
  });
});

describe('INV-1329 快照保留期配置', () => {
  test('默认 90;环境变量可调;非法值回落 90', () => {
    const prev = process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS;
    try {
      delete process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS;
      expect(snapshotRetentionDays()).toBe(90);
      process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS = '30';
      expect(snapshotRetentionDays()).toBe(30);
      process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS = 'not-a-number';
      expect(snapshotRetentionDays()).toBe(90);
      process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS = '-5';
      expect(snapshotRetentionDays()).toBe(90);
    } finally {
      if (prev === undefined) delete process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS;
      else process.env.PLANOFPLAN_SNAPSHOT_RETENTION_DAYS = prev;
    }
  });

  test('pruneSnapshotsBefore 分批删除:跨批次清干净,只动过期行', () => {
    const store = openMemoryDb();
    try {
      const now = Date.now();
      for (let i = 0; i < 12; i += 1) store.insertWindows('p', [win(`old-${i}`)], now - 100 * DAY);
      for (let i = 0; i < 3; i += 1) store.insertWindows('p', [win(`new-${i}`)], now);
      const pruned = store.pruneSnapshotsBefore(now - 90 * DAY, 5);
      expect(pruned).toBe(12);
      const n = store.db.query('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number };
      expect(n.n).toBe(3);
      // 再跑一次:没有过期行,返回 0(batchSize 边界不误删)
      expect(store.pruneSnapshotsBefore(now - 90 * DAY, 5)).toBe(0);
    } finally { store.close(); }
  });
});

describe('INV-1329 空间回收', () => {
  test('空闲页超阈值:一次性 VACUUM 激活 incremental 并回收;标记落 maintenance_state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-reclaim-'));
    const store = openDb(join(dir, 'planofplan.db'));
    try {
      // 制造空闲页:写入大批消息后删除(FTS churn 同款路径)
      for (let round = 0; round < 4; round += 1) {
        const batch: SessionMessageRow[] = [];
        for (let i = 0; i < 400; i += 1) {
          batch.push(msg({
            id: `r${round}-m${i}`, sessionId: 'claude:x', seq: round * 400 + i,
            text: '内存治理样本正文'.repeat(200),
          }));
        }
        store.upsertSessionMessages(batch);
        store.deleteSessionMessages('claude:x');
      }
      const before = store.freelistBytes();
      expect(before).toBeGreaterThan(1024);
      // 阈值压到 1KB 触发回收
      const r1 = store.reclaimDbSpace(1024);
      expect(r1.skipped).toBe(false);
      expect(r1.afterBytes).toBeLessThan(r1.beforeBytes);
      expect(store.getMaintenanceState('db.autovacuum')).toBe('incremental');
      // 回收后空闲页低于默认阈值:常态扫描零成本跳过
      const r2 = store.reclaimDbSpace();
      expect(r2.skipped).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('默认阈值 256MB:健康库(小空闲页)不会被 VACUUM', () => {
    expect(SPACE_RECLAIM_THRESHOLD_BYTES).toBe(256 * 1024 * 1024);
    const store = openMemoryDb();
    try {
      store.upsertSessionMessages([msg({ id: 'm1', sessionId: 'claude:x', seq: 1, text: 'tiny' })]);
      expect(store.reclaimDbSpace().skipped).toBe(true);
    } finally { store.close(); }
  });

  test('walCheckpoint:写入后截断 WAL,不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-wal-'));
    const store = openDb(join(dir, 'planofplan.db'));
    try {
      store.insertWindows('p', [win('w')], Date.now());
      const ok = store.walCheckpoint();
      expect(typeof ok).toBe('boolean');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('INV-1329 流式迭代器', () => {
  test('iterateUsageRecords 与 getUsageRecords 等价', () => {
    const store = openMemoryDb();
    try {
      const now = Date.now();
      const records: UsageRecord[] = [];
      for (let i = 0; i < 50; i += 1) records.push(localUsage(`u${i}`, now - i * 1000));
      store.upsertUsageRecords(records);
      const streamed = [...store.iterateUsageRecords(now - 60_000, now + 1)];
      const batched = store.getUsageRecords(now - 60_000, now + 1);
      expect(streamed).toEqual(batched);
      expect(streamed.length).toBe(50);
    } finally { store.close(); }
  });

  test('iterateUserMessageRows 与 listUserMessageRows 等价(按 session 分组连续)', () => {
    const store = openMemoryDb();
    try {
      for (const sid of ['claude:a', 'claude:b']) {
        store.upsertSessionMessages([
          msg({ id: `${sid}:1`, sessionId: sid, seq: 1, text: '第一条' }),
          msg({ id: `${sid}:2`, sessionId: sid, seq: 2, text: '第二条' }),
        ]);
      }
      expect([...store.iterateUserMessageRows()]).toEqual(store.listUserMessageRows());
    } finally { store.close(); }
  });
});

describe('INV-1329 zcode/opencode 共享只读连接', () => {
  function buildZcodeFixture(path: string): void {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE session (
        id text primary key, title text, directory text, path text,
        parent_id text, time_created integer, time_updated integer
      );
      CREATE TABLE message (
        id text primary key, session_id text, time_created integer, data text
      );
      CREATE TABLE part (
        id text primary key, message_id text, session_id text,
        time_created integer, time_updated integer, data text, sequence integer
      );
    `);
    // 时间戳用当前纪元毫秒:过老的消息会被扫描收尾的保留期裁剪删掉
    const t0 = Date.now() - 60_000;
    db.query(`INSERT INTO session VALUES ('s1', '标题', '/tmp/w', '/tmp/w', NULL, ${t0}, ${t0 + 1})`).run();
    db.query(`INSERT INTO message VALUES ('m1', 's1', ${t0}, ?)`).run(JSON.stringify({ role: 'user' }));
    db.query(`INSERT INTO message VALUES ('m2', 's1', ${t0 + 100}, ?)`).run(JSON.stringify({ role: 'assistant' }));
    db.query(`INSERT INTO part VALUES ('p1', 'm1', 's1', ${t0}, ${t0}, ?, 0)`).run(
      JSON.stringify({ type: 'text', text: '帮我重构扫描引擎' }),
    );
    db.query(`INSERT INTO part VALUES ('p2', 'm2', 's1', ${t0 + 100}, ${t0 + 100}, ?, 0)`).run(
      // touch 抽取的键位是 file_path(filePathOfInput 的匹配列表)
      JSON.stringify({ type: 'tool', tool: 'Edit', state: { input: { file_path: '/tmp/w/a.ts' } } }),
    );
    db.query(`INSERT INTO part VALUES ('p3', 'm2', 's1', ${t0 + 200}, ${t0 + 200}, ?, 1)`).run(
      JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'git commit -m x' }, output: '[main abc1234def] x', time: t0 + 200 } }),
    );
    db.close();
  }

  test('三个抽取器:共享连接输出与自开路径完全一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-zcode-conn-'));
    const dbPath = join(dir, 'db.sqlite');
    try {
      buildZcodeFixture(dbPath);
      const shared = new Database(dbPath, { readonly: true });
      try {
        expect(messagesFromZcodeDb(dbPath, 's1', 'zcode:s1', shared))
          .toEqual(messagesFromZcodeDb(dbPath, 's1', 'zcode:s1'));
        expect(touchesFromOpencodeDb(dbPath, 's1', 'zcode:s1', null, shared))
          .toEqual(touchesFromOpencodeDb(dbPath, 's1', 'zcode:s1', null));
        expect(commitWitnessesFromZcodeDb(dbPath, 's1', 'zcode:s1', shared))
          .toEqual(commitWitnessesFromZcodeDb(dbPath, 's1', 'zcode:s1'));
        // 抽取物本身有效:消息、touch、witness 都非空
        expect(messagesFromZcodeDb(dbPath, 's1', 'zcode:s1', shared).length).toBeGreaterThan(0);
        expect(touchesFromOpencodeDb(dbPath, 's1', 'zcode:s1', null, shared).length).toBeGreaterThan(0);
        expect(commitWitnessesFromZcodeDb(dbPath, 's1', 'zcode:s1', shared).length).toBeGreaterThan(0);
        // 共享连接用完仍可继续查询(调用方负责生命周期)
        expect(shared.query('SELECT COUNT(*) AS n FROM part').get()).toEqual({ n: 3 });
      } finally {
        shared.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('zcode 目录扫描走文件级事务入库:消息/touch/witness 全量落库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-zcode-scan-'));
    const store = openMemoryDb();
    try {
      mkdirSync(join(dir, 'db'), { recursive: true });
      buildZcodeFixture(join(dir, 'db', 'db.sqlite'));
      await collectSessionCatalog(store, {
        since: Date.now() - DAY,
        until: Date.now() + 1000,
        claudeRoots: [join(dir, 'none-c')],
        codexRoot: join(dir, 'none-x'),
        grokRoot: join(dir, 'none-g'),
        dshRoot: join(dir, 'none-d'),
        kimiRoot: join(dir, 'none-k'),
        droidRoot: join(dir, 'none-f'),
        zcodeRoot: join(dir),
        antigravityRoot: join(dir, 'none-a'),
        opencodeRoot: join(dir, 'none-o'),
        ampRoot: join(dir, 'none-m'),
      });
      const session = store.getSession('zcode:s1');
      expect(session).not.toBeNull();
      expect(session?.cwd).toBe('/tmp/w');
      const messages = store.db
        .query('SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?')
        .get('zcode:s1') as { n: number };
      expect(messages.n).toBeGreaterThan(0);
      const touches = store.db
        .query('SELECT COUNT(*) AS n FROM session_file_touches WHERE session_id = ?')
        .get('zcode:s1') as { n: number };
      expect(touches.n).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('INV-1329 分块落库', () => {
  test('超过单批(256)的目录行分多批 upsert,终态完整不丢行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-flush-'));
    const store = openMemoryDb();
    const claudeRoot = join(dir, 'claude', '-proj');
    try {
      mkdirSync(claudeRoot, { recursive: true });
      const TOTAL = 300; // 跨过 256 的分块边界
      for (let i = 0; i < TOTAL; i += 1) {
        const uuid = `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`;
        writeFileSync(
          join(claudeRoot, `${uuid}.jsonl`),
          `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-23T10:00:00.000Z', message: { content: [{ type: 'text', text: `会话 ${i} 的首条消息` }] }, cwd: `/tmp/p${i}` })}\n`,
        );
      }
      await collectSessionCatalog(store, {
        since: Date.now() - DAY,
        until: Date.now() + 1000,
        claudeRoots: [join(dir, 'claude')],
        codexRoot: join(dir, 'none-x'),
        grokRoot: join(dir, 'none-g'),
        dshRoot: join(dir, 'none-d'),
        kimiRoot: join(dir, 'none-k'),
        droidRoot: join(dir, 'none-f'),
        zcodeRoot: join(dir, 'none-z'),
        antigravityRoot: join(dir, 'none-a'),
        opencodeRoot: join(dir, 'none-o'),
        ampRoot: join(dir, 'none-m'),
      });
      const n = store.db
        .query("SELECT COUNT(*) AS n FROM sessions WHERE provider = 'claude'")
        .get() as { n: number };
      expect(n.n).toBe(TOTAL);
      // 再扫一轮(全量走复用行路径 + 分块):行数不重复不丢失
      await collectSessionCatalog(store, {
        since: Date.now() - DAY,
        until: Date.now() + 1000,
        claudeRoots: [join(dir, 'claude')],
        codexRoot: join(dir, 'none-x'),
        grokRoot: join(dir, 'none-g'),
        dshRoot: join(dir, 'none-d'),
        kimiRoot: join(dir, 'none-k'),
        droidRoot: join(dir, 'none-f'),
        zcodeRoot: join(dir, 'none-z'),
        antigravityRoot: join(dir, 'none-a'),
        opencodeRoot: join(dir, 'none-o'),
        ampRoot: join(dir, 'none-m'),
      });
      const n2 = store.db
        .query("SELECT COUNT(*) AS n FROM sessions WHERE provider = 'claude'")
        .get() as { n: number };
      expect(n2.n).toBe(TOTAL);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('INV-1329 requirements 流式物化', () => {
  test('多 session 用户消息流式派生:输出与需求表终态正确', () => {
    const store = openMemoryDb();
    try {
      const now = Date.now();
      store.upsertSessions([
        { id: 'claude:a', provider: 'claude', nativeId: 'a', cwd: null, title: null, sourceFile: '/a.jsonl', startedAt: now, updatedAt: now, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: now },
        { id: 'claude:b', provider: 'claude', nativeId: 'b', cwd: null, title: null, sourceFile: '/b.jsonl', startedAt: now, updatedAt: now, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: now },
      ]);
      store.upsertSessionMessages([
        msg({ id: 'claude:a:1', sessionId: 'claude:a', seq: 1, text: '请实现用户导出功能,支持 CSV' }),
        msg({ id: 'claude:a:2', sessionId: 'claude:a', seq: 2, text: '继续' }),
        msg({ id: 'claude:b:1', sessionId: 'claude:b', seq: 1, text: '请增加按月统计的用量报表功能' }),
      ]);
      const count = materializeRequirements(store);
      expect(count).toBeGreaterThan(0);
      const texts = (store.db.query('SELECT text FROM requirements ORDER BY session_id, seq').all() as Array<{ text: string }>)
        .map((r) => r.text);
      expect(texts.some((t) => t.includes('用户导出'))).toBe(true);
      expect(texts.some((t) => t.includes('用量报表'))).toBe(true);
      // 幂等:再物化一次,行数不变
      expect(materializeRequirements(store)).toBe(count);
    } finally { store.close(); }
  });
});
