import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openDb, openMemoryDb, projectEntityId , SCHEMA_VERSION } from '../src/db.ts';
import { canonicalRepoUrl, groupCanonicalProjects, isToolOrNoiseRoot } from '../src/repos.ts';
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
      // 迁移链 v4 → … → v11(Launch 边 · 需求实体 · 计划态 · FTS 瘦身)
      expect(store.getUserVersion()).toBe(SCHEMA_VERSION);
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

describe('INV-2198: 项目归并、去重 commitCount 与 codeOnly 降噪', () => {
  test('canonicalRepoUrl 与 isToolOrNoiseRoot 判定准确(不误伤 ~/source/research 业务仓)', () => {
    expect(canonicalRepoUrl('https://github.com/fakechris/lumenbox.git')).toBe('github.com/fakechris/lumenbox');
    expect(canonicalRepoUrl('https://github.com/fakechris/lumenbox')).toBe('github.com/fakechris/lumenbox');
    expect(canonicalRepoUrl('git@github.com:FakeChris/LumenBox.git')).toBe('github.com/fakechris/lumenbox');
    expect(canonicalRepoUrl('file:///Users/chris/repo/')).toBe('/Users/chris/repo');

    expect(isToolOrNoiseRoot('/opt/homebrew/Library/Taps/homebrew/homebrew-core')).toBe(true);
    expect(isToolOrNoiseRoot('/Users/chris/.agents/skills/gstack')).toBe(true);
    expect(isToolOrNoiseRoot('/Users/chris/.claude/skills/humanizer-zh')).toBe(true);
    expect(isToolOrNoiseRoot('/tmp/scratch')).toBe(true);
    // 业务项目放在 ~/source/research/ 下绝不被误判为工具目录
    expect(isToolOrNoiseRoot('/Users/chris/source/research/grokbot/agentbox')).toBe(false);
    expect(isToolOrNoiseRoot('/Users/chris/workspace/planofplan')).toBe(false);
  });

  test('groupCanonicalProjects 归并同源 .git/无.git、同 root、兄弟 worktree 与单仓父目录,但不误合并多仓父目录', () => {
    const now = Date.now();
    const gitRoots = new Set([
      '/Users/chris/source/research/grokbot/agentbox',
      '/Users/chris/workspace/repo-a',
      '/Users/chris/workspace/repo-b',
      '/opt/homebrew',
    ]);
    const items = [
      { id: 'p-main', url: 'https://github.com/fakechris/lumenbox.git', name: 'lumenbox', root: '/Users/chris/source/research/grokbot/agentbox', lastSeenAt: now },
      { id: 'p-nogit', url: 'https://github.com/fakechris/lumenbox', name: 'lumenbox', root: '/Users/chris/source/research/grokbot/agentbox', lastSeenAt: now - 100 },
      { id: 'p-local', url: '/Users/chris/source/research/grokbot/agentbox', name: 'agentbox', root: '/Users/chris/source/research/grokbot/agentbox', lastSeenAt: now - 200 },
      { id: 'p-wt', url: '/Users/chris/source/research/grokbot/agentbox-r30', name: 'agentbox-r30', root: '/Users/chris/source/research/grokbot/agentbox-r30', lastSeenAt: now - 300 },
      { id: 'p-parent', url: '/Users/chris/source/research/grokbot', name: 'grokbot', root: '/Users/chris/source/research/grokbot', lastSeenAt: now - 400 },
      { id: 'p-ra', url: 'https://github.com/org/repo-a.git', name: 'repo-a', root: '/Users/chris/workspace/repo-a', lastSeenAt: now },
      { id: 'p-rb', url: 'https://github.com/org/repo-b.git', name: 'repo-b', root: '/Users/chris/workspace/repo-b', lastSeenAt: now },
      { id: 'p-ws', url: '/Users/chris/workspace', name: 'workspace', root: '/Users/chris/workspace', lastSeenAt: now - 500 },
      { id: 'p-brew', url: 'https://github.com/Homebrew/brew', name: 'brew', root: '/opt/homebrew', lastSeenAt: now - 600 },
    ];
    const groups = groupCanonicalProjects(items, { hasGitDir: (r) => gitRoots.has(r) });
    const lumen = groups.find((g) => g.primary.id === 'p-main');
    expect(lumen).toBeDefined();
    expect(lumen!.aliases.map((a) => a.id).sort()).toEqual(['p-local', 'p-nogit', 'p-parent', 'p-wt']);
    expect(lumen!.aliasNames.sort()).toEqual(['agentbox', 'agentbox-r30', 'grokbot']);
    expect(lumen!.hasGit).toBe(true);
    expect(lumen!.isToolRepo).toBe(false);

    // 多仓父目录 ~/workspace 不得被合并到 repo-a 或 repo-b
    const ws = groups.find((g) => g.primary.id === 'p-ws');
    expect(ws).toBeDefined();
    expect(ws!.hasGit).toBe(false);

    // brew 标记为工具仓
    const brew = groups.find((g) => g.primary.id === 'p-brew');
    expect(brew?.isToolRepo).toBe(true);
  });

  test('COUNT(DISTINCT sha) 去重 + commit_provenance 优先 + codeOnly 过滤 + 别名 ID 路由兼容', async () => {
    const store = openMemoryDb();
    const now = Date.now();
    const mainUrl = 'https://github.com/fakechris/lumenbox.git';
    const aliasUrl = '/Users/chris/source/research/grokbot/agentbox';
    const noiseUrl = '/Users/chris/scratch-empty-dir';
    const sha1 = '1'.repeat(40);
    const sha2 = '2'.repeat(40);
    const sha3 = '3'.repeat(40);

    store.upsertSessions([
      session({ id: 'claude:s1', provider: 'claude', nativeId: 's1', updatedAt: now - 1000, totalTokens: 200 }),
      session({ id: 'codex:s2', provider: 'codex', nativeId: 's2', updatedAt: now - 2000, totalTokens: 300 }),
      session({ id: 'claude:noise', provider: 'claude', nativeId: 'noise', updatedAt: now - 3000, totalTokens: 10 }),
    ]);
    // 同一 session s1 同时关联 mainUrl 和 aliasUrl,合并后不能重复计 session/token
    store.replaceSessionRepos('claude:s1', [
      repo('claude:s1', 'work', mainUrl, '/repo/lumenbox', 'lumenbox'),
      repo('claude:s1', 'touch', aliasUrl, '/repo/lumenbox', 'agentbox'),
    ]);
    store.replaceSessionRepos('codex:s2', [
      repo('codex:s2', 'work', aliasUrl, '/repo/lumenbox', 'agentbox'),
    ]);
    store.replaceSessionRepos('claude:noise', [
      repo('claude:noise', 'work', noiseUrl, noiseUrl, 'scratch-empty-dir'),
    ]);
    // 同一 SHA 被两个 session 匹配成 candidate,COUNT(DISTINCT sha) 应为 1 而非 2
    store.upsertSessionCommits([
      { sessionId: 'claude:s1', repo: mainUrl, sha: sha1, kind: 'candidate', ts: now - 500, summary: 'feat: one', fileOverlap: false, pushed: true },
      { sessionId: 'codex:s2', repo: mainUrl, sha: sha1, kind: 'witnessed', ts: now - 500, summary: 'feat: one', fileOverlap: true, pushed: true },
    ]);
    store.materializeProjects();

    expect(store.projectCommitCounts(now - 86_400_000).get(mainUrl)).toBe(1);

    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    // 未写 commit_provenance 前:回退 session_commits 去重数 (= 1)
    const r1 = await (await server.request('http://localhost/api/projects?days=7&codeOnly=1')).json() as {
      totalProjects: number;
      projects: Array<{ id: string; name: string; sessionCount: number; commitCount: number; commitSource: string; aliasNames: string[] }>;
    };
    expect(r1.totalProjects).toBe(2); // lumenbox(合并后) + scratch-empty-dir
    expect(r1.projects).toHaveLength(1); // codeOnly 折叠无 git 零 commit 目录
    expect(r1.projects[0]).toMatchObject({
      name: 'lumenbox',
      sessionCount: 2, // s1 不双计!
      commitCount: 1,
      commitSource: 'session_commits',
      aliasNames: ['agentbox'],
    });

    // 写入 3 条真实 commit_provenance 后:列表与详情 commitCount 立刻切换为 3 (provenance)
    store.upsertCommitProvenance([sha1, sha2, sha3].map((sha, i) => ({
      repoUrl: mainUrl,
      sha,
      prNumber: i + 1,
      committedAt: now - (i + 1) * 1000,
      authorName: 'Chris',
      subject: `feat: c${i + 1}`,
      tier: 'hunk-matched' as const,
      primaryProvider: 'claude',
      primaryModel: 'claude-opus-5-5',
      totalDistLines: 10,
      matchedDistLines: 10,
      relayKind: '' as const,
      filesCount: 1,
      files: ['src/a.ts'],
      authors: [{ provider: 'claude', model: 'claude-opus-5-5', lines: 10, source: 'hunk' }],
      declared: [],
      witnessedAuthor: [],
      mergedBy: [],
      reviewers: [],
      sessions: [],
      analyzerVersion: 1,
      analyzedAt: now,
    })));

    const r2 = await (await server.request('http://localhost/api/projects?days=7&codeOnly=1')).json() as {
      projects: Array<{ id: string; commitCount: number; commitSource: string }>;
    };
    expect(r2.projects[0]).toMatchObject({ commitCount: 3, commitSource: 'provenance' });

    // 用旧别名 ID 访问 /api/projects/:aliasId 仍可自动路由到主项目并拿到合并后的全部 session/commit
    const aliasId = projectEntityId(aliasUrl);
    const detailRes = await server.request(`http://localhost/api/projects/${aliasId}?days=7`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as {
      name: string;
      sessionCount: number;
      commitCount: number;
      commitSource: string;
      aliasNames: string[];
      commits: Array<{ sha: string; kind: string; fileOverlap: boolean }>;
    };
    expect(detail).toMatchObject({
      name: 'lumenbox',
      sessionCount: 2,
      commitCount: 3,
      commitSource: 'provenance',
      aliasNames: ['agentbox'],
    });
    // projectCommits 按 sha 去重并保留高证据档(witnessed)和 fileOverlap=true
    expect(detail.commits).toHaveLength(1);
    expect(detail.commits[0]).toMatchObject({ sha: sha1, kind: 'witnessed', fileOverlap: true });
  });
});

describe('INV-2200: 跨仓广播 touch 过滤、updated_at 漂移校准与 days=all / totalCommitCount', () => {
  test('单会话 touch > 5 仓时过滤其 touch 广播噪音,但保留自身 work 归属', async () => {
    const store = openMemoryDb();
    const now = Date.now();
    const urls = Array.from({ length: 7 }, (_, i) => `https://github.com/org/repo-${i}.git`);
    store.upsertSessions([
      session({ id: 'minimax-code:sweep', provider: 'minimax-code', nativeId: 'sweep', updatedAt: now - 1000 }),
      session({ id: 'claude:real0', provider: 'claude', nativeId: 'real0', updatedAt: now - 5000 }),
    ]);
    // sweep 会话在 repo-0 上 work,但顺带 touch 了 6 个其它仓库(>5 阈值)
    store.replaceSessionRepos('minimax-code:sweep', [
      repo('minimax-code:sweep', 'work', urls[0]!, '/repo/0', 'repo-0'),
      ...urls.slice(1).map((u, i) => repo('minimax-code:sweep', 'touch', u, `/repo/${i + 1}`, `repo-${i + 1}`)),
    ]);
    store.replaceSessionRepos('claude:real0', [
      repo('claude:real0', 'work', urls[0]!, '/repo/0', 'repo-0'),
    ]);
    store.materializeProjects();

    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const body = await (await server.request('http://localhost/api/projects?days=30')).json() as {
      projects: Array<{ name: string; sessionCount: number; lastActive: number | null }>;
    };
    const r0 = body.projects.find((p) => p.name === 'repo-0');
    const r1 = body.projects.find((p) => p.name === 'repo-1');
    expect(r0?.sessionCount).toBe(2); // work 边完整保留
    expect(r1?.sessionCount).toBe(0); // 广播 touch 不得污染 repo-1..6
    expect(r1?.lastActive).toBeNull();

    // 详情页 projectSessionsForUrls 同样排除广播 touch
    const d1 = await (await server.request(`http://localhost/api/projects/${projectEntityId(urls[1]!)}?days=30`)).json() as {
      sessions: Array<{ id: string }>;
    };
    expect(d1.sessions).toHaveLength(0);
  });

  test('days=30 返回 totalCommitCount(全量考古数)且 days=all 返回全量 commit 与会话', async () => {
    const store = openMemoryDb();
    const now = Date.now();
    const oldTs = now - 45 * 86_400_000; // 45 天前(在 30 天外)
    const repoUrl = 'https://github.com/fakechris/mreviewer.git';
    store.upsertSessions([
      session({ id: 'claude:old', provider: 'claude', nativeId: 'old', updatedAt: oldTs }),
    ]);
    store.replaceSessionRepos('claude:old', [repo('claude:old', 'work', repoUrl, '/repo/mreviewer', 'mreviewer')]);
    store.upsertCommitProvenance([{
      repoUrl,
      sha: '9'.repeat(40),
      prNumber: 1,
      committedAt: oldTs,
      authorName: 'Chris',
      subject: 'old commit',
      tier: 'hunk-matched',
      primaryProvider: 'claude',
      primaryModel: 'claude-opus-5-5',
      totalDistLines: 10,
      matchedDistLines: 10,
      relayKind: '',
      filesCount: 1,
      files: ['src/a.ts'],
      authors: [{ provider: 'claude', model: 'claude-opus-5-5', lines: 10, source: 'hunk' }],
      declared: [],
      witnessedAuthor: [],
      mergedBy: [],
      reviewers: [],
      sessions: [],
      analyzerVersion: 1,
      analyzedAt: now,
    }]);
    store.materializeProjects();

    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const d30 = await (await server.request('http://localhost/api/projects?days=30&codeOnly=1')).json() as {
      projects: Array<{ name: string; commitCount: number; totalCommitCount?: number; sessionCount: number }>;
    };
    expect(d30.projects).toHaveLength(1);
    expect(d30.projects[0]).toMatchObject({ name: 'mreviewer', commitCount: 0, totalCommitCount: 1, sessionCount: 0 });

    const dAll = await (await server.request('http://localhost/api/projects?days=all&codeOnly=1')).json() as {
      days: string | number;
      projects: Array<{ name: string; commitCount: number; totalCommitCount?: number; sessionCount: number }>;
    };
    expect(dAll.days).toBe('all');
    expect(dAll.projects[0]).toMatchObject({ name: 'mreviewer', commitCount: 1, totalCommitCount: 1, sessionCount: 1 });
  });

  test('reconcileDriftedSessionUpdatedAt 将被元事件顶高的旧会话 updated_at 回拨到真实消息时间', () => {
    const store = openMemoryDb();
    const now = Date.now();
    const realMsgTs = now - 32 * 86_400_000;
    store.upsertSessions([
      session({ id: 'claude:drifted', provider: 'claude', nativeId: 'drifted', updatedAt: now }),
      session({ id: 'claude:fresh', provider: 'claude', nativeId: 'fresh', updatedAt: now }),
    ]);
    store.upsertSessionMessages([
      {
        id: 'claude:drifted:1', sessionId: 'claude:drifted', seq: 1, role: 'assistant', kind: 'text',
        toolName: null, text: 'done', timestamp: realMsgTs, model: null, inputTokens: null, outputTokens: null,
      },
      {
        id: 'claude:fresh:1', sessionId: 'claude:fresh', seq: 1, role: 'assistant', kind: 'text',
        toolName: null, text: 'recent', timestamp: now - 5_000, model: null, inputTokens: null, outputTokens: null,
      },
    ]);
    expect(store.reconcileDriftedSessionUpdatedAt()).toBe(1);
    expect(store.getSession('claude:drifted')?.updatedAt).toBe(realMsgTs);
    expect(store.getSession('claude:fresh')?.updatedAt).toBe(now);
  });
});

describe('INV-2206: 依赖缓存/内部目录折叠、0-commit 蹭边只读过滤与 4 种排序', () => {
  test('isToolOrNoiseRoot 覆盖 cargo 依赖缓存、codex memories 与 esp-idf SDK', () => {
    expect(isToolOrNoiseRoot('/Users/chris/.cargo/git/checkouts/lumen-suite-6af7ae16d8ed3389/22c1e6c/')).toBe(true);
    expect(isToolOrNoiseRoot('/Users/chris/.codex/memories')).toBe(true);
    expect(isToolOrNoiseRoot('/Users/chris/esp/esp-idf-v5.5.3')).toBe(true);
    expect(isToolOrNoiseRoot('/Users/chris/source/lumen-suite')).toBe(false);
  });

  test('codeOnly=1 折叠工具目录与 0-commit 仅 touch/子代理只读仓,且默认 commit_recent 排序有 commit 优先', async () => {
    const store = openMemoryDb();
    const now = Date.now();
    const uCommitOld = 'https://github.com/org/main-repo.git';
    const uCommitNew = 'https://github.com/org/newer-repo.git';
    const uWorkNoCommit = 'https://github.com/org/wip-repo.git';
    const uTouchOnly = 'https://github.com/org/sdk-touch-only.git';
    const uSubagentOnly = 'https://github.com/org/subagent-read.git';
    const uMemories = '/Users/chris/.codex/memories';

    store.upsertSessions([
      session({ id: 'claude:c1', provider: 'claude', nativeId: 'c1', updatedAt: now - 60_000, origin: 'user' }),
      session({ id: 'claude:c2', provider: 'claude', nativeId: 'c2', updatedAt: now - 30_000, origin: 'user' }),
      session({ id: 'claude:wip', provider: 'claude', nativeId: 'wip', updatedAt: now - 1_000, origin: 'user' }), // 最近但 0 commit
      session({ id: 'claude:sub', provider: 'claude', nativeId: 'sub', updatedAt: now - 500, origin: 'subagent' }),
      session({ id: 'codex:mem', provider: 'codex', nativeId: 'mem', updatedAt: now - 200, origin: 'exec' }),
    ]);
    store.replaceSessionRepos('claude:c1', [repo('claude:c1', 'work', uCommitOld, '/repo/main-repo', 'main-repo')]);
    store.replaceSessionRepos('claude:c2', [repo('claude:c2', 'work', uCommitNew, '/repo/newer-repo', 'newer-repo')]);
    store.replaceSessionRepos('claude:wip', [
      repo('claude:wip', 'work', uWorkNoCommit, '/repo/wip-repo', 'wip-repo'),
      repo('claude:wip', 'touch', uTouchOnly, '/repo/sdk-touch-only', 'sdk-touch-only'),
    ]);
    store.replaceSessionRepos('claude:sub', [repo('claude:sub', 'work', uSubagentOnly, '/repo/subagent-read', 'subagent-read')]);
    store.replaceSessionRepos('codex:mem', [repo('codex:mem', 'work', uMemories, uMemories, 'memories')]);
    store.upsertSessionCommits([
      { sessionId: 'claude:c1', repo: uCommitOld, sha: 'a'.repeat(40), kind: 'declared', ts: now - 60_000, summary: 'c1', fileOverlap: true, pushed: true },
      { sessionId: 'claude:c1', repo: uCommitOld, sha: 'b'.repeat(40), kind: 'declared', ts: now - 55_000, summary: 'c2', fileOverlap: true, pushed: true },
      { sessionId: 'claude:c2', repo: uCommitNew, sha: 'c'.repeat(40), kind: 'declared', ts: now - 30_000, summary: 'c3', fileOverlap: true, pushed: true },
      // 即使 memories 偶然有 1 条 commit,工具目录在 codeOnly=1 下也必须被折叠
      { sessionId: 'codex:mem', repo: uMemories, sha: 'd'.repeat(40), kind: 'candidate', ts: now - 200, summary: 'mem', fileOverlap: false, pushed: true },
    ]);
    store.materializeProjects();

    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    // 默认 sort=commit_recent + codeOnly=1:
    // 1) sdk-touch-only (0 work), subagent-read (0 user), memories (isToolRepo) 全部折叠
    // 2) 有 commit 的 newer-repo(更近) > main-repo(更早) 排在 0-commit 但最新的 wip-repo 前面!
    const rDefault = await (await server.request('http://localhost/api/projects?days=30&codeOnly=1')).json() as {
      sort: string;
      projects: Array<{ name: string; commitCount: number }>;
    };
    expect(rDefault.sort).toBe('commit_recent');
    expect(rDefault.projects.map((p) => p.name)).toEqual(['newer-repo', 'main-repo', 'wip-repo']);

    // sort=commits: main-repo(2) > newer-repo(1) > wip-repo(0)
    const rCommits = await (await server.request('http://localhost/api/projects?days=30&codeOnly=1&sort=commits')).json() as {
      projects: Array<{ name: string }>;
    };
    expect(rCommits.projects.map((p) => p.name)).toEqual(['main-repo', 'newer-repo', 'wip-repo']);

    // sort=recent: wip-repo(1s ago) > newer-repo(30s ago) > main-repo(60s ago)
    const rRecent = await (await server.request('http://localhost/api/projects?days=30&codeOnly=1&sort=recent')).json() as {
      projects: Array<{ name: string }>;
    };
    expect(rRecent.projects.map((p) => p.name)).toEqual(['wip-repo', 'newer-repo', 'main-repo']);
  });
});

describe('INV-2208: 全面性能与 Safari 内存优化回归锁定', () => {
  test('/api/sessions?graph=0 跳过大 work graph 构建,不传时保持向后兼容', async () => {
    const store = seededStore();
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const withGraph = await (await server.request('http://localhost/api/sessions?days=30')).json() as {
      sessions: unknown[];
      graph: { nodes: unknown[]; edges: unknown[] };
    };
    expect(withGraph.sessions.length).toBeGreaterThan(0);
    expect(withGraph.graph.nodes.length).toBeGreaterThan(0);

    const noGraph = await (await server.request('http://localhost/api/sessions?days=30&graph=0')).json() as {
      sessions: unknown[];
      graph: { nodes: unknown[]; edges: unknown[] };
    };
    expect(noGraph.sessions.length).toBe(withGraph.sessions.length);
    expect(noGraph.graph.nodes).toEqual([]);
    expect(noGraph.graph.edges).toEqual([]);
  });

  test('/api/requirements 与 /api/planfiles 支持有界 limit、total 计数与单次联查', async () => {
    const store = openMemoryDb();
    const now = Date.now();
    store.upsertSessions([
      session({ id: 'claude:r1', provider: 'claude', nativeId: 'r1', updatedAt: now - 1000 }),
    ]);
    store.replaceAllRequirements([1, 2, 3, 4].map((i) => ({
      id: `req:r1:${i}`,
      sessionId: 'claude:r1',
      seq: i,
      text: `需求 ${i}`,
      originLevel: 'user_explicit' as const,
      ts: now - i * 1000,
      repos: [URL_A],
    })));
    for (let i = 1; i <= 4; i++) {
      store.upsertPlanFileWithSnapshot({
        id: `pf-${i}`,
        path: `/repo/alpha/plan-${i}.md`,
        kind: 'plan',
        title: `Plan ${i}`,
        goal: `Goal ${i}`,
        currentPhase: 'P1',
        repo: URL_A,
        mtimeMs: now - i * 1000,
        rawHash: `hash-${i}-abcdef012345`,
        sections: [],
        checkboxChecked: i,
        checkboxTotal: 5,
        commitSha: null,
        now,
      });
    }
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });

    const reqRes = await (await server.request('http://localhost/api/requirements?days=30&limit=2')).json() as {
      total: number;
      truncated: boolean;
      requirements: unknown[];
      byProject: Array<{ name: string; count: number }>;
    };
    expect(reqRes.total).toBe(4);
    expect(reqRes.truncated).toBe(true);
    expect(reqRes.requirements).toHaveLength(2);
    expect(reqRes.byProject[0]?.count).toBe(4); // facets 始终基于全量

    const planRes = await (await server.request('http://localhost/api/planfiles?days=30&limit=2')).json() as {
      total: number;
      truncated: boolean;
      plans: Array<{ id: string; checkboxChecked: number; snapshotCount: number }>;
    };
    expect(planRes.total).toBe(4);
    expect(planRes.truncated).toBe(true);
    expect(planRes.plans).toHaveLength(2);
    expect(planRes.plans[0]).toMatchObject({ id: 'pf-1', checkboxChecked: 1, snapshotCount: 1 });
    expect(store.planFilesForRepos([URL_A])).toHaveLength(4);
  });

  test('web/app.js 具备后台休眠(document.hidden)、离屏 Tab 释放与事件委托守卫', async () => {
    const { readFileSync } = await import('node:fs');
    const appJs = readFileSync(join(import.meta.dir, '../web/app.js'), 'utf8');
    expect(appJs).toContain('if (!force && document.hidden) return;');
    expect(appJs).toContain('function releaseHiddenTabMemory(');
    expect(appJs).toContain("document.addEventListener('visibilitychange'");
    expect(appJs).toContain('&graph=0');
  });
});
