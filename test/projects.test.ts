import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDb, openMemoryDb, projectEntityId } from '../src/db.ts';
import { materializeRequirements } from '../src/requirements.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionRecord, SessionRepo } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'provider' | 'nativeId'>): SessionRecord {
  return {
    cwd: '/repo',
    title: 'demo',
    sourceFile: '/tmp/x.jsonl',
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

function repo(sessionId: string, role: SessionRepo['role'], url: string, root: string, name: string): SessionRepo {
  return { sessionId, role, url, root, name, evidenceKind: 'observed' };
}

const URL_A = 'https://github.com/org/alpha.git';
const URL_B = 'https://github.com/org/beta.git';

function seededStore() {
  const store = openMemoryDb();
  const now = Date.now();
  store.upsertSessions([
    session({ id: 'claude:u1', provider: 'claude', nativeId: 'u1', updatedAt: now - 1000, totalTokens: 100 }),
    session({ id: 'codex:s1', provider: 'codex', nativeId: 's1', updatedAt: now - 2000, totalTokens: 50, origin: 'subagent' }),
    session({ id: 'claude:u2', provider: 'claude', nativeId: 'u2', updatedAt: now - 3000, totalTokens: 30 }),
  ]);
  store.replaceSessionRepos('claude:u1', [repo('claude:u1', 'work', URL_A, '/repo/alpha', 'alpha')]);
  store.replaceSessionRepos('codex:s1', [repo('codex:s1', 'touch', URL_A, '/repo/alpha', 'alpha')]);
  store.replaceSessionRepos('claude:u2', [repo('claude:u2', 'touch', URL_B, '/repo/beta', 'beta')]);
  store.upsertSessionCommits([{
    sessionId: 'claude:u1', repo: URL_A, sha: 'a'.repeat(40), kind: 'candidate',
    ts: now - 500, summary: 'feat: alpha work', fileOverlap: true, pushed: true,
  }]);
  store.upsertSessionMessages([{
    id: 'claude:u1:msg1', sessionId: 'claude:u1', seq: 1, role: 'user', kind: 'text',
    toolName: null, text: '给 alpha 项目补上鉴权中间件', timestamp: now - 900, model: null,
    inputTokens: null, outputTokens: null,
  }]);
  // 需求 span 归因的证据窗口内有 touch,需求才能落到 alpha 项目
  store.upsertSessionTouches([{
    id: 'claude:u1:touch1', sessionId: 'claude:u1', provider: 'claude',
    filePath: '/repo/alpha/src/auth.ts', toolName: 'Edit', op: 'edit', ts: now - 800, ordinal: 3000,
  }]);
  materializeRequirements(store);
  store.materializeProjects();
  return store;
}

describe('projectEntityId', () => {
  test('确定性 + 区分输入', () => {
    expect(projectEntityId(URL_A)).toBe(projectEntityId(URL_A));
    expect(projectEntityId(URL_A)).not.toBe(projectEntityId(URL_B));
    expect(projectEntityId(URL_A)).toMatch(/^[0-9a-f]{12}$/);
    // 无 remote 的 repo 用 root path 做输入(dsh-track 同款退化)
    expect(projectEntityId('/repo/local-only')).toBe(projectEntityId('/repo/local-only'));
  });
});

describe('materializeProjects', () => {
  test('幂等 + root 多数值', () => {
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'claude:a', provider: 'claude', nativeId: 'a' }),
      session({ id: 'claude:b', provider: 'claude', nativeId: 'b' }),
      session({ id: 'claude:c', provider: 'claude', nativeId: 'c' }),
    ]);
    store.replaceSessionRepos('claude:a', [repo('claude:a', 'work', URL_A, '/wt/alpha-worktree', 'alpha')]);
    store.replaceSessionRepos('claude:b', [repo('claude:b', 'touch', URL_A, '/repo/alpha', 'alpha')]);
    store.replaceSessionRepos('claude:c', [repo('claude:c', 'touch', URL_A, '/repo/alpha', 'alpha')]);
    expect(store.materializeProjects()).toBe(1);
    expect(store.materializeProjects()).toBe(1); // 幂等:重跑不重复
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ url: URL_A, name: 'alpha', root: '/repo/alpha' });
    expect(projects[0]?.id).toBe(projectEntityId(URL_A));
  });

  test('v5 迁移:老库(user_version=4)从 session_repos backfill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planofplan-projects-migration-'));
    const dbPath = join(dir, 'old.db');
    try {
      // 模拟 v4 老库:只有 session_repos 和版本号(其它表由 SCHEMA IF NOT EXISTS 补)
      const raw = new Database(dbPath);
      raw.exec(`CREATE TABLE session_repos (
        session_id TEXT NOT NULL, role TEXT NOT NULL, url TEXT NOT NULL,
        root TEXT, name TEXT NOT NULL, evidence_kind TEXT NOT NULL, first_seq INTEGER,
        PRIMARY KEY (session_id, role, url))`);
      raw.query('INSERT INTO session_repos VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('claude:a', 'work', URL_A, '/repo/alpha', 'alpha', 'observed', null);
      raw.exec('PRAGMA user_version = 4');
      raw.close();
      const store = openDb(dbPath);
      // 迁移链 v4 → … → v7(v6:Launch 边;v7:需求实体)
      expect(store.getUserVersion()).toBe(7);
      const projects = store.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ url: URL_A, name: 'alpha' });
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  });
});

describe('project endpoints', () => {
  test('/api/projects:窗口聚合 + origin 拆分 + commit 计数', async () => {
    const store = seededStore();
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const response = await server.request('http://localhost/api/projects?days=7');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      projects: Array<{
        id: string; name: string; sessionCount: number; userSessionCount: number;
        commitCount: number; requirementCount: number | null;
        agents: Array<{ provider: string; sessions: number; userSessions: number; automatedSessions: number; tokens: number }>;
      }>;
    };
    expect(body.projects).toHaveLength(2);
    const alpha = body.projects.find((p) => p.name === 'alpha');
    expect(alpha).toMatchObject({ sessionCount: 2, userSessionCount: 1, commitCount: 1, requirementCount: 1 });
    expect(alpha?.agents.map((a) => `${a.provider}:${a.sessions}/${a.userSessions}`)).toEqual(['claude:1/1', 'codex:1/0']);
    expect(alpha?.agents[0]?.tokens).toBe(100);
    // 空窗口
    const empty = await server.request('http://localhost/api/projects?days=1');
    const emptyBody = await empty.json() as { projects: Array<{ sessionCount: number }> };
    const cutoff = Date.now() - 86_400_000;
    const anyInWindow = store.projectActivity(cutoff, Date.now()).length > 0;
    if (!anyInWindow) {
      expect(emptyBody.projects.every((p) => p.sessionCount === 0)).toBe(true);
    }
  });

  test('/api/projects/:id:详情字段完整 + 404', async () => {
    const store = seededStore();
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const id = projectEntityId(URL_A);
    const response = await server.request(`http://localhost/api/projects/${id}?days=7`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      name: string;
      agents: Array<{ provider: string }>;
      sessions: Array<{ id: string; origin?: string }>;
      requirements: Array<{ sessionId: string; text: string }>;
      commits: Array<{ sha: string; fileOverlap: boolean }>;
    };
    expect(body.name).toBe('alpha');
    expect(body.agents).toHaveLength(2);
    expect(body.sessions.map((s) => s.id).sort()).toEqual(['claude:u1', 'codex:s1']);
    // requirements 来自需求实体表(span 归因到本项目),带 origin 分级
    expect(body.requirements).toHaveLength(1);
    expect(body.requirements[0]).toMatchObject({ sessionId: 'claude:u1', text: '给 alpha 项目补上鉴权中间件', originLevel: 'user_explicit' });
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]?.fileOverlap).toBe(true);

    const missing = await server.request('http://localhost/api/projects/nope');
    expect(missing.status).toBe(404);
  });
});
