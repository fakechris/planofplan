import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { refineRequirements, requirementLlmEnabled } from '../src/requirement-llm.ts';
import type { LlmConfig } from '../src/config.ts';
import type { RequirementRecord, SessionRecord } from '../src/types.ts';

const NOW = Date.now();
const CFG: LlmConfig = { provider: 'minimax', model: 'test-model' } as LlmConfig;

function seed() {
  const store = openMemoryDb();
  store.upsertSessions([{
    id: 'claude:r1', nativeId: 'r1', provider: 'claude', cwd: '/repo', title: 't',
    sourceFile: '/tmp/r1.jsonl', startedAt: NOW - 3600_000, updatedAt: NOW - 1000,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW,
  } as SessionRecord]);
  store.replaceAllRequirements([{
    id: 'req:claude:r1:1', sessionId: 'claude:r1', seq: 1,
    text: '稍晚 ，再核对 一下这个东西吧', originLevel: 'user_explicit', ts: NOW - 3600_000, repos: [],
  } as RequirementRecord]);
  store.upsertSessionMessages([
    { id: 'm1', sessionId: 'claude:r1', seq: 1, role: 'user', kind: 'text', toolName: null, text: '帮我把 docs/api.md 里的接口表更新到 v2,顺便把 auth.ts 的过期时间改成 30 分钟', timestamp: NOW - 3600_000, model: null, inputTokens: null, outputTokens: null },
    { id: 'm2', sessionId: 'claude:r1', seq: 2, role: 'user', kind: 'text', toolName: null, text: '记得跑一下 pnpm test 再提交', timestamp: NOW - 3000_000, model: null, inputTokens: null, outputTokens: null },
  ]);
  return store;
}

function fakeFetch(reply: string) {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { content: reply } }],
  }), { status: 200 })) as never;
}

describe('需求 LLM 精炼层', () => {
  test('env 开关默认关闭', () => {
    expect(requirementLlmEnabled({})).toBe(false);
    expect(requirementLlmEnabled({ PLANOFPLAN_REQUIREMENT_LLM: '1' })).toBe(true);
  });

  test('精炼回写 + 读侧偏好(原话不覆盖)', async () => {
    const store = seed();
    const r1 = await refineRequirements(store, CFG, {
      env: { PLANOFPLAN_REQUIREMENT_LLM: '1', MINIMAX_API_KEY: 'test-key' },
      fetchImpl: fakeFetch('更新 docs/api.md 接口表到 v2,auth.ts 过期时间改 30 分钟'),
    });
    expect(r1.attempted).toBe(1);
    expect(r1.refined).toBe(1);
    const reqs = store.listRequirements();
    expect(reqs[0]?.refinedText).toContain('docs/api.md');
    expect(reqs[0]?.text).toBe('稍晚 ，再核对 一下这个东西吧'); // 原话不动
    const first = store.firstRequirementBySession().get('claude:r1');
    expect(first?.text).toContain('docs/api.md'); // 展示用精炼
  });

  test('空结果按可重试处理(不标记),后续轮次还能再试', async () => {
    const store = seed();
    const env = { PLANOFPLAN_REQUIREMENT_LLM: '1', MINIMAX_API_KEY: 'test-key' };
    const r1 = await refineRequirements(store, CFG, { env, fetchImpl: fakeFetch('') });
    expect(r1.refined).toBe(0);
    expect(store.listRequirements()[0]?.refinedAt).toBeNull();
    const r2 = await refineRequirements(store, CFG, { env, fetchImpl: fakeFetch('第二轮成功') });
    expect(r2.attempted).toBe(1);
    expect(store.listRequirements()[0]?.refinedText).toBe('第二轮成功');
  });

  test('env 未开启时不做事', async () => {
    const store = seed();
    const r = await refineRequirements(store, CFG, { env: {}, fetchImpl: fakeFetch('x') });
    expect(r.attempted).toBe(0);
    expect(r.skipped).toBe('精炼未开启(config llm.refine 或 env)');
  });
});

describe('config 开关路径', () => {
  test('llm.refine=true 时无需 env', async () => {
    const store = seed();
    const r = await refineRequirements(store, { ...CFG, refine: true } as LlmConfig, {
      env: { MINIMAX_API_KEY: 'test-key' }, fetchImpl: fakeFetch('config 路径精炼'),
    });
    expect(r.attempted).toBe(1);
    expect(store.listRequirements()[0]?.refinedText).toBe('config 路径精炼');
  });
});

describe('输出守卫', () => {
  test('元评论输出按无精炼落库,原话保持', async () => {
    const store = seed();
    await refineRequirements(store, CFG, {
      env: { PLANOFPLAN_REQUIREMENT_LLM: '1', MINIMAX_API_KEY: 'k' },
      fetchImpl: fakeFetch('The user is asking me to extract a requirement statement from these messages'),
    });
    const req = store.listRequirements()[0]!;
    expect(req.refinedText).toBeNull();
    expect(req.refinedAt).not.toBeNull();
    expect(store.firstRequirementBySession().get('claude:r1')?.text).toBe('稍晚 ，再核对 一下这个东西吧');
  });
});
