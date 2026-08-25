/**
 * OpenAI Codex adapter（M2.2）
 *
 * 规格出处：CodexBar docs/codex.md + docs/codex-oauth.md（源码级）
 * - 凭据：~/.codex/auth.json（或 $CODEX_HOME/auth.json）→ tokens.access_token + account_id；
 *   token 刷新归 Codex CLI 所有，本 adapter 只读不刷新（过期时提示运行 `codex` 重新登录）
 * - 端点：GET https://chatgpt.com/backend-api/wham/usage
 * - 头：Authorization: Bearer <token>；ChatGPT-Account-Id: <account_id>；User-Agent
 * - 响应：rate_limit.primary_window/secondary_window(used_percent, reset_at 秒,
 *   limit_window_seconds；实际窗口以该字段为准) + credits(has_credits/unlimited/balance) + plan_type
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { clampPct } from './util.ts';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

interface AuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
    id_token?: string;
  };
}

function readAuthFile(): AuthFile {
  const file = join(codexHome(), 'auth.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AuthFile;
  } catch {
    return {};
  }
}

/** JWT exp 校验（不解析内容，只看过期时间）；无效返回 null */
function jwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload + '='.repeat((-payload.length % 4 + 4) % 4);
    const data = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as { exp?: number };
    return typeof data.exp === 'number' ? data.exp * 1000 : null;
  } catch {
    return null;
  }
}

interface WindowPayload {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
}

interface UsagePayload {
  plan_type?: string;
  rate_limit?: {
    primary_window?: WindowPayload;
    secondary_window?: WindowPayload;
    additional_rate_limits?: Array<{ used_percent?: number; reset_at?: number }>;
  };
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number | null;
  };
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

export function normalizeCodex(raw: unknown): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Codex 响应不是 JSON 对象');
  }
  const root = raw as UsagePayload;
  const windows: QuotaWindow[] = [];

  const pushWindow = (
    fallbackId: string,
    fallbackLabel: string,
    w: WindowPayload | undefined,
    classifyDuration = true,
  ): void => {
    if (!w || typeof w !== 'object') return;
    const usedPercent = num(w.used_percent);
    if (usedPercent == null) return;
    const duration = num(w.limit_window_seconds);
    const isFiveHour = classifyDuration && duration != null
      ? duration <= 6 * 60 * 60
      : fallbackId === 'rolling_5h';
    const id = classifyDuration ? (isFiveHour ? 'rolling_5h' : 'weekly') : fallbackId;
    const label = classifyDuration ? (isFiveHour ? '5小时限额' : '周限额') : fallbackLabel;
    const resetSec = num(w.reset_at);
    windows.push({
      window: id,
      label,
      used: null, // 接口只给百分比
      total: null,
      unit: 'percent',
      percentage: clampPct(usedPercent),
      resetAt: resetSec != null ? resetSec * 1000 : null,
      note: null,
    });
  };

  pushWindow('rolling_5h', '5小时限额', root.rate_limit?.primary_window);
  pushWindow('weekly', '周限额', root.rate_limit?.secondary_window);

  // 附加窗口两种形态:
  // 1) 旧扁平 {used_percent, reset_at}
  // 2) 2026-08 新嵌套 {limit_name: "GPT-5.3-Codex-Spark", rate_limit:
  //    {primary_window(5h), secondary_window(周)}}——prolite 套餐的 5h
  //    限额搬到了这里(顶层 primary 变成周限额),不解析它 5h 窗口就丢了
  let extraIdx = 0;
  for (const extra of root.rate_limit?.additional_rate_limits ?? []) {
    if (!extra || typeof extra !== 'object') continue;
    const entry = extra as {
      used_percent?: number; reset_at?: number; limit_window_seconds?: number;
      limit_name?: string;
      rate_limit?: { primary_window?: WindowPayload; secondary_window?: WindowPayload };
    };
    const shortName = typeof entry.limit_name === 'string' && entry.limit_name
      ? entry.limit_name.split('-').filter(Boolean).pop() ?? entry.limit_name
      : null;
    if (entry.rate_limit && typeof entry.rate_limit === 'object') {
      const nested: Array<[string, WindowPayload | undefined]> = [
        ['rolling_5h', entry.rate_limit.primary_window],
        ['weekly', entry.rate_limit.secondary_window],
      ];
      for (const [fallbackId, payload] of nested) {
        if (!payload || typeof payload !== 'object') continue;
        const usedPercent = num(payload.used_percent);
        if (usedPercent == null) continue;
        const duration = num(payload.limit_window_seconds);
        const isFiveHour = duration != null
          ? duration <= 6 * 60 * 60
          : fallbackId === 'rolling_5h';
        extraIdx += 1;
        windows.push({
          window: `extra_${isFiveHour ? '5h' : 'weekly'}`,
          label: shortName ? `${shortName}·${isFiveHour ? '5h' : '周'}限额` : `Extra${extraIdx}`,
          used: null,
          total: null,
          unit: 'percent',
          percentage: clampPct(usedPercent),
          resetAt: num(payload.reset_at) != null ? num(payload.reset_at)! * 1000 : null,
          note: null,
        });
      }
      continue;
    }
    const usedPercent = num(entry.used_percent);
    if (usedPercent == null) continue;
    extraIdx += 1;
    pushWindow('extra', `Extra${extraIdx}`, entry, false);
  }

  // credits：余额信息（无窗口百分比）
  const credits = root.credits;
  if (credits && credits.has_credits) {
    const balance = num(credits.balance);
    windows.push({
      window: 'credits',
      label: 'Credits',
      used: balance,
      total: null,
      unit: 'usd',
      percentage: null,
      resetAt: null,
      note: credits.unlimited ? '不限量' : balance != null ? `余额 $${balance}` : null,
    });
  }

  if (windows.length === 0) {
    throw new AdapterError('parse', 'Codex 响应没有可用窗口');
  }
  return windows;
}

export const codexAdapter: PlanAdapter = {
  slug: 'codex',
  credentialHint: '缺少凭据：运行 `codex` 登录，或 planofplan auth set codex --key <token>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const envToken = process.env.CODEX_TOKEN;
    if (envToken && envToken.trim()) {
      return { kind: 'bearer', value: envToken.trim(), source: 'env' };
    }
    const auth = readAuthFile();
    const token = auth.tokens?.access_token;
    if (!token) return null;
    return {
      kind: 'bearer',
      value: token,
      accountId: auth.tokens?.account_id ?? null,
      source: 'auto',
    };
  },

  async fetchUsage(_ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    // 过期预检：token 刷新归 Codex CLI 所有，过期时引导用户重新登录
    const exp = jwtExp(cred.value);
    if (exp != null && exp < Date.now() + 60_000) {
      throw new AdapterError('auth', 'Codex OAuth token 已过期：请运行 `codex` 重新登录后重试');
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.value}`,
      accept: 'application/json',
      'user-agent': cred.source === 'manual' ? 'planofplan' : 'codex-cli',
    };
    if (cred.accountId) headers['ChatGPT-Account-Id'] = cred.accountId;

    let res: Response;
    try {
      res = await fetch(USAGE_URL, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new AdapterError('network', `Codex 请求超时：${USAGE_URL}`);
      }
      throw new AdapterError('network', `Codex 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterError('auth', `Codex 鉴权失败(HTTP ${res.status})：请运行 \`codex\` 重新登录`);
    }
    if (!res.ok) {
      if (res.status === 429) throw new AdapterError('api', 'Codex 请求被限流(HTTP 429)');
      throw new AdapterError('api', `Codex API 错误(HTTP ${res.status})`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', 'Codex 响应不是合法 JSON');
    }
    return normalizeCodex(json);
  },
};
