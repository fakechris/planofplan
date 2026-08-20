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
  /** 计量单位 */
  unit: 'percent' | 'requests' | 'credits' | 'prompts' | 'tokens' | 'usd';
  /** 已用百分比 0-100；未知为 null */
  percentage: number | null;
  /** 重置时间 epoch ms；未知为 null */
  resetAt: number | null;
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
}

export interface WorkRequirement {
  id: string;
  sessionId: string;
  text: string;
  provider: string;
  project: string;
  updatedAt: number;
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
  kind: 'session' | 'project' | 'requirement';
  label: string;
  provider?: string;
  sessionId?: string;
}

export interface WorkEdge {
  from: string;
  to: string;
  kind: 'in-project' | 'has-requirement';
  /** Filesystem / log observation. Semantic links stay candidate and are not written here. */
  evidenceKind: 'observed';
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
