/**
 * 经验图谱节点契约与自底向上合成骨架(INV-2169,M8 第一个子合同)。
 *
 * 借鉴 EGM bootstrap 的 Peanuts/Hay 目录契约(调研 INV-2166 §3.7):节点 =
 * path/summary/interface/invariants/side_effects 五元组;叶子(leaf)=需求簇
 * 契约,父索引(index)=仓库聚合。与 EGM 的差异:数据源是 L1 索引(需求/会话/
 * commit 归因/知识卡)而非源码树,节点对象从"目录"换成"仓库/需求簇"。
 *
 * 铁律:
 * - 证据强制:每条 invariant 必须带 ≥1 条可解析证据引用(@session:{…}/pop:/
 *   req:/inv:/ovp://、commit sha、URL)与证据等级,无证据断言拒绝入库;
 * - 零捏造:summary 只用需求原话/聚合事实,LLM 只做可选精炼(镜像
 *   requirement-llm:opt-in、有界、失败跳过),原话永不覆盖;
 * - superseded 不删除:内容变更时旧行标记 superseded_by 指向新行,历史保留;
 *   内容不变的重跑是 no-op(幂等);回退到旧内容会复活旧行;
 * - L0 只读:合成只读写 L1 表(experience_nodes),不触碰任何原生日志;
 * - 安全门:待合成节点数超阈值(默认 15)时,交互路径暂停请求确认,无人值守
 *   跳过该批次并记录(EGM bootstrap 的 >15 目录安全门同款)。
 *
 * 产物表 experience_nodes 属 L1 可重建数据,与 session_user_meta 状态层
 * 隔离(星标/隐藏/墓碑不落此表);隐藏会话在合成期与读取期双重过滤。
 */
import { createHash } from 'node:crypto';
import type { Store } from './db.ts';
import type {
  ExperienceInvariant,
  ExperienceNodeKind,
  ExperienceNodeRecord,
  ExperienceNodeSaveResult,
  KnowledgeCardRecord,
  RequirementRecord,
} from './types.ts';
import { readRequirementEvidence } from './requirement-evidence.ts';
import { llmChat } from './llm.ts';
import type { LlmConfig } from './config.ts';

export type {
  ExperienceEvidence,
  ExperienceEvidenceLevel,
  ExperienceInvariant,
  ExperienceNodeKind,
  ExperienceNodeRecord,
  ExperienceNodeSaveResult,
} from './types.ts';

// ── 节点输入(合成层的构造面;落库前经 validateExperienceNode)────────

export interface ExperienceNodeInput {
  nodeKind: ExperienceNodeKind;
  /** 仓库键(url 或名称,与 session_repos/knowledge_cards 对齐)。 */
  repo: string;
  /** leaf:需求 id 锚;index:仓库键本身。 */
  path: string;
  parentId: string | null;
  summary: string;
  /** 对外接触面:文件路径(仓库相对)/工具名。 */
  interface: string[];
  invariants: ExperienceInvariant[];
  /** 观察到的行为副作用(commit 摘要等,带等级标注)。 */
  sideEffects: string[];
  /** 内容来源指纹(幂等比较参与),如 {requirementIds, knowledgeCardIds, commitShas}。 */
  sources: Record<string, unknown>;
}

// ── 证据引用校验(无证据断言拒绝入库的第一道闸)──────────────────────

const EVIDENCE_REF_PATTERNS: RegExp[] = [
  /^@session:\{[^\s{}]+\}$/,                                   // 会话引用(handoff 协议)
  /^pop:[a-z][a-z0-9_]*:[^\s#]+#[^\s@]+(@\S+)?$/,             // 跨系统消息引用(INV-1434)
  /^req:[A-Za-z0-9:_-]+$/,                                     // 需求 id
  /^inv:INV-\d+$/,                                             // Involute 工单
  /^ovp:\/\/[A-Za-z0-9][A-Za-z0-9/.:_-]*$/,                   // OVP URI
  /^[0-9a-f]{7,40}$/,                                          // commit sha
  /^https?:\/\/\S+$/,                                          // URL
];

export function isValidEvidenceRef(ref: string): boolean {
  const value = ref.trim();
  return value.length > 0 && value.length <= 500 && EVIDENCE_REF_PATTERNS.some((pattern) => pattern.test(value));
}

export class ExperienceValidationError extends Error {
  constructor(message: string) { super(message); }
}

/** 校验节点输入;不合法直接抛(入库前的唯一入口,调用方不得吞)。 */
export function validateExperienceNode(input: ExperienceNodeInput): void {
  if (input.nodeKind !== 'leaf' && input.nodeKind !== 'index') {
    throw new ExperienceValidationError(`node_kind 必须是 leaf/index,收到:${input.nodeKind}`);
  }
  if (!input.repo.trim()) throw new ExperienceValidationError('repo 必填');
  if (!input.path.trim()) throw new ExperienceValidationError('path 必填');
  if (!input.summary.trim()) throw new ExperienceValidationError('summary 必填(零捏造:只能来自已物化证据)');
  for (const invariant of input.invariants) {
    if (!invariant.text.trim()) {
      throw new ExperienceValidationError('invariant.text 不能为空');
    }
    if (!Array.isArray(invariant.evidence) || invariant.evidence.length === 0) {
      throw new ExperienceValidationError(`无证据断言拒绝入库:"${invariant.text.slice(0, 60)}" 必须带 ≥1 条证据引用`);
    }
    for (const evidence of invariant.evidence) {
      if (!isValidEvidenceRef(evidence.ref)) {
        throw new ExperienceValidationError(`证据引用格式不符:"${evidence.ref}"(支持 @session:{}/pop:/req:/inv:/ovp://、commit sha、URL)`);
      }
      if (!['declared', 'witnessed', 'candidate', 'reviewed'].includes(evidence.level)) {
        throw new ExperienceValidationError(`证据等级非法:${evidence.level}`);
      }
    }
  }
}

/** 内容指纹:自然键 + 内容规范化 → 稳定 id(幂等/复活/变更检测共用)。 */
function experienceNodeId(input: ExperienceNodeInput): string {
  const canonical = JSON.stringify([
    input.nodeKind, input.repo, input.path, input.parentId,
    input.summary.trim(), input.interface, input.invariants, input.sideEffects, input.sources,
  ]);
  return `expv:${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

/**
 * 幂等落库:同 id 已 active → unchanged;同 id 曾存在但 superseded → 复活并
 * 接管 active 位;新 id → 当前的 active 同键行标记 superseded(不删除)后插入。
 */
export function saveExperienceNode(store: Store, input: ExperienceNodeInput): ExperienceNodeSaveResult {
  validateExperienceNode(input);
  const id = experienceNodeId(input);
  return store.saveExperienceNode({
    id,
    nodeKind: input.nodeKind,
    repo: input.repo.trim(),
    path: input.path.trim(),
    parentId: input.parentId,
    summary: input.summary.trim(),
    summaryRefined: null,
    interface: input.interface,
    invariants: input.invariants,
    sideEffects: input.sideEffects,
    sources: input.sources,
  });
}

// ── 自底向上合成(确定性;LLM 只做可选 summary 精炼)──────────────────

export interface SynthesizeOptions {
  /** 安全门阈值:待合成节点(leaf+index)总数超过则暂停/跳过。默认 15。 */
  maxNodes?: number;
  /** 交互路径传 true 越过安全门;false 时超阈值返回 confirmation-required。 */
  confirm?: boolean;
  now?: number;
}

export interface SynthesizeResult {
  status: 'ok' | 'confirmation-required';
  /** 安全门发现的总节点数(confirmation-required 时 >maxNodes)。 */
  discovered: number;
  created: number;
  superseded: number;
  unchanged: number;
  resurrected: number;
  /** 被证据闸拒绝的断言条数(无证据/格式不符),如实记录不静默。 */
  rejectedInvariants: number;
  /** 跳过的知识卡(无 source_refs 的 reviewed 卡,断言不入库)。 */
  skippedCards: string[];
  repos: string[];
}

/** 不可见会话(隐藏/墓碑)——合成期过滤与读取期过滤共用。 */
export function unavailableSessionIds(store: Store): Set<string> {
  return new Set([...store.getSessionUserMetaMap()]
    .filter(([, meta]) => meta.hidden || meta.deletedAt != null).map(([sid]) => sid));
}

function relativize(path: string, root: string | null): string {
  if (!root) return path;
  const norm = root.replace(/\/+$/, '');
  return path === norm ? '.' : path.startsWith(`${norm}/`) ? path.slice(norm.length + 1) : path;
}

/** 触碰路径是否落在仓库根下(两端都按 handoff 同款规则归一:/private 前缀与尾斜杠)。 */
function pathUnderRepoRoot(filePath: string, repoRoot: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '').replace(/^\/private(?=\/)/, '');
  const file = norm(filePath);
  const root = norm(repoRoot);
  return file === root || file.startsWith(`${root}/`);
}

/** 需求簇 → 叶子节点输入(确定性;invariants 只来自已审核知识卡)。 */
function leafInputFor(args: {
  repo: string;
  requirement: RequirementRecord;
  parentId: string;
  cards: KnowledgeCardRecord[];
  unavailable: Set<string>;
  result: SynthesizeResult;
}): ExperienceNodeInput {
  const { repo, requirement, parentId, cards } = args;
  const invariants: ExperienceInvariant[] = [];
  for (const card of cards) {
    // 证据闸:reviewed 卡自身的 sourceRefs 即证据。来源格式全部不可解析 →
    // 断言拒绝入库(rejectedInvariants 计数);指向隐藏会话的引用剔除,
    // 剔空则整条断言不出(隐藏边界,不计为拒绝)。
    const validRefs = card.sourceRefs
      .map((source) => source.ref.trim())
      .filter((ref) => isValidEvidenceRef(ref));
    if (validRefs.length === 0) {
      if (card.sourceRefs.length > 0) args.result.rejectedInvariants += 1;
      else args.result.skippedCards.push(card.id);
      continue;
    }
    const visibleRefs = validRefs.filter((ref) => {
      const sessionId = ref.match(/^@session:\{([^\s{}]+)\}$/)?.[1];
      return sessionId == null || !args.unavailable.has(sessionId);
    });
    if (visibleRefs.length === 0) continue;
    invariants.push({
      text: `[${card.kind}] ${card.problem} → ${card.action}`,
      evidence: visibleRefs.map((ref) => ({ ref, level: 'reviewed' as const })),
    });
  }

  const summary = requirement.text.trim().slice(0, 300);
  return {
    nodeKind: 'leaf',
    repo,
    path: requirement.id,
    parentId,
    summary,
    interface: [],
    invariants,
    sideEffects: [],
    // sources 只含稳定标识(不带时间戳):内容指纹参与幂等比较,时间会让重跑永远"变更"
    sources: { requirementId: requirement.id, knowledgeCardIds: cards.map((card) => card.id) },
  };
}

/**
 * 合成一轮:按仓库分组,叶子=需求簇(含 span 文件面/commit 副作用/知识卡断言),
 * 父=仓库索引。确定性、幂等;隐藏会话的需求/卡断言/commit 全部过滤。
 */
export function synthesizeExperienceGraph(store: Store, options: SynthesizeOptions = {}): SynthesizeResult {
  const maxNodes = options.maxNodes ?? 15;
  const now = options.now ?? Date.now();
  const result: SynthesizeResult = {
    status: 'ok', discovered: 0, created: 0, superseded: 0, unchanged: 0, resurrected: 0,
    rejectedInvariants: 0, skippedCards: [], repos: [],
  };
  const unavailable = unavailableSessionIds(store);

  // 仓库分组:需求 → repos(session_repos 归因);跨仓需求在每个仓库各立叶子
  const requirements = store.listRequirements().filter((req) => !unavailable.has(req.sessionId));
  const cards = store.listKnowledgeCards({ view: 'effective' })
    .filter((card) => !card.expiresAt || card.expiresAt > now);

  // 先构造全部节点输入(只读阶段),安全门在写库前拦截
  const byRepo = new Map<string, { repoRoot: string | null; leaves: Array<{ requirement: RequirementRecord; evidence: ReturnType<Store['listSessionCommits']> }> }>();
  for (const requirement of requirements) {
    const repos = requirement.repos.length > 0 ? requirement.repos : ['(unknown)'];
    for (const repo of repos) {
      let entry = byRepo.get(repo);
      if (!entry) {
        const root = store.listSessionRepos().find((row) => row.url === repo || row.name === repo)?.root ?? null;
        entry = { repoRoot: root, leaves: [] };
        byRepo.set(repo, entry);
      }
      const evidence = readRequirementEvidence(store, requirement);
      entry.leaves.push({ requirement, evidence: evidence.commits });
    }
  }

  const pending: ExperienceNodeInput[] = [];
  for (const [repo, entry] of byRepo) {
    const indexId = `exp-index:${repo}`;
    const repoCards = cards.filter((card) => card.repo == null || card.repo === repo || repo.includes(card.repo));
    const leafInputs: ExperienceNodeInput[] = [];
    for (const leaf of entry.leaves) {
      const input = leafInputFor({
        repo, requirement: leaf.requirement, parentId: indexId,
        cards: repoCards, unavailable, result,
      });
      // 文件接触面(span touches,仓库相对)与 commit 副作用
      const next = store.listRequirements()
        .filter((row) => row.sessionId === leaf.requirement.sessionId && row.seq > leaf.requirement.seq)
        .sort((a, b) => a.seq - b.seq)[0] ?? null;
      const touches = leaf.requirement.seq >= 0
        ? store.spanTouches(leaf.requirement.sessionId, leaf.requirement.seq, next ? next.seq : null) : [];
      const fileCount = new Map<string, number>();
      for (const touch of touches) {
        // 跨仓需求(INV-2186):叶子的接触面只计落在所属仓库根下的触碰;
        // 根未知(URL-only 仓库)无法判定归属,保留全量并保持原路径。
        if (entry.repoRoot != null && !pathUnderRepoRoot(touch.filePath, entry.repoRoot)) continue;
        const rel = relativize(touch.filePath, entry.repoRoot);
        fileCount.set(rel, (fileCount.get(rel) ?? 0) + 1);
      }
      input.interface = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, n]) => `${path} ×${n}`);
      input.sideEffects = leaf.evidence
        .filter((commit) => commit.ts != null)
        .slice(0, 8)
        .map((commit) => `${commit.sha.slice(0, 8)} [${commit.kind}] ${commit.summary || '(no subject)'}`);
      input.sources = { ...input.sources, commitShas: leaf.evidence.map((commit) => commit.sha) };
      leafInputs.push(input);
    }
    // 父索引:聚合事实(零捏造——只有计数与文件面,无生成文本)
    const allFiles = new Map<string, number>();
    for (const leaf of leafInputs) {
      for (const line of leaf.interface) {
        const path = line.replace(/ ×\d+$/, '');
        allFiles.set(path, (allFiles.get(path) ?? 0) + 1);
      }
    }
    pending.push({
      nodeKind: 'index',
      repo,
      path: repo,
      parentId: null,
      summary: `仓库 ${repo}:${leafInputs.length} 个需求簇,${repoCards.length} 张有效经验卡;文件面 top ${Math.min(10, allFiles.size)}。`,
      interface: [...allFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, n]) => `${path} ×${n}`),
      invariants: [], // 索引不携带断言;断言在叶子(证据所在)
      sideEffects: [],
      sources: { leafIds: leafInputs.map((leaf) => leaf.path) },
    });
    pending.push(...leafInputs);
  }

  result.discovered = pending.length;
  if (pending.length > maxNodes && !options.confirm) {
    result.status = 'confirmation-required';
    return result; // 安全门:交互路径暂停;无人值守由调用方决定跳过并记录
  }

  result.repos = [...byRepo.keys()];
  for (const input of pending) {
    const saved = saveExperienceNode(store, input);
    if (saved.action === 'created') result.created += 1;
    else if (saved.action === 'superseded') result.superseded += 1;
    else if (saved.action === 'unchanged') result.unchanged += 1;
    else if (saved.action === 'resurrected') result.resurrected += 1;
  }
  return result;
}

// ── 读取面(隐藏边界在读取期再过滤一次:合成后新隐藏的会话)──────────

/** 读取期隐藏过滤:证据引用指向隐藏会话的剔除;剔空的断言整条不输出。 */
export function visibleInvariants(node: ExperienceNodeRecord, unavailable: Set<string>): ExperienceInvariant[] {
  return node.invariants
    .map((invariant) => ({
      ...invariant,
      evidence: invariant.evidence.filter((evidence) => {
        const sessionId = evidence.ref.match(/^@session:\{([^\s{}]+)\}$/)?.[1];
        return sessionId == null || !unavailable.has(sessionId);
      }),
    }))
    .filter((invariant) => invariant.evidence.length > 0);
}

// ── LLM 可选精炼(镜像 requirement-llm:opt-in/有界/失败跳过)──────────

const SUMMARY_REFINE_SYSTEM = `你为研发经验图谱的节点写一句精炼摘要,给接手该仓库的工程师/agent 看。
规则:
- 输出恰好一句中文,不超过 80 字符,无前后缀、引号或解释。
- 保留精确的文件路径、命令、库名、标识符,原文引用。
- 只概括这个需求簇要做什么与当前状态,不虚构输入之外的信息。
- 无法提炼出比原文更清晰的陈述时,只输出一个空行。`;

export function experienceLlmEnabled(env: NodeJS.ProcessEnv = process.env, cfg?: { refine?: boolean }): boolean {
  return env.PLANOFPLAN_EXPERIENCE_LLM === '1' || cfg?.refine === true;
}

export interface RefineResult {
  attempted: number;
  refined: number;
  skipped?: string;
}

/** 精炼一轮 active 节点的 summary(有界,默认 8 条);原话永不覆盖。 */
export async function refineExperienceSummaries(
  store: Store,
  cfg: LlmConfig,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: unknown; timeoutMs?: number; limit?: number } = {},
): Promise<RefineResult> {
  const env = options.env ?? process.env;
  if (!experienceLlmEnabled(env, cfg) || !cfg.provider) {
    return { attempted: 0, refined: 0, skipped: !experienceLlmEnabled(env, cfg) ? '精炼未开启(config llm.refine 或 env PLANOFPLAN_EXPERIENCE_LLM)' : '未配置 LLM' };
  }
  const limit = options.limit ?? 8;
  const candidates = store.listExperienceNodes({ includeSuperseded: false, limit })
    .filter((node) => node.summaryRefined == null);
  if (candidates.length === 0) return { attempted: 0, refined: 0 };
  let refined = 0;
  for (const node of candidates) {
    try {
      const result = await llmChat({
        cfg,
        env,
        system: SUMMARY_REFINE_SYSTEM,
        user: `仓库:${node.repo}\n节点:${node.path}\n原摘要:${node.summary}\n\n请直接输出这一句精炼摘要(无解释);无法提炼则只输出一个空行:`,
        fetchImpl: options.fetchImpl as never,
        timeoutMs: options.timeoutMs ?? 20_000,
      });
      if (result.error) continue;
      const raw = (result.content ?? '').trim();
      const metaCommentary = /^(the user|user is|let me|作为 ai|作为模型)/i.test(raw);
      const text = !metaCommentary && raw.length > 0 && raw.length <= 120 ? raw : '';
      store.setExperienceSummaryRefined(node.id, text || ''); // '' = 已尝试无精炼,null = 未尝试
      if (text) refined += 1;
    } catch {
      /* 单条失败不拖垮整轮,不标记(下次重试) */
    }
  }
  return { attempted: candidates.length, refined };
}
