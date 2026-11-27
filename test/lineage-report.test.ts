import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { buildLineageReport, driftCleanMessage } from '../src/lineage-report.ts';
import { handleMcpBody } from '../src/mcp.ts';
import type { RequirementRecord, SessionRecord, SessionMessageRow, UsageRecord } from '../src/types.ts';

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

// ── 偏差裁决层(INV-2167:四分类 + 只报差异)──────────────────────────

/** 五会话 fixture,一次产齐四类裁决:
 *  a:declared 落地 + 成本已知(一致项,不产 finding)
 *  b:无 commit + 有已索引消息(→ no-evidence CONTEST)+ 一条 ts 缺失 commit(→ unallocated PROPOSE FIX)
 *  c:无 commit + 无已索引消息(→ no-evidence 降级 ESCALATE)
 *  d:仅 candidate commit(→ candidate-only PROPOSE FIX)
 *  e:需求 ts=null(→ unknown-time ESCALATE)
 *  外加一条 null 成本 usage 挂在 b(→ cost-unknown DECLINE)
 */
function findingsSeed() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  store.upsertSessions([
    { id: 'claude:a', provider: 'claude', nativeId: 'a', cwd: '/repo', title: '一致项',
      sourceFile: '/tmp/a.jsonl', startedAt: NOW - 7200_000, updatedAt: NOW - 1000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
    { id: 'claude:b', provider: 'claude', nativeId: 'b', cwd: '/repo', title: '无落地有消息',
      sourceFile: '/tmp/b.jsonl', startedAt: NOW - 3600_000, updatedAt: NOW - 2000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
    { id: 'claude:c', provider: 'claude', nativeId: 'c', cwd: '/repo', title: '无落地无消息',
      sourceFile: '/tmp/c.jsonl', startedAt: NOW - 3500_000, updatedAt: NOW - 2500,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
    { id: 'claude:d', provider: 'claude', nativeId: 'd', cwd: '/repo', title: '仅推断关联',
      sourceFile: '/tmp/d.jsonl', startedAt: NOW - 3400_000, updatedAt: NOW - 2600,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
    { id: 'claude:e', provider: 'claude', nativeId: 'e', cwd: '/repo', title: '时间不可靠',
      sourceFile: '/tmp/e.jsonl', startedAt: NOW - 3300_000, updatedAt: NOW - 2700,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW },
  ] as SessionRecord[]);
  store.replaceAllRequirements([
    { id: 'req:claude:a:1', sessionId: 'claude:a', seq: 1, text: '已落地的一致项', originLevel: 'user_explicit', ts: NOW - 7200_000, repos: [] },
    { id: 'req:claude:b:1', sessionId: 'claude:b', seq: 1, text: '无 commit 见证但有消息可核验', originLevel: 'user_explicit', ts: NOW - 3600_000, repos: [] },
    { id: 'req:claude:c:1', sessionId: 'claude:c', seq: 1, text: '无 commit 见证也无消息', originLevel: 'user_explicit', ts: NOW - 3500_000, repos: [] },
    { id: 'req:claude:d:1', sessionId: 'claude:d', seq: 1, text: '只有时间窗推断的关联', originLevel: 'user_explicit', ts: NOW - 3400_000, repos: [] },
    { id: 'req:claude:e:1', sessionId: 'claude:e', seq: 1, text: '时间边界缺失的需求', originLevel: 'user_explicit', ts: null, repos: [] },
  ] as RequirementRecord[]);
  store.upsertSessionMessages([
    { id: 'm-b1', sessionId: 'claude:b', seq: 1, role: 'user', kind: 'text', toolName: null,
      text: '无 commit 见证但有消息可核验', timestamp: NOW - 3600_000, model: null, inputTokens: null, outputTokens: null } as SessionMessageRow,
  ]);
  store.upsertSessionCommits([
    { sessionId: 'claude:a', repo: REPO, sha: 'a'.repeat(40), kind: 'declared', ts: NOW - 500_000, summary: 'feat: landed', fileOverlap: true },
    { sessionId: 'claude:b', repo: REPO, sha: 'b'.repeat(40), kind: 'witnessed', ts: null, summary: 'no ts', fileOverlap: false },
    { sessionId: 'claude:d', repo: REPO, sha: 'd'.repeat(40), kind: 'candidate', ts: NOW - 3000, summary: 'maybe', fileOverlap: false },
  ]);
  store.upsertUsageRecords([
    { id: 'u-a', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 3000, provider: 'claude', model: 'claude-fable-5',
      inputTokens: 1000, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 500,
      reasoningOutputTokens: 0, totalTokens: 1500, billableTokens: null, estimatedCostUsd: 0.02,
      source: 'local', confidence: 'measured', sessionId: 'a' } as UsageRecord,
    { id: 'u-b', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 2400, provider: 'claude', model: 'claude-fable-5',
      inputTokens: 200, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 100,
      reasoningOutputTokens: 0, totalTokens: 300, billableTokens: null, estimatedCostUsd: null,
      source: 'local', confidence: 'measured', sessionId: 'b' } as UsageRecord,
  ]);
  return store;
}

describe('偏差裁决层(INV-2167)', () => {
  test('四分类枚举完整;一致项不出现在偏差段', () => {
    const store = findingsSeed();
    try {
      const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
      const rulings = new Set(report.findings.map((finding) => finding.ruling));
      expect(rulings).toEqual(new Set(['PROPOSE FIX', 'CONTEST', 'ESCALATE', 'DECLINE']));
      // 一致项(a:declared 落地、无缺口、成本已知)零 finding
      expect(report.findings.some((finding) => finding.requirementId === 'req:claude:a:1')).toBe(false);
      // b 的 no-evidence 是 CONTEST,且证据引用可解析(会话引用 + 需求 id)
      const contest = report.findings.find((finding) => finding.kind === 'no-evidence' && finding.ruling === 'CONTEST')!;
      expect(contest.requirementId).toBe('req:claude:b:1');
      expect(contest.evidenceRefs).toContain('@session:{claude:b}');
      expect(contest.evidenceRefs).toContain('req:claude:b:1');
      // d 的 candidate-only 是 PROPOSE FIX,证据是 candidate sha
      const propose = report.findings.find((finding) => finding.kind === 'candidate-only')!;
      expect(propose.ruling).toBe('PROPOSE FIX');
      expect(propose.evidenceRefs).toContain('d'.repeat(40));
      // e 的 unknown-time 是 ESCALATE,证据为空(在外)
      const escalate = report.findings.find((finding) => finding.kind === 'unknown-time')!;
      expect(escalate.ruling).toBe('ESCALATE');
      expect(escalate.evidenceRefs).toEqual([]);
      // b 的成本未知是 DECLINE,只记录计数不展开
      const decline = report.findings.find((finding) => finding.kind === 'cost-unknown')!;
      expect(decline.ruling).toBe('DECLINE');
      expect(decline.evidenceRefs).toEqual([]);
      expect(decline.note).toContain('1 条用量记录成本未知');
      // 呈现层边界:裁决不改 items 的证据等级计算
      const a = report.items.find((item) => item.requirementId === 'req:claude:a:1')!;
      expect(a.landed).toBe(true);
      expect(a.landedBasis).toBe('declared-or-witnessed');
    } finally {
      store.close();
    }
  });

  test('CONTEST 无可解析引用自动降级 ESCALATE', () => {
    const store = findingsSeed();
    try {
      const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
      // c 会话没有任何已索引消息:read_session 无 SourceRef 可取,引用不可解析 → 降级
      const c = report.findings.find((finding) => finding.requirementId === 'req:claude:c:1')!;
      expect(c.kind).toBe('no-evidence');
      expect(c.ruling).toBe('ESCALATE');
      expect(c.evidenceRefs).toEqual([]);
      expect(c.note).toContain('证据在外');
      // 对照组 b(有消息)保持 CONTEST
      const b = report.findings.find((finding) => finding.kind === 'no-evidence' && finding.ruling === 'CONTEST')!;
      expect(b.requirementId).toBe('req:claude:b:1');
    } finally {
      store.close();
    }
  });

  test('全一致时 findings 为空且声明 No drift detected;MCP 文本同步', () => {
    const store = findingsSeed();
    try {
      // 只留一致项 a
      store.replaceAllRequirements([
        { id: 'req:claude:a:1', sessionId: 'claude:a', seq: 1, text: '已落地的一致项', originLevel: 'user_explicit', ts: NOW - 7200_000, repos: [] },
      ] as RequirementRecord[]);
      const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
      expect(report.findings).toEqual([]);
      expect(driftCleanMessage(1)).toContain('No drift detected');
      // MCP 出口:显式声明 + 四分类标题
      const body = handleMcpBody(store, { port: 9291, plans: [] }, {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lineage_report', arguments: {} },
      }) as { result?: { content: Array<{ text: string }> } };
      const text = body.result!.content[0]!.text;
      expect(text).toContain('偏差裁决');
      expect(text).toContain('未检测到漂移(No drift detected)');
    } finally {
      store.close();
    }
  });

  test('MCP 偏差段按四分类渲染,CONTEST 行带可核验引用', () => {
    const store = findingsSeed();
    try {
      const body = handleMcpBody(store, { port: 9291, plans: [] }, {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lineage_report', arguments: {} },
      }) as { result?: { content: Array<{ text: string }> } };
      const text = body.result!.content[0]!.text;
      expect(text).toContain('[PROPOSE FIX]');
      expect(text).toContain('[CONTEST]');
      expect(text).toContain('[ESCALATE]');
      expect(text).toContain('[DECLINE]');
      expect(text).toContain('证据:@session:{claude:b}');
      expect(text).toContain('只报差异');
    } finally {
      store.close();
    }
  });

  test('隐藏会话不进 items 也不产 findings(INV-443 边界贯通)', () => {
    const store = findingsSeed();
    try {
      store.setSessionHidden('claude:b', true);
      const report = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
      expect(report.items.some((item) => item.sessionId === 'claude:b')).toBe(false);
      expect(report.findings.some((finding) => finding.requirementId === 'req:claude:b:1')).toBe(false);
      // 其余会话不受影响
      expect(report.items.some((item) => item.sessionId === 'claude:a')).toBe(true);
    } finally {
      store.close();
    }
  });

  test('API 端点透出 findings;web 与 /api 同源同构', async () => {
    const store = findingsSeed();
    try {
      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
      const res = await server.request('http://localhost/api/lineage-report?days=7');
      expect(res.status).toBe(200);
      const body = await res.json() as { findings: Array<{ ruling: string; kind: string }> };
      expect(body.findings.length).toBeGreaterThan(0);
      expect(new Set(body.findings.map((finding) => finding.ruling))).toEqual(new Set(['PROPOSE FIX', 'CONTEST', 'ESCALATE', 'DECLINE']));
    } finally {
      store.close();
    }
  });
});

// ── findings 服务端 limit(INV-2185:千条级裁决的无界 payload 治理)─────

/** 批量 fixture:一个会话 N 条无见证需求,每条产 1 条 ESCALATE finding(会话无已索引消息)。 */
function bulkSeed(count: number) {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  store.upsertSessions([{
    id: 'claude:bulk', provider: 'claude', nativeId: 'bulk', cwd: '/repo', title: 'bulk',
    sourceFile: '/tmp/bulk.jsonl', startedAt: NOW - 7200_000, updatedAt: NOW - 100,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW,
  } as SessionRecord]);
  store.replaceAllRequirements(Array.from({ length: count }, (_, i) => ({
    id: `req:claude:bulk:${i + 1}`, sessionId: 'claude:bulk', seq: i + 1, text: `无见证需求 ${i + 1}`,
    originLevel: 'user_explicit', ts: NOW - 7000_000 + i, repos: [],
  })) as RequirementRecord[]);
  return store;
}

describe('findings 服务端 limit(INV-2185)', () => {
  test('默认 100:超限截断,findings_total/分布/提示齐全;findings_by_ruling 与全量一致', async () => {
    const store = bulkSeed(120);
    try {
      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
      const res = await server.request('http://localhost/api/lineage-report?days=7');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        findings: Array<{ ruling: string }>;
        findings_total: number;
        findings_truncated: boolean;
        findings_by_ruling: Record<string, number>;
        findings_note: string | null;
      };
      expect(body.findings).toHaveLength(100);
      expect(body.findings_total).toBe(120);
      expect(body.findings_truncated).toBe(true);
      expect(body.findings_note).toContain('另有 20 条未返回');
      expect(body.findings_note).toContain('findings_limit');
      // 分布汇总覆盖全部 120 条,不因切片丢失
      expect(body.findings_by_ruling).toEqual({ ESCALATE: 120 });
      // 与裁决层全量计算同口径
      const full = buildLineageReport(store, NOW - 7 * 86_400_000, NOW + 1000);
      expect(full.findings).toHaveLength(120);
    } finally {
      store.close();
    }
  });

  test('findings_limit=1000 全量返回:truncated=false,findings_total=数组长度', async () => {
    const store = bulkSeed(120);
    try {
      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
      const res = await server.request('http://localhost/api/lineage-report?days=7&findings_limit=1000');
      expect(res.status).toBe(200);
      const body = await res.json() as { findings: unknown[]; findings_total: number; findings_truncated: boolean; findings_note: string | null };
      expect(body.findings).toHaveLength(120);
      expect(body.findings_total).toBe(120);
      expect(body.findings_truncated).toBe(false);
      expect(body.findings_note).toBeNull();
    } finally {
      store.close();
    }
  });

  test('非法 findings_limit 回 400:0/负数/超上限/非整数/非数字', async () => {
    const store = bulkSeed(3);
    try {
      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
      for (const bad of ['0', '-5', '1001', '10.5', 'abc']) {
        const res = await server.request(`http://localhost/api/lineage-report?days=7&findings_limit=${encodeURIComponent(bad)}`);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
      // 空参数 = 缺省(即默认 100),不报 400;不传参同
      const ok = await server.request('http://localhost/api/lineage-report?days=7&findings_limit=');
      expect(ok.status).toBe(200);
      const omitted = await server.request('http://localhost/api/lineage-report?days=7');
      expect(omitted.status).toBe(200);
    } finally {
      store.close();
    }
  });

  test('MCP 偏差段超限行用 findings_total 口径:渲染 15 条,"另有 N 条(共 M 条)"', () => {
    const store = bulkSeed(120);
    try {
      const body = handleMcpBody(store, { port: 9291, plans: [] }, {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lineage_report', arguments: {} },
      }) as { result?: { content: Array<{ text: string }> } };
      const text = body.result!.content[0]!.text;
      expect(text).toContain('另有 105 条未展示(共 120 条)');
    } finally {
      store.close();
    }
  });
});
