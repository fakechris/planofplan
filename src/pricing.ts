import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureHome } from './config.ts';

// ── 模型价格快照(参照 agentsview 的做法:LiteLLM 快照 + 离线家族表兜底) ──
// 家族正则(MODEL_PRICE_FAMILIES)对新模型是盲的——快照让"价格数据"变成
// 可刷新的数据文件而不是代码。回退链:快照(精确/归一化匹配) → 家族正则
// → null(不虚构价格)。金额仍是估算层,不做整数微美分迁移。

export interface ModelPrice {
  /** USD / MTok,与 MODEL_PRICE_FAMILIES 同单位。 */
  input: number;
  cached: number;
  cacheCreation: number;
  output: number;
}

export interface PricingSnapshot {
  source: string;
  fetchedAt: number;
  models: Record<string, ModelPrice>;
}

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export function pricingSnapshotPath(): string {
  return join(ensureHome(), 'pricing-snapshot.json');
}

let snapshotCache: { at: number; path: string; snapshot: PricingSnapshot | null } | null = null;
const SNAPSHOT_RECHECK_MS = 60_000;

/** 读取快照(进程内缓存,至多每 60s 重新 stat 一次;损坏/缺失返回 null)。 */
export function loadPricingSnapshot(path = pricingSnapshotPath()): PricingSnapshot | null {
  const now = Date.now();
  if (snapshotCache && snapshotCache.path === path && now - snapshotCache.at < SNAPSHOT_RECHECK_MS) {
    return snapshotCache.snapshot;
  }
  let snapshot: PricingSnapshot | null = null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PricingSnapshot>;
    if (raw && typeof raw.source === 'string' && typeof raw.fetchedAt === 'number' && raw.models && typeof raw.models === 'object') {
      const models: Record<string, ModelPrice> = {};
      for (const [key, value] of Object.entries(raw.models)) {
        const price = value as Partial<ModelPrice>;
        if (typeof price?.input !== 'number'
          || typeof price?.output !== 'number'
          || !Number.isFinite(price.input) || !Number.isFinite(price.output)) continue;
        models[key] = {
          input: price.input,
          output: price.output,
          cached: typeof price.cached === 'number' ? price.cached : 0,
          cacheCreation: typeof price.cacheCreation === 'number' ? price.cacheCreation : 0,
        };
      }
      snapshot = { source: raw.source, fetchedAt: raw.fetchedAt, models };
    }
  } catch {
    /* 缺失或损坏:走家族表 */
  }
  snapshotCache = { at: now, path, snapshot };
  return snapshot;
}

/** 模型名归一化匹配候选:原名 → 去 provider 前缀 → 再去 -YYYY-MM-DD 日期后缀。 */
function modelKeyCandidates(model: string): string[] {
  const lower = model.toLowerCase();
  const candidates = [lower];
  const slashed = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : null;
  if (slashed) candidates.push(slashed);
  const stripped = (slashed ?? lower).replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  if (stripped !== (slashed ?? lower)) candidates.push(stripped);
  return candidates;
}

/** 快照里查模型价;查不到返回 null(调用方继续走家族正则)。 */
export function priceFromSnapshot(snapshot: PricingSnapshot, model: string): ModelPrice | null {
  for (const key of modelKeyCandidates(model)) {
    const price = snapshot.models[key];
    if (price) return price;
  }
  return null;
}

interface LiteLLMEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  input_cost_per_character?: unknown;
  output_cost_per_character?: unknown;
  output_cost_per_audio_token?: unknown;
  output_cost_per_image_above_128p_token?: unknown;
}

/**
 * 从 LiteLLM 的 model_prices_and_context_window.json 生成快照。
 * per-token 价 ×1e6 折成 USD/MTok;跳过缺 input/output 价的条目
 * (embedding/音频/按字符计费等与本工具口径不符)。
 */
export function snapshotFromLiteLLM(payload: unknown, fetchedAt = Date.now()): PricingSnapshot {
  const models: Record<string, ModelPrice> = {};
  if (payload && typeof payload === 'object') {
    for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as LiteLLMEntry;
      const input = Number(entry.input_cost_per_token);
      const output = Number(entry.output_cost_per_token);
      if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0) continue;
      if (entry.input_cost_per_character != null || entry.output_cost_per_character != null) continue;
      models[key.toLowerCase()] = {
        input: input * 1e6,
        output: output * 1e6,
        cached: Number.isFinite(Number(entry.cache_read_input_token_cost))
          ? Number(entry.cache_read_input_token_cost) * 1e6
          : 0,
        cacheCreation: Number.isFinite(Number(entry.cache_creation_input_token_cost))
          ? Number(entry.cache_creation_input_token_cost) * 1e6
          : 0,
      };
    }
  }
  return { source: 'litellm', fetchedAt, models };
}

export interface PricingRefreshResult {
  ok: boolean;
  models?: number;
  fetchedAt?: number;
  path?: string;
  error?: string;
}

/** 拉取并落盘价格快照。fetchImpl 可注入(测试),默认用运行时 fetch。 */
export async function refreshPricingSnapshot(
  url = LITELLM_PRICES_URL,
  fetchImpl: (requestUrl: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = (u) => fetch(u),
  path = pricingSnapshotPath(),
): Promise<PricingRefreshResult> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const snapshot = snapshotFromLiteLLM(await response.json());
    if (Object.keys(snapshot.models).length === 0) return { ok: false, error: 'payload contained no priced models' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    // 立刻让缓存看到新快照
    snapshotCache = { at: Date.now(), path, snapshot };
    return { ok: true, models: Object.keys(snapshot.models).length, fetchedAt: snapshot.fetchedAt, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
  }
}

/** 进程内查询入口:usage.ts 的 costFor 用。无快照时返回 null。 */
export function modelPriceFor(model: string, path?: string): ModelPrice | null {
  const snapshot = loadPricingSnapshot(path);
  if (!snapshot) return null;
  return priceFromSnapshot(snapshot, model);
}

/** 供 CLI 展示快照状态。 */
export function pricingSnapshotStatus(path = pricingSnapshotPath()): { exists: boolean; source: string | null; fetchedAt: number | null; models: number } {
  if (!existsSync(path)) return { exists: false, source: null, fetchedAt: null, models: 0 };
  const snapshot = loadPricingSnapshot(path);
  if (!snapshot) return { exists: true, source: null, fetchedAt: null, models: 0 };
  return { exists: true, source: snapshot.source, fetchedAt: snapshot.fetchedAt, models: Object.keys(snapshot.models).length };
}
