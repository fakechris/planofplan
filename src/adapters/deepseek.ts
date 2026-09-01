/**
 * DeepSeek adapter。
 *
 * CodexBar / opencode-quota 对 DeepSeek 都只做「API key → 余额端点」一件事，
 * 本地 JSONL 消耗走 dsh harness 的 ~/.dsh/sessions，由 src/usage.ts 的
 * scanDshLogs 统一进 Usage & Spend 报表（docs/more-provider-token-usage-research.md:142-157
 * 与 docs/codexbar-onwatch-token-consumption-research.md:108-114 的结论一致）。
 *
 * 端点：GET https://api.deepseek.com/user/balance
 * 鉴权：Authorization: Bearer <DEEPSEEK_API_KEY>
 * 响应：{ is_available, balance_infos: [{ currency, total_balance,
 *   granted_balance, topped_up_balance, available_balance }] }
 *
 * 高峰/低谷注解：与 GLM 一致由 src/tier.ts 中心化在 core.ts buildPlanOverview
 * 处理；本 adapter 只负责返回原始余额窗口。
 */
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { formatMoney, round2 } from './util.ts';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const REQUEST_TIMEOUT_MS = 10_000;

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
  /** Optional — DeepSeek returns this on some account types but not others. */
  available_balance?: string;
}

interface BalanceResponse {
  is_available?: boolean;
  balance_infos?: BalanceInfo[];
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 把 DeepSeek 余额响应归一为单个 credits_period 窗口。
 *
 * /user/balance 只返回 5 个字段：is_available / currency / total_balance /
 * granted_balance / topped_up_balance（api-docs.deepseek.com/api/get-user-balance）；
 * 历史 cost/API requests/tokens 只在 web 仪表盘展示，公开 API 不暴露。
 * DeepSeek 是预付费余额账户，没有 used/total 比例概念，故不计算 percentage。
 *
 * available = available_balance（部分账号类型返回）→ 兜底 granted + topped_up
 *             → 兜底 total_balance。多个币种账户时只展示第一个，其余附在 note。
 */
export function normalizeDeepseekBalance(
  raw: unknown,
): { window: QuotaWindow; planName?: string } {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'DeepSeek 余额响应不是 JSON 对象');
  }
  const body = raw as BalanceResponse;
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  if (infos.length === 0) {
    throw new AdapterError('parse', 'DeepSeek 余额响应 balance_infos 为空');
  }
  const first = infos[0]!;
  const total = num(first.total_balance);
  const granted = num(first.granted_balance);
  const toppedUp = num(first.topped_up_balance);
  // available_balance 部分账号类型不返回；fallback 到 granted + topped_up，
  // 再不行就用 total（账户里全是可用余额）。
  const available =
    num(first.available_balance) ??
    (granted != null && toppedUp != null ? granted + toppedUp : null) ??
    total;
  if (total == null || available == null) {
    throw new AdapterError('parse', 'DeepSeek 余额字段缺失（total_balance）');
  }
  const currency = (first.currency ?? 'CNY').toUpperCase();
  // note 把 granted / topped_up 拆开，UI 直接念出账户余额结构。
  // 多币种账户时其余的也列在末尾，便于排查。
  const parts: string[] = [];
  if (granted != null) parts.push(`赠额 ${formatMoney(granted, currency)}`);
  if (toppedUp != null) parts.push(`充值 ${formatMoney(toppedUp, currency)}`);
  if (infos.length > 1) parts.push(`共 ${infos.length} 个币种账户`);
  const note = parts.length > 0 ? parts.join(' · ') : null;
  return {
    window: {
      window: 'credits_period',
      label: 'Balance',
      // 余额型 provider：used/total 设成同一个数值，UI 在 percentage=null
      // 时只显示一个金额；percentage 显式 null，不当配额百分比算。
      used: round2(available),
      total: round2(available),
      unit: currency,
      percentage: null,
      resetAt: null,
      note,
    },
    planName: currency,
  };
}

export const deepseekAdapter: PlanAdapter = {
  slug: 'deepseek',
  credentialHint:
    '缺少凭据：设置 DEEPSEEK_API_KEY 或 planofplan auth set deepseek --key <key>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const env = process.env.DEEPSEEK_API_KEY?.trim();
    if (env) return { kind: 'bearer', value: env, source: 'env' };
    return null;
  },

  async fetchUsage(_ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    const res = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.value}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      throw new AdapterError('auth', `DeepSeek 鉴权失败(HTTP ${res.status})：请检查 API Key`);
    }
    if (!res.ok) {
      throw new AdapterError('api', `DeepSeek API 错误(HTTP ${res.status})`);
    }
    // 先取 text 再 parse:失败时把响应体前缀带进错误信息——瞬时非 JSON
    // 多为代理/拦截页注入(实测 200+HTML),有前缀才能区分真因
    let json: unknown;
    const body = await res.text();
    try {
      json = JSON.parse(body);
    } catch {
      const preview = body.replace(/\s+/g, ' ').slice(0, 80);
      throw new AdapterError('parse', `DeepSeek 余额响应不是合法 JSON:${preview || '(空响应)'}`);
    }
    const { window } = normalizeDeepseekBalance(json);
    return [window];
  },
};
