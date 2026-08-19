/**
 * z.ai / GLM Coding Plan adapter（M2.1，M2.5 对齐 opencode-quota）
 *
 * GLM Coding Plan：用 API key 自动尝试 z.ai 与 BigModel quota host，
 * 不要求用户区分 legacy/current 或手动选择 region。
 *
 * 规格出处：CodexBar docs/zai.md + ZaiProviderDescriptor.swift + opencode-quota glm-coding-plan.ts
 * - 端点：GET {host}/api/monitor/usage/quota/limit（cn: open.bigmodel.cn / bigmodel.cn；global: api.z.ai）
 * - 头：Authorization: <token>（onWatch）或 Bearer <token>（CodexBar）+ accept: application/json
 * - token 源（cn）：Z_AI_API_KEY/ZAI_API_KEY → BIGMODEL_API_KEY/ZHIPU_API_KEY/ZHIPUAI_API_KEY/GLM_API_KEY
 *   → relay 文件 ~/.coding-relay/glm-api-key / ~/.config/bigmodel/api_key / ~/.config/zhipu/api_key
 *   （global 只认 Z_AI_API_KEY/ZAI_API_KEY，BigModel 别名不用于 global 路由）
 * - 解析：data.limits[] TOKENS_LIMIT 按 unit（3=5h / 6=周，与 opencode-quota 判定一致，
 *   缺 unit 时退回按 nextResetTime 长短分类）为主/周窗口、TIME_LIMIT 为 MCP 通道；
 *   percentage 为【已用 %】（剩余 = 100 - percentage，opencode-quota 同语义，超界钳制 0-100）；
 *   nextResetTime(epoch ms) → 重置时间；data.planName/level/plan → 套餐名
 * - team 需 Bigmodel-Organization/Bigmodel-Project 头 + type=2（本实现预留 extra.orgId/projId）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';

const LIMIT_PATH = '/api/monitor/usage/quota/limit';

function hostsFor(): string[] {
  return ['https://api.z.ai', 'https://open.bigmodel.cn', 'https://bigmodel.cn'];
}

function quotaUrls(plan: AdapterContext['plan']): string[] {
  const env = process.env;
  const override = env.Z_AI_QUOTA_URL ?? plan.extra.quotaUrl;
  if (override) {
    if (!/^https:\/\//.test(override)) {
      throw new AdapterError('api', 'GLM quota URL 覆写必须为 https');
    }
    return [override];
  }
  const hostOverride = env.Z_AI_API_HOST ?? plan.extra.host;
  const hosts = hostOverride ? [hostOverride] : hostsFor();
  return [...new Set(hosts.map((h) => h.replace(/\/+$/, '') + LIMIT_PATH))];
}

interface LimitEntry {
  type?: string;
  unit?: number;
  percentage?: number;
  nextResetTime?: number;
  used?: number;
  total?: number;
  windowName?: string;
}

interface GlmResponse {
  code?: number;
  msg?: string;
  data?: {
    limits?: LimitEntry[];
    planName?: string;
    plan?: string;
    plan_type?: string;
    packageName?: string;
    level?: string;
  };
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function now(): number {
  return Date.now();
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

export function glmAuthorizationHeaders(
  apiKey: string,
  preferred: 'bearer' | 'raw' = 'bearer',
): string[] {
  const bearer = `Bearer ${apiKey}`;
  return preferred === 'raw' ? [apiKey, bearer] : [bearer, apiKey];
}

export function normalizeGlm(
  raw: unknown,
  at: number,
  opts: { percentageIsRemaining?: boolean } = {},
): { windows: QuotaWindow[]; planName?: string } {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'GLM 响应不是 JSON 对象');
  }
  const root = raw as GlmResponse;
  const code = num(root.code);
  // 业务码：0 或 200 视为成功（JinHanAI 示例 code:200）
  if (code != null && code !== 0 && code !== 200) {
    const message = String(root.msg ?? '') || `code ${code}`;
    if (/login|authorization|token|api[ -]?key/i.test(message) || code === 401) {
      throw new AdapterError('auth', `GLM 鉴权失败(${code}): ${message}`);
    }
    throw new AdapterError('api', `GLM API 错误(${code}): ${message}`);
  }
  const data = root.data;
  if (data == null || typeof data !== 'object') {
    throw new AdapterError('parse', 'GLM 响应缺少 data（团队用量需 Bigmodel-Organization/Project 头）');
  }
  const limits = Array.isArray(data.limits) ? data.limits : [];
  if (limits.length === 0) {
    throw new AdapterError('parse', 'GLM 响应 limits 为空（可能套餐已过期或 team 头缺失）');
  }

  const tokensLimits = limits
    .filter((l) => l && typeof l === 'object' && l.type === 'TOKENS_LIMIT')
    .map((l) => ({ ...l, remainingMs: (num(l.nextResetTime) ?? Number.POSITIVE_INFINITY) - at }))
    .sort((a, b) => a.remainingMs - b.remainingMs); // 先按长短排，unit 缺失时的兜底

  const percentageIsRemaining = opts.percentageIsRemaining === true;

  const windows: QuotaWindow[] = [];
  tokensLimits.forEach((l, i) => {
    const pct = num(l.percentage);
    if (pct == null) return;
    const used = clampPct(percentageIsRemaining ? 100 - pct : pct);
    const resetAt = num(l.nextResetTime);
    // opencode-quota 判定：TOKENS_LIMIT unit=3 → 5h、unit=6 → 周；缺 unit 退回按时长分类
    const unit = num(l.unit);
    const is5h = unit === 3 || (unit == null && i === 0);
    const label = (typeof l.windowName === 'string' && l.windowName) || (is5h ? '5H' : 'Week');
    windows.push({
      window: is5h ? 'rolling_5h' : 'weekly',
      label,
      used: num(l.used),
      total: num(l.total),
      unit: 'percent',
      percentage: used,
      resetAt: resetAt != null && resetAt > 0 ? resetAt : null,
      note: null,
    });
  });

  for (const l of limits) {
    if (l && typeof l === 'object' && l.type === 'TIME_LIMIT') {
      const pct = num(l.percentage);
      if (pct == null) continue;
      const used = clampPct(percentageIsRemaining ? 100 - pct : pct);
      const resetAt = num(l.nextResetTime);
      windows.push({
        window: 'mcp',
        label: 'MCP',
        used: num(l.used),
        total: num(l.total),
        unit: 'percent',
        percentage: used,
        resetAt: resetAt != null && resetAt > 0 ? resetAt : null,
        note: null,
      });
    }
  }

  if (windows.length === 0) {
    throw new AdapterError('parse', 'GLM 响应没有可用的限额窗口');
  }

  const planName =
    data.planName ?? data.plan ?? data.plan_type ?? data.packageName ?? data.level ?? undefined;

  return { windows, planName };
}

function readRelayKeys(): string[] {
  const candidates = [
    join(homedir(), '.coding-relay', 'glm-api-key'),
    join(homedir(), '.config', 'bigmodel', 'api_key'),
    join(homedir(), '.config', 'zhipu', 'api_key'),
  ];
  const out: string[] = [];
  for (const f of candidates) {
    try {
      if (existsSync(f)) {
        const v = readFileSync(f, 'utf8').trim();
        if (v) out.push(v);
      }
    } catch {
      /* ignore unreadable relay 文件 */
    }
  }
  return out;
}

function cnEnvKey(): string | null {
  for (const k of ['ZAI_API_KEY', 'BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY']) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

export const glmAdapter: PlanAdapter = {
  slug: 'glm',
  credentialHint:
    '缺少凭据：设置 Z_AI_API_KEY / ZAI_API_KEY / BIGMODEL_API_KEY，或运行 planofplan auth set <slug> --key <key>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const zKey = process.env.Z_AI_API_KEY?.trim() || process.env.ZAI_API_KEY?.trim();
    if (zKey) return { kind: 'bearer', value: zKey, source: 'env' };
    const cnKey = cnEnvKey();
    if (cnKey) return { kind: 'bearer', value: cnKey, source: 'env' };
    const relay = readRelayKeys()[0];
    if (relay) return { kind: 'bearer', value: relay, source: 'auto' };
    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    const urls = quotaUrls(ctx.plan);
    // CodexBar 使用 Bearer；onWatch 使用原始 API key。两者都是真实客户端，
    // 对 401/业务鉴权错误自动尝试另一种头格式。
    const authHeaders = glmAuthorizationHeaders(
      cred.value,
      ctx.plan.extra.authHeader === 'raw' ? 'raw' : 'bearer',
    );

    let lastErr: Error | null = null;
    for (const url of urls) {
      for (const authorization of authHeaders) {
        const headers: Record<string, string> = {
          Authorization: authorization,
          accept: 'application/json',
        };
        // team 模式预留：extra.orgId + extra.projId → Bigmodel 头 + type=2；M2 暂不启用
        if (ctx.plan.extra.orgId && ctx.plan.extra.projId) {
          headers['Bigmodel-Organization'] = ctx.plan.extra.orgId;
          headers['Bigmodel-Project'] = ctx.plan.extra.projId;
        }

        let res: Response;
        try {
          res = await fetch(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10_000),
          });
        } catch (e) {
          if (e instanceof Error && e.name === 'TimeoutError') {
            lastErr = new AdapterError('network', `GLM 请求超时：${url}`);
          } else {
            lastErr = new AdapterError(
              'network',
              `GLM 网络错误：${String(e instanceof Error ? e.message : e)}`,
            );
          }
          break; // 网络错误与鉴权头无关，尝试下一个 host
        }

        if (res.status === 401 || res.status === 403) {
          lastErr = new AdapterError('auth', `GLM 鉴权失败(HTTP ${res.status})：请检查 API Key`);
          continue; // 尝试另一种 Authorization 格式
        }
        if (!res.ok) {
          if (res.status === 429) throw new AdapterError('api', 'GLM 请求被限流(HTTP 429)');
          lastErr = new AdapterError('api', `GLM API 错误(HTTP ${res.status})`);
          break; // 非鉴权错误换下一个 host
        }

        let json: unknown;
        try {
          json = await res.json();
        } catch {
          lastErr = new AdapterError('parse', `GLM 响应不是合法 JSON：${url}`);
          break;
        }
        try {
          return normalizeGlm(json, now(), {
            percentageIsRemaining: ctx.plan.extra.percentageIsRemaining === 'true',
          }).windows;
        } catch (error) {
          if (error instanceof AdapterError && error.kind === 'auth') {
            lastErr = error;
            continue; // onWatch 可能返回 HTTP 200 + code=401
          }
          throw error;
        }
      }
    }
    throw lastErr ?? new AdapterError('api', 'GLM 无可用 host');
  },
};
