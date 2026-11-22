import { describe, expect, test } from 'bun:test';
import { openDb, openMemoryDb } from '../src/db.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** INV-2010:多进程/多连接并发写 planofplan.db 的 SQLITE_BUSY 与残留事务风暴。 */
describe('withTransaction 自愈（INV-2010）', () => {
  test('孤儿事务：BEGIN 残留后下一次 withTransaction 自动清场成功', () => {
    const store = openMemoryDb();
    // 表先在自动提交态建好(孤儿事务里的未提交内容本就应被回滚清掉)
    store.db.exec('CREATE TABLE selfheal_probe (k TEXT)');
    // 直接在底层连接上制造残留事务(模拟上一轮 ROLLBACK 被 BUSY 打断后的状态)
    store.db.exec('BEGIN');
    // 此前这里会抛 "cannot start a transaction within a transaction"
    expect(() =>
      store.withTransaction(() => {
        store.db.query('INSERT INTO selfheal_probe (k) VALUES (?)').run('ok');
      }),
    ).not.toThrow();
    const rows = store.db.query('SELECT k FROM selfheal_probe').all() as Array<{ k: string }>;
    expect(rows).toEqual([{ k: 'ok' }]);
  });

  test('work 抛错 + ROLLBACK 也被打断：txDepth 语义恢复，下一次事务正常', () => {
    const store = openMemoryDb();
    store.db.exec('CREATE TABLE probe2 (k TEXT)');
    // 第一轮:work 抛错,且污染连接(ROLLBACK 吞错后残留由自愈清场)
    expect(() =>
      store.withTransaction(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // 自愈路径:残留(如有)被清,事务照常工作
    store.withTransaction(() => {
      store.db.query('INSERT INTO probe2 (k) VALUES (?)').run('after');
    });
    const rows = store.db.query('SELECT k FROM probe2').all() as Array<{ k: string }>;
    expect(rows).toEqual([{ k: 'after' }]);
  });
});

describe('跨进程并发写（WAL + busy_timeout 排队，INV-2010）', () => {
  test('子进程持写锁 500ms 时本连接排队等待而非立抛 SQLITE_BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planofplan-busy-'));
    const dbPath = join(dir, 'test.db');
    try {
      // 主连接先建表(WAL 由 openDb 设置,子进程继承库级 journal_mode)
      const main = openDb(dbPath);
      main.db.exec('CREATE TABLE race (k TEXT)');
      main.db.exec('INSERT INTO race (k) VALUES (\'seed\')');
      main.db.close();

      // 子进程:BEGIN IMMEDIATE 持写锁 500ms 后提交(真实跨进程持锁者,
      // 同线程的 setTimeout 会被主连接的忙等阻塞,模拟不了多进程)
      const child = Bun.spawn([
        process.execPath, '-e',
        `const { Database } = require('bun:sqlite');
         const db = new Database(${JSON.stringify(dbPath)});
         db.exec('PRAGMA busy_timeout = 2000');
         db.exec('BEGIN IMMEDIATE');
         db.query('INSERT INTO race (k) VALUES (?)').run('a-hold');
         await new Promise((r) => setTimeout(r, 500));
         db.exec('COMMIT');
         db.close();`,
      ], { stdout: 'ignore', stderr: 'inherit' });

      // 等子进程拿到写锁
      await new Promise((r) => setTimeout(r, 150));
      const b = openDb(dbPath);
      const started = Date.now();
      // busy_timeout(15s)内排队:子进程 500ms 提交后本事务成功
      b.withTransaction(() => {
        b.db.query('INSERT INTO race (k) VALUES (?)').run('b-win');
      });
      const waited = Date.now() - started;
      await child.exited;
      expect(waited).toBeGreaterThanOrEqual(200); // 确实排队等了持锁者
      const rows = b.db.query('SELECT k FROM race ORDER BY rowid').all() as Array<{ k: string }>;
      expect(rows.map((r) => r.k)).toEqual(['seed', 'a-hold', 'b-win']);
      b.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
