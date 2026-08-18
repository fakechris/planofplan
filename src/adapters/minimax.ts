/**
 * MiniMax Coding Plan adapter（M1）
 *
 * 规格出处：
 * - 端点/鉴权：CodexBar docs/minimax.md（GET {host}/v1/api/openplatform/coding_plan/remains，Bearer）
 * - 鉴权头/重试顺序：CodexBar Sources/.../MiniMaxUsageFetcher.swift
 * - 响应字段：JinHanAI/coding-plan-monitor（实测；current_interval_usage_count 实为【剩余】值）
 *
 * 响应两种形态都支持：
 *   A. 老式：{ base_resp, model_remains: [{ start_time, end_time, remains_time,
 *        current_interval_total_count, current_interval_usage_count(剩余),
 *        current_interval_remaining_percent, current_interval_status, ... }] }
 *   B. 新式多服务：{ data: { services: [...] } }（M1 仅尽力解析）
 * legacy 套餐通常只有 5h 单车道；weekly 车道仅在 current_weekly_total_count > 0 时渲染。
 */
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';

const REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains';

/** 区域 → 尝试的 host 顺序（cn 默认；en 走 minimax.io）。均可被 env/extra 覆写。 */
function hostChain(region: string): string[] {
  if (region === 'global') {
    return ['https://www.minimax.io', 'https://platform.minimaxi.com', 'https://www.minimaxi.com'];
  }
  return ['https://www.minimaxi.com', 'https://platform.minimaxi.com', 'https://www.minimax.io'];
}

function remainsUrls(plan: AdapterContext['plan']): string[] {
  const env = process.env;
  const override =
    env.MINIMAX_REMAINS_URL ?? env.MINIMAX_CODING_PLAN_URL; // 完整 URL 覆写（最高优先级）
  const host = env.MINIMAX_HOST ?? plan.extra.host; // host 覆写
  const region = plan.extra.region ?? env.MINIMAX_REGION ?? 'cn';
  if (override) return [override];
  const bases = host ? [host] : hostChain(region);
  return bases.map((b) => b.replace(/\/+$/, '') + REMAINS_PATH);
}

interface ModelRemain {
  model_name?: string;
  start_time?: number;
  end_time?: number;
  remains_time?: number;
  // interval（5h 窗口）
  current_interval_total_count?: number;
  current_interval_usage_count?: number; // 注意：这是【剩余】值
  current_interval_remaining_percent?: number;
  current_interval_status?: number;
  interval_boost_permille?: number;
  // weekly 车道（仅在有真实配额时存在）
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
  current_weekly_status?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
  weekly_remains_time?: number;
}

interface MiniMaxResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: DataPart;
  model_remains?: ModelRemain[];
  plan_name?: string;
}

/** 响应的「有效数据」部分：老式格式在 root，新式格式在 data，字段一致 */
interface DataPart {
  base_resp?: { status_code?: number; status_msg?: string };
  plan_name?: string;
  current_subscribe_title?: string;
  model_remains?: ModelRemain[];
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface LaneInput {
  window: string;
  label: string;
  modelName?: string;
  total: number | null;
  remaining: number | null;
  remainingPercent: number | null;
  status: number | null;
  end: number | null;
  remainsTime: number | null;
  unlimitedService: boolean;
}

type Lane = QuotaWindow & { modelName?: string };

function pushLane(out: Lane[], input: LaneInput, now: number): void {
  // 占位车道（status 3 且总量/剩余缺失或为 0、剩余 100%）跳过（CodexBar isUnavailableQuotaPlaceholder）
  if (
    input.status === 3 &&
    input.total == null &&
    input.remaining == null &&
    (input.remainingPercent == null || input.remainingPercent >= 100)
  ) {
    return;
  }

  let used: number | null = null;
  let percentage: number | null = null;
  const rp = input.remainingPercent;
  if (rp != null) {
    percentage = clamp(100 - rp, 0, 100);
    if (input.total != null && input.total > 0) {
      used = Math.round((percentage / 100) * input.total);
    }
  } else if (input.total != null && input.total > 0 && input.remaining != null) {
    used = Math.max(0, input.total - input.remaining);
    percentage = clamp((used / input.total) * 100, 0, 100);
  }

  if (percentage == null && used == null) return;

  let resetAt: number | null = null;
  if (input.end != null && input.end > now) {
    resetAt = input.end;
  } else if (input.remainsTime != null && input.remainsTime > 0) {
    resetAt = now + input.remainsTime;
  }

  out.push({
    window: input.window,
    label: input.label,
    modelName: input.modelName,
    used,
    total: input.total,
    unit: 'prompts',
    percentage,
    resetAt,
    note: input.unlimitedService ? '不限量' : null,
  });
}

export function normalizeMiniMax(raw: unknown, now: number): { windows: QuotaWindow[]; planName?: string } {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'MiniMax 响应不是 JSON 对象');
  }
  const root = raw as MiniMaxResponse;
  let data: DataPart = root;
  if (root.data && typeof root.data === 'object') {
    data = root.data;
  }
  const modelRemains = data.model_remains ?? root.model_remains ?? [];

  const baseResp = root.base_resp ?? data.base_resp;
  const status = num(baseResp?.status_code);
  if (status != null && status !== 0) {
    const msg = String(baseResp?.status_msg ?? '') || `status_code ${status}`;
    if (status === 1004 || /cookie|log\s*in|login/i.test(msg)) {
      throw new AdapterError('auth', `MiniMax 鉴权失败(${status}): ${msg}`);
    }
    throw new AdapterError('api', `MiniMax API 错误(${status}): ${msg}`);
  }

  if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
    throw new AdapterError('parse', 'MiniMax 响应缺少 model_remains（可能为多服务格式，M1 暂不支持）');
  }

  const lanes: Lane[] = [];
  for (const item of modelRemains) {
    if (item == null || typeof item !== 'object') continue;
    const modelName = typeof item.model_name === 'string' ? item.model_name : undefined;
    // 5h 区间车道（legacy 主窗口）
    pushLane(lanes, {
      window: 'rolling_5h',
      label: '5H',
      modelName,
      total: num(item.current_interval_total_count),
      remaining: num(item.current_interval_usage_count),
      remainingPercent: num(item.current_interval_remaining_percent),
      status: num(item.current_interval_status),
      end: num(item.end_time),
      remainsTime: num(item.remains_time),
      unlimitedService: false,
    }, now);

    // weekly 车道仅在真实配额时渲染（CodexBar 同规则）
    const weeklyTotal = num(item.current_weekly_total_count);
    if (weeklyTotal != null && weeklyTotal > 0) {
      pushLane(lanes, {
        window: 'weekly',
        label: 'Week',
        modelName,
        total: weeklyTotal,
        remaining: num(item.current_weekly_usage_count),
        remainingPercent: num(item.current_weekly_remaining_percent),
        status: num(item.current_weekly_status),
        end: num(item.weekly_end_time),
        remainsTime: num(item.weekly_remains_time),
        unlimitedService: false,
      }, now);
    }
  }

  if (lanes.length === 0) {
    throw new AdapterError('parse', 'MiniMax 响应没有可用配额窗口');
  }

  // 同窗口多条车道时 label 追加模型名（如 5H·general / 5H·video），避免 UI 上一排同名 bar
  const countByWindow = new Map<string, number>();
  for (const lane of lanes) {
    countByWindow.set(lane.window, (countByWindow.get(lane.window) ?? 0) + 1);
  }
  const windows: QuotaWindow[] = lanes.map((lane) => {
    const dup = (countByWindow.get(lane.window) ?? 0) > 1;
    const label = dup && lane.modelName ? `${lane.label}·${lane.modelName}` : lane.label;
    return { ...lane, label };
  });

  const planName =
    (typeof data.plan_name === 'string' && data.plan_name) ||
    (typeof data.current_subscribe_title === 'string' && data.current_subscribe_title) ||
    (typeof root.plan_name === 'string' && root.plan_name) ||
    undefined;

  return { windows, planName };
}

export const minimaxAdapter: PlanAdapter = {
  slug: 'minimax',
  credentialHint:
    '缺少凭据：设置 MINIMAX_CODING_API_KEY 或运行 planofplan auth set minimax --key <sk-cp-*>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    // 手动 key（credentials.json，经 config cred_ref 引用）优先
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) {
        return { kind: 'bearer', value: stored.value, source: 'manual' };
      }
    }
    // env：coding plan key 优先，普通 key 兜底
    const envKey = process.env.MINIMAX_CODING_API_KEY ?? process.env.MINIMAX_API_KEY;
    if (envKey && envKey.trim()) {
      return { kind: 'bearer', value: envKey.trim(), source: 'env' };
    }
    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    const urls = remainsUrls(ctx.plan);
    let lastError: AdapterError = new AdapterError('unknown', '没有可用的 MiniMax 端点');

    for (const url of urls) {
      try {
        // 参照 CodexBar：Bearer + accept/json；401/403 → auth；404/405 → 换端点
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${cred.value}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'MM-API-Source': 'planofplan',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (res.status === 401 || res.status === 403) {
          throw new AdapterError('auth', `MiniMax 鉴权失败(HTTP ${res.status})：请检查 Coding Plan API Key`);
        }
        if (res.status === 404 || res.status === 405) {
          lastError = new AdapterError('network', `MiniMax 端点不存在(HTTP ${res.status})：${url}`);
          ctx.log(`[minimax] 端点 ${url} 返回 ${res.status}，尝试下一个`);
          continue;
        }
        if (!res.ok) {
          if (res.status === 429) {
            throw new AdapterError('api', 'MiniMax 请求被限流(HTTP 429)');
          }
          throw new AdapterError('api', `MiniMax API 错误(HTTP ${res.status})`);
        }

        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new AdapterError('parse', `MiniMax 响应不是合法 JSON：${url}`);
        }
        return normalizeMiniMax(json, ctx.now()).windows;
      } catch (e) {
        if (e instanceof AdapterError) {
          if (e.kind === 'auth') throw e; // 凭据无效不需要换端点
          lastError = e;
          if (e.kind === 'api' && !/404|405/.test(e.message)) throw e;
          continue;
        }
        if (e instanceof Error && e.name === 'TimeoutError') {
          throw new AdapterError('network', `MiniMax 请求超时：${url}`);
        }
        lastError = new AdapterError('network', `MiniMax 网络错误：${String(e instanceof Error ? e.message : e)}`);
      }
    }
    throw lastError;
  },
};
