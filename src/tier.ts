/**
 * 高峰/低谷（peak/off-peak）时段规则。
 *
 * 背景：DeepSeek 与 GLM 公开计价在「高峰时段」与「空闲时段」不同：
 *   - DeepSeek：每日 09:00-12:00、14:00-18:00（Asia/Shanghai），非高峰半价
 *   - GLM：周一至周五 14:00-18:00（Asia/Shanghai），非高峰按基础积分 50% 抵扣
 *
 * 设计：纯函数 + 静态规则表。`getTier` 只在 `now` 上做无副作用查表，方便测试
 * 与跨进程复用；调度器 / 渲染层各自决定是否启用。
 *
 * 参考：CodexBar / onWatch 自身不在 quota 卡里建模 peak/off-peak，仅在本地
 * 成本估算时考虑时段。详见 docs/codexbar-onwatch-token-consumption-research.md。
 * 唯一一个把「premium 模型消耗倍率（高峰/低谷）」实现出来的开源参考是
 * jukanntenn/glm-plan-usage（见 docs/coding-plan-usage-trackers.md §2.7）。
 */
export type TierName = 'peak' | 'offpeak';

export interface TierState {
  /** 当前时段；规则不覆盖时返回 null（adapter 不打 tier 注解） */
  tier: TierName | null;
  /** 距离下次切换（毫秒）；无法计算（如规则不覆盖）时为 null */
  nextChangeAt: number | null;
  /** 当前费用倍率：peak 默认 1.0，offpeak 默认 0.5；规则不覆盖时为 null */
  multiplier: number | null;
  /** 当前时段人类可读标签；未覆盖时为 null */
  label: string | null;
  /** 规则使用的 IANA 时区（用于 UI 提示） */
  timezone: string | null;
}

interface TimeWindow {
  /** 0=Sunday .. 6=Saturday（与 `new Date().getDay()` 一致） */
  weekdays: ReadonlyArray<number>;
  /** 0-1439：自当天 0 点起的分钟数 */
  startMin: number;
  endMin: number;
}

interface ProviderRule {
  provider: string;
  timezone: string;
  peakWindows: ReadonlyArray<TimeWindow>;
  peakMultiplier: number;
  offpeakMultiplier: number;
  /** 人类可读标签前缀，例如「Asia/Shanghai 高峰」 */
  labelPrefix: string;
}

/** 把 "HH:MM" 解析为 0-1439 的分钟数；非法输入返回 null。 */
function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 24 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

const DEEPSEEK_WINDOWS: ReadonlyArray<TimeWindow> = [
  { weekdays: [0, 1, 2, 3, 4, 5, 6], startMin: parseHHMM('09:00')!, endMin: parseHHMM('12:00')! },
  { weekdays: [0, 1, 2, 3, 4, 5, 6], startMin: parseHHMM('14:00')!, endMin: parseHHMM('18:00')! },
];

const GLM_WINDOWS: ReadonlyArray<TimeWindow> = [
  { weekdays: [1, 2, 3, 4, 5], startMin: parseHHMM('14:00')!, endMin: parseHHMM('18:00')! },
];

const RULES: ReadonlyArray<ProviderRule> = [
  {
    provider: 'deepseek',
    timezone: 'Asia/Shanghai',
    peakWindows: DEEPSEEK_WINDOWS,
    peakMultiplier: 1.0,
    offpeakMultiplier: 0.5,
    labelPrefix: 'DeepSeek',
  },
  {
    provider: 'glm',
    timezone: 'Asia/Shanghai',
    peakWindows: GLM_WINDOWS,
    peakMultiplier: 1.0,
    offpeakMultiplier: 0.5,
    labelPrefix: 'GLM',
  },
];

const RULE_BY_PROVIDER = new Map(RULES.map((rule) => [rule.provider, rule]));

export function knownTierProviders(): string[] {
  return RULES.map((rule) => rule.provider);
}

/** 在测试中可临时替换规则表；不在公共 API 中导出。 */
export function _ruleForTest(provider: string): ProviderRule | undefined {
  return RULE_BY_PROVIDER.get(provider);
}

interface LocalTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  /** 0=Sunday */
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAY_NAME_TO_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** 取 epoch 在指定 IANA 时区的本地时间分量。Asia/Shanghai 这类无 DST 时区结果稳定。 */
export function partsInTimezone(epochMs: number, timezone: string): LocalTime {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  const weekday = WEEKDAY_NAME_TO_INDEX[parts.weekday as string];
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // Intl quirk: '24' for midnight in some locales
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday,
    hour,
    minute: Number(parts.minute),
  };
}

/** 把「指定 IANA 时区的本地 ymd/hm」转换为 epoch 毫秒（两次扫描消除 DST 跳变）。 */
export function epochFromLocal(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMs(guess, timezone);
  const adjusted = guess - offset;
  // 第二次扫描：避开 DST 切换边界上的 ±1h 漂移
  const offset2 = tzOffsetMs(adjusted, timezone);
  return guess - offset2;
}

function tzOffsetMs(epochMs: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - epochMs;
}

function minutesIntoDay(local: LocalTime): number {
  return local.hour * 60 + local.minute;
}

function windowContains(window: TimeWindow, minutes: number, weekday: number): boolean {
  if (!window.weekdays.includes(weekday)) return false;
  if (window.startMin <= window.endMin) {
    return minutes >= window.startMin && minutes < window.endMin;
  }
  // 跨午夜：start > end；目前规则不出现，留位
  return minutes >= window.startMin || minutes < window.endMin;
}

function isPeakAt(rule: ProviderRule, local: LocalTime): boolean {
  const min = minutesIntoDay(local);
  return rule.peakWindows.some((window) => windowContains(window, min, local.weekday));
}

interface CandidateTransition {
  /** epoch 毫秒；绝对值；与 `now` 比较取最小正值 */
  at: number;
  /** 该切换之后落入的时段 */
  to: TierName;
}

/**
 * 枚举当前 local 日期前后 ±1 天内所有窗口边界，返回「先发生的切换」点。
 * 1 天边界已足够覆盖 GLM 周一-周五 14:00 这一情形（周末 offpeak → 周一 14:00 切换），
 * 因为周末两天都没有 peak 窗口，下一切换直接到周一 14:00，距离可能 > 48h，
 * 所以再扩 1 天到下周二 14:00；为简单实现，这里直接扫描未来 8 天。
 */
function nextTransitions(rule: ProviderRule, from: LocalTime, fromEpoch: number): CandidateTransition[] {
  const out: CandidateTransition[] = [];
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const probe = epochFromLocal(rule.timezone, from.year, from.month, from.day, 0, 0) + dayOffset * 86_400_000;
    const parts = partsInTimezone(probe, rule.timezone);
    for (const window of rule.peakWindows) {
      if (!window.weekdays.includes(parts.weekday)) continue;
      const startEpoch = epochFromLocal(rule.timezone, parts.year, parts.month, parts.day, Math.floor(window.startMin / 60), window.startMin % 60);
      const endEpoch = epochFromLocal(rule.timezone, parts.year, parts.month, parts.day, Math.floor(window.endMin / 60), window.endMin % 60);
      out.push({ at: startEpoch, to: 'peak' });
      out.push({ at: endEpoch, to: 'offpeak' });
    }
  }
  return out
    .filter((c) => c.at > fromEpoch)
    .sort((a, b) => a.at - b.at);
}

/**
 * 查询 provider 在 `nowMs` 时的 tier 状态。
 *
 * - provider 规则未注册 → 返回所有字段为 null 的 TierState
 * - `nowMs` 必须为 epoch 毫秒；测试可注入固定值
 */
export function getTier(provider: string, nowMs: number): TierState {
  const rule = RULE_BY_PROVIDER.get(provider);
  if (!rule) {
    return { tier: null, nextChangeAt: null, multiplier: null, label: null, timezone: null };
  }
  const local = partsInTimezone(nowMs, rule.timezone);
  const peak = isPeakAt(rule, local);
  const tier: TierName = peak ? 'peak' : 'offpeak';
  const multiplier = peak ? rule.peakMultiplier : rule.offpeakMultiplier;
  const transitions = nextTransitions(rule, local, nowMs);
  const next = transitions[0] ?? null;
  const nextChangeAt = next?.at ?? null;
  const label = `${rule.labelPrefix} ${peak ? '高峰' : '空闲'}`;
  return { tier, nextChangeAt, multiplier, label, timezone: rule.timezone };
}

/**
 * 给一组 QuotaWindow 打 tier 注解；规则不覆盖的 provider 直接返回原数组（不修改）。
 *
 * 调用方应先确认 `plan.extra.peakPricing === 'true'`，再调用本函数。
 */
export function annotateWindowsWithTier<T extends { window: string }>(
  provider: string,
  windows: T[],
  nowMs: number,
): T[] {
  const tier = getTier(provider, nowMs);
  if (tier.tier == null) return windows;
  return windows.map((w) => {
    if (w.window === 'mcp') return w; // 月度 MCP 用量与时段无关
    return {
      ...w,
      tier: tier.tier,
      tierMultiplier: tier.multiplier,
      tierLabel: tier.label,
      tierNextChangeAt: tier.nextChangeAt,
      tierTimezone: tier.timezone,
    } as T;
  });
}

/** 全局开关：环境变量 `PLANOFPPLAN_TIER_PRICING=0` 关闭。 */
export function isTierPricingEnabled(): boolean {
  const raw = process.env.PLANOFPPLAN_TIER_PRICING;
  if (raw == null) return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/** 每 plan 开关：plan.extra.peakPricing === 'true' 启用。 */
export function planWantsTierPricing(planExtra: Record<string, string> | undefined): boolean {
  return planExtra?.peakPricing === 'true';
}
