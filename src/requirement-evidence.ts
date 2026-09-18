import type { Store } from './db.ts';
import type { RequirementRecord } from './types.ts';

/** A requirement owns a source-sequence span, never the session's latest state. */
export function readRequirementEvidence(
  store: Store,
  requirement: RequirementRecord,
  requirements = store.listRequirements(),
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
  const sessionCommits = store.listSessionCommits(requirement.sessionId);
  const warnings: string[] = [];
  if (!reliableTime) warnings.push('时间边界不完整或不单调：commit 的需求归属为 Unknown。');
  const commits = reliableTime ? sessionCommits.filter((commit) => commit.ts != null
    && commit.ts >= requirement.ts! && (next == null || commit.ts < next.ts!)
    && requirement.repos.includes(commit.repo)) : [];
  if (sessionCommits.some((commit) => commit.ts == null || !requirement.repos.includes(commit.repo))) {
    warnings.push('存在未分配的会话 commit：时间缺失或与需求仓库不匹配；未作为本需求成果。');
  }
  return {
    requirement,
    next,
    todos: store.todoSnapshotsForSession(requirement.sessionId).filter(inSpan),
    notes: store.progressNotesForSession(requirement.sessionId).filter(inSpan),
    commits,
    warnings,
  };
}
