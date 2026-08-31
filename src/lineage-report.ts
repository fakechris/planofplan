import type { Store } from './db.ts';
import type { RequirementRecord, SessionCommit } from './types.ts';

// ── 谱系周报 v0:纯静态聚合,不引 LLM ────────────────────────────────
// 需求(requirements) × 行为(sessions/tokens) × 结果(commits) 三表 join,
// 回答"这段时间做了什么、落了多少、各烧多少"——三家都没有的谱系视角。

export interface LineageReportItem {
  requirementId: string;
  text: string;
  originLevel: RequirementRecord['originLevel'];
  sessionId: string;
  provider: string;
  title: string | null;
  project: string | null;
  updatedAt: number;
  commits: Array<{ sha: string; kind: SessionCommit['kind']; summary: string }>;
  declaredCommits: number;
  landed: boolean;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface LineageReport {
  generatedAt: number;
  since: number;
  until: number;
  totals: {
    requirements: number;
    landed: number;
    commits: number;
    declaredCommits: number;
    witnessedCommits: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  };
  items: LineageReportItem[];
}

export function buildLineageReport(store: Store, since: number, until: number): LineageReport {
  const now = Date.now();
  const sessions = store.listSessionRows();
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const commitsBySession = new Map<string, SessionCommit[]>();
  for (const commit of store.listSessionCommits()) {
    const list = commitsBySession.get(commit.sessionId) ?? [];
    list.push(commit);
    commitsBySession.set(commit.sessionId, list);
  }
  // usage_records.session_id 存的是各家原生 uuid(无 provider 前缀),与
  // sessions.id('claude:<uuid>' 等)不同键——用 provider|native 复合键对齐
  const usageByNative = new Map<string, { tokens: number; cost: number | null }>();
  for (const record of store.getUsageRecords(since, until)) {
    if (!record.sessionId) continue;
    const key = `${record.provider}|${record.sessionId}`;
    const bucket = usageByNative.get(key) ?? { tokens: 0, cost: 0 };
    bucket.tokens += record.totalTokens;
    bucket.cost = (bucket.cost ?? 0) + (record.estimatedCostUsd ?? 0);
    usageByNative.set(key, bucket);
  }

  const items: LineageReportItem[] = [];
  for (const requirement of store.listRequirements()) {
    const session = sessionById.get(requirement.sessionId);
    if (!session || (session.updatedAt < since || session.updatedAt >= until)) continue;
    const commits = (commitsBySession.get(requirement.sessionId) ?? [])
      .filter((commit) => commit.ts == null || (commit.ts >= since && commit.ts < until))
      .map((commit) => ({ sha: commit.sha, kind: commit.kind, summary: commit.summary }));
    const usage = usageByNative.get(`${session.provider}|${session.nativeId}`);
    items.push({
      requirementId: requirement.id,
      text: requirement.refinedText ?? requirement.text,
      originLevel: requirement.originLevel,
      sessionId: requirement.sessionId,
      provider: session.provider,
      title: session.title,
      project: (session.repos ?? [])[0]?.name ?? session.gitName ?? null,
      updatedAt: session.updatedAt,
      commits,
      declaredCommits: commits.filter((commit) => commit.kind === 'declared').length,
      landed: commits.length > 0,
      totalTokens: usage?.tokens ?? 0,
      estimatedCostUsd: usage?.cost ?? null,
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);

  // 用量按 session 去重:一个 session 常有多个需求,逐条累加会把同一份
  // 消耗计 N 次(实测膨胀 ~10x)。item 级仍展示该 session 的消耗(需求间
  // 会重复出现,语义是"所在会话消耗"),totals 只按唯一 session 计。
  const uniqueSessions = new Map<string, LineageReportItem>();
  for (const item of items) {
    const existing = uniqueSessions.get(item.sessionId);
    if (!existing || item.updatedAt > existing.updatedAt) uniqueSessions.set(item.sessionId, item);
  }
  const totalTokens = [...uniqueSessions.values()].reduce((sum, item) => sum + item.totalTokens, 0);
  const costItems = [...uniqueSessions.values()].filter((item) => item.estimatedCostUsd != null);
  // commits 计数同口径去重:同 session 多需求会重复携带同一批 commit,
  // totals 只按唯一 (session, sha) 计
  const uniqueCommitKeys = new Set<string>();
  let uniqueCommits = 0;
  let uniqueDeclared = 0;
  let uniqueWitnessed = 0;
  for (const item of items) {
    for (const commit of item.commits) {
      const key = `${item.sessionId}:${commit.sha}`;
      if (uniqueCommitKeys.has(key)) continue;
      uniqueCommitKeys.add(key);
      uniqueCommits += 1;
      if (commit.kind === 'declared') uniqueDeclared += 1;
      else if (commit.kind === 'witnessed') uniqueWitnessed += 1;
    }
  }
  return {
    generatedAt: now,
    since,
    until,
    totals: {
      requirements: items.length,
      landed: items.filter((item) => item.landed).length,
      commits: uniqueCommits,
      declaredCommits: uniqueDeclared,
      witnessedCommits: uniqueWitnessed,
      totalTokens,
      estimatedCostUsd: costItems.length > 0
        ? costItems.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)
        : null,
    },
    items,
  };
}
