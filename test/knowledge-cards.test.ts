import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { KnowledgeCardRecord } from '../src/types.ts';

const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
const NOW = Date.now();

function card(partial: Partial<KnowledgeCardRecord> = {}): KnowledgeCardRecord {
  return {
    id: '',
    kind: 'constraint',
    problem: '支付回调不能直接重试',
    action: '重试前必须以幂等键去重,否则可能重复入账',
    preconditions: null,
    repo: 'org/payments',
    scopePaths: ['src/callbacks/'],
    repoRevision: null,
    versionRange: null,
    sourceRefs: [{ ref: 'req:claude:s1:1' }, { ref: '@session:{claude:s1}' }],
    counterexamples: [],
    status: 'candidate',
    reviewer: null,
    reviewedAt: null,
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function app() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  return { store, server: createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS }) };
}

async function rpc(server: ReturnType<typeof app>['server'], method: string, params?: unknown, id: unknown = 1): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const res = await server.request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json() as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
}

async function callTool(server: ReturnType<typeof app>['server'], name: string, args: Record<string, unknown>): Promise<string> {
  const body = await rpc(server, 'tools/call', { name, arguments: args });
  const result = body.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  expect(body.error).toBeUndefined();
  expect(result?.isError ?? false).toBe(false);
  return (result?.content ?? []).map((block) => block.text).join('\n');
}

describe('经验卡存储(INV-485)', () => {
  test('创建即 candidate;默认查询(effective)不返回未审核卡', () => {
    const store = openMemoryDb();
    const created = store.upsertKnowledgeCard(card());
    expect(created.id).toMatch(/^kc_/);
    expect(created.status).toBe('candidate');
    expect(store.listKnowledgeCards({ view: 'effective' })).toHaveLength(0);
    expect(store.listKnowledgeCards({ view: 'candidate' })).toHaveLength(1);
    expect(store.knowledgeCardCounts().candidate).toBe(1);
  });

  test('人工审核后进入 effective;过期在查询层推导,不改写存储状态', () => {
    const store = openMemoryDb();
    const created = store.upsertKnowledgeCard(card());
    const reviewed = store.updateKnowledgeCardStatus(created.id, 'reviewed', 'chris');
    expect(reviewed?.status).toBe('reviewed');
    expect(reviewed?.reviewer).toBe('chris');
    expect(reviewed?.reviewedAt).toBeGreaterThan(0);
    expect(store.listKnowledgeCards({ view: 'effective' })).toHaveLength(1);

    // 已过期的 reviewed 卡:存储状态不变,但 effective 视图排除,计数归 expired
    const expired = store.upsertKnowledgeCard(card({ problem: '旧约束', expiresAt: NOW - 1000 }));
    store.updateKnowledgeCardStatus(expired.id, 'reviewed', 'chris');
    expect(store.knowledgeCardById(expired.id)?.status).toBe('reviewed'); // 存储未被改写
    const effective = store.listKnowledgeCards({ view: 'effective' });
    expect(effective.some((row) => row.id === expired.id)).toBe(false);
    expect(store.knowledgeCardCounts().expired).toBe(1);

    // 未过期的保留
    const future = store.upsertKnowledgeCard(card({ problem: '未来到期', expiresAt: NOW + 86_400_000 }));
    store.updateKnowledgeCardStatus(future.id, 'reviewed', 'chris');
    expect(store.listKnowledgeCards({ view: 'effective' }).some((row) => row.id === future.id)).toBe(true);
  });

  test('驳回后不进默认;repo 双向片段匹配;q 命中问题/结论', () => {
    const store = openMemoryDb();
    const a = store.upsertKnowledgeCard(card());
    store.updateKnowledgeCardStatus(a.id, 'reviewed', 'chris');
    const rejected = store.upsertKnowledgeCard(card({ problem: '被驳回的卡' }));
    store.updateKnowledgeCardStatus(rejected.id, 'rejected', 'chris');
    expect(store.listKnowledgeCards({ view: 'effective' })).toHaveLength(1);
    expect(store.listKnowledgeCards({ view: 'rejected' })).toHaveLength(1);

    // repo 片段双向匹配:卡记 org/payments,查询用完整 url 或片段都能命中
    expect(store.listKnowledgeCards({ view: 'effective', repo: 'git@example.com:org/payments.git' })).toHaveLength(1);
    expect(store.listKnowledgeCards({ view: 'effective', repo: 'payments' })).toHaveLength(1);
    expect(store.listKnowledgeCards({ view: 'effective', repo: 'nope/nope' })).toHaveLength(0);
    // q 命中
    expect(store.listKnowledgeCards({ view: 'effective', q: '重复入账' })).toHaveLength(1);
    expect(store.listKnowledgeCards({ view: 'effective', q: '完全不相关' })).toHaveLength(0);
  });

  test('反例追加与 json 字段往返', () => {
    const store = openMemoryDb();
    const created = store.upsertKnowledgeCard(card({ scopePaths: ['a.ts', 'b/'] }));
    const withCx = store.addKnowledgeCardCounterexample(created.id, { text: '沙箱环境下去重表不可用', source: 'codex review' });
    expect(withCx?.counterexamples).toHaveLength(1);
    expect(withCx?.counterexamples[0]).toMatchObject({ text: '沙箱环境下去重表不可用', source: 'codex review' });
    expect(withCx?.scopePaths).toEqual(['a.ts', 'b/']);
    expect(store.addKnowledgeCardCounterexample('kc_missing', { text: 'x' })).toBeNull();
    expect(store.knowledgeCardById('kc_missing')).toBeNull();
  });
});

describe('经验卡 API', () => {
  test('创建校验与状态机闭环', async () => {
    const { server } = app();
    // 缺 kind / 缺 problem / 缺来源 → 400
    const noKind = await server.request('http://localhost/api/knowledge/cards', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ problem: 'p', action: 'a', sourceRefs: [{ ref: 'x' }] }),
    });
    expect(noKind.status).toBe(400);
    const noSource = await server.request('http://localhost/api/knowledge/cards', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'constraint', problem: 'p', action: 'a', sourceRefs: [] }),
    });
    expect(noSource.status).toBe(400);

    // 创建 → candidate,即使外部传 status 也被忽略
    const created = await (await server.request('http://localhost/api/knowledge/cards', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'decision', problem: '选 SQLite 不选 Postgres', action: '单机本地索引,零运维',
        repo: 'planofplan', sourceRefs: [{ ref: 'req:claude:s9:1' }], status: 'reviewed',
      }),
    })).json() as { ok: boolean; card: KnowledgeCardRecord };
    expect(created.ok).toBe(true);
    expect(created.card.status).toBe('candidate'); // 创建永远候选,不接收外部状态

    // candidate 未审核 → effective 列表为空
    const effective = await (await server.request('http://localhost/api/knowledge/cards?view=effective')).json() as { cards: unknown[] };
    expect(effective.cards).toHaveLength(0);

    // 审核需署名
    const noReviewer = await server.request(`http://localhost/api/knowledge/cards/${created.card.id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }),
    });
    expect(noReviewer.status).toBe(400);

    // 审核 → effective 可见
    const reviewed = await (await server.request(`http://localhost/api/knowledge/cards/${created.card.id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'reviewed', reviewer: 'chris' }),
    })).json() as { ok: boolean; card: KnowledgeCardRecord };
    expect(reviewed.card.status).toBe('reviewed');
    const effectiveAfter = await (await server.request('http://localhost/api/knowledge/cards?view=effective')).json() as { cards: KnowledgeCardRecord[] };
    expect(effectiveAfter.cards).toHaveLength(1);

    // 反例
    const withCx = await (await server.request(`http://localhost/api/knowledge/cards/${created.card.id}/counterexamples`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '多机协作时不适用' }),
    })).json() as { card: KnowledgeCardRecord };
    expect(withCx.card.counterexamples).toHaveLength(1);
  });
});

describe('knowledge_query MCP 工具', () => {
  test('默认只返回已审核有效卡;候选需显式索取并标注', async () => {
    const { store, server } = app();
    const reviewed = store.upsertKnowledgeCard(card());
    store.updateKnowledgeCardStatus(reviewed.id, 'reviewed', 'chris');
    store.upsertKnowledgeCard(card({ problem: '未审核的约束', action: '不该被默认返回' }));

    const out = await callTool(server, 'knowledge_query', {});
    expect(out).toContain('支付回调不能直接重试');
    expect(out).toContain('审核:chris');
    expect(out).not.toContain('未审核的约束');

    const withCandidates = await callTool(server, 'knowledge_query', { include_candidates: true });
    expect(withCandidates).toContain('未审核的约束');
    expect(withCandidates).toContain('candidate');
    expect(withCandidates).toContain('待审核');

    // 查询过滤:repo + q
    const filtered = await callTool(server, 'knowledge_query', { project: 'payments', q: '入账' });
    expect(filtered).toContain('支付回调');
    const miss = await callTool(server, 'knowledge_query', { q: '毫不相干' });
    expect(miss).toContain('没有匹配的已审核经验卡');
  });
});
