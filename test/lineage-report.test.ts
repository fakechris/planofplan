import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { buildLineageReport } from '../src/lineage-report.ts';
import type { RequirementRecord, SessionRecord, UsageRecord } from '../src/types.ts';

const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
const NOW = Date.now();

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
    { sessionId: 'claude:a', repo: 'git@example.com:org/repo.git', sha: 'abcdef1234567890abcdef1234567890abcdef12', kind: 'declared', ts: NOW - 500_000, summary: 'feat: lineage report', fileOverlap: true },
  ]);
  store.upsertUsageRecords([
    { id: 'u1', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 3000, provider: 'claude', model: 'claude-fable-5',
      inputTokens: 1000, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 500,
      reasoningOutputTokens: 0, totalTokens: 1500, billableTokens: null, estimatedCostUsd: 0.02,
      source: 'local', confidence: 'measured', sessionId: 'a' } as UsageRecord, // session_id 存原生 uuid(无前缀)
  ]);
  return store;
}

describe('谱系周报 v0', () => {
  test('需求×commit×额度聚合,窗口过滤,landed 判定', () => {
    const store = seed();
    const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
    expect(report.totals.requirements).toBe(2); // 窗口外需求排除
    expect(report.totals.landed).toBe(1);
    expect(report.totals.commits).toBe(1);
    expect(report.totals.declaredCommits).toBe(1);
    expect(report.totals.totalTokens).toBe(1500);
    expect(report.totals.estimatedCostUsd).toBeCloseTo(0.02);
    const landed = report.items.find((item) => item.requirementId === 'req:claude:a:1');
    expect(landed?.landed).toBe(true);
    expect(landed?.commits[0].kind).toBe('declared');
    expect(landed?.totalTokens).toBe(1500);
    const unlanded = report.items.find((item) => item.requirementId === 'req:claude:b:1');
    expect(unlanded?.landed).toBe(false);
    expect(unlanded?.estimatedCostUsd).toBeNull(); // 无 usage 记录 = 未知,不伪装成 0
  });

  test('API 端点', async () => {
    const store = seed();
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const res = await server.request('http://localhost/api/lineage-report?days=7');
    expect(res.status).toBe(200);
    const body = await res.json() as { totals: { requirements: number } };
    expect(body.totals.requirements).toBe(2);
  });
});
