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
}

export interface PlanAdapter {
  slug: string;
  /** 自动检测凭据；无则返回 null（UI/CLI 提示手动配置） */
  detectCredentials(ctx: AdapterContext): Promise<Credential | null>;
  /** 拉取并归一化出多窗口快照 */
  fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]>;
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
