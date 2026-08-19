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

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const REQUEST_TIMEOUT_MS = 10_000;

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
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

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * 把 DeepSeek 余额响应归一为单个 credits_period 窗口。
 * DeepSeek 没有 5h/周/月多窗口，余额是单一额度；used = total - available。
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
  // 多币种账户：选第一笔；其余附在 note 字段，便于调试。
  const first = infos[0]!;
  const total = num(first.total_balance);
  const available = num(first.available_balance);
  if (total == null || available == null) {
    throw new AdapterError('parse', 'DeepSeek 余额字段缺失（total_balance / available_balance）');
  }
  const usedRaw = total - available;
  const used = Math.max(0, usedRaw);
  const percentage = total > 0
    ? Math.min(100, Math.max(0, (used / total) * 100))
    : 0;
  const currency = first.currency ?? 'CNY';
  const extra = infos.length > 1 ? `（共 ${infos.length} 个币种账户）` : '';
  return {
    window: {
      window: 'credits_period',
      label: 'Balance',
      used: round(used),
      total: round(total),
      unit: 'usd',
      percentage: Math.round(percentage * 10) / 10,
      resetAt: null,
      note: `${currency}  可用 ${available}${extra}`,
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
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', 'DeepSeek 余额响应不是合法 JSON');
    }
    const { window } = normalizeDeepseekBalance(json);
    return [window];
  },
};
