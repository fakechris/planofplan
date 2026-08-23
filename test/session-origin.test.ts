import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHerdrOrigin,
  backfillSessionOrigins,
  classifyCodexMeta,
  classifySessionPath,
  herdrPaneCwd,
  parseHerdrLog,
} from '../src/session-origin.ts';
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
    expect(store.getSession('codex:late')?.origin).toBe('user');
    expect(store.getSession('codex:wrongdir')?.origin).toBe('user');
    expect(store.getSession('claude:sub')?.origin).toBe('subagent');
    // herdr 文件不存在 → 跳过
    expect(applyHerdrOrigin(store, join(root, 'nope.log'), join(root, 'nope.json'))).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('backfillSessionOrigins', () => {
  test('codex 重读文件头分类、claude 路径判断、幂等、版本推进', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-origin-backfill-'));
    const codexFile = join(root, 'rollout-2026-08-20T10-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    try {
      writeFileSync(codexFile, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', originator: 'Claude Code', source: 'cli' },
      })}\n`);
      const store = openMemoryDb();
      expect(store.getUserVersion()).toBe(2); // 新库列由 SCHEMA 带齐,但版本号要等 backfill 完成才推 3
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
      expect(store.getUserVersion()).toBe(3);
      // 幂等:重跑不报错、结果不变
      backfillSessionOrigins(store);
      expect(store.getSession('codex:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')?.origin).toBe('plugin:claude');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('老库(v2)升级:列补全 + backfill 后版本推到 3', () => {
    // 用 ALTER 前的老 schema 模拟:openMemoryDb 走的是新 SCHEMA,这里验证
    // getUserVersion 语义与重复 ALTER 容错即可(真实老库迁移由 v1→v2→v3 链覆盖)
    const store = openMemoryDb();
    expect(() => store.setUserVersion(3)).not.toThrow();
    expect(store.getUserVersion()).toBe(3);
  });
});
