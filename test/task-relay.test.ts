import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { linkHandoffTargets } from '../src/handoff.ts';
import type { PlanConfig, RequirementRecord, SessionMessageRow, SessionRecord } from '../src/types.ts';

const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
const NOW = Date.now();
const REPO_URL = 'git@example.com:org/demo.git';

function sessionRow(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'nativeId' | 'provider'>): SessionRecord {
  return {
    cwd: '/repo/demo', title: 'demo', sourceFile: `/tmp/${partial.id}.jsonl`,
    startedAt: NOW - 3_600_000, updatedAt: NOW - 1_000_000,
    inputTokens: 0, outputTokens: 0, totalTokens: 10, estimatedCostUsd: null, seenAt: NOW,
    ...partial,
  };
}

function seededStore() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  store.upsertSessions([
    sessionRow({ id: 'claude:s1', nativeId: 's1', provider: 'claude', title: '支付回调修复' }),
    sessionRow({ id: 'codex:s2', nativeId: 's2', provider: 'codex', title: '别的话题' }),
  ]);
  for (const id of ['claude:s1', 'codex:s2']) {
    store.replaceSessionRepos(id, [
      { sessionId: id, role: 'work', url: REPO_URL, root: '/repo/demo', name: 'demo', evidenceKind: 'observed' },
    ]);
  }
  store.replaceAllRequirements([
    { id: 'req:claude:s1:1', sessionId: 'claude:s1', seq: 1, text: '把支付回调改成幂等重试,避免重复入账', originLevel: 'user_explicit', ts: NOW - 3_600_000, repos: [REPO_URL] },
    { id: 'req:claude:s1:2', sessionId: 'claude:s1', seq: 5, text: '顺便更新文档', originLevel: 'user_explicit', ts: NOW - 1_400_000, repos: [REPO_URL] },
    { id: 'req:codex:s2:1', sessionId: 'codex:s2', seq: 1, text: '完全不相关的导航需求', originLevel: 'user_explicit', ts: NOW - 3_600_000, repos: [REPO_URL] },
  ] as RequirementRecord[]);
  store.upsertSessionMessages([
    { id: 'm1', sessionId: 'claude:s1', seq: 1, role: 'user', kind: 'text', toolName: null,
      text: '支付回调幂等改造', timestamp: NOW - 3_600_000, model: null, inputTokens: null, outputTokens: null },
  ] as SessionMessageRow[]);
  store.upsertSessionTouches([{
    id: 't1', sessionId: 'claude:s1', provider: 'claude',
    filePath: '/repo/demo/src/callbacks/pay.ts', toolName: 'Edit', op: 'edit', ts: NOW - 1_800_000, ordinal: 1,
  }]);
  store.upsertSessionCommits([{
    sessionId: 'claude:s1', repo: REPO_URL, sha: 'a'.repeat(40), kind: 'witnessed',
    ts: NOW - 1_500_000, summary: 'fix: idempotent callback', fileOverlap: true,
  }]);
  // 一张已审核经验卡 + 一张候选卡(不得出现在 brief)
  const reviewed = store.upsertKnowledgeCard({
    id: '', kind: 'constraint', problem: '支付回调不能直接重试', action: '必须以幂等键去重,否则重复入账',
    preconditions: null, repo: 'demo', scopePaths: ['src/callbacks/'], repoRevision: null, versionRange: null,
    sourceRefs: [{ ref: 'req:claude:s1:1' }], counterexamples: [], status: 'candidate',
    reviewer: null, reviewedAt: null, expiresAt: null, createdAt: 0, updatedAt: 0,
  });
  store.updateKnowledgeCardStatus(reviewed.id, 'reviewed', 'chris');
  store.upsertKnowledgeCard({
    id: '', kind: 'decision', problem: '未审核的候选决定', action: '不该被 brief 返回',
    preconditions: null, repo: 'demo', scopePaths: [], repoRevision: null, versionRange: null,
    sourceRefs: [{ ref: 'x' }], counterexamples: [], status: 'candidate',
    reviewer: null, reviewedAt: null, expiresAt: null, createdAt: 0, updatedAt: 0,
  });
  return store;
}

function app(store = seededStore()) {
  return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
}

async function callTool(server: ReturnType<typeof app>, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await server.request('http://localhost/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json() as { result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError ?? false).toBe(false);
  return (body.result?.content ?? []).map((block) => block.text).join('\n');
}

describe('planofplan_task_brief(INV-1427)', () => {
  test('命中相关历史需求/经验卡/commit/文件;候选卡与无关需求不出现', async () => {
    const out = await callTool(app(), 'planofplan_task_brief', {
      project: 'demo', task: '修改支付回调的重试策略,注意幂等',
    });
    expect(out).toContain('支付回调改成幂等重试');
    expect(out).toContain('req:claude:s1:1');
    expect(out).toContain('范围内 commit');
    expect(out).toContain('witnessed');
    expect(out).toContain('支付回调不能直接重试');
    expect(out).toContain('幂等键去重');
    expect(out).toContain('src/callbacks/pay.ts');
    // 候选卡与无关需求不得进入
    expect(out).not.toContain('未审核的候选决定');
    expect(out).not.toContain('导航需求');
    // 边界声明
    expect(out).toContain('不是执行授权');
  });

  test('exclude_session 排除调用者自己;paths 过滤相关文件', async () => {
    const store = seededStore();
    const server = app(store);
    const out = await callTool(server, 'planofplan_task_brief', {
      project: 'demo', task: '支付回调幂等', exclude_session: 'claude:s1', paths: ['nomatch'],
    });
    // claude:s1 被排除:它的需求/commit/文件都不得出现(只剩 codex:s2,无 term 命中)
    expect(out).not.toContain('req:claude:s1:1');
    expect(out).not.toContain('幂等重试');
    expect(out).not.toContain('idempotent callback');
    expect(out).not.toContain('src/callbacks/pay.ts'); // paths=nomatch 一并过滤
    expect(out).toContain('无 term 命中');
    // 经验卡不受 exclude 影响(它是项目级知识)
    expect(out).toContain('支付回调不能直接重试');
  });

  test('参数校验:project/task 必填', async () => {
    const server = app();
    const missTask = await server.request('http://localhost/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'planofplan_task_brief', arguments: { project: 'demo' } } }),
    });
    const body = await missTask.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(body.result?.isError).toBe(true);
  });
});

describe('交接面板额度感知(INV-1427)', () => {
  test('handoff GET 返回全部可注入 provider 的额度快照,窗口数据齐全', async () => {
    const store = seededStore();
    const plans: PlanConfig[] = [
      { slug: 'kimi-main', name: 'Kimi', adapter: 'kimi', enabled: true, pollIntervalSec: 60, credRef: null, extra: {} },
      { slug: 'claude-main', name: 'Claude', adapter: 'claude', enabled: true, pollIntervalSec: 60, credRef: null, extra: {} },
    ];
    for (const plan of plans) store.syncPlan(plan);
    store.insertWindows('kimi-main', [
      { window: '5h', label: '5H 窗口', used: 31, total: 50, unit: 'percent', percentage: 62, resetAt: Date.now() + 90 * 60_000, note: null, fetchedAt: 0 },
    ], Date.now());
    store.insertWindows('claude-main', [
      { window: 'weekly', label: '周窗口', used: 180, total: 200, unit: 'percent', percentage: 90, resetAt: Date.now() + 3 * 3_600_000, note: null, fetchedAt: 0 },
    ], Date.now());
    const server = createServer(store, scheduler as never, { port: 9291, plans });

    const res = await server.request('http://localhost/api/handoff/session/claude:s1');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      providers: string[];
      providerQuota: Array<{ provider: string; availability: string; quotaLabel: string; windows: unknown[] }>;
    };
    expect(body.providers).toContain('kimi');
    expect(body.providers).toContain('claude');
    const quota = new Map(body.providerQuota.map((q) => [q.provider, q]));
    expect(quota.size).toBe(body.providers.length);
    expect(quota.get('kimi')?.availability).toBe('ok');
    expect(quota.get('kimi')?.quotaLabel).toContain('62%');
    expect(quota.get('kimi')?.windows).toHaveLength(1);
    expect(quota.get('claude')?.availability).toBe('tight');
    expect(quota.get('grok')?.availability).toBe('unknown'); // 未配置额度源
  });
});

describe('交接回链(INV-1427)', () => {
  function deliver(store: ReturnType<typeof seededStore>, provider: string, targetDir: string, createdAt: number): void {
    store.db.query(
      `INSERT INTO handoffs (source_type, source_id, mode, provider, target_dir, package_path, ok, created_at)
       VALUES ('session', 'claude:s1', 'agent', ?, ?, '/tmp/pkg.md', 1, ?)`,
    ).run(provider, targetDir, createdAt);
  }

  test('唯一候选回链;歧义不误链;窗口/provider/目录不匹配不链;幂等', () => {
    const store = seededStore();
    const t0 = NOW - 2_000_000;
    // 唯一:交付后 5 分钟同 provider 在 target_dir 新起的会话
    deliver(store, 'kimi', '/work/handoff', t0);
    store.upsertSessions([sessionRow({
      id: 'kimi:next', nativeId: 'next', provider: 'kimi',
      cwd: '/work/handoff', startedAt: t0 + 5 * 60_000, updatedAt: t0 + 5 * 60_000, seenAt: NOW,
    })]);
    // 歧义:同窗口同目录两个 codex 会话
    deliver(store, 'codex', '/work/ambiguous', t0);
    store.upsertSessions([
      sessionRow({ id: 'codex:a1', nativeId: 'a1', provider: 'codex', cwd: '/work/ambiguous', startedAt: t0 + 3 * 60_000, updatedAt: t0 + 3 * 60_000, seenAt: NOW }),
      sessionRow({ id: 'codex:a2', nativeId: 'a2', provider: 'codex', cwd: '/work/ambiguous/sub', startedAt: t0 + 4 * 60_000, updatedAt: t0 + 4 * 60_000, seenAt: NOW }),
    ]);
    // provider 不匹配:grok 交付但 claude 接
    deliver(store, 'grok', '/work/wrong-provider', t0);
    store.upsertSessions([sessionRow({
      id: 'claude:not-me', nativeId: 'not-me', provider: 'claude',
      cwd: '/work/wrong-provider', startedAt: t0 + 2 * 60_000, updatedAt: t0 + 2 * 60_000, seenAt: NOW,
    })]);
    // 窗口外:交付 2 小时后才起
    deliver(store, 'kimi', '/work/too-late', t0);
    store.upsertSessions([sessionRow({
      id: 'kimi:late', nativeId: 'late', provider: 'kimi',
      cwd: '/work/too-late', startedAt: t0 + 2 * 3_600_000, updatedAt: t0 + 2 * 3_600_000, seenAt: NOW,
    })]);

    const linked = linkHandoffTargets(store, NOW);
    expect(linked).toBe(1);
    const history = store.handoffsFor('session', 'claude:s1');
    expect(history).toHaveLength(4);
    expect(history.find((row) => row.targetDir === '/work/handoff')?.targetSessionId).toBe('kimi:next');
    expect(history.find((row) => row.targetDir === '/work/ambiguous')?.targetSessionId).toBeNull();
    expect(history.find((row) => row.targetDir === '/work/wrong-provider')?.targetSessionId).toBeNull();
    expect(history.find((row) => row.targetDir === '/work/too-late')?.targetSessionId).toBeNull();
    expect(history.find((row) => row.targetDir === '/work/handoff')?.linkedAt).toBeGreaterThan(0);

    // 幂等:已链接的不再改写;重复跑不产生新链接
    expect(linkHandoffTargets(store, NOW)).toBe(0);
  });
});
