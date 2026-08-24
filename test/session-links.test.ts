import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, openMemoryDb } from '../src/db.ts';
import { claudeParentOfPath, materializeSessionLinks } from '../src/session-links.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

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

function msg(partial: Partial<SessionMessageRow> & Pick<SessionMessageRow, 'id' | 'sessionId' | 'seq' | 'role' | 'text'>): SessionMessageRow {
  return { kind: 'text', toolName: null, timestamp: null, model: null, inputTokens: null, outputTokens: null, ...partial };
}

describe('claudeParentOfPath', () => {
  test('嵌套形态 <proj>/<parent-uuid>/subagents/agent-*.jsonl → claude:<parent-uuid>', () => {
    expect(claudeParentOfPath('/x/.claude/projects/-Users-x-repo/6f2ac0b1-1111-4222-8333-444455556666/subagents/agent-a1.jsonl'))
      .toBe('claude:6f2ac0b1-1111-4222-8333-444455556666');
  });

  test('顶层形态 <proj>/subagents/agent-*.jsonl → null(父 uuid 不在路径上)', () => {
    expect(claudeParentOfPath('/x/.claude/projects/-Users-x-repo/subagents/agent-a1.jsonl')).toBeNull();
  });

  test('普通 session 路径 → null', () => {
    expect(claudeParentOfPath('/x/.claude/projects/-Users-x-repo/6f2ac0b1-1111-4222-8333-444455556666.jsonl')).toBeNull();
  });
});

describe('materializeSessionLinks', () => {
  test('claude subagent 路径补 parentId 并写 spawned-by/observed 边;悬空父容忍;幂等', () => {
    const parentUuid = '6f2ac0b1-1111-4222-8333-444455556666';
    const ghostUuid = '00000000-1111-2222-3333-444444444444';
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: `claude:${parentUuid}`, provider: 'claude', nativeId: parentUuid, sourceFile: `/x/.claude/projects/-p/${parentUuid}.jsonl` }),
      session({ id: 'claude:sub-1', provider: 'claude', nativeId: 'sub-1', sourceFile: `/x/.claude/projects/-p/${parentUuid}/subagents/agent-a1.jsonl` }),
      // 父 uuid 不在库(窗口外/已删)→ parentId 照写,边悬空
      session({ id: 'claude:sub-2', provider: 'claude', nativeId: 'sub-2', sourceFile: `/x/.claude/projects/-p/${ghostUuid}/subagents/agent-b2.jsonl` }),
      // 非 claude 的既有 parentId(codex thread_spawn)也统一进边表
      session({ id: 'codex:sub-9', provider: 'codex', nativeId: 'sub-9', origin: 'subagent', parentId: 'codex:parent-9' }),
    ]);
    materializeSessionLinks(store);

    expect(store.getSession('claude:sub-1')?.parentId).toBe(`claude:${parentUuid}`);
    expect(store.getSession('claude:sub-2')?.parentId).toBe(`claude:${ghostUuid}`);
    const links = store.listSessionLinks();
    expect(links).toHaveLength(3);
    // 幂等:重跑不翻倍
    materializeSessionLinks(store);
    expect(store.listSessionLinks()).toHaveLength(3);
    // 双向:子查父(在库,非悬空);父查子
    expect(store.linksForSession('claude:sub-1').spawnedBy[0])
      .toMatchObject({ sessionId: `claude:${parentUuid}`, evidenceKind: 'observed', dangling: false, provider: 'claude' });
    expect(store.linksForSession(`claude:${parentUuid}`).spawned.map((view) => view.sessionId)).toEqual(['claude:sub-1']);
    // 悬空父:对端 provider 为 null,dangling = true
    expect(store.linksForSession('claude:sub-2').spawnedBy[0])
      .toMatchObject({ sessionId: `claude:${ghostUuid}`, dangling: true, provider: null });
  });

  test('plugin:claude 回链 declared:companion 形态(命令行逐字含 <task> 正文,剥壳后匹配)', () => {
    const t0 = Date.now();
    const store = openMemoryDb();
    const prompt = 'Review the diff in src/db.ts and report any issues you find, be thorough';
    store.upsertSessions([
      session({ id: 'codex:plug-1', provider: 'codex', nativeId: 'plug-1', origin: 'plugin:claude', cwd: '/repo', startedAt: t0, updatedAt: t0 }),
      session({ id: 'claude:caller', provider: 'claude', nativeId: 'caller', cwd: '/repo', title: '发起方', updatedAt: t0 }),
    ]);
    store.upsertSessionMessages([
      // codex 首条是插件注入信封,真实 prompt 在 <task> 包裹里
      msg({ id: 'm0', sessionId: 'codex:plug-1', seq: 0, role: 'user', text: '<recommended_plugins>\nHere is a list of plugins that is available but not installed\n' }),
      msg({ id: 'm1', sessionId: 'codex:plug-1', seq: 1, role: 'user', text: `<task>\n${prompt}\n` }),
      // claude 侧:companion 脚本命令行,逐字包含 <task> 正文;消息时间贴近拉起
      msg({ id: 'm2', sessionId: 'claude:caller', seq: 5, role: 'tool', text: `node codex-companion.mjs task --background "<task>\n${prompt}"`, timestamp: t0 - 30_000 }),
    ]);
    materializeSessionLinks(store);
    expect(store.linksForSession('codex:plug-1').spawnedBy[0])
      .toMatchObject({ sessionId: 'claude:caller', evidenceKind: 'declared', dangling: false });
  });

  test('plugin:claude 回链 declared:Task 工具改写形态(probe 降级到词组);时间窗外旧同款消息不误配', () => {
    const t0 = Date.now();
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'codex:plug-2', provider: 'codex', nativeId: 'plug-2', origin: 'plugin:claude', cwd: '/repo', startedAt: t0, updatedAt: t0 }),
      session({ id: 'claude:stale', provider: 'claude', nativeId: 'stale', cwd: '/repo', updatedAt: t0 }),
      session({ id: 'claude:live', provider: 'claude', nativeId: 'live', cwd: '/repo', updatedAt: t0 }),
    ]);
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'codex:plug-2', seq: 0, role: 'user', text: '<task>\nRun an ADVERSARIAL code review of the repository at /repo and report all defects found\n' }),
      // 三天前的旧消息,同款句式开头(review 类 prompt 常见复用)
      msg({ id: 'm2', sessionId: 'claude:stale', seq: 1, role: 'tool', text: '{"prompt":"Run an ADVERSARIAL code review using codex over the repository at /other"}', timestamp: t0 - 3 * 86_400_000 }),
      // 拉起前 1 分钟的真·发起消息:prompt 被改写,只共享开头词组
      msg({ id: 'm3', sessionId: 'claude:live', seq: 9, role: 'tool', text: '{"prompt":"Run an ADVERSARIAL code review using codex. Do not change any files."}', timestamp: t0 - 60_000 }),
    ]);
    materializeSessionLinks(store);
    expect(store.linksForSession('codex:plug-2').spawnedBy[0])
      .toMatchObject({ sessionId: 'claude:live', evidenceKind: 'declared' });
  });

  test('plugin:claude 回链 candidate:declared 对不上时退时间窗(±10min)+ cwd(相同或子树)', () => {
    const t0 = Date.now();
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'codex:plug-2', provider: 'codex', nativeId: 'plug-2', origin: 'plugin:claude', cwd: '/repo/sub', startedAt: t0, updatedAt: t0 }),
      session({ id: 'claude:near', provider: 'claude', nativeId: 'near', cwd: '/repo', updatedAt: t0 - 5 * 60_000 }),
      session({ id: 'claude:far', provider: 'claude', nativeId: 'far', cwd: '/repo', updatedAt: t0 - 30 * 60_000 }),
      session({ id: 'claude:otherdir', provider: 'claude', nativeId: 'otherdir', cwd: '/other', updatedAt: t0 - 60_000 }),
    ]);
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'codex:plug-2', seq: 0, role: 'user', text: 'unrelated prompt that does not appear anywhere else' }),
    ]);
    materializeSessionLinks(store);
    expect(store.linksForSession('codex:plug-2').spawnedBy[0])
      .toMatchObject({ sessionId: 'claude:near', evidenceKind: 'candidate' });
  });

  test('plugin:claude 无任何匹配 → 不写边', () => {
    const t0 = Date.now();
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'codex:plug-3', provider: 'codex', nativeId: 'plug-3', origin: 'plugin:claude', cwd: '/nowhere', startedAt: t0, updatedAt: t0 }),
    ]);
    materializeSessionLinks(store);
    expect(store.linksForSession('codex:plug-3').spawnedBy).toEqual([]);
    expect(store.listSessionLinks()).toHaveLength(0);
  });
});

describe('session_links 级联删除', () => {
  test('删子或删父都清边', () => {
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'claude:p', provider: 'claude', nativeId: 'p' }),
      session({ id: 'codex:c', provider: 'codex', nativeId: 'c', origin: 'subagent', parentId: 'claude:p' }),
    ]);
    materializeSessionLinks(store);
    expect(store.listSessionLinks()).toHaveLength(1);
    store.deleteSession('codex:c');
    expect(store.listSessionLinks()).toHaveLength(0);
    // 反向:悬空到父的边,父被删时一并清掉
    store.upsertSessionLinks([{
      fromSession: 'codex:c2', toSession: 'claude:p2', kind: 'spawned-by', evidenceKind: 'observed', createdAt: Date.now(),
    }]);
    store.deleteSession('claude:p2');
    expect(store.listSessionLinks()).toHaveLength(0);
  });
});

describe('GET /api/sessions/:provider/:id/links', () => {
  test('双向 + 悬空标记 + 未知 session 404', async () => {
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'claude:p', provider: 'claude', nativeId: 'p', title: '父会话' }),
      session({ id: 'codex:c', provider: 'codex', nativeId: 'c', origin: 'subagent', parentId: 'claude:p' }),
      session({ id: 'codex:d', provider: 'codex', nativeId: 'd', origin: 'subagent', parentId: 'claude:ghost' }),
    ]);
    materializeSessionLinks(store);
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });

    const child = await server.request('http://localhost/api/sessions/codex/c/links');
    expect(child.status).toBe(200);
    expect(await child.json()).toMatchObject({
      sessionId: 'codex:c',
      spawnedBy: [{ sessionId: 'claude:p', evidenceKind: 'observed', provider: 'claude', title: '父会话', dangling: false }],
    });

    const parent = await server.request('http://localhost/api/sessions/claude/p/links');
    expect(parent.status).toBe(200);
    const parentBody = await parent.json() as { spawnedBy: unknown[]; spawned: Array<{ sessionId: string }> };
    expect(parentBody.spawnedBy).toEqual([]);
    expect(parentBody.spawned.map((view) => view.sessionId)).toEqual(['codex:c']);

    const dangling = await server.request('http://localhost/api/sessions/codex/d/links');
    expect(await dangling.json()).toMatchObject({
      spawnedBy: [{ sessionId: 'claude:ghost', dangling: true, provider: null }],
    });

    const missing = await server.request('http://localhost/api/sessions/codex/none/links');
    expect(missing.status).toBe(404);
  });
});

describe('v6 迁移幂等', () => {
  test('老库重开:ALTER 已存在容错,backfill 重跑边不翻倍', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planofplan-links-migration-'));
    const dbPath = join(dir, 'app.db');
    try {
      const s1 = openDb(dbPath);
      s1.upsertSessions([
        session({ id: 'codex:c', provider: 'codex', nativeId: 'c', origin: 'subagent', parentId: 'claude:p' }),
      ]);
      // openDb 建新库时迁移已到 v6;推回 5 再重开 → 走 v6 块(列已存在,
      // ALTER 抛错被吞)+ backfillLaunchLinks 重跑
      s1.setUserVersion(5);
      const s2 = openDb(dbPath);
      expect(s2.getUserVersion()).toBe(6);
      expect(s2.listSessionLinks()).toHaveLength(1);
      const s3 = openDb(dbPath);
      expect(s3.getUserVersion()).toBe(6);
      expect(s3.listSessionLinks()).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  });
});
