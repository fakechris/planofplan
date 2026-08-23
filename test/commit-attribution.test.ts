import { describe, expect, test } from 'bun:test';
import {
  attributeRepoCommits,
  boundedGitRunner,
  collectSessionCommits,
  parseGitLogFiles,
} from '../src/commit-attribution.ts';
import { openMemoryDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionRecord, SessionRepo } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

/** 按真实 `git log -z --format='%H%x00%cI%x00%s%x00%b%x00' --name-only` 输出拼 raw。 */
function gitLogRaw(commits: Array<{ sha: string; iso: string; subject: string; body?: string; files?: string[] }>): string {
  const fields: string[] = [];
  for (const commit of commits) {
    fields.push(commit.sha, commit.iso, commit.subject, commit.body ?? '');
    if (commit.files && commit.files.length > 0) {
      fields.push('', `\n${commit.files[0]}`, ...commit.files.slice(1));
    }
  }
  return fields.join('\0') + '\0';
}

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'nativeId'>): SessionRecord {
  return {
    provider: 'claude',
    cwd: '/repo',
    title: 'demo',
    sourceFile: '/tmp/x.jsonl',
    startedAt: Date.parse('2026-08-20T10:00:00.000Z'),
    updatedAt: Date.parse('2026-08-20T11:00:00.000Z'),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    ...partial,
  };
}

const repo = { url: 'git@example.com:org/repo.git', root: '/repo', name: 'repo' };
const touches = new Map([['claude:s1', new Set(['src/db.ts'])]]);

describe('parseGitLogFiles', () => {
  test('真实输出格式:header 四字段 + 空字段 + \\n 前缀的文件列表', () => {
    const raw = gitLogRaw([
      { sha: SHA_A, iso: '2026-08-20T10:30:00.000Z', subject: 'feat: db layer', body: 'body line\n', files: ['src/db.ts', 'src/types.ts'] },
      { sha: SHA_B, iso: '2026-08-20T10:45:00.000Z', subject: 'fix: no files' },
    ]);
    const commits = parseGitLogFiles(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ sha: SHA_A, subject: 'feat: db layer', files: ['src/db.ts', 'src/types.ts'] });
    expect(commits[0]?.committedAt).toBe(Date.parse('2026-08-20T10:30:00.000Z'));
    expect(commits[1]?.files).toEqual([]);
    expect(parseGitLogFiles('')).toEqual([]);
  });
});

describe('attributeRepoCommits', () => {
  test('trailer 命中 → declared', () => {
    const s1 = session({ id: 'claude:s1', nativeId: 's1' });
    const git = () => gitLogRaw([
      { sha: SHA_A, iso: '2026-08-20T10:30:00.000Z', subject: 'feat', body: 'x\n\nHarness-Session: claude:s1\n', files: ['src/db.ts'] },
    ]);
    const rows = attributeRepoCommits({ repo, sessions: [s1], touchesBySession: touches, git });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'claude:s1', sha: SHA_A, kind: 'declared', fileOverlap: true });
  });

  test('时间窗内 → candidate;文件交集标 fileOverlap;窗外不关联', () => {
    const s1 = session({ id: 'claude:s1', nativeId: 's1' });
    const git = () => gitLogRaw([
      { sha: SHA_A, iso: '2026-08-20T10:30:00.000Z', subject: 'in window, touched file', files: ['src/db.ts'] },
      { sha: SHA_B, iso: '2026-08-20T10:35:00.000Z', subject: 'in window, other file', files: ['docs/x.md'] },
      { sha: SHA_C, iso: '2026-08-25T10:30:00.000Z', subject: 'out of window', files: ['src/db.ts'] },
    ]);
    const rows = attributeRepoCommits({ repo, sessions: [s1], touchesBySession: touches, git });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sha === SHA_A)).toMatchObject({ kind: 'candidate', fileOverlap: true });
    expect(rows.find((r) => r.sha === SHA_B)).toMatchObject({ kind: 'candidate', fileOverlap: false });
  });

  test('candidate 每 commit 最多挂 5 个 session,文件交集优先', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session({
      id: `claude:s${i}`,
      nativeId: `s${i}`,
      updatedAt: Date.parse('2026-08-20T11:00:00.000Z') + i,
    }));
    const touchMap = new Map([['claude:s7', new Set(['src/db.ts'])]]);
    const git = () => gitLogRaw([
      { sha: SHA_A, iso: '2026-08-20T10:30:00.000Z', subject: 'x', files: ['src/db.ts'] },
    ]);
    const rows = attributeRepoCommits({ repo, sessions, touchesBySession: touchMap, git });
    expect(rows).toHaveLength(5);
    expect(rows[0]?.sessionId).toBe('claude:s7'); // 有文件交集的排最前
    expect(rows[0]?.fileOverlap).toBe(true);
  });

  test('git 失败 → 空结果,不抛出', () => {
    const git = () => { throw new Error('git killed: timeout'); };
    expect(attributeRepoCommits({
      repo,
      sessions: [session({ id: 'claude:s1', nativeId: 's1' })],
      touchesBySession: touches,
      git,
    })).toEqual([]);
  });

  test('boundedGitRunner 在非 repo 目录抛错(被调用方捕获)', () => {
    const git = boundedGitRunner(2000);
    expect(() => git(['-C', '/tmp', 'log', '-n', '1'])).toThrow();
  });
});

describe('collectSessionCommits', () => {
  function seededStore() {
    const store = openMemoryDb();
    const now = Date.now();
    store.upsertSessions([session({
      id: 'claude:s1', nativeId: 's1', cwd: '/repo', seenAt: now,
    })]);
    const repoRow: SessionRepo = {
      sessionId: 'claude:s1', role: 'work', url: repo.url, root: '/repo', name: 'repo', evidenceKind: 'observed',
    };
    store.replaceSessionRepos('claude:s1', [repoRow]);
    store.upsertSessionTouches([{
      id: 'claude:s1:1:0', sessionId: 'claude:s1', provider: 'claude',
      filePath: '/repo/src/db.ts', toolName: 'Edit', op: 'edit', ts: now - 1000, ordinal: 1,
    }]);
    return store;
  }

  const since = Date.parse('2026-08-20T00:00:00.000Z');
  const until = Date.parse('2026-08-21T00:00:00.000Z');

  test('trailer + candidate 落表,重跑幂等,级联删除', async () => {
    const store = seededStore();
    const git = () => gitLogRaw([
      { sha: SHA_A, iso: '2026-08-20T10:30:00.000Z', subject: 'declared one', body: 'Harness-Session: s1\n', files: ['src/db.ts'] },
      { sha: SHA_B, iso: '2026-08-20T10:40:00.000Z', subject: 'candidate one', files: ['src/db.ts'] },
    ]);
    const n = await collectSessionCommits(store, { since, until, git });
    expect(n).toBe(2);
    const rows = store.listSessionCommits('claude:s1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.sha === SHA_A)?.kind).toBe('declared');
    expect(rows.find((r) => r.sha === SHA_B)).toMatchObject({ kind: 'candidate', fileOverlap: true });
    // 反查
    expect(store.sessionsForCommit(SHA_A).map((r) => r.sessionId)).toEqual(['claude:s1']);
    expect(store.sessionsForCommit(SHA_A.slice(0, 8))).toHaveLength(1);
    // 重跑:先清后算,不重复
    const again = await collectSessionCommits(store, { since, until, git });
    expect(again).toBe(2);
    expect(store.listSessionCommits('claude:s1')).toHaveLength(2);
    // 级联
    store.deleteSession('claude:s1');
    expect(store.listSessionCommits('claude:s1')).toHaveLength(0);
  });

  test('git 抛错时跳过该 repo,返回 0', async () => {
    const store = seededStore();
    const git = () => { throw new Error('timeout'); };
    expect(await collectSessionCommits(store, { since, until, git })).toBe(0);
    expect(store.listSessionCommits()).toHaveLength(0);
  });

  test('git: null 整环关闭', async () => {
    const store = seededStore();
    expect(await collectSessionCommits(store, { since, until, git: null })).toBe(0);
  });
});

describe('commit endpoints', () => {
  test('GET commits / sha 反查', async () => {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const now = Date.now();
    store.upsertSessions([session({ id: 'claude:s1', nativeId: 's1', seenAt: now })]);
    store.upsertSessionCommits([{
      sessionId: 'claude:s1', repo: repo.url, sha: SHA_A, kind: 'declared',
      ts: now - 1000, summary: 'feat: x', fileOverlap: true,
    }]);
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });

    const bySession = await server.request('http://localhost/api/sessions/claude/s1/commits');
    expect(bySession.status).toBe(200);
    const body = await bySession.json() as { commits: Array<{ sha: string; kind: string; fileOverlap: boolean }> };
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({ sha: SHA_A, kind: 'declared', fileOverlap: true });

    const bySha = await server.request(`http://localhost/api/commits/${SHA_A.slice(0, 8)}/sessions`);
    const shaBody = await bySha.json() as { sessions: Array<{ sessionId: string; title: string }> };
    expect(shaBody.sessions).toHaveLength(1);
    expect(shaBody.sessions[0]).toMatchObject({ sessionId: 'claude:s1', title: 'demo' });

    const unknown = await server.request('http://localhost/api/sessions/claude/nope/commits');
    expect(unknown.status).toBe(404);
  });
});
