import type { Store } from './db.ts';
import type { RequirementRecord, SessionCommit } from './types.ts';
import { readRequirementEvidence } from './requirement-evidence.ts';

// ── 谱系周报 v1:纯静态聚合,不引 LLM ────────────────────────────────
// 需求(requirements) × 行为(sessions/tokens) × 结果(commits) 三表 join,
// 回答"这段时间做了什么、落了多少、各烧多少"——三家都没有的谱系视角。
//
// INV-1428 口径修正:
// - 逐需求复用 readRequirementEvidence 的范围证据(span/时间边界/仓库归属),
//   不再把整 session 的 commit 分摊给每条需求;repos 未知时按时间边界宽松归属
//   并带警告(避免 Unknown 退化成全部排除)。
// - landed 只认 declared/witnessed;candidate-only 是「可能落地」不是「落地」;
//   时间边界不可靠时为 unknown-time。验证/验收状态本报告永远 Unknown。
// - 成本未知不按 0 累加:全未知 → null;部分未知 → 已知合计 + 未知条数。
//
// INV-2167 裁决层(呈现层语义,不改上述任何计算):
// - findings 段对每条信息缺口强制四分类裁决(借鉴 EGM resolve):
//   PROPOSE FIX(成立待修,附证据)/ CONTEST(可反驳,证据必须是收报告方
//   本来就能读到的——附可两跳解析的引用,给不出即降级 ESCALATE)/
//   ESCALATE(证据在可读范围外,留人类)/ DECLINE(低置信 Nit,记录不展开)。
// - 漂移纪律(借鉴 EGM drift-report):只报差异,一致项(有 declared/witnessed
//   落地且无缺口)不出现;全一致时输出显式 No drift detected 语义。
// - 隐藏会话不进 items 也不产 findings(INV-443 隐藏边界贯通本出口)。

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
  witnessedCommits: number;
  candidateCommits: number;
  /** declared/witnessed 范围内提交存在才为 true;candidate 不算落地。 */
  landed: boolean;
  landedBasis: 'declared-or-witnessed' | 'candidate-only' | 'none' | 'unknown-time';
  unallocatedCommits: number;
  warnings: string[];
  /** 所在会话的消耗(同会话多需求会重复出现,语义是"会话消耗"而非需求独占)。 */
  totalTokens: number;
  usageRecords: number;
  /** 已知成本合计;全未知或无记录为 null,不伪装成 0。 */
  estimatedCostUsd: number | null;
  /** 成本未知的记录条数(部分未知时 estimatedCostUsd 只是下界)。 */
  costUnknownRecords: number;
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
    candidateCommits: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    costUnknownSessions: number;
  };
  items: LineageReportItem[];
  /** INV-2167 裁决层:只含差异项;空 = 全一致(No drift detected)。 */
  findings: LineageFinding[];
}

// ── 四分类裁决(INV-2167,借鉴 EGM resolve;呈现层,不改归因计算)─────

export type FindingRuling = 'PROPOSE FIX' | 'CONTEST' | 'ESCALATE' | 'DECLINE';

export type FindingKind = 'no-evidence' | 'candidate-only' | 'unknown-time' | 'unallocated' | 'cost-unknown';

export interface LineageFinding {
  kind: FindingKind;
  ruling: FindingRuling;
  requirementId: string;
  /** 需求陈述(截断)。 */
  text: string;
  /**
   * CONTEST 的证据引用——必须是收报告方本来就能读到的(可两跳解析:
   * read_session 取 SourceRef → read_message);给不出可解析引用的
   * CONTEST 在生成期即降级 ESCALATE。PROPOSE FIX 附报告内可见的
   * commit sha;ESCALATE/DECLINE 为空(证据在外/低置信)。
   */
  evidenceRefs: string[];
  note: string;
}

/** 全一致时的显式声明(EGM "No drift detected" 等价语义)。 */
export function driftCleanMessage(requirements: number): string {
  return `未检测到漂移(No drift detected):窗口内 ${requirements} 个需求均有 declared/witnessed 级落地见证,且无未分配 commit、时间边界缺口与成本未知记录。验证/验收状态仍为 Unknown(本报告只看关联证据)。`;
}

/** 会话是否有已索引消息(决定 CONTEST 引用是否可两跳解析)。 */
function sessionHasIndexedMessages(store: Store, sessionId: string): boolean {
  const row = store.db.query(
    'SELECT count(*) AS n FROM session_messages WHERE session_id = ?',
  ).get(sessionId) as { n: number };
  return row.n > 0;
}

function buildFindings(store: Store, items: LineageReportItem[]): LineageFinding[] {
  const findings: LineageFinding[] = [];
  for (const item of items) {
    const clip = (text: string): string => text.length > 60 ? `${text.slice(0, 59)}…` : text;
    if (item.landedBasis === 'none') {
      // 窗口内无 commit 见证:证据缺口,不是未完成断言。读者可核验后反驳
      // (CONTEST);会话没有已索引消息时引用不可解析,降级 ESCALATE。
      if (sessionHasIndexedMessages(store, item.sessionId)) {
        findings.push({
          kind: 'no-evidence',
          ruling: 'CONTEST',
          requirementId: item.requirementId,
          text: clip(item.text),
          // requirementId 本身即 req: 前缀格式,可直接作引用
          evidenceRefs: [`@session:{${item.sessionId}}`, item.requirementId],
          note: '窗口内未见该需求的 commit 见证(≠未完成:可能落在别的时间窗/仓库/未推送)。对引用两跳核验(read_session → read_message)后可反驳',
        });
      } else {
        findings.push({
          kind: 'no-evidence',
          ruling: 'ESCALATE',
          requirementId: item.requirementId,
          text: clip(item.text),
          evidenceRefs: [],
          note: '窗口内未见 commit 见证,且会话无可索引消息供核验(证据在外)——留人工确认',
        });
      }
    }
    if (item.landedBasis === 'candidate-only') {
      findings.push({
        kind: 'candidate-only',
        ruling: 'PROPOSE FIX',
        requirementId: item.requirementId,
        text: clip(item.text),
        evidenceRefs: item.commits.filter((commit) => commit.kind === 'candidate').map((commit) => commit.sha),
        note: `仅有时间窗推断级关联(${item.candidateCommits} 条 candidate,见证据 sha);建议 hook install 声明或人工核验补强`,
      });
    }
    if (item.landedBasis === 'unknown-time') {
      findings.push({
        kind: 'unknown-time',
        ruling: 'ESCALATE',
        requirementId: item.requirementId,
        text: clip(item.text),
        evidenceRefs: [],
        note: '时间边界不完整或不单调,commit 归属 Unknown;归属所需证据在索引外,留人工',
      });
    }
    if (item.unallocatedCommits > 0) {
      findings.push({
        kind: 'unallocated',
        ruling: 'PROPOSE FIX',
        requirementId: item.requirementId,
        text: clip(item.text),
        evidenceRefs: [`@session:{${item.sessionId}}`],
        note: `${item.unallocatedCommits} 条会话 commit 因时间缺失或仓库不匹配未分配到任何需求;可对该会话补 witness/声明`,
      });
    }
    if (item.costUnknownRecords > 0) {
      // DECLINE:低置信 Nit,只记录计数不展开细节(EGM resolve 的 DECLINE 语义)
      findings.push({
        kind: 'cost-unknown',
        ruling: 'DECLINE',
        requirementId: item.requirementId,
        text: clip(item.text),
        evidenceRefs: [],
        note: `${item.costUnknownRecords} 条用量记录成本未知(已知合计只是下界),低置信不展开`,
      });
    }
  }
  return findings;
}

export function buildLineageReport(store: Store, since: number, until: number): LineageReport {
  const now = Date.now();
  const sessions = store.listSessionRows();
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  // 隐藏边界(INV-443 原则贯通本出口):隐藏/墓碑会话的需求不进周报、不产 findings
  const unavailable = new Set([...store.getSessionUserMetaMap()]
    .filter(([, meta]) => meta.hidden || meta.deletedAt != null).map(([sid]) => sid));
  const requirements = store.listRequirements();
  // usage_records.session_id 存的是各家原生 uuid(无 provider 前缀),与
  // sessions.id('claude:<uuid>' 等)不同键——用 provider|native 复合键对齐。
  // 成本按「已知合计 + 未知条数」分账,未知绝不折成 0。
  const usageByNative = new Map<string, { tokens: number; costKnown: number; records: number; unknownCost: number }>();
  for (const record of store.getUsageRecords(since, until)) {
    if (!record.sessionId) continue;
    const key = `${record.provider}|${record.sessionId}`;
    const bucket = usageByNative.get(key) ?? { tokens: 0, costKnown: 0, records: 0, unknownCost: 0 };
    bucket.tokens += record.totalTokens;
    bucket.records += 1;
    if (record.estimatedCostUsd == null) bucket.unknownCost += 1;
    else bucket.costKnown += record.estimatedCostUsd;
    usageByNative.set(key, bucket);
  }

  const items: LineageReportItem[] = [];
  for (const requirement of requirements) {
    const session = sessionById.get(requirement.sessionId);
    if (!session || (session.updatedAt < since || session.updatedAt >= until)) continue;
    if (unavailable.has(requirement.sessionId)) continue;
    const evidence = readRequirementEvidence(store, requirement, requirements, { relaxUnknownRepos: true });
    const commits = evidence.commits
      .filter((commit) => commit.ts != null && commit.ts >= since && commit.ts < until)
      .map((commit) => ({ sha: commit.sha, kind: commit.kind, summary: commit.summary }));
    const declaredCommits = commits.filter((commit) => commit.kind === 'declared').length;
    const witnessedCommits = commits.filter((commit) => commit.kind === 'witnessed').length;
    const candidateCommits = commits.filter((commit) => commit.kind === 'candidate').length;
    const landedBasis: LineageReportItem['landedBasis'] = !evidence.reliableTime
      ? 'unknown-time'
      : declaredCommits + witnessedCommits > 0 ? 'declared-or-witnessed'
        : candidateCommits > 0 ? 'candidate-only' : 'none';
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
      declaredCommits,
      witnessedCommits,
      candidateCommits,
      landed: landedBasis === 'declared-or-witnessed',
      landedBasis,
      unallocatedCommits: evidence.unallocatedCommits,
      warnings: evidence.warnings,
      totalTokens: usage?.tokens ?? 0,
      usageRecords: usage?.records ?? 0,
      estimatedCostUsd: usage == null ? null : (usage.unknownCost >= usage.records ? null : usage.costKnown),
      costUnknownRecords: usage?.unknownCost ?? 0,
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
  const costUnknownSessions = [...uniqueSessions.values()].filter((item) => item.costUnknownRecords > 0).length;
  // commits 计数同口径去重:同 session 多需求各自带 span 内 commit,
  // totals 只按唯一 (session, sha, kind) 计
  const uniqueCommitKeys = new Set<string>();
  let uniqueCommits = 0;
  let uniqueDeclared = 0;
  let uniqueWitnessed = 0;
  let uniqueCandidate = 0;
  for (const item of items) {
    for (const commit of item.commits) {
      const key = `${item.sessionId}:${commit.sha}:${commit.kind}`;
      if (uniqueCommitKeys.has(key)) continue;
      uniqueCommitKeys.add(key);
      uniqueCommits += 1;
      if (commit.kind === 'declared') uniqueDeclared += 1;
      else if (commit.kind === 'witnessed') uniqueWitnessed += 1;
      else if (commit.kind === 'candidate') uniqueCandidate += 1;
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
      candidateCommits: uniqueCandidate,
      totalTokens,
      estimatedCostUsd: costItems.length > 0
        ? costItems.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)
        : null,
      costUnknownSessions,
    },
    items,
    findings: buildFindings(store, items),
  };
}
