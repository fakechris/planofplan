import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { openDb } from '../src/db.ts';
import { buildWorkGraph } from '../src/graph.ts';
import { _clearRepoCache, repoRefOf, sessionProject } from '../src/repos.ts';
import { attachGit, searchSessions } from '../src/sessions.ts';
import type { SessionRecord } from '../src/types.ts';

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'provider' | 'nativeId'>): SessionRecord {
  return {
    cwd: null,
    title: null,
    sourceFile: '/tmp/x',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    ...partial,
  };
}

describe('git project identity', () => {
  test('walks up to origin URL instead of using cwd basename', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-repo-'));
    try {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/dsh-external/dsh-track.git\n`);
      const nested = join(root, 'explorer', 'src');
      mkdirSync(nested, { recursive: true });
      _clearRepoCache();
      const repo = repoRefOf(nested);
      expect(repo).toMatchObject({
        root,
        url: 'https://github.com/dsh-external/dsh-track.git',
        name: 'dsh-track',
      });
      const attached = attachGit(session({
        id: 'grok:1',
        provider: 'grok',
        nativeId: '1',
        cwd: nested,
        title: '抽需求',
      }));
      expect(attached.gitName).toBe('dsh-track');
      expect(sessionProject(attached)).toBe('dsh-track');
    } finally {
      _clearRepoCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('work graph and search', () => {
  test('links sessions to observed git projects and requirements', () => {
    const sessions = [
      session({
        id: 'grok:1',
        provider: 'grok',
        nativeId: '1',
        cwd: '/tmp/demo-a',
        title: '修 Resume PATH',
        gitRoot: '/tmp/planofplan',
        gitUrl: 'https://example.com/planofplan.git',
        gitName: 'planofplan',
      }),
      session({
        id: 'codex:2',
        provider: 'codex',
        nativeId: '2',
        cwd: '/tmp/demo-a/web',
        title: '做 session 搜索',
        gitRoot: '/tmp/planofplan',
        gitUrl: 'https://example.com/planofplan.git',
        gitName: 'planofplan',
      }),
      session({
        id: 'claude:3',
        provider: 'claude',
        nativeId: '3',
        cwd: '/tmp/other',
        title: '别的仓',
        gitName: 'other',
        gitRoot: '/tmp/other',
        gitUrl: '/tmp/other',
      }),
    ];
    const graph = buildWorkGraph(sessions);
    expect(graph.projects[0]?.name).toBe('planofplan');
    expect(graph.projects[0]?.sessionCount).toBe(2);
    expect(graph.projects[0]?.requirements.map((row) => row.text).sort()).toEqual([
      '修 Resume PATH',
      '做 session 搜索',
    ].sort());
    expect(graph.edges.every((edge) => edge.evidenceKind === 'observed')).toBe(true);
    expect(searchSessions(sessions, 'resume path')).toHaveLength(1);
    expect(searchSessions(sessions, 'planofplan')).toHaveLength(2);
  });
});

describe('sessions schema migration', () => {
  test('old sessions tables gain git columns before indexing git_name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planofplan-olddb-'));
    const file = join(dir, 'planofplan.db');
    try {
      const raw = new Database(file);
      raw.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          native_id TEXT NOT NULL,
          cwd TEXT,
          title TEXT,
          source_file TEXT,
          started_at INTEGER,
          updated_at INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd REAL,
          seen_at INTEGER NOT NULL
        );
      `);
      raw.close();
      const store = openDb(file);
      store.upsertSessions([{
        id: 'grok:1',
        provider: 'grok',
        nativeId: '1',
        cwd: '/tmp/x',
        title: '修 schema',
        sourceFile: '/tmp/x',
        startedAt: 1,
        updatedAt: 2,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
        seenAt: 3,
        gitRoot: '/tmp/planofplan',
        gitUrl: 'https://example.com/planofplan.git',
        gitName: 'planofplan',
      }]);
      expect(store.getSession('grok:1')?.gitName).toBe('planofplan');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('subagent filtering in work graph', () => {
  // claude 布局:subagent transcript 在 <proj>/<uuid>/subagents/agent-*.jsonl,
  // 其「需求」是父 agent 的派工 prompt,默认不进图
  const main = session({
    id: 'claude:main',
    provider: 'claude',
    nativeId: 'main',
    title: '用户的真实需求',
  });
  const sub = session({
    id: 'claude:sub1',
    provider: 'claude',
    nativeId: 'sub1',
    title: '请审查以下改动(派工 prompt)',
    sourceFile: '/Users/x/.claude/projects/-x/main-uuid/subagents/agent-abc.jsonl',
  });

  test('默认排除 /subagents/ 路径的 session(节点+边+requirement)', () => {
    const graph = buildWorkGraph([main, sub]);
    const sessionNodes = graph.nodes.filter((n) => n.kind === 'session');
    expect(sessionNodes.map((n) => n.id)).toEqual(['claude:main']);
    expect(graph.nodes.some((n) => n.kind === 'requirement' && n.sessionId === 'claude:sub1')).toBe(false);
    expect(graph.edges.some((e) => e.from === 'claude:sub1' || e.to.includes('sub1'))).toBe(false);
  });

  test('includeSubagents=true 时保持现状', () => {
    const graph = buildWorkGraph([main, sub], undefined, undefined, true);
    const sessionNodes = graph.nodes.filter((n) => n.kind === 'session');
    expect(sessionNodes.map((n) => n.id).sort()).toEqual(['claude:main', 'claude:sub1']);
  });
});
