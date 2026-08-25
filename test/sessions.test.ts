import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openMemoryDb } from '../src/db.ts';
import {
  collectSessionCatalog,
  extractSessionFile,
  extractSessionRecords,
  isShortAck,
  sessionKey,
  titleify,
} from '../src/sessions.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-sessions-'));
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('session catalog extractors', () => {
  test('titleify skips list markers and caps length', () => {
    expect(titleify('1. 先扫 session 目录')).toBe('先扫 session 目录');
    expect(isShortAck('可以')).toBe(true);
    expect(isShortAck('把额度页接到 session 目录')).toBe(false);
  });

  test('Claude jsonl uses filename UUID and first user text', () => {
    const root = tempRoot();
    const id = '23e499d0-0689-45b7-9a69-11f6543e430f';
    const file = join(root, `${id}.jsonl`);
    try {
      writeFileSync(file, jsonl([
        { type: 'mode', mode: 'normal', sessionId: id },
        { type: 'user', message: { content: [{ type: 'text', text: 'ok' }] } },
        { type: 'user', timestamp: '2026-08-19T01:00:00.000Z', message: { content: [{ type: 'text', text: '看一下 dsh-track 的实现' }] }, cwd: '/Users/chris/source/dsh-involute' },
      ]), 'utf8');
      const row = extractSessionFile('claude', file, Date.parse('2026-08-19T02:00:00.000Z'));
      expect(row).toMatchObject({
        id: sessionKey('claude', id),
        provider: 'claude',
        nativeId: id,
        cwd: '/Users/chris/source/dsh-involute',
        title: '看一下 dsh-track 的实现',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex rollout head provides id and cwd without reading the rest of the file', () => {
    const root = tempRoot();
    const id = '01a01cbe-aa74-7060-b5ca-459e22f1f284';
    const file = join(root, `rollout-2026-08-19T18-17-32-${id}.jsonl`);
    try {
      writeFileSync(file, jsonl([
        { type: 'session_meta', payload: { id, cwd: '/Users/chris/workspace/planofplan', timestamp: '2026-08-19T18:17:32.000Z' } },
        { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '列出本机 session' }] } },
      ]), 'utf8');
      const row = extractSessionFile('codex', file, Date.parse('2026-08-19T18:20:00.000Z'));
      expect(row).toMatchObject({
        id: `codex:${id}`,
        cwd: '/Users/chris/workspace/planofplan',
        title: '列出本机 session',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Grok summary.json is the catalog source', () => {
    const root = tempRoot();
    const id = '01a01dca-bbc8-7101-b5ae-4bca7f34c894';
    const file = join(root, 'sessions', encodeURIComponent('/Users/chris/source/dsh-involute'), id, 'summary.json');
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({
        info: { id, cwd: '/Users/chris/source/dsh-involute' },
        generated_title: 'Extend dsh-track to other agent sessions',
        created_at: '2026-08-20T06:10:20.872Z',
        updated_at: '2026-08-20T06:14:14.559Z',
      }), 'utf8');
      const row = extractSessionFile('grok', file, Date.parse('2026-08-20T06:14:14.559Z'));
      expect(row).toMatchObject({
        id: `grok:${id}`,
        cwd: '/Users/chris/source/dsh-involute',
        title: 'Extend dsh-track to other agent sessions',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DSH session header supplies cwd and first user request', () => {
    const root = tempRoot();
    const id = 'session-76764e4b-b4d9-4962-83d2-215ce6e89ccb';
    const file = join(root, '--Users-chris-source-dsh-involute--', id, 'session.jsonl');
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, jsonl([
        { type: 'session', id, cwd: '/Users/chris/source/dsh-involute', createdAt: 1787137376282 },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先落设计文档，再开 m3' }] } },
      ]), 'utf8');
      const row = extractSessionFile('dsh', file, 1787137376282);
      expect(row).toMatchObject({
        id: `dsh:${id}`,
        cwd: '/Users/chris/source/dsh-involute',
        title: '先落设计文档，再开 m3',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DSH subagent 头部(origin + parentSession)标记 subagent 并带父 id', () => {
    const root = tempRoot();
    const parentId = 'session-c56c015a-8009-4d8d-9b03-a77423e06eeb';
    const file = join(root, '--Users-chris-source-dsh-explorer--', '004f77e4-55b2-4128-8b5b-824fbab89176', 'session.jsonl');
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, jsonl([
        { type: 'session', id: '004f77e4-55b2-4128-8b5b-824fbab89176', cwd: '/Users/chris/source/dsh/explorer', createdAt: 1786440969796, origin: 'subagent', parentSession: parentId, delegationDepth: 1 },
        { type: 'subagent/descriptor', seq: 0, data: { label: 'Deep-dive', agentProvider: 'deepseek-official' } },
      ]), 'utf8');
      const row = extractSessionFile('dsh', file, 1786440969796);
      expect(row).toMatchObject({
        origin: 'subagent',
        parentId: `dsh:${parentId}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('factory Worker 会话(callingSessionId)标记 subagent 并带父 id;普通会话不动', () => {
    const root = tempRoot();
    const dir = join(root, '-Users-chris-workspace-planofplan');
    try {
      mkdirSync(dir, { recursive: true });
      const worker = join(dir, '71129b6f-bc0d-46b5-b686-9d8f9f550014.jsonl');
      writeFileSync(worker, jsonl([
        { type: 'session_start', id: '71129b6f-bc0d-46b5-b686-9d8f9f550014', title: 'Worker: Research CodexBar providers', owner: 'chris', callingSessionId: '7e73b9de-b025-4bb5-94f2-a39e774dfb49', callingToolUseId: 'call_v2v5', version: 2, cwd: '/Users/chris/workspace/planofplan' },
      ]), 'utf8');
      const workerRow = extractSessionFile('factory', worker, Date.now());
      expect(workerRow).toMatchObject({
        origin: 'subagent',
        parentId: 'factory:7e73b9de-b025-4bb5-94f2-a39e774dfb49',
      });
      const plain = join(dir, '31a94f5a-23e7-409a-b228-bd7e2097befd.jsonl');
      writeFileSync(plain, jsonl([
        { type: 'session_start', id: '31a94f5a-23e7-409a-b228-bd7e2097befd', title: 'New Session', owner: 'chris', version: 2, cwd: '/Users/chris/Documents/baolijinjian' },
      ]), 'utf8');
      const plainRow = extractSessionFile('factory', plain, Date.now());
      expect(plainRow?.origin ?? 'user').toBe('user');
      expect(plainRow?.parentId ?? null).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('collectSessionCatalog upserts four providers and fills tokens from usage_records', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    const claudeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const codexId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const grokId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const dshId = 'session-dddddddd-dddd-dddd-dddd-dddddddddddd';
    const since = Date.parse('2026-08-19T00:00:00.000Z');
    const until = Date.parse('2026-08-21T00:00:00.000Z');
    try {
      mkdirSync(join(root, 'claude'), { recursive: true });
      writeFileSync(join(root, 'claude', `${claudeId}.jsonl`), jsonl([
        { type: 'user', timestamp: '2026-08-19T12:00:00.000Z', message: { content: [{ type: 'text', text: 'Claude session' }] }, cwd: '/tmp/claude' },
      ]));
      mkdirSync(join(root, 'codex'), { recursive: true });
      writeFileSync(join(root, 'codex', `rollout-2026-08-19T12-00-00-${codexId}.jsonl`), jsonl([
        { type: 'session_meta', payload: { id: codexId, cwd: '/tmp/codex', timestamp: '2026-08-19T12:00:00.000Z' } },
      ]));
      mkdirSync(join(root, 'grok', 'sessions', 'tmp', grokId), { recursive: true });
      writeFileSync(join(root, 'grok', 'sessions', 'tmp', grokId, 'summary.json'), JSON.stringify({
        info: { id: grokId, cwd: '/tmp/grok' },
        generated_title: 'Grok session',
        created_at: '2026-08-19T12:00:00.000Z',
        updated_at: '2026-08-19T13:00:00.000Z',
      }));
      mkdirSync(join(root, 'dsh', 'ws', dshId), { recursive: true });
      writeFileSync(join(root, 'dsh', 'ws', dshId, 'session.jsonl'), jsonl([
        { type: 'session', id: dshId, cwd: '/tmp/dsh', createdAt: since + 1000 },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先落设计文档再开 session 目录' }] } },
      ]));

      store.upsertUsageRecords([{
        id: 'local:codex:1',
        day: '2026-08-19',
        timestamp: since + 2000,
        provider: 'codex',
        model: 'gpt-5',
        sessionId: codexId,
        sourceFile: join(root, 'codex', `rollout-2026-08-19T12-00-00-${codexId}.jsonl`),
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
        billableTokens: null,
        estimatedCostUsd: 0.01,
        source: 'local',
        confidence: 'measured',
      }]);

      const count = await collectSessionCatalog(store, {
        since,
        until,
        claudeRoots: [join(root, 'claude')],
        codexRoot: join(root, 'codex'),
        grokRoot: join(root, 'grok'),
        dshRoot: join(root, 'dsh'),
        kimiRoot: join(root, 'missing-kimi'),
        droidRoot: join(root, 'missing-factory'),
        zcodeRoot: join(root, 'missing-zcode'),
      });
      expect(count).toBeGreaterThanOrEqual(4);
      const claude = store.getSession(`claude:${claudeId}`);
      const codex = store.getSession(`codex:${codexId}`);
      const grok = store.getSession(`grok:${grokId}`);
      const dsh = store.getSession(`dsh:${dshId}`);
      expect(claude?.title).toBe('Claude session');
      expect(codex?.cwd).toBe('/tmp/codex');
      expect(codex?.totalTokens).toBe(15);
      expect(grok?.title).toBe('Grok session');
      expect(dsh?.title).toBe('先落设计文档再开 session 目录');
      expect(store.getSession('zcode:should-not-exist')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ZCode GUI sessions come from cli/db sqlite, not Application Support Chromium cookies', () => {
    const root = tempRoot();
    const dbPath = join(root, 'db', 'db.sqlite');
    try {
      mkdirSync(join(root, 'db'), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE session (
          id text primary key,
          title text,
          directory text,
          path text,
          parent_id text,
          time_created integer,
          time_updated integer
        );
      `);
      db.query(`INSERT INTO session (id, title, directory, path, parent_id, time_created, time_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'sess_top',
        '排查 GLM 高峰 pill',
        '/Users/chris/workspace/planofplan',
        '/Users/chris/workspace/planofplan',
        null,
        1,
        2,
      );
      db.query(`INSERT INTO session (id, title, directory, path, parent_id, time_created, time_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'sess_subagent_agent_1',
        '子代理',
        '/tmp',
        '/tmp',
        'sess_top',
        1,
        2,
      );
      db.close();
      const rows = extractSessionRecords('zcode', dbPath, 3);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'zcode:sess_top',
        cwd: '/Users/chris/workspace/planofplan',
        title: '排查 GLM 高峰 pill',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('claude subagent discovery', () => {
  test('subagents/agent-*.jsonl 也入目录:标题取第一条用户派发消息,origin=subagent', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    const parentId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const dir = join(root, 'claude', '-proj', parentId, 'subagents');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent-a3192a0f.jsonl'), jsonl([
        { type: 'user', uuid: 'u1', timestamp: '2026-08-20T10:00:00.000Z', message: { content: [{ type: 'text', text: '请审查以下改动,重点看鉴权边界和事务完整性' }] }, cwd: '/tmp/demo' },
        { type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: '先看 diff' }] } },
      ]));
      await collectSessionCatalog(store, {
        since: Date.now() - 86_400_000,
        until: Date.now() + 1000,
        claudeRoots: [join(root, 'claude')],
        codexRoot: join(root, 'm1'),
        grokRoot: join(root, 'm2'),
        dshRoot: join(root, 'm3'),
        kimiRoot: join(root, 'm4'),
        droidRoot: join(root, 'm5'),
        zcodeRoot: join(root, 'm6'),
      });
      const row = store.getSession('claude:agent-a3192a0f');
      expect(row).not.toBeNull();
      expect(row?.title).toBe('请审查以下改动,重点看鉴权边界和事务完整性');
      expect(row?.origin).toBe('subagent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('无 git cwd 的项目身份(目录即项目)', () => {
  test('workRepoOf:非 git cwd 兜底为路径身份;junk cwd 跳过', async () => {
    const { workRepoOf } = await import('../src/session-repos.ts');
    const home = await import('node:os').then((m) => m.homedir());
    const s = (cwd: string | null) => ({
      id: 'claude:x', provider: 'claude', nativeId: 'x', cwd, title: null, sourceFile: null,
      startedAt: null, updatedAt: Date.now(), inputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: null, seenAt: Date.now(), gitRoot: null, gitUrl: null, gitName: null,
    }) as never;
    const repo = workRepoOf(s('/tmp/research-note-xyz' + ''), home);
    // /tmp 子目录是合法工作目录(只有 /tmp 本体算 junk)
    expect(repo).toMatchObject({ role: 'work', url: '/tmp/research-note-xyz', root: '/tmp/research-note-xyz', name: 'research-note-xyz' });
    expect(workRepoOf(s(home), home)).toBeNull();
    expect(workRepoOf(s('/tmp'), home)).toBeNull();
    expect(workRepoOf(s('/var/folders/ab/xyz'), home)).toBeNull();
  });

  test('存量 backfill:无 work 行的会话补路径身份,projects 物化能看见', () => {
    const store = openMemoryDb();
    store.upsertSessions([{
      id: 'claude:research1', provider: 'claude', nativeId: 'r1', cwd: '/Users/x/source/research/cabinet',
      title: '研究', sourceFile: null, startedAt: null, updatedAt: Date.now(),
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: Date.now(),
    }]);
    expect(store.listSessionRows()[0]!.repos?.filter((r) => r.role === 'work')).toHaveLength(0);
    // 模拟 collect 的 backfill 段
    const withWork = store.sessionIdsWithWorkRepo();
    expect(withWork.size).toBe(0);
    store.appendSessionRepo({ sessionId: 'claude:research1', role: 'work', url: '/Users/x/source/research/cabinet', root: '/Users/x/source/research/cabinet', name: 'cabinet', evidenceKind: 'observed' });
    expect(store.sessionIdsWithWorkRepo().has('claude:research1')).toBe(true);
    // 幂等
    store.appendSessionRepo({ sessionId: 'claude:research1', role: 'work', url: '/Users/x/source/research/cabinet', root: '/Users/x/source/research/cabinet', name: 'cabinet', evidenceKind: 'observed' });
    const count = store.listSessionRows()[0]!.repos!.filter((r) => r.role === 'work').length;
    expect(count).toBe(1);
  });
});
