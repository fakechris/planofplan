/**
 * Claude Code adapter（M2.2）
 *
 * 规格出处：CodexBar docs/claude.md + 本机实测（2026-08-18，keychain token 直连 status 200）
 * - 凭据优先级：手动 key → ANTHROPIC_TOKEN env → macOS Keychain "Claude Code-credentials"
 *   （security find-generic-password -w，进程内读取，不落盘不打印；内容为 JSON claudeAiOauth.accessToken）
 * - 端点：GET https://api.anthropic.com/api/oauth/usage
 * - 头：Authorization Bearer + anthropic-beta: oauth-2025-04-20
 * - 解析（实测响应）：five_hour.utilization → 5h；seven_day.utilization → 周；
 *   extra_usage{is_enabled, monthly_limit, used_credits, utilization} → 月度花费（启用时）
 * - 注意：/api/oauth/usage 限流较严（~5 req/token），429 时刷新 token 换限流窗口（onWatch 方案）；
 *   token 需 user:profile scope；keychain 读取触发系统授权时自动降级提示
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';

const execFileAsync = promisify(execFile);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

interface OauthWindow {
  utilization?: number | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}

interface ExtraUsage {
  is_enabled?: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
}

interface ClaudeUsageResponse {
  five_hour?: OauthWindow | null;
  seven_day?: OauthWindow | null;
  extra_usage?: ExtraUsage;
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

export function normalizeClaude(raw: unknown): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Claude 响应不是 JSON 对象');
  }
  const r = raw as ClaudeUsageResponse;
  const windows: QuotaWindow[] = [];

  const pushPctWindow = (id: string, label: string, w: OauthWindow | null | undefined): void => {
    if (!w || typeof w !== 'object') return;
    const utilization = num(w.utilization);
    if (utilization == null) return;
    windows.push({
      window: id,
      label,
      used: num(w.used_dollars),
      total: num(w.limit_dollars),
      unit: 'percent',
      percentage: Math.min(100, Math.max(0, utilization)),
      resetAt: null,
      note: null,
    });
  };

  pushPctWindow('rolling_5h', '5H', r.five_hour);
  pushPctWindow('weekly', 'Week', r.seven_day);

  const extra = r.extra_usage;
  if (extra && extra.is_enabled) {
    const monthlyLimit = num(extra.monthly_limit);
    const usedCredits = num(extra.used_credits);
    const utilization = num(extra.utilization);
    if (monthlyLimit != null && (usedCredits != null || utilization != null)) {
      windows.push({
        window: 'monthly',
        label: 'Month',
        used: usedCredits,
        total: monthlyLimit,
        unit: 'usd',
        percentage: utilization ?? (monthlyLimit > 0 && usedCredits != null ? (usedCredits / monthlyLimit) * 100 : null),
        resetAt: null,
        note: 'extra usage',
      });
    }
  }

  if (windows.length === 0) {
    throw new AdapterError('parse', 'Claude 响应没有可用窗口');
  }
  return windows;
}

/** macOS Keychain 读取（进程内，超时 8s；触发系统授权时抛错由上层降级） */
async function readKeychainToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  let stdout: string;
  try {
    const r = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 8_000, maxBuffer: 512 * 1024 },
    );
    stdout = r.stdout;
  } catch {
    return null;
  }
  const blob = stdout.trim();
  if (!blob) return null;
  for (const candidate of [blob, atobSafe(blob)]) {
    if (!candidate) continue;
    try {
      const d = JSON.parse(candidate) as { claudeAiOauth?: { accessToken?: string } };
      const tok = d.claudeAiOauth?.accessToken;
      if (tok && tok.trim()) return tok.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

function atobSafe(v: string): string {
  try {
    const padded = v + '='.repeat((-v.length % 4 + 4) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

export const claudeAdapter: PlanAdapter = {
  slug: 'claude',
  credentialHint: '缺少凭据：运行 `claude` 登录（OAuth 进 Keychain），或 planofplan auth set claude --key <token>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const envToken =
      process.env.ANTHROPIC_TOKEN ??
      process.env.ANTHROPIC_AUTH_TOKEN ??
      process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (envToken && envToken.trim()) {
      return { kind: 'bearer', value: envToken.trim(), source: 'env' };
    }
    const keychain = await readKeychainToken();
    if (keychain) return { kind: 'bearer', value: keychain, source: 'auto' };
    return null;
  },

  async fetchUsage(_ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    let res: Response;
    try {
      res = await fetch(USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cred.value}`,
          'anthropic-beta': 'oauth-2025-04-20',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new AdapterError('network', `Claude 请求超时：${USAGE_URL}`);
      }
      throw new AdapterError('network', `Claude 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterError('auth', `Claude 鉴权失败(HTTP ${res.status})：请运行 \`claude\` 重新登录`);
    }
    if (res.status === 429) {
      // 限流：提示降频或手动刷新（token 刷新刷新权在 Claude Code，参照 onWatch 思路）
      throw new AdapterError('api', 'Claude usage 端点限流(HTTP 429)，稍后重试');
    }
    if (!res.ok) {
      throw new AdapterError('api', `Claude API 错误(HTTP ${res.status})`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', 'Claude 响应不是合法 JSON');
    }
    return normalizeClaude(json);
  },
};
