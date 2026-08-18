/**
 * z.ai / GLM Coding Plan adapter（M2.1）
 *
 * 同时覆盖「GLM legacy（智谱 BigModel CN，早期单 5h 窗口）」与「GLM current（周+5h+MCP）」：
 * 同一端点家族，靠 extra.region 区分 host 与可用 token 源。
 *
 * 规格出处：CodexBar docs/zai.md
 * - 端点：GET {host}/api/monitor/usage/quota/limit（cn: open.bigmodel.cn；global: api.z.ai）
 * - 头：Authorization: Bearer <token> + accept: application/json
 * - token 源（cn）：Z_AI_API_KEY → BIGMODEL_API_KEY/ZHIPU_API_KEY/ZHIPUAI_API_KEY/GLM_API_KEY
 *   → relay 文件 ~/.coding-relay/glm-api-key / ~/.config/bigmodel/api_key / ~/.config/zhipu/api_key
 *   （global 只认 Z_AI_API_KEY，BigModel 别名不用于 global 路由）
 * - 解析：data.limits[] 取最短 TOKENS_LIMIT（5h）为主窗口、较长 TOKENS_LIMIT 为周窗口、
 *   TIME_LIMIT 为 MCP 通道；nextResetTime(epoch ms) → 重置时间；data.planName/level/plan → 套餐名
 * - team 需 Bigmodel-Organization/Bigmodel-Project 头 + type=2（本实现预留 extra.orgId/projId）
 *
 * 注意（待实测）：GLM quota/limit 的 percentage 语义按【已用 %】处理（与 MiniMax 的 remaining 相反），
 * 若你账号实测为剩余值，改 extra.percentageIsRemaining=true。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';

const LIMIT_PATH = '/api/monitor/usage/quota/limit';

function hostsFor(region: string): string[] {
  if (region === 'global') return ['https://api.z.ai'];
  return ['https://open.bigmodel.cn'];
}

function quotaUrl(plan: AdapterContext['plan']): string {
  const env = process.env;
  const override =
    env.Z_AI_QUOTA_URL ?? plan.extra.quotaUrl;
  if (override) {
    if (!/^https:\/\//.test(override)) {
      throw new AdapterError('api', 'GLM quota URL 覆写必须为 https');
    }
    return override;
  }
  const host = env.Z_AI_API_HOST ?? plan.extra.host ?? hostsFor(plan.extra.region ?? 'cn')[0]!;
  return host.replace(/\/+$/, '') + LIMIT_PATH;
}

interface LimitEntry {
  type?: string;
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
    .sort((a, b) => a.remainingMs - b.remainingMs); // 最短（5h）在前，较长（周）在后

  const percentageIsRemaining = opts.percentageIsRemaining === true;

  const windows: QuotaWindow[] = [];
  tokensLimits.forEach((l, i) => {
    const pct = num(l.percentage);
    if (pct == null) return;
    const used = percentageIsRemaining ? 100 - pct : pct;
    const resetAt = num(l.nextResetTime);
    const label =
      (typeof l.windowName === 'string' && l.windowName) ||
      (i === 0 ? '5H' : 'Week'); // 最短 → 5h 主窗口，较长 → 周窗口
    windows.push({
      window: i === 0 ? 'rolling_5h' : 'weekly',
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
      const used = percentageIsRemaining ? 100 - pct : pct;
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
  for (const k of ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY']) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

export const glmAdapter: PlanAdapter = {
  slug: 'glm',
  credentialHint:
    '缺少凭据：设置 Z_AI_API_KEY / BIGMODEL_API_KEY，或运行 planofplan auth set <slug> --key <key>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const region = ctx.plan.extra.region ?? 'cn';
    const zKey = process.env.Z_AI_API_KEY;
    if (zKey && zKey.trim()) return { kind: 'bearer', value: zKey.trim(), source: 'env' };
    if (region === 'global') return null; // global 路由不认 BIGMODEL 别名/relay
    const cnKey = cnEnvKey();
    if (cnKey) return { kind: 'bearer', value: cnKey, source: 'env' };
    const relay = readRelayKeys()[0];
    if (relay) return { kind: 'bearer', value: relay, source: 'auto' };
    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    const url = quotaUrl(ctx.plan);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.value}`,
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
        throw new AdapterError('network', `GLM 请求超时：${url}`);
      }
      throw new AdapterError('network', `GLM 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterError('auth', `GLM 鉴权失败(HTTP ${res.status})：请检查 API Key`);
    }
    if (!res.ok) {
      if (res.status === 429) throw new AdapterError('api', 'GLM 请求被限流(HTTP 429)');
      throw new AdapterError('api', `GLM API 错误(HTTP ${res.status})`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', `GLM 响应不是合法 JSON：${url}`);
    }
    return normalizeGlm(json, now(), {
      percentageIsRemaining: ctx.plan.extra.percentageIsRemaining === 'true',
    }).windows;
  },
};
