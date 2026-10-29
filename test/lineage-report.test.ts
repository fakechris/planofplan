import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { buildLineageReport } from '../src/lineage-report.ts';
import type { RequirementRecord, SessionRecord, UsageRecord } from '../src/types.ts';

const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
const NOW = Date.now();
const REPO = 'git@example.com:org/repo.git';

function seed() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  store.upsertSessions([
    { id: 'claude:a', provider: 'claude', nativeId: 'a', cwd: '/repo', title: '做谱系周报',
      sourceFile: '/tmp/a.jsonl', startedAt: NOW - 7200_000, updatedAt: NOW - 1000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
    { id: 'claude:b', provider: 'claude', nativeId: 'b', cwd: '/repo', title: '没落地的需求',
      sourceFile: '/tmp/b.jsonl', startedAt: NOW - 3600_000, updatedAt: NOW - 2000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
    { id: 'claude:old', provider: 'claude', nativeId: 'old', cwd: '/repo', title: '窗口外',
      sourceFile: '/tmp/old.jsonl', startedAt: NOW - 40 * 86_400_000, updatedAt: NOW - 40 * 86_400_000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
  ] as SessionRecord[]);
  store.replaceAllRequirements([
    { id: 'req:claude:a:1', sessionId: 'claude:a', seq: 1, text: '把谱系周报的静态聚合做出来', originLevel: 'user_explicit', ts: NOW - 7200_000, repos: [] },
    { id: 'req:claude:b:1', sessionId: 'claude:b', seq: 1, text: '顺便把导出也做了', originLevel: 'user_explicit', ts: NOW - 3600_000, repos: [] },
    { id: 'req:claude:old:1', sessionId: 'claude:old', seq: 1, text: '很早以前的需求', originLevel: 'user_explicit', ts: NOW - 40 * 86_400_000, repos: [] },
  ] as RequirementRecord[]);
  store.upsertSessionCommits([
    { sessionId: 'claude:a', repo: REPO, sha: 'abcdef1234567890abcdef1234567890abcdef12', kind: 'declared', ts: NOW - 500_000, summary: 'feat: lineage report', fileOverlap: true },
  ]);
  store.upsertUsageRecords([
    { id: 'u1', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 3000, provider: 'claude', model: 'claude-fable-5',
      inputTokens: 1000, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 500,
      reasoningOutputTokens: 0, totalTokens: 1500, billableTokens: null, estimatedCostUsd: 0.02,
      source: 'local', confidence: 'measured', sessionId: 'a' } as UsageRecord, // session_id 存原生 uuid(无前缀)
  ]);
  return store;
}

describe('谱系周报 v1(INV-1428 口径)', () => {
  test('需求×commit×额度聚合,窗口过滤,landed 判定', () => {
    const store = seed();
    const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    expect(report.totals.requirements).toBe(2); // 窗口外需求排除
    expect(report.totals.landed).toBe(1);
    expect(report.totals.commits).toBe(1);
    expect(report.totals.declaredCommits).toBe(1);
    expect(report.totals.candidateCommits).toBe(0);
    expect(report.totals.totalTokens).toBe(1500);
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.02);
    expect(report.totals.costUnknownSessions).toBe(0);
    const landed = report.items.find((item) => item.requirementId === 'req:claude:a:1');
    expect(landed?.landed).toBe(true);
    expect(landed?.landedBasis).toBe('declared-or-witnessed');
    expect(landed?.commits[0].kind).toBe('declared');
    expect(landed?.totalTokens).toBe(1500);
    expect(landed?.estimatedCostUsd).toBeCloseTo(0.02);
    expect(landed?.costUnknownRecords).toBe(0);
    const unlanded = report.items.find((item) => item.requirementId === 'req:claude:b:1');
    expect(unlanded?.landed).toBe(false);
    expect(unlanded?.landedBasis).toBe('none');
    expect(unlanded?.estimatedCostUsd).toBeNull(); // 无 usage 记录 = 未知,不伪装成 0
    expect(unlanded?.usageRecords).toBe(0);
  });

  test('candidate-only 不算落地:landed=false,landedBasis=candidate-only', () => {
    const store = seed();
    store.upsertSessionCommits([
      { sessionId: 'claude:b', repo: REPO, sha: 'b'.repeat(40), kind: 'candidate', ts: NOW - 100_000, summary: 'maybe', fileOverlap: false },
    ]);
    const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    const b = report.items.find((item) => item.requirementId === 'req:claude:b:1');
    expect(b?.landed).toBe(false);
    expect(b?.landedBasis).toBe('candidate-only');
    expect(b?.candidateCommits).toBe(1);
    expect(report.totals.landed).toBe(1); // candidate 不计入落地
    expect(report.totals.candidateCommits).toBe(1);
    expect(report.totals.commits).toBe(2);
  });

  test('ts 缺失的 commit 不计入需求成果,计入 unallocatedCommits 与警告', () => {
    const store = seed();
    store.upsertSessionCommits([
      { sessionId: 'claude:b', repo: REPO, sha: 'c'.repeat(40), kind: 'witnessed', ts: null, summary: 'no ts', fileOverlap: false },
    ]);
    const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    const b = report.items.find((item) => item.requirementId === 'req:claude:b:1');
    expect(b?.commits).toHaveLength(0);
    expect(b?.landed).toBe(false);
    expect(b?.landedBasis).toBe('none'); // ts 缺失 → 可靠时间窗内无 commit,非 unknown-time(需求自身时间可靠)
    expect(b?.unallocatedCommits).toBe(1);
    expect(b?.warnings.some((w) => w.includes('未分配'))).toBe(true);
    expect(report.totals.commits).toBe(1); // 只有 a 的 declared
  });

  test('同 session 多需求:commit 只归 span 命中的需求,不再整会话分摊', () => {
    const store = seed();
    store.replaceAllRequirements([
      { id: 'req:claude:a:1', sessionId: 'claude:a', seq: 1, text: '把谱系周报的静态聚合做出来', originLevel: 'user_explicit', ts: NOW - 7200_000, repos: [] },
      { id: 'req:claude:a:2', sessionId: 'claude:a', seq: 5, text: '补上回归测试', originLevel: 'user_explicit', ts: NOW - 3000, repos: [] },
      { id: 'req:claude:b:1', sessionId: 'claude:b', seq: 1, text: '顺便把导出也做了', originLevel: 'user_explicit', ts: NOW - 3600_000, repos: [] },
    ] as RequirementRecord[]);
    // declared commit ts=NOW-500_000 落在 a:1 的 span [NOW-7200_000, NOW-3000) 内,不属于 a:2
    const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    expect(report.totals.requirements).toBe(3);
    const a1 = report.items.find((item) => item.requirementId === 'req:claude:a:1');
    const a2 = report.items.find((item) => item.requirementId === 'req:claude:a:2');
    expect(a1?.commits).toHaveLength(1);
    expect(a1?.landed).toBe(true);
    expect(a2?.commits).toHaveLength(0);
    expect(a2?.landed).toBe(false);
    expect(a2?.landedBasis).toBe('none');
    expect(report.totals.commits).toBe(1); // 去重后仍只有 1 条
    expect(report.totals.totalTokens).toBe(1500); // usage 仍按 session 去重
  });

  test('成本未知不按零累加:全未知 null,部分未知已知合计+未知条数', () => {
    const store = seed();
    // 给 claude:b 加两条:一条未知成本、一条已知 → 部分未知
    store.upsertUsageRecords([
      { id: 'u2', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 2500, provider: 'claude', model: 'claude-fable-5',
        inputTokens: 100, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 50,
        reasoningOutputTokens: 0, totalTokens: 150, billableTokens: null, estimatedCostUsd: null,
        source: 'local', confidence: 'measured', sessionId: 'b' } as UsageRecord,
      { id: 'u3', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 2400, provider: 'claude', model: 'claude-fable-5',
        inputTokens: 200, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 100,
        reasoningOutputTokens: 0, totalTokens: 300, billableTokens: null, estimatedCostUsd: 0.01,
        source: 'local', confidence: 'measured', sessionId: 'b' } as UsageRecord,
    ]);
    let report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    let b = report.items.find((item) => item.requirementId === 'req:claude:b:1');
    expect(b?.usageRecords).toBe(2);
    expect(b?.costUnknownRecords).toBe(1);
    expect(b?.estimatedCostUsd).toBeCloseTo(0.01); // 已知合计,未知不折零
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.03);
    expect(report.totals.costUnknownSessions).toBe(1);
    // 再把 a 的唯一一条也换成未知成本 → a 全未知
    store.upsertUsageRecords([
      { id: 'u1', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 3000, provider: 'claude', model: 'claude-fable-5',
        inputTokens: 1000, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 500,
        reasoningOutputTokens: 0, totalTokens: 1500, billableTokens: null, estimatedCostUsd: null,
        source: 'local', confidence: 'measured', sessionId: 'a' } as UsageRecord,
    ]);
    report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    const a = report.items.find((item) => item.requirementId === 'req:claude:a:1');
    expect(a?.usageRecords).toBe(1);
    expect(a?.estimatedCostUsd).toBeNull(); // 有记录但全未知 → null,不是 $0
    expect(a?.costUnknownRecords).toBe(1);
    expect(a?.totalTokens).toBe(1500); // token 照常累计,只有成本是未知
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.01); // 只剩 b 的已知部分
    expect(report.totals.costUnknownSessions).toBe(2);
  });

  test('API 端点', async () => {
    const store = seed();
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const res = await server.request('http://localhost/api/lineage-report?days=7');
    expect(res.status).toBe(200);
    const body = await res.json() as { totals: { requirements: number; candidateCommits: number } };
    expect(body.totals.requirements).toBe(2);
    expect(body.totals.candidateCommits).toBe(0);
  });
});

describe('周报用量去重', () => {
  test('同 session 多需求:totals 只计一次,item 各自展示所在会话消耗', () => {
    const store = seed();
    store.replaceAllRequirements([
      { id: 'req:claude:a:1', sessionId: 'claude:a', seq: 1, text: '把谱系周报的静态聚合做出来', originLevel: 'user_explicit', ts: NOW - 7200_000, repos: [] },
      { id: 'req:claude:a:2', sessionId: 'claude:a', seq: 5, text: '补上回归测试', originLevel: 'user_explicit', ts: NOW - 3000, repos: [] },
      { id: 'req:claude:b:1', sessionId: 'claude:b', seq: 1, text: '顺便把导出也做了', originLevel: 'user_explicit', ts: NOW - 3600_000, repos: [] },
    ] as RequirementRecord[]);
    const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    expect(report.totals.requirements).toBe(3);
    // usage 只属于 claude:a(1500 tokens/$0.02):totals 不得按需求数翻倍
    expect(report.totals.totalTokens).toBe(1500);
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.02);
    const aItems = report.items.filter((item) => item.sessionId === 'claude:a');
    expect(aItems).toHaveLength(2);
    expect(aItems[0].totalTokens).toBe(1500); // item 级保持会话消耗
  });
});
