import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  SUPPORTED_DEVIN_SCHEMA_VERSION,
  extractDevinSessionFile,
  openDevinSqlite,
  parseDevinMessages,
  readDevinMessageStoreIndex,
} from '../src/devin-session.ts';
import { collectSessionCatalog, sessionKey } from '../src/sessions.ts';
import { openMemoryDb } from '../src/db.ts';

/**
 * fixture：2026-11-20 实测 payload 形状的脱敏样本（真实结构，虚构内容；
 * 不含真实 token/邮箱/session id）。
 */
const UUID = '83f5aabb00112233445566778899aabbccddeeff';
const SESSION_ID = 'devin-aaaabbbbccccddddeeeeffff00001111';
const INDEX_KEY =
  'windsurf.acp.messageStore.session.acp/devin-cloud/devin-session-cache/1/test-user/account-0123456789abcdef0123456789abcdef/devin-cloud/' +
  SESSION_ID;

const USER_MSG = {
  kind: 'user_message',
  content: [
    {
      messageId: 'event-u1',
      content: { text: '帮我审一下 LumenBox 的录像权限改动', type: 'text' },
      _meta: {
        'cognition.ai/eventId': 'event-u1',
        'cognition.ai/timestamp': '2026-11-20T10:35:40.000Z',
        'cognition.ai/createdAtMs': 1_795_170_940_000,
        'cognition.ai/eventType': 'user_message',
      },
    },
  ],
};

const AGENT_MSG = {
  kind: 'agent_message',
  content: [
    {
      content: { text: '三件事都处理完了，PR 已就绪等审。', type: 'text' },
      messageId: 'event-a1',
      _meta: {
        'cognition.ai/eventId': 'event-a1',
        'cognition.ai/timestamp': '2026-11-20T08:06:27.841Z',
        'cognition.ai/createdAtMs': 1_795_170_987_841,
      },
    },
  ],
};

const TOOL_MSG = {
  id: 'tool:event-t1',
  kind: 'tool_call',
  content: {
    toolCallId: 'event-t1',
    title: 'session analysis: completed',
    kind: 'other',
    status: 'completed',
    _meta: {
      'cognition.ai/eventId': 'event-t1',
      'cognition.ai/timestamp': '2026-11-20T13:23:35.109701+00:00',
      'cognition.ai/createdAtMs': 1_795_181_015_110,
      'cognition.ai/eventType': 'session_analysis',
    },
  },
};

const ACU_MSG = {
  id: 'tool:event-acu1',
  kind: 'tool_call',
  content: {
    toolCallId: 'event-acu1',
    title: 'ACU usage reset',
    kind: 'other',
    status: 'completed',
    _meta: {
      'cognition.ai/eventId': 'event-acu1',
      'cognition.ai/timestamp': '2026-11-20T13:26:36.098000Z',
      'cognition.ai/createdAtMs': 1_795_181_041_098,
      'cognition.ai/eventType': 'acu_consumption_at_last_user_interaction',
      'cognition.ai/acuAmount': 0,
    },
  },
};

const PROGRESS_MSG = { kind: 'progress_marker', content: [] };

const SKELETON_FIRST_MS = 1_795_078_317_000; // 早于缓存窗口的会话起点（2026-11-19）

function makeAcpDb(
  root: string,
  { schemaVersion = SUPPORTED_DEVIN_SCHEMA_VERSION, withIndex = true }: { schemaVersion?: number; withIndex?: boolean } = {},
): string {
  const acpDir = join(root, 'User', 'acp-messages');
  mkdirSync(acpDir, { recursive: true });
  const db = new Database(join(acpDir, `${UUID}.db`));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE messages (position INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)');
  db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(schemaVersion));
  db.query('INSERT INTO meta (key, value) VALUES (?, ?)').run(
    'history_skeleton',
    JSON.stringify({ items: [{ id: 'event-s0', type: 'devin_message', created_at_ms: SKELETON_FIRST_MS }] }),
  );
  const rows: Array<[number, string, string]> = [
    [0, 'agent_message', JSON.stringify(AGENT_MSG)],
    [1, 'user_message', JSON.stringify(USER_MSG)],
    [2, 'tool_call', JSON.stringify(TOOL_MSG)],
    [3, 'tool_call', JSON.stringify(ACU_MSG)],
    [4, 'progress_marker', JSON.stringify(PROGRESS_MSG)],
  ];
  for (const [pos, kind, payload] of rows) {
    db.query('INSERT INTO messages (position, kind, payload) VALUES (?, ?, ?)').run(pos, kind, payload);
  }
  db.close();
  if (withIndex) {
    const gsDir = join(root, 'User', 'globalStorage');
    mkdirSync(gsDir, { recursive: true });
    const state = new Database(join(gsDir, 'state.vscdb'));
    state.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    state.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      INDEX_KEY,
      JSON.stringify({ uuid: UUID, lastUpdated: 1_795_181_041_098 }),
    );
    state.close();
  }
  return join(acpDir, `${UUID}.db`);
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-devin-'));
}

describe('parseDevinMessages', () => {
  test('user/agent/tool 行、ACU 事件如实入 tool 行、progress_marker 跳过', () => {
    const root = tempRoot();
    try {
      const path = makeAcpDb(root);
      const handle = openDevinSqlite(path)!;
      try {
        const sessionId = sessionKey('devin', SESSION_ID);
        const parsed = parseDevinMessages(handle.db, sessionId);
        // progress_marker 不产行
        expect(parsed.rows).toHaveLength(4);
        const user = parsed.rows.find((r) => r.role === 'user')!;
        expect(user.text).toContain('LumenBox');
        expect(user.seq).toBe(1);
        expect(user.timestamp).toBe(1_795_170_940_000);
        const agent = parsed.rows.find((r) => r.role === 'assistant')!;
        expect(agent.timestamp).toBe(1_795_170_987_841);
        // ACU 事件是 tool 行,标题保留 "ACU usage reset"(FTS 可命中,不换算 token)
        const acu = parsed.rows.find((r) => r.toolName === 'ACU usage reset')!;
        expect(acu.kind).toBe('tool_use');
        expect(acu.timestamp).toBe(1_795_181_041_098);
        expect(acu.inputTokens).toBeNull();
        expect(parsed.firstUserText).toContain('LumenBox');
        // position 0 是 agent（回放窗口首行）——firstMs 取首行而非首条用户消息
        expect(parsed.firstMs).toBe(1_795_170_987_841);
        expect(parsed.lastMs).toBe(1_795_181_041_098);
        expect(parsed.maxPosition).toBe(4);
      } finally {
        handle.cleanup?.();
        handle.db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sincePosition 行级水位：只解析新增行', () => {
    const root = tempRoot();
    try {
      const path = makeAcpDb(root);
      const handle = openDevinSqlite(path)!;
      try {
        // 水位 2（已处理 0/1/2）→ 只出 position 3（ACU），4 是 progress_marker 跳过
        const parsed = parseDevinMessages(handle.db, 'devin:x', 2);
        expect(parsed.rows.map((r) => r.seq)).toEqual([3]);
        expect(parsed.rows[0]!.toolName).toBe('ACU usage reset');
        expect(parsed.maxPosition).toBe(4);
        // 首条用户文本不在新增窗口内——增量趟不回填会话摘要
        expect(parsed.firstUserText).toBeNull();
      } finally {
        handle.cleanup?.();
        handle.db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('extractDevinSessionFile', () => {
  test('索引映射 nativeId、标题链、骨架起点、token 零捏造', () => {
    const root = tempRoot();
    try {
      const path = makeAcpDb(root);
      const rows = extractDevinSessionFile(path, 1_795_181_041_098);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.provider).toBe('devin');
      expect(row.nativeId).toBe(SESSION_ID);
      expect(row.id).toBe(sessionKey('devin', SESSION_ID));
      expect(row.title).toContain('LumenBox');
      // startedAt 用骨架首条(早于缓存窗口),updatedAt 用最后一条消息
      expect(row.startedAt).toBe(SKELETON_FIRST_MS);
      expect(row.updatedAt).toBe(1_795_181_041_098);
      // ACU 计费无 token 明细：零捏造
      expect(row.inputTokens).toBe(0);
      expect(row.outputTokens).toBe(0);
      expect(row.totalTokens).toBe(0);
      expect(row.estimatedCostUsd).toBeNull();
      expect(row.cwd).toBeNull();
      expect(row.sourceFile).toBe(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('无索引(未装好/漂移)：uuid 兜底为 nativeId', () => {
    const root = tempRoot();
    try {
      const path = makeAcpDb(root, { withIndex: false });
      const rows = extractDevinSessionFile(path, 0);
      expect(rows[0]!.nativeId).toBe(UUID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('schema_version 不认识：fail-soft 空返回（不抛）', () => {
    const root = tempRoot();
    try {
      const path = makeAcpDb(root, { schemaVersion: SUPPORTED_DEVIN_SCHEMA_VERSION + 1 });
      expect(extractDevinSessionFile(path, 0)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('文件不存在 / 非 db 路径：空返回', () => {
    expect(extractDevinSessionFile(join(tmpdir(), 'no-such-devin', 'deadbeef.db'), 0)).toEqual([]);
    expect(extractDevinSessionFile('/tmp/not-a-hex-stem.db', 0)).toEqual([]);
  });
});

describe('openDevinSqlite 拷贝兜底', () => {
  test('forceCopy 走临时拷贝读取同一份数据，cleanup 清理', () => {
    const root = tempRoot();
    try {
      const path = makeAcpDb(root);
      const direct = openDevinSqlite(path)!;
      const copyHandle = openDevinSqlite(path, { forceCopy: true })!;
      expect(copyHandle.cleanup).not.toBeNull();
      try {
        const a = parseDevinMessages(direct.db, 's');
        const b = parseDevinMessages(copyHandle.db, 's');
        expect(b.rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id));
      } finally {
        direct.db.close();
        copyHandle.cleanup?.();
        copyHandle.db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('路径不存在 → null', () => {
    expect(openDevinSqlite(join(tmpdir(), 'devin-missing', 'x.db'))).toBeNull();
  });
});

describe('readDevinMessageStoreIndex', () => {
  test('合法键入库、非法键静默忽略', () => {
    const root = tempRoot();
    try {
      const gsDir = join(root, 'User', 'globalStorage');
      mkdirSync(gsDir, { recursive: true });
      const statePath = join(gsDir, 'state.vscdb');
      const state = new Database(statePath);
      state.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      state.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        INDEX_KEY,
        JSON.stringify({ uuid: UUID, lastUpdated: 42 }),
      );
      state.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'windsurf.acp.messageStore.session.acp/devin-cloud/not-a-session-id',
        JSON.stringify({ uuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      );
      state.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(INDEX_KEY + 'x', 'not-json');
      state.close();
      const index = readDevinMessageStoreIndex(statePath);
      expect(index.size).toBe(1);
      expect(index.get(UUID)).toEqual({ sessionId: SESSION_ID, lastUpdated: 42 });
      // state.vscdb 不存在 → 空索引(未安装降级)
      expect(readDevinMessageStoreIndex(join(root, 'missing.vscdb')).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collectSessionCatalog devin 集成（行级水位）', () => {
  function makeRoots(root: string, devinRoot: string) {
    return {
      since: Date.now() - 86_400_000,
      until: Date.now() + 1000,
      claudeRoots: [join(root, 'missing-claude')],
      codexRoot: join(root, 'missing-codex'),
      grokRoot: join(root, 'missing-grok'),
      dshRoot: join(root, 'missing-dsh'),
      kimiRoot: join(root, 'missing-kimi'),
      droidRoot: join(root, 'missing-factory'),
      zcodeRoot: join(root, 'missing-zcode'),
      antigravityRoot: join(root, 'missing-antigravity'),
      opencodeRoot: join(root, 'missing-opencode'),
      ampRoot: join(root, 'missing-amp'),
      workbuddyRoot: join(root, 'missing-workbuddy'),
      doubaoRoot: join(root, 'missing-doubao'),
      minimaxCodeRoot: join(root, 'missing-minimax-code'),
      devinRoot,
    };
  }

  test('首扫入目录与消息；追加消息后二扫只增量入新行', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    try {
      const dbPath = makeAcpDb(root);
      const devinRoot = join(root);
      const sessionId = sessionKey('devin', SESSION_ID);

      await collectSessionCatalog(store, makeRoots(root, devinRoot));
      const row = store.listSessionRows().find((r) => r.provider === 'devin');
      expect(row).toBeDefined();
      expect(row!.title).toContain('LumenBox');
      expect(row!.nativeId).toBe(SESSION_ID);
      const page1 = store.listSessionMessagePage(sessionId, 1, 100);
      expect(page1.total).toBe(4);

      // 追加一条新消息(模拟 Devin 活跃写入):mtime/size 变化触发重扫,
      // 行级水位只解析新增 position
      const extra = {
        kind: 'user_message',
        content: [
          {
            messageId: 'event-u2',
            content: { text: '第二个需求：把 smoke 测试也隔离掉', type: 'text' },
            _meta: {
              'cognition.ai/eventId': 'event-u2',
              'cognition.ai/timestamp': '2026-11-20T15:00:00.000Z',
              'cognition.ai/createdAtMs': 1_795_245_600_000,
              'cognition.ai/eventType': 'user_message',
            },
          },
        ],
      };
      const w = new Database(dbPath);
      w.query('INSERT INTO messages (position, kind, payload) VALUES (?, ?, ?)').run(5, 'user_message', JSON.stringify(extra));
      w.close();

      await collectSessionCatalog(store, makeRoots(root, devinRoot));
      const page2 = store.listSessionMessagePage(sessionId, 1, 100);
      // 只新增 1 行,旧行不重复(幂等 upsert + 行级水位)
      expect(page2.total).toBe(5);
      expect(page2.rows.some((r) => r.text.includes('smoke 测试'))).toBe(true);
      const row2 = store.listSessionRows().find((r) => r.provider === 'devin')!;
      expect(row2.updatedAt).toBe(1_795_245_600_000);
    } finally {
      store.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
