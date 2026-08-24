import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHerdrOrigin,
  backfillDshFactoryOrigins,
  backfillSessionOrigins,
  classifyCodexMeta,
  classifyDshHeader,
  classifyFactoryStart,
  classifySessionPath,
  herdrPaneCwd,
  parseHerdrLog,
} from '../src/session-origin.ts';
import { materializeSessionLinks } from '../src/session-links.ts';
import { openMemoryDb } from '../src/db.ts';
import type { SessionRecord } from '../src/types.ts';

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'provider' | 'nativeId'>): SessionRecord {
  return {
    cwd: null,
    title: null,
    sourceFile: null,
    startedAt: null,
    updatedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    ...partial,
  };
}

describe('classifyCodexMeta', () => {
  test('source.subagent.thread_spawn → subagent + parentId', () => {
    expect(classifyCodexMeta({
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-uuid', depth: 1 } } },
    })).toEqual({ origin: 'subagent', parentId: 'codex:parent-uuid' });
  });

  test('thread_spawn 回指自身 id 时抑制 parentId(同 session 多 rollout 文件)', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-origin-self-'));
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const file = join(root, `rollout-2026-08-20T10-00-00-${id}.jsonl`);
    try {
      writeFileSync(file, `${JSON.stringify({
        type: 'session_meta',
        payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: id, depth: 0 } } } },
      })}\n`);
      const store = openMemoryDb();
      store.upsertSessions([session({ id: `codex:${id}`, provider: 'codex', nativeId: id, sourceFile: file })]);
      backfillSessionOrigins(store);
      const row = store.getSession(`codex:${id}`);
      expect(row?.origin).toBe('subagent');
      expect(row?.parentId).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("originator 'Claude Code' → plugin:claude", () => {
    expect(classifyCodexMeta({ originator: 'Claude Code', source: 'cli' })).toEqual({ origin: 'plugin:claude' });
  });

  test("codex_exec / source 'exec' → exec", () => {
    expect(classifyCodexMeta({ originator: 'codex_exec' })).toEqual({ origin: 'exec' });
    expect(classifyCodexMeta({ originator: 'codex-tui', source: 'exec' })).toEqual({ origin: 'exec' });
  });

  test('codex-tui / vscode 等交互来源 → null(不动既有值)', () => {
    expect(classifyCodexMeta({ originator: 'codex-tui', source: 'cli' })).toBeNull();
    expect(classifyCodexMeta({ originator: 'Codex Desktop', source: 'vscode' })).toBeNull();
    expect(classifyCodexMeta({})).toBeNull();
  });
});

describe('classifySessionPath', () => {
  test('claude /subagents/ 路径 → subagent;其它不动', () => {
    expect(classifySessionPath('claude', '/x/.claude/projects/-p/uuid/subagents/agent-a.jsonl'))
      .toEqual({ origin: 'subagent' });
    expect(classifySessionPath('claude', '/x/.claude/projects/-p/uuid.jsonl')).toBeNull();
    expect(classifySessionPath('codex', '/x/subagents/rollout.jsonl')).toBeNull();
  });
});

describe('herdr 关联(fixture,不依赖真机文件)', () => {
  const root = mkdtempSync(join(tmpdir(), 'planofplan-herdr-'));
  const logPath = join(root, 'herdr-server.log');
  const jsonPath = join(root, 'session.json');
  const t0 = Date.parse('2026-08-20T10:00:00.000Z');

  test('parseHerdrLog / herdrPaneCwd', () => {
    const events = parseHerdrLog(
      '2026-07-20T05:46:39.147568Z  INFO herdr::pane: agent changed pane=1 previous_agent=None agent=Some(Claude) process=claude pgid=Some(59753)\n'
      + '2026-07-20T05:46:57.388226Z  INFO herdr::pane: agent changed pane=1 previous_agent=Some(Claude) agent=None pgid=Some(52596)\n',
    );
    expect(events).toHaveLength(1); // agent=None 是退出事件,不算
    expect(events[0]).toMatchObject({ pane: 1, agent: 'Claude' });
    const cwd = herdrPaneCwd(JSON.stringify({
      workspaces: [{ tabs: [{ panes: { 1: { cwd: '/repo/a' }, 2: { cwd: '/repo/b' } } }] }],
    }));
    expect(cwd.get(1)).toBe('/repo/a');
    expect(herdrPaneCwd('not json').size).toBe(0);
  });

  test('user session 在事件 ±2 分钟且 cwd 匹配 → 升级 herdr;更强标记不被覆盖', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(logPath, [
      `2026-08-20T10:00:30.000Z  INFO herdr::pane: agent changed pane=1 previous_agent=None agent=Some(Codex) process=codex`,
    ].join('\n'));
    writeFileSync(jsonPath, JSON.stringify({
      workspaces: [{ tabs: [{ panes: { 1: { cwd: '/repo/a' } } }] }],
    }));
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'codex:hit', provider: 'codex', nativeId: 'hit', cwd: '/repo/a', startedAt: t0 + 45_000 }),
      session({ id: 'codex:late', provider: 'codex', nativeId: 'late', cwd: '/repo/a', startedAt: t0 + 10 * 60_000 }),
      session({ id: 'codex:wrongdir', provider: 'codex', nativeId: 'wrongdir', cwd: '/repo/b', startedAt: t0 + 30_000 }),
      session({ id: 'claude:sub', provider: 'claude', nativeId: 'sub', cwd: '/repo/a', startedAt: t0 + 10_000, origin: 'subagent' }),
    ]);
    const upgraded = applyHerdrOrigin(store, logPath, jsonPath);
    expect(upgraded).toBe(1);
    expect(store.getSession('codex:hit')?.origin).toBe('herdr');
    expect(store.getSession('codex:hit')?.originDetail).toBe('herdr:pane:1');
    expect(store.getSession('codex:late')?.origin).toBe('user');
    expect(store.getSession('codex:wrongdir')?.origin).toBe('user');
    expect(store.getSession('claude:sub')?.origin).toBe('subagent');
    // herdr 文件不存在 → 跳过
    expect(applyHerdrOrigin(store, join(root, 'nope.log'), join(root, 'nope.json'))).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('upsert 不洗掉已有 origin(回归:VALUES 里 COALESCE 曾污染 excluded.origin)', () => {
  test('stub 重扫(origin 缺省)保留 backfill/标记的 subagent', () => {
    const store = openMemoryDb();
    // 1. 先按 user 入库(模拟 usage stub,不带 origin)
    store.upsertSessions([session({ id: 'claude:agent-x', provider: 'claude', nativeId: 'agent-x', sourceFile: '/x/.claude/projects/-p/u/subagents/agent-x.jsonl' })]);
    expect(store.getSession('claude:agent-x')?.origin).toBe('user');
    // 2. backfill 标成 subagent
    store.updateSessionOrigins([{ id: 'claude:agent-x', origin: 'subagent' }]);
    expect(store.getSession('claude:agent-x')?.origin).toBe('subagent');
    // 3. 重扫:stub 再次 upsert(origin 缺省)→ 必须保留 subagent
    store.upsertSessions([session({ id: 'claude:agent-x', provider: 'claude', nativeId: 'agent-x', sourceFile: '/x/.claude/projects/-p/u/subagents/agent-x.jsonl' })]);
    expect(store.getSession('claude:agent-x')?.origin).toBe('subagent');
  });

  test('v3 存量库(被洗过的)→ backfill 重跑自愈', () => {
    const store = openMemoryDb();
    store.setUserVersion(3); // 模拟:列已迁但 origin 被旧 upsert 洗回 user
    store.upsertSessions([session({ id: 'claude:agent-y', provider: 'claude', nativeId: 'agent-y', sourceFile: '/x/subagents/agent-y.jsonl' })]);
    expect(store.getSession('claude:agent-y')?.origin).toBe('user');
    backfillSessionOrigins(store);
    expect(store.getSession('claude:agent-y')?.origin).toBe('subagent');
    // 完成标记是哨兵行,不是 user_version(schema 迁移也会推它,双用途会互相踩)
    expect(store.getSessionIndexState('__origin_backfill__')).not.toBeNull();
    // 重跑被哨兵挡住
    store.updateSessionOrigins([{ id: 'claude:agent-y', origin: 'user' }]);
    backfillSessionOrigins(store);
    expect(store.getSession('claude:agent-y')?.origin).toBe('user');
  });
});

describe('backfillSessionOrigins', () => {
  test('codex 重读文件头分类、claude 路径判断、幂等、哨兵标记', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-origin-backfill-'));
    const codexFile = join(root, 'rollout-2026-08-20T10-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    try {
      writeFileSync(codexFile, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', originator: 'Claude Code', source: 'cli' },
      })}\n`);
      const store = openMemoryDb();
      store.upsertSessions([
        session({ id: 'codex:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', provider: 'codex', nativeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', sourceFile: codexFile }),
        session({ id: 'claude:c1', provider: 'claude', nativeId: 'c1', sourceFile: '/x/.claude/projects/-p/uuid/subagents/agent-a.jsonl' }),
        session({ id: 'claude:plain', provider: 'claude', nativeId: 'plain', sourceFile: '/x/.claude/projects/-p/uuid.jsonl' }),
        session({ id: 'codex:gone', provider: 'codex', nativeId: 'gone', sourceFile: join(root, 'deleted.jsonl') }),
      ]);
      backfillSessionOrigins(store);
      expect(store.getSession('codex:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')?.origin).toBe('plugin:claude');
      expect(store.getSession('claude:c1')?.origin).toBe('subagent');
      expect(store.getSession('claude:plain')?.origin).toBe('user');
      expect(store.getSession('codex:gone')?.origin).toBe('user'); // 文件不在 → 跳过
      expect(store.getSessionIndexState('__origin_backfill__')).not.toBeNull();
      // 幂等:重跑不报错、结果不变
      backfillSessionOrigins(store);
      expect(store.getSession('codex:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')?.origin).toBe('plugin:claude');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('getUserVersion/setUserVersion 语义(重复 ALTER 容错)', () => {
    // openMemoryDb 走新 SCHEMA + 全部迁移;真实老库迁移由 v1→…→v6 链覆盖
    const store = openMemoryDb();
    expect(store.getUserVersion()).toBe(6);
    expect(() => store.setUserVersion(4)).not.toThrow();
    expect(store.getUserVersion()).toBe(4);
  });
});

describe('dsh / factory 子代理分类', () => {
  test('classifyDshHeader:头部 origin=subagent + parentSession → subagent + dsh 父', () => {
    expect(classifyDshHeader({
      type: 'session', id: '004f77e4-55b2-4128-8b5b-824fbab89176',
      origin: 'subagent', parentSession: 'session-c56c015a-8009-4d8d-9b03-a77423e06eeb',
      delegationDepth: 1,
    })).toEqual({ origin: 'subagent', parentId: 'dsh:session-c56c015a-8009-4d8d-9b03-a77423e06eeb' });
  });

  test('classifyDshHeader:user 头部 / 缺 parentSession / 回指自身 → 不带或抑制 parentId', () => {
    expect(classifyDshHeader({ type: 'session', id: 'session-x', cwd: '/repo', delegationDepth: 0 })).toBeNull();
    expect(classifyDshHeader({ type: 'session', id: 'x', origin: 'subagent' })).toEqual({ origin: 'subagent', parentId: null });
    expect(classifyDshHeader({ type: 'session', id: 'same', origin: 'subagent', parentSession: 'same' }))
      .toEqual({ origin: 'subagent', parentId: null });
    expect(classifyDshHeader(undefined)).toBeNull();
  });

  test('classifyFactoryStart:callingSessionId → subagent + factory 父;普通会话 → null', () => {
    expect(classifyFactoryStart({
      type: 'session_start', id: '71129b6f', title: 'Worker: Research',
      callingSessionId: '7e73b9de', callingToolUseId: 'call_x',
    })).toEqual({ origin: 'subagent', parentId: 'factory:7e73b9de' });
    expect(classifyFactoryStart({ type: 'session_start', id: 'a', title: 'New Session' })).toBeNull();
    // 回指自身抑制
    expect(classifyFactoryStart({ type: 'session_start', id: 'a', callingSessionId: 'a' })).toBeNull();
    expect(classifyFactoryStart(undefined)).toBeNull();
  });
});

describe('backfillDshFactoryOrigins', () => {
  test('存量行重读首行分类、幂等哨兵、已识别的不动', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-origin-dsh-factory-'));
    try {
      const dshSub = join(root, 'session.jsonl');
      writeFileSync(dshSub, `${JSON.stringify({
        type: 'session', id: 'sub-uuid', cwd: '/repo',
        origin: 'subagent', parentSession: 'session-parent-uuid', delegationDepth: 1,
      })}\n`);
      const dshUser = join(root, 'user-session.jsonl');
      writeFileSync(dshUser, `${JSON.stringify({ type: 'session', id: 'user-uuid', cwd: '/repo', delegationDepth: 0 })}\n`);
      const factoryWorker = join(root, 'worker.jsonl');
      writeFileSync(factoryWorker, `${JSON.stringify({
        type: 'session_start', id: 'w1', title: 'Worker: Research',
        callingSessionId: 'p1', callingToolUseId: 'call_x',
      })}\n`);
      const store = openMemoryDb();
      store.upsertSessions([
        session({ id: 'dsh:sub-uuid', provider: 'dsh', nativeId: 'sub-uuid', sourceFile: dshSub }),
        session({ id: 'dsh:user-uuid', provider: 'dsh', nativeId: 'user-uuid', sourceFile: dshUser }),
        session({ id: 'factory:w1', provider: 'factory', nativeId: 'w1', sourceFile: factoryWorker }),
        // 已识别的不动(herdr 强于无标记,但这里只验证不被覆盖)
        session({ id: 'factory:marked', provider: 'factory', nativeId: 'marked', origin: 'herdr', sourceFile: join(root, 'gone.jsonl') }),
      ]);
      backfillDshFactoryOrigins(store);
      expect(store.getSession('dsh:sub-uuid')).toMatchObject({ origin: 'subagent', parentId: 'dsh:session-parent-uuid' });
      expect(store.getSession('dsh:user-uuid')?.origin).toBe('user');
      expect(store.getSession('factory:w1')).toMatchObject({ origin: 'subagent', parentId: 'factory:p1' });
      expect(store.getSession('factory:marked')?.origin).toBe('herdr');
      // 哨兵置位;重跑不报错
      expect(store.getSessionIndexState('__origin_backfill_dsh_factory__')).not.toBeNull();
      backfillDshFactoryOrigins(store);
      expect(store.getSession('dsh:sub-uuid')?.origin).toBe('subagent');
      // parentId 落库后,Launch 边物化统一接手(provider 无关)
      materializeSessionLinks(store);
      expect(store.linksForSession('dsh:sub-uuid').spawnedBy[0]).toMatchObject({ evidenceKind: 'observed' });
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
});
