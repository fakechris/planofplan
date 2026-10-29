import type { Store } from './db.ts';
import type { RequirementRecord } from './types.ts';

export interface RequirementEvidenceOptions {
  /**
   * 需求 repos 为空(仓库未知)时,不按仓库过滤 commit,时间边界仍生效,并加
   * 「未按仓库过滤」警告。默认严格:repos 不匹配的 commit 一律不计。周报聚合
   * (INV-1428)用它避免「仓库 Unknown」退化成「全部排除」;交接/MCP 保持严格。
   */
  relaxUnknownRepos?: boolean;
}

/** A requirement owns a source-sequence span, never the session's latest state. */
export function readRequirementEvidence(
  store: Store,
  requirement: RequirementRecord,
  requirements = store.listRequirements(),
  options: RequirementEvidenceOptions = {},
) {
  const next = requirements
    .filter((row) => row.sessionId === requirement.sessionId && row.seq > requirement.seq)
    .sort((a, b) => a.seq - b.seq)[0] ?? null;
  const inSpan = (row: { seq: number }) => requirement.seq >= 0
    && row.seq >= requirement.seq && (next == null || row.seq < next.seq);
  const siblings = requirements.filter((row) => row.sessionId === requirement.sessionId && row.seq >= 0)
    .sort((a, b) => a.seq - b.seq);
  const reliableTime = requirement.seq >= 0 && requirement.ts != null && siblings.every((row, index) =>
    row.ts != null && Number.isFinite(row.ts) && (index === 0 || row.ts > siblings[index - 1]!.ts!));
  const unknownRepos = requirement.repos.length === 0;
  const repoAllows = (repo: string) => (unknownRepos && options.relaxUnknownRepos) || requirement.repos.includes(repo);
  const sessionCommits = store.listSessionCommits(requirement.sessionId);
  const warnings: string[] = [];
  if (!reliableTime) warnings.push('时间边界不完整或不单调：commit 的需求归属为 Unknown。');
  const commits = reliableTime ? sessionCommits.filter((commit) => commit.ts != null
    && commit.ts >= requirement.ts! && (next == null || commit.ts < next.ts!)
    && repoAllows(commit.repo)) : [];
  const unallocatedCommits = sessionCommits.filter((commit) => commit.ts == null || !repoAllows(commit.repo)).length;
  if (unallocatedCommits > 0) {
    warnings.push(`存在未分配的会话 commit：时间缺失或与需求仓库不匹配；未作为本需求成果（${unallocatedCommits} 条）。`);
  }
  if (unknownRepos && options.relaxUnknownRepos && sessionCommits.length > 0) {
    warnings.push('需求未关联仓库：commit 仅按时间边界归属，未按仓库过滤。');
  }
  return {
    requirement,
    next,
    reliableTime,
    todos: store.todoSnapshotsForSession(requirement.sessionId).filter(inSpan),
    notes: store.progressNotesForSession(requirement.sessionId).filter(inSpan),
    commits,
    unallocatedCommits,
    warnings,
  };
}
