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
  const usageBySession = new Map<string, { tokens: number; cost: number | null }>();
  for (const record of store.getUsageRecords(since, until)) {
    if (!record.sessionId) continue;
    const bucket = usageBySession.get(record.sessionId) ?? { tokens: 0, cost: 0 };
    bucket.tokens += record.totalTokens;
    bucket.cost = (bucket.cost ?? 0) + (record.estimatedCostUsd ?? 0);
    usageBySession.set(record.sessionId, bucket);
  }

  const items: LineageReportItem[] = [];
  for (const requirement of store.listRequirements()) {
    const session = sessionById.get(requirement.sessionId);
    if (!session || (session.updatedAt < since || session.updatedAt >= until)) continue;
    const commits = (commitsBySession.get(requirement.sessionId) ?? [])
      .filter((commit) => commit.ts == null || (commit.ts >= since && commit.ts < until))
      .map((commit) => ({ sha: commit.sha, kind: commit.kind, summary: commit.summary }));
    const usage = usageBySession.get(requirement.sessionId);
    items.push({
      requirementId: requirement.id,
      text: requirement.text,
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

  const totalTokens = items.reduce((sum, item) => sum + item.totalTokens, 0);
  const costItems = items.filter((item) => item.estimatedCostUsd != null);
  return {
    generatedAt: now,
    since,
    until,
    totals: {
      requirements: items.length,
      landed: items.filter((item) => item.landed).length,
      commits: items.reduce((sum, item) => sum + item.commits.length, 0),
      declaredCommits: items.reduce((sum, item) => sum + item.declaredCommits, 0),
      totalTokens,
      estimatedCostUsd: costItems.length > 0
        ? costItems.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)
        : null,
    },
    items,
  };
}
