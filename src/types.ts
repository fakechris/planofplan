/** 一个限额窗口（5h / 周 / 月 / 请求数 / 周期余额……）。8 个 plan 的限额模型统一建模为多窗口。 */
export interface QuotaWindow {
  /** 语义窗口 id：rolling_5h | weekly | monthly | requests | credits_period（也可扩展） */
  window: string;
  /** 展示名，如 "5H" / "Week" / "Month" / "Requests" */
  label: string;
  /** 已用数量；只有余额（如 credits）时可 null */
  used: number | null;
  /** 总量；纯余额时可 null */
  total: number | null;
  /** 计量单位。已知语义：percent/requests/credits/prompts/tokens/usd。
   * 也可承载原始币种代码（CNY/USD/EUR/GBP/JPY…）——DeepSeek 等余额型 provider
   * 用 API 响应里的实际币种填，前端按 3 位大写字母识别成货币渲染。 */
  unit: string;
  /** 已用百分比 0-100；未知为 null */
  percentage: number | null;
  /** 重置时间 epoch ms；未知为 null */
  resetAt: number | null;
  /** 窗口开始时间 epoch ms；由 server 根据窗口类型估算或 provider 返回。 */
  startedAt?: number | null;
  /** 附加说明（如 "不限量"、"网页端可见"） */
  note: string | null;
  /** 抓取时间（由写入方填充） */
  fetchedAt?: number;
  /** 高峰/低谷标记；由 tier engine 在 server 端按当前时间注解，非持久化字段。 */
  tier?: 'peak' | 'offpeak' | null;
  /** 当前时段费率倍率：offpeak=0.5，peak=1.0；规则不覆盖为 null。 */
  tierMultiplier?: number | null;
  /** 当前时段人类可读标签（例：'DeepSeek 高峰'）。 */
  tierLabel?: string | null;
  /** 距离下次切换的 epoch 毫秒；切换时间未知时为 null。 */
  tierNextChangeAt?: number | null;
  /** tier 规则使用的 IANA 时区，用于 tooltip 显示。 */
  tierTimezone?: string | null;
}

/** 每 plan 的静态配置（config.json / db plans 表） */
export interface PlanConfig {
  slug: string;
  name: string;
  adapter: string;
  enabled: boolean;
  pollIntervalSec: number;
  /** 引用的手动凭据 id（~/.planofplan/credentials.json 的 key） */
  credRef?: string | null;
  /** adapter 私有参数，如 { region: "cn" } */
  extra: Record<string, string>;
}

export interface AdapterContext {
  plan: PlanConfig;
  now(): number;
  log(msg: string): void;
}

export interface Credential {
  kind: 'bearer';
  value: string;
  /** 来源：manual（credentials.json）| env | auto */
  source: string;
  /** OAuth refresh token supplied by a provider-owned credential store. */
  refreshToken?: string | null;
  /** Previous browser refresh token kept as a one-step fallback after rotation. */
  refreshTokenFallback?: string | null;
  /** WorkOS organization selected by the browser session, when present. */
  organizationId?: string | null;
  /** Browser cookies used by WorkOS when redeeming a browser refresh session. */
  workosCookie?: string | null;
  /** 会话所属 plan slug(factory/kimi 多账号按 slug 隔离浏览器会话链)。 */
  sessionSlug?: string | null;
  /** OAuth access-token expiry, in epoch milliseconds when known. */
  expiresAt?: number | null;
  /** Persist a provider-owned rotated OAuth credential without exposing its storage format to the scheduler. */
  persist?: (credential: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number | null;
  }) => Promise<void> | void;
  /** 部分 provider（Codex）需要 account id 头 */
  accountId?: string | null;
  /** 会话型 provider（Cursor）用完整 Cookie 头鉴权 */
  cookie?: string | null;
}

export interface PlanAdapter {
  slug: string;
  /** 自动检测凭据；无则返回 null（UI/CLI 提示手动配置） */
  detectCredentials(ctx: AdapterContext): Promise<Credential | null>;
  /** 拉取并归一化出多窗口快照 */
  fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]>;
  /** 缺少凭据时的引导文案 */
  credentialHint?: string;
  /**
   * 是否支持手动 API key/token（auth set / dashboard 设置弹窗）。
   * 默认支持（detectCredentials 都先读 credRef），只有确实无法使用静态
   * 凭据的 adapter 才显式置 false。新 adapter 无需改 UI 即自动获得
   * key 配置入口——避免再出现「后端支持、前端漏掉入口」的缺口。
   */
  manualKey?: boolean;
}

export type UsageSource = 'local' | 'official';
export type UsageConfidence = 'measured' | 'official';

/** Normalized token-consumption row. QuotaWindow intentionally does not use this model. */
export interface UsageRecord {
  id: string;
  day: string;
  timestamp: number;
  provider: string;
  model: string;
  sessionId?: string | null;
  project?: string | null;
  sourceFile?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  billableTokens: number | null;
  estimatedCostUsd: number | null;
  source: UsageSource;
  confidence: UsageConfidence;
  fetchedAt?: number;
}

/** Catalog row for one coding-agent session (work-graph M3). Token columns are
 *  a projection of usage_records, not a second ledger. */
export interface SessionRecord {
  id: string;
  provider: string;
  nativeId: string;
  cwd: string | null;
  title: string | null;
  sourceFile: string | null;
  startedAt: number | null;
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  seenAt: number;
  /** Enclosing git root of cwd, when one exists. */
  gitRoot?: string | null;
  /** origin URL, or git root when origin is missing. */
  gitUrl?: string | null;
  /** Display name from origin tail / root basename. */
  gitName?: string | null;
  /** 会话来源归因(session-origin.ts);未标记即真实用户会话。 */
  origin?: SessionOrigin;
  /** codex/claude subagent 的父 session id(provider:<parent_native_id>)。 */
  parentId?: string | null;
  /** 环境型启动方标识(如 `herdr:pane:10`);不进 session_links 边表。 */
  originDetail?: string | null;
  /** 用户数据层(session_user_meta):星标,由读侧联入,不落 sessions 表。 */
  starred?: boolean;
  /** 用户数据层:隐藏,列表默认过滤,「显示已隐藏」时可见。 */
  hidden?: boolean;
  /** 需求文本:从 session_messages 用户消息流抽取(motivation.ts),由读侧附上。 */
  requirement?: string | null;
  /**
   * Multi-dimension git identity for this session.
   * work = cwd walk-up; touch = tool-call paths; commit = git log in the
   * session window. Yarn / requirement project uses touch, not work.
   */
  repos?: SessionRepo[];
  /** 内容搜索（FTS）命中摘要，仅 /api/sessions?q= 时由 server 附上。 */
  messageHit?: SessionMessageHit | null;
}

/** 消息级索引行（session_messages 表）。只存可见文本与 tool_use 入参。 */
export interface SessionMessageRow {
  id: string;
  sessionId: string;
  /** 源文件行号 / part 序号，会话内排序用。 */
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: 'text' | 'tool_use' | 'summary';
  toolName: string | null;
  text: string;
  timestamp: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** 一次内容搜索命中的会话聚合：命中条数 + 最佳片段。snippet 里 \u0001/\u0002 包住命中词。 */
export interface SessionMessageHit {
  sessionId: string;
  count: number;
  snippet: string;
}

/** session_links 表行:session ↔ session 关系边(Launch 实体,§1.4b)。 */
export interface SessionLink {
  /** 被拉起的 session(子)。 */
  fromSession: string;
  /** 发起者 session(父);可能悬空(窗口外/已删),查询侧容忍。 */
  toSession: string;
  /** 首值 'spawned-by'。 */
  kind: string;
  evidenceKind: EvidenceKind;
  createdAt: number;
}

/** /api/sessions/:provider/:id/links 的解析行(带对端 session 摘要)。 */
export interface SessionLinkView {
  sessionId: string;
  evidenceKind: EvidenceKind;
  provider: string | null;
  title: string | null;
  /** true = 对端 session 不在库里(悬空)。 */
  dangling: boolean;
}

/** 计划文件的解析结果(plan 快照的 phases_json 内容)。 */
export interface PlanSection {
  heading: string;
  /** `**Status:** xxx` 行;无则 null。 */
  status: string | null;
  checked: number;
  total: number;
}

/** plan_files 表行(PlanFile 实体,身份 = 文件路径)。 */
export interface PlanFileRecord {
  /** 确定性 id:路径 sha1 前 12 位(与 projects 同款纪律)。 */
  id: string;
  path: string;
  kind: string;
  title: string | null;
  goal: string | null;
  currentPhase: string | null;
  /** 所属 repo(git remote url;无 remote 退 root;非 git 为 null)。 */
  repo: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 文件从磁盘消失的时间;保留行供历史快照查询(thin-observer 同款)。 */
  missingSince: number | null;
  lastSnapshotId: string | null;
  /** 最近快照的 mtime(mtime 门控:未变则跳过重读/重哈希)。 */
  lastSnapshotMtimeMs: number | null;
  lastSnapshotHash: string | null;
}

/** plan_snapshots 表行(append-only;演进态 = 快照序列,不做任务级身份)。 */
export interface PlanSnapshotRecord {
  /** 确定性 id:<planFileId>:<rawHash 前 12>,同内容重捕幂等。 */
  id: string;
  planFileId: string;
  rawHash: string;
  mtimeMs: number;
  /** 捕获时该文件所在 repo 的 HEAD(verified 对账的 git 锚)。 */
  commitSha: string | null;
  sections: PlanSection[];
  checkboxChecked: number;
  checkboxTotal: number;
  currentPhase: string | null;
  capturedAt: number;
}

/** todo_snapshots 表行(TodoWrite/todo_write 消息快照,演进时间序列)。 */
export interface TodoSnapshotRecord {
  id: string;
  sessionId: string;
  seq: number;
  ts: number | null;
  items: Array<{ title: string; status: string }>;
}

/** progress_notes 表行(§5.3 ④:assistant 尾总结,message_inferred 档)。 */
export interface ProgressNoteRecord {
  /** 确定性 id:<session_id>:<seq>。 */
  id: string;
  sessionId: string;
  seq: number;
  ts: number | null;
  text: string;
}

/** requirements 表行(Requirement 实体,§1.5)。 */
export interface RequirementRecord {
  /** 确定性 id:req:<session_id>:<seq>(推断退化实体 seq = -1)。 */
  id: string;
  sessionId: string;
  /** 证据锚点:user 消息 seq;-1 = 无消息锚点(从 title 退化推断)。 */
  seq: number;
  text: string;
  /** v1 两档;user_confirmed / agent_proposed 是 HITL 后话。 */
  originLevel: 'user_explicit' | 'system_inferred';
  ts: number | null;
  /** span 归因到的 repo url(§1.5:证据窗口内实际碰的 repo)。 */
  repos: string[];
  /** LLM 精炼的需求陈述(可选;原话 text 永不被覆盖——合成缓存不替代原始证据)。 */
  refinedText?: string | null;
  /** 精炼尝试时间(空结果也标记,避免反复重试)。 */
  refinedAt?: number | null;
}

/** session_index_state 表行：消息级索引的行级续扫水位。 */
export interface SessionIndexState {
  path: string;
  mtimeMs: number;
  size: number;
  parsedBytes: number;
  lines: number;
  parserVersion: number;
}

/** session_file_touches 表行:一次工具调用对一个文件的触碰。 */
export interface SessionFileTouch {
  id: string;
  sessionId: string;
  provider: string;
  /** 规范化后的绝对路径(能 resolve 的话)。 */
  filePath: string;
  toolName: string;
  /** read / write / edit / search / …(opOfTool 归类)。 */
  op: string;
  ts: number | null;
  ordinal: number;
}

/** /api/files/sessions 的聚合行:一个文件被哪些 session 碰过。 */
export interface FileTouchSession {
  sessionId: string;
  provider: string;
  title: string | null;
  lastTs: number | null;
  touches: number;
  ops: string[];
}

/** session_commits 表行:session ↔ commit 归因。 */
export interface SessionCommit {
  sessionId: string;
  /** repo url,与 session_repos.url 对齐。 */
  repo: string;
  sha: string;
  /** declared = trailer 声明;witnessed = transcript 目击 git commit 输出 sha;candidate = 时间窗推断。 */
  kind: 'declared' | 'witnessed' | 'candidate';
  ts: number | null;
  summary: string;
  /** commit 触碰文件与 session_file_touches 有交集(candidate 里的强信号)。 */
  fileOverlap: boolean;
  /**
   * 是否已推送到远端(以本地 remote-tracking refs 为准)。
   * undefined = 未知(远端查询失败,按已推送处理,维持渲染链接的旧行为)。
   */
  pushed?: boolean;
}

/** projects 表行:一等项目实体,身份 = git remote URL(无 remote 退化为 root path)。 */
export interface Project {
  /** url 的确定性短 hash(sha1 前 12 位,见 db.ts projectEntityId)。 */
  id: string;
  url: string;
  name: string;
  /** 本地主根(session_repos.root 的多数值)。 */
  root: string | null;
  createdAt: number;
  lastSeenAt: number;
}

/** 项目页列表/详情的 agent 分解行。 */
export interface ProjectAgentStat {
  provider: string;
  /** 全部 session 数(含自动化)。 */
  sessions: number;
  /** origin='user' 的 session 数。 */
  userSessions: number;
  /** 非 user(subagent/plugin/exec/herdr)的 session 数。 */
  automatedSessions: number;
  tokens: number;
  lastActive: number | null;
}

export interface ProjectListItem extends Project {
  /** 窗口内 session 数(全部 origin)。 */
  sessionCount: number;
  /** 窗口内 origin='user' 的 session 数。 */
  userSessionCount: number;
  /** 按 sessions 倒排。 */
  agents: ProjectAgentStat[];
  lastActive: number | null;
  commitCount: number;
  /** 预留:窗口内推导需求数(v1 不算,恒 null)。 */
  requirementCount: number | null;
}

export interface ProjectRequirementItem {
  sessionId: string;
  text: string;
  provider: string;
  updatedAt: number;
}

export interface ProjectDetail extends ProjectListItem {
  /** 窗口内 session 时间线(updatedAt 倒排,带 origin/parentId)。 */
  sessions: SessionRecord[];
  /** 窗口内 user session 的推导需求(motivation 抽取)。 */
  requirements: ProjectRequirementItem[];
  /** 窗口内落在该项目的 commit(session_commits where repo = url)。 */
  commits: SessionCommit[];
}

export type GitRole = 'work' | 'touch' | 'commit';
export type EvidenceKind = 'observed' | 'declared' | 'candidate';

/** 会话来源:user=真实用户;subagent=子代理;plugin:claude=被 claude 插件拉起;
 *  exec=脚本化调用(codex_exec/exec);herdr=herdr 窗格关联(启发式)。 */
export type SessionOrigin = 'user' | 'subagent' | 'plugin:claude' | 'exec' | 'herdr';

/** One git repository associated with a session, in a specific role. */
export interface SessionRepo {
  sessionId: string;
  role: GitRole;
  url: string;
  root: string;
  name: string;
  evidenceKind: EvidenceKind;
  firstSeq?: number | null;
}

export interface WorkRequirement {
  id: string;
  sessionId: string;
  text: string;
  provider: string;
  /** Touch-git display name, or '(unmapped)' when the span touched no repo. */
  project: string;
  updatedAt: number;
  /** §1.5 origin 分级(user_explicit / system_inferred),图谱着色用。 */
  originLevel?: string;
}

export interface WorkProject {
  id: string;
  name: string;
  root: string | null;
  url: string | null;
  sessionCount: number;
  providers: string[];
  requirements: WorkRequirement[];
}

export interface WorkNode {
  id: string;
  kind: 'session' | 'project' | 'requirement' | 'commit';
  label: string;
  provider?: string;
  sessionId?: string;
  /** commit 节点专用:与 session 的文件触碰有交集(candidate 里的强信号)。 */
  fileOverlap?: boolean;
  /** requirement 节点专用:§1.5 origin 分级,着色用。 */
  originLevel?: string;
}

export interface WorkEdge {
  from: string;
  to: string;
  kind: 'worked-in' | 'touched' | 'landed-in' | 'in-project' | 'has-requirement';
  /**
   * work/touch filesystem facts are observed. Time-window commit matches are
   * candidate. Commit trailers are declared. Semantic clustering is not written.
   */
  evidenceKind: EvidenceKind;
}

export interface WorkGraph {
  projects: WorkProject[];
  nodes: WorkNode[];
  edges: WorkEdge[];
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
}

export type ResumeKind = 'cli' | 'url' | 'app';

/** Per-provider resume override in ~/.planofplan/config.json → resume.<provider>. */
export interface ResumeOverride {
  kind?: ResumeKind;
  /** CLI path or name. `~` is expanded. Example: ~/.local/bin/claude.sh */
  bin?: string;
  /** Extra argv after the binary; `{id}` is replaced with the native session id. */
  args?: string[];
  /** Extra env for Terminal launch. Prefer a wrapper script over putting secrets here. */
  env?: Record<string, string>;
  /** URL jump; `{id}` and `{cwd}` are interpolated. */
  url?: string;
  /** macOS app name for `open -a`, e.g. ZCode. */
  app?: string;
}

export type ResumeConfig = Record<string, ResumeOverride>;

export interface SessionResume {
  available: boolean;
  command: string | null;
  reason?: string;
  kind?: ResumeKind;
  label?: string;
}

export interface SessionTranscript {
  session: SessionRecord;
  turns: TranscriptTurn[];
  truncated: boolean;
  resume: SessionResume;
}

export interface SessionList {
  generatedAt: number;
  since: number;
  until: number;
  sessions: SessionRecord[];
  byProvider: Array<{ provider: string; count: number }>;
  byProject: Array<{ project: string; count: number }>;
  graph: WorkGraph;
  indexedAt: number | null;
  indexStatus: 'idle' | 'running';
}

export interface UsageScanFile {
  path: string;
  provider: string;
  size: number;
  mtimeMs: number;
  scannedAt: number;
  scannedSince: number;
  parsedBytes: number;
  cursorJson?: string | null;
}

export interface UsageAggregate {
  key: string;
  day?: string;
  provider: string;
  model: string;
  recordCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  billableTokens: number | null;
  estimatedCostUsd: number | null;
  source?: UsageSource;
  confidence?: UsageConfidence;
  lastFetchedAt?: number | null;
}

export interface UsageReport {
  generatedAt: number;
  since: number;
  until: number;
  recordCount: number;
  totals: Omit<UsageAggregate, 'key' | 'day' | 'provider' | 'model' | 'source' | 'confidence' | 'recordCount'> & {
    recordCount: number;
  };
  daily: UsageAggregate[];
  models: UsageAggregate[];
  providers: UsageAggregate[];
  sources: Array<{
    source: UsageSource;
    confidence: UsageConfidence;
    recordCount: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    fetchedAt: number | null;
  }>;
  /** 按 plan 归属的用量汇总（usage provider/model → plan 映射），供 menubar
   * 分页页脚显示当页 provider 的用量；与 totals 同源同缓存。 */
  byPlan: PlanUsageSummary[];
}

export interface PlanUsageSummary {
  plan: string;
  totalTokens: number;
  estimatedCostUsd: number | null;
  topModels: Array<{ model: string; totalTokens: number }>;
  topProjects: Array<{ project: string; totalTokens: number; estimatedCostUsd: number | null }>;
  /** 最近活跃会话（dsh 深链跳转用）；url 仅对有跳转目标的 provider 生成。 */
  recentSessions: Array<{ sessionId: string; timestamp: number; project: string | null; url: string | null }>;
  /** 30 天逐日序列（今日/图表用），按 day 升序。 */
  daily: Array<{ day: string; totalTokens: number; estimatedCostUsd: number | null }>;
}

/** 带错误分类的 adapter 异常，供 scheduler 判定 auth/network/api/parse */
export class AdapterError extends Error {
  constructor(
    public kind: 'auth' | 'network' | 'api' | 'parse' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface PlanStateRow {
  plan_id: string;
  last_success_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  paused_until: number | null;
  auth_status: string;
}

export const AUTH_STATUS = {
  AUTO: 'auto',
  MANUAL: 'manual',
  MISSING: 'missing',
  INVALID: 'invalid',
  UNKNOWN: 'unknown',
} as const;
