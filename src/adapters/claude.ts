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
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

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

interface ClaudeOAuthRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes?: string[];
}

function parseClaudeOAuthRecord(value: string): ClaudeOAuthRecord | null {
  for (const candidate of [value, atobSafe(value)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as {
        claudeAiOauth?: {
          accessToken?: unknown;
          refreshToken?: unknown;
          expiresAt?: unknown;
          scopes?: unknown;
        };
      };
      const oauth = parsed.claudeAiOauth;
      if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) continue;
      return {
        accessToken: oauth.accessToken.trim(),
        refreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken ? oauth.refreshToken : null,
        expiresAt: typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
        scopes: Array.isArray(oauth.scopes)
          ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string')
          : undefined,
      };
    } catch {
      /* try the next supported Keychain encoding */
    }
  }
  return null;
}

/** macOS Keychain 读取（进程内，超时 8s；触发系统授权时抛错由上层降级） */
async function readKeychainCredential(): Promise<Credential | null> {
  if (process.platform !== 'darwin') return null;
  let stdout: string;
  try {
    const r = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 8_000, maxBuffer: 512 * 1024 },
    );
    stdout = r.stdout;
  } catch {
    return null;
  }
  const blob = stdout.trim();
  if (!blob) return null;
  const record = parseClaudeOAuthRecord(blob);
  if (!record) return null;
  return {
    kind: 'bearer',
    value: record.accessToken,
    source: 'auto',
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    persist: async (next) => {
      const payload = JSON.stringify({
        claudeAiOauth: {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: next.expiresAt ?? Date.now() + 8 * 60 * 60 * 1000,
          ...(record.scopes ? { scopes: record.scopes } : {}),
        },
      });
      await execFileAsync(
        'security',
        [
          'add-generic-password',
          '-U',
          '-a',
          process.env.USER ?? '',
          '-s',
          KEYCHAIN_SERVICE,
          '-w',
          payload,
        ],
        { timeout: 8_000, maxBuffer: 64 * 1024 },
      );
    },
  };
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
      return {
        kind: 'bearer',
        value: envToken.trim(),
        source: 'env',
        refreshToken: process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN?.trim() || null,
      };
    }
    return readKeychainCredential();
  },

  async fetchUsage(_ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    let activeToken = cred.value;
    const refresh = async (): Promise<boolean> => {
      if (!cred.refreshToken) return false;
      let res: Response;
      try {
        const endpoint = process.env.CLAUDE_OAUTH_TOKEN_URL?.trim() || OAUTH_TOKEN_URL;
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            client_id: process.env.CLAUDE_OAUTH_CLIENT_ID?.trim() || CLAUDE_OAUTH_CLIENT_ID,
          }).toString(),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        return false;
      }
      if (!res.ok) return false;
      try {
        const json = (await res.json()) as {
          access_token?: unknown;
          refresh_token?: unknown;
          expires_in?: unknown;
        };
        if (typeof json.access_token !== 'string' || !json.access_token) return false;
        activeToken = json.access_token;
        const rotatedRefresh =
          typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : cred.refreshToken;
        const expiresIn =
          typeof json.expires_in === 'number'
            ? Number.isFinite(json.expires_in)
              ? json.expires_in
              : null
            : typeof json.expires_in === 'string'
              ? Number.isFinite(Number(json.expires_in))
                ? Number(json.expires_in)
                : null
              : null;
        const expiresAt = expiresIn == null ? null : Date.now() + expiresIn * 1000;
        cred.value = activeToken;
        cred.refreshToken = rotatedRefresh;
        cred.expiresAt = expiresAt;
        try {
          await cred.persist?.({ accessToken: activeToken, refreshToken: rotatedRefresh, expiresAt });
        } catch {
          // A temporary Keychain lock must not discard a valid access token for this poll.
        }
        return true;
      } catch {
        return false;
      }
    };

    if (cred.expiresAt != null && cred.expiresAt <= Date.now() + 60_000) {
      await refresh();
    }

    const requestUsage = async (): Promise<Response> => {
      try {
        return await fetch(USAGE_URL, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${activeToken}`,
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
    };

    let res = await requestUsage();
    if ((res.status === 401 || res.status === 403 || res.status === 429) && (await refresh())) {
      res = await requestUsage();
    }
    if (res.status === 401 || res.status === 403) {
      throw new AdapterError(
        'auth',
        `Claude OAuth token 被拒绝(HTTP ${res.status})：请运行 \`claude\` 触发凭据刷新后重试`,
      );
    }
    if (res.status === 429) throw new AdapterError('api', 'Claude usage 端点限流(HTTP 429)，稍后重试');
    if (!res.ok) throw new AdapterError('api', `Claude API 错误(HTTP ${res.status})`);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', 'Claude 响应不是合法 JSON');
    }
    return normalizeClaude(json);
  },
};
