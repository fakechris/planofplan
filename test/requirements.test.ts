import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { classifyMessageIntent, deriveSessionRequirements, materializeRequirements } from '../src/requirements.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionFileTouch, SessionMessageRow, SessionRecord, SessionRepo } from '../src/types.ts';

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

function touch(partial: Partial<SessionFileTouch> & Pick<SessionFileTouch, 'id' | 'sessionId' | 'ordinal' | 'filePath'>): SessionFileTouch {
  return { provider: 'claude', toolName: 'Edit', op: 'edit', ts: null, ...partial };
}

const URL_A = 'git@github.com:chris/alpha.git';
const URL_B = 'git@github.com:chris/beta.git';

function seedRepos(store: ReturnType<typeof openMemoryDb>, sessionId: string): void {
  const repos: SessionRepo[] = [
    { sessionId, role: 'work', url: URL_A, root: '/repo/alpha', name: 'alpha', evidenceKind: 'observed' },
    { sessionId, role: 'touch', url: URL_B, root: '/repo/beta', name: 'beta', evidenceKind: 'observed' },
  ];
  store.replaceSessionRepos(sessionId, repos);
}

describe('classifyMessageIntent(v1 规则)', () => {
  test('实质请求 → requirement;执行步骤 → directive;纠正 → interruption;噪音 → noise', () => {
    expect(classifyMessageIntent('给项目页加一个按目录过滤的功能,要能记住选择')).toBe('requirement');
    expect(classifyMessageIntent('继续刚才的工作,先把测试跑绿再提交')).toBe('directive');
    expect(classifyMessageIntent('commit 并推送到远端仓库')).toBe('directive');
    expect(classifyMessageIntent('跑一下测试然后告诉我结果')).toBe('directive');
    expect(classifyMessageIntent('请你开始运行,开始执行吧。')).toBe('directive');
    expect(classifyMessageIntent('不对,这里应该改用方案 B 来处理并发')).toBe('interruption');
    expect(classifyMessageIntent('好')).toBe('noise'); // isShortAck
    expect(classifyMessageIntent('继续')).toBe('noise'); // 短确认,先于 directive 判定
    expect(classifyMessageIntent('<system-reminder>file changed</system-reminder>')).toBe('noise');
    expect(classifyMessageIntent('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>')).toBe('noise'); // markdown 粘贴
    expect(classifyMessageIntent('docs/134-paddle-system-milestones-and-task-list.md')).toBe('noise'); // 裸路径粘贴
    expect(classifyMessageIntent("The TodoWrite tool hasn't been used recently. If you're sure you want to continue")).toBe('noise'); // zcode 工具提醒注入
    expect(classifyMessageIntent('Unable to establish a secure connection to api.factory.ai. Retrying')).toBe('noise'); // 错误回显
    expect(classifyMessageIntent('')).toBe('noise');
  });

  test('长消息即使以指令词开头也是 requirement(长度护栏)', () => {
    const long = `继续把需求实体做完:要求建 requirements 表、带 origin 分级、按 span 归因项目,${'并且补上完整的测试覆盖与迁移幂等验证,确保真实库迁移一次通过。'.repeat(3)}`;
    expect(classifyMessageIntent(long)).toBe('requirement');
  });
});

describe('deriveSessionRequirements', () => {
  test('多条 requirement 意图消息 → 多个 user_explicit 实体;directive/envelope 不建', () => {
    const s = session({ id: 'claude:r1', provider: 'claude', nativeId: 'r1' });
    const derived = deriveSessionRequirements(s, [
      { seq: 2, ts: 1000, text: '<recommended_plugins>\nlist\n' },
      { seq: 4, ts: 2000, text: '给对话页加目录过滤,要能记住选择' },
      { seq: 6, ts: 3000, text: '继续' },
      { seq: 9, ts: 4000, text: '再做一个导出 csv 的功能,支持按项目分组' },
    ]);
    expect(derived).toHaveLength(2);
    expect(derived[0]).toMatchObject({ id: 'req:claude:r1:4', seq: 4, originLevel: 'user_explicit' });
    expect(derived[1]).toMatchObject({ id: 'req:claude:r1:9', seq: 9 });
  });

  test('一条都不合格时退 title → system_inferred;无 title → 空', () => {
    const s = session({ id: 'grok:g1', provider: 'grok', nativeId: 'g1', title: '头部解析的标题' });
    const derived = deriveSessionRequirements(s, [{ seq: 1, ts: null, text: '好' }]);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ id: 'req:grok:g1:-1', seq: -1, originLevel: 'system_inferred', text: '头部解析的标题' });
    expect(deriveSessionRequirements(session({ id: 'x:y', provider: 'grok', nativeId: 'y' }), [])).toEqual([]);
  });
});

describe('materializeRequirements', () => {
  test('span 级项目归因:窗口内碰的 repo 落到对应需求,不是 session 第一个 repo', () => {
    const store = openMemoryDb();
    const t0 = Date.now() - 60_000;
    store.upsertSessions([session({ id: 'claude:s1', provider: 'claude', nativeId: 's1', updatedAt: t0 + 5000 })]);
    seedRepos(store, 'claude:s1');
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:s1', seq: 4, role: 'user', text: '给 alpha 加一个入口页', timestamp: t0 }),
      msg({ id: 'm2', sessionId: 'claude:s1', seq: 9, role: 'user', text: '再去 beta 仓库做数据迁移', timestamp: t0 + 1000 }),
    ]);
    store.upsertSessionTouches([
      touch({ id: 't1', sessionId: 'claude:s1', ordinal: 5000, filePath: '/repo/alpha/src/a.ts' }),
      touch({ id: 't2', sessionId: 'claude:s1', ordinal: 9500, filePath: '/repo/beta/src/b.ts' }),
    ]);
    expect(materializeRequirements(store)).toBe(2);
    const rows = store.listRequirements();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'req:claude:s1:4', repos: [URL_A] });
    expect(rows[1]).toMatchObject({ id: 'req:claude:s1:9', repos: [URL_B] });
    // 幂等:重跑结果一致(确定性 id)
    materializeRequirements(store);
    expect(store.listRequirements()).toHaveLength(2);
  });

  test('只覆盖 user session;subagent 的派工 prompt 不建实体;全量替换语义', () => {
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'claude:u1', provider: 'claude', nativeId: 'u1', title: '用户会话' }),
      session({ id: 'claude:sub1', provider: 'claude', nativeId: 'sub1', origin: 'subagent' }),
    ]);
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:u1', seq: 1, role: 'user', text: '做一个真实的用户需求,要求全链路可追溯' }),
      msg({ id: 'm2', sessionId: 'claude:sub1', seq: 1, role: 'user', text: '你是研究员,去研究 X 并产出报告' }),
    ]);
    materializeRequirements(store);
    const rows = store.listRequirements();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('claude:u1');
    // 全量替换:空重导清掉存量(重导即幂等的另一面)
    store.replaceAllRequirements([]);
    expect(store.listRequirements()).toHaveLength(0);
  });

  test('级联:deleteSession 连带 requirements + requirement_repos', () => {
    const store = openMemoryDb();
    store.upsertSessions([session({ id: 'claude:c1', provider: 'claude', nativeId: 'c1' })]);
    seedRepos(store, 'claude:c1');
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:c1', seq: 1, role: 'user', text: '做一个能落库的真实需求实体,带级联测试' }),
    ]);
    store.upsertSessionTouches([
      touch({ id: 't1', sessionId: 'claude:c1', ordinal: 2000, filePath: '/repo/alpha/x.ts' }),
    ]);
    materializeRequirements(store);
    expect(store.listRequirements()).toHaveLength(1);
    store.deleteSession('claude:c1');
    expect(store.listRequirements()).toHaveLength(0);
    expect(store.projectRequirementCounts(0).size).toBe(0);
  });
});

describe('需求端点', () => {
  test('GET /api/requirements:窗口 + facet 口径 + 过滤', async () => {
    const store = openMemoryDb();
    const t0 = Date.now() - 1000;
    store.upsertSessions([
      session({ id: 'claude:ra', provider: 'claude', nativeId: 'ra', updatedAt: t0 }),
      session({ id: 'codex:rb', provider: 'codex', nativeId: 'rb', updatedAt: t0 }),
    ]);
    seedRepos(store, 'claude:ra');
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:ra', seq: 1, role: 'user', text: 'alpha 加一个导出功能,支持增量刷新', timestamp: t0 }),
      msg({ id: 'm2', sessionId: 'codex:rb', seq: 1, role: 'user', text: '做另一件事:把 grok 的解析器补齐并加测试', timestamp: t0 }),
    ]);
    store.upsertSessionTouches([
      touch({ id: 't1', sessionId: 'claude:ra', ordinal: 2000, filePath: '/repo/alpha/x.ts' }),
    ]);
    materializeRequirements(store);
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });

    const all = await server.request('http://localhost/api/requirements?days=30');
    expect(all.status).toBe(200);
    const allBody = await all.json() as {
      requirements: Array<{ id: string; provider: string; originLevel: string; repoNames: string[] }>;
      byProvider: Array<{ name: string; count: number }>;
      byLevel: Array<{ name: string; count: number }>;
      byProject: Array<{ name: string; count: number }>;
    };
    expect(allBody.requirements).toHaveLength(2);
    const alpha = allBody.requirements.find((item) => item.id === 'req:claude:ra:1');
    expect(alpha).toMatchObject({ provider: 'claude', originLevel: 'user_explicit', repoNames: ['alpha'] });
    expect(allBody.byProject.find((item) => item.name === 'alpha')?.count).toBe(1);

    const filtered = await server.request('http://localhost/api/requirements?days=30&provider=codex');
    const filteredBody = await filtered.json() as { requirements: Array<{ id: string }> };
    expect(filteredBody.requirements.map((item) => item.id)).toEqual(['req:codex:rb:1']);

    const missing = await server.request('http://localhost/api/requirements/req:none');
    expect(missing.status).toBe(404);
  });

  test('GET /api/requirements/:id:span 文件 + span commit + 404', async () => {
    const store = openMemoryDb();
    const t0 = Date.now() - 1000;
    store.upsertSessions([session({ id: 'claude:rc', provider: 'claude', nativeId: 'rc', updatedAt: t0 + 9000 })]);
    seedRepos(store, 'claude:rc');
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:rc', seq: 2, role: 'user', text: '第一个需求:把入口页重构为列表式布局', timestamp: t0 }),
      msg({ id: 'm2', sessionId: 'claude:rc', seq: 8, role: 'user', text: '第二个需求:补齐 README 和部署文档', timestamp: t0 + 5000 }),
    ]);
    store.upsertSessionTouches([
      touch({ id: 't1', sessionId: 'claude:rc', ordinal: 3000, filePath: '/repo/alpha/src/entry.ts' }),
      touch({ id: 't2', sessionId: 'claude:rc', ordinal: 9000, filePath: '/repo/beta/docs.md' }),
    ]);
    materializeRequirements(store);
    // 两条 commit:ts 分别落在 span1 / span2
    store.upsertSessionCommits([
      {
        sessionId: 'claude:rc', repo: URL_A, sha: 'aaaa1111aaaa', kind: 'declared',
        ts: t0 + 1000, summary: 'refactor entry', fileOverlap: true, pushed: true,
      },
      {
        sessionId: 'claude:rc', repo: URL_B, sha: 'bbbb2222bbbb', kind: 'candidate',
        ts: t0 + 8000, summary: 'docs', fileOverlap: false, pushed: false,
      },
    ]);
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });

    const detail = await server.request(`http://localhost/api/requirements/${encodeURIComponent('req:claude:rc:2')}`);
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      requirement: { text: string; repoNames: string[] };
      files: Array<{ path: string; ops: string[]; count: number }>;
      commits: Array<{ sha: string; kind: string; pushed: number }>;
      nextRequirementId: string | null;
    };
    expect(body.requirement.text).toContain('第一个需求');
    expect(body.files.map((file) => file.path)).toEqual(['/repo/alpha/src/entry.ts']);
    expect(body.commits.map((commit) => commit.sha.slice(0, 4))).toEqual(['aaaa']);
    expect(body.nextRequirementId).toBe('req:claude:rc:8');

    const tail = await server.request(`http://localhost/api/requirements/${encodeURIComponent('req:claude:rc:8')}`);
    const tailBody = await tail.json() as { files: Array<{ path: string }>; commits: Array<{ sha: string }>; nextRequirementId: string | null };
    expect(tailBody.files.map((file) => file.path)).toEqual(['/repo/beta/docs.md']);
    expect(tailBody.commits.map((commit) => commit.sha.slice(0, 4))).toEqual(['bbbb']);
    expect(tailBody.nextRequirementId).toBeNull();
  });

  test('/api/sessions:user session 的 requirement 来自实体表;subagent 保持消息现场抽取', async () => {
    const store = openMemoryDb();
    const t0 = Date.now() - 1000; // 离窗口上界留 1s,避免同毫秒撞 buildSessionList 的 [since, until) 边界
    store.upsertSessions([
      session({ id: 'claude:rd', provider: 'claude', nativeId: 'rd', updatedAt: t0 }),
      session({ id: 'claude:rdsub', provider: 'claude', nativeId: 'rdsub', origin: 'subagent', updatedAt: t0 }),
    ]);
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:rd', seq: 1, role: 'user', text: '用户会话的第一个真实需求' }),
      msg({ id: 'm2', sessionId: 'claude:rdsub', seq: 1, role: 'user', text: '你是研究员,研究 dsh-track 并产出报告' }),
    ]);
    materializeRequirements(store);
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const res = await server.request('http://localhost/api/sessions?days=30');
    const body = await res.json() as { sessions: Array<{ id: string; requirement: string | null }> };
    const byId = new Map(body.sessions.map((row) => [row.id, row.requirement]));
    expect(byId.get('claude:rd')).toBe('用户会话的第一个真实需求');
    expect(byId.get('claude:rdsub')).toContain('研究员');
  });
});
