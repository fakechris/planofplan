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
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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

interface LocalRateLimitRecord {
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: number } | null;
  secondary: { usedPercent: number; resetsAt: number } | null;
  atMs: number;
}

function readTail(path: string, bytes = 128 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function collectRolloutFiles(root: string): string[] {
  // sessions/YYYY/MM/DD/rollout-*.jsonl;全量收集后按 mtime 排序取头部——
  // 不能在遍历中截断(readdir 字母序会先走完 04 月才到 08 月,截断=永远
  // 采不到最新文件)。~1.4k 个文件的 statSync 成本可忽略。
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          out.push({ path: full, mtimeMs: statSync(full).mtimeMs });
        } catch { /* 竞态跳过 */ }
      }
    }
  };
  walk(join(root, 'sessions'), 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12).map((row) => row.path);
}

function parseRateLimitsPayload(node: unknown): LocalRateLimitRecord | null {
  if (!node || typeof node !== 'object') return null;
  const doc = node as {
    limit_name?: unknown;
    primary?: unknown;
    secondary?: unknown;
  };
  const win = (raw: unknown): { usedPercent: number; resetsAt: number } | null => {
    if (!raw || typeof raw !== 'object') return null;
    const w = raw as { used_percent?: unknown; resets_at?: unknown };
    const usedPercent = num(w.used_percent);
    const resetsAt = num(w.resets_at);
    if (usedPercent == null) return null;
    return { usedPercent, resetsAt: resetsAt != null ? resetsAt * 1000 : 0 };
  };
  const primary = win(doc.primary);
  const secondary = win(doc.secondary);
  if (!primary && !secondary) return null;
  return {
    limitName: typeof doc.limit_name === 'string' && doc.limit_name
      ? doc.limit_name.split('-').filter(Boolean).pop() ?? doc.limit_name
      : null,
    primary,
    secondary,
    atMs: 0,
  };
}

/**
 * 本地收割:codex CLI 每轮响应把 rate_limits 快照写进 rollout 文件;wham/usage
 * 的 5h 窗口只有活跃用量时才出现(prolite 顶层只剩周限额),rollout 是 5h 数据
 * 的稳定本地源。取最近改动文件里最后一条快照,按 resets_at 未过期过滤。
 */
export function harvestLocalRateLimits(root = codexHome(), now = Date.now()): QuotaWindow[] {
  for (const file of collectRolloutFiles(root)) {
    const tail = readTail(file);
    if (!tail.includes('rate_limits')) continue;
    let record: LocalRateLimitRecord | null = null;
    for (const line of tail.split('\n')) {
      if (!line.includes('rate_limits')) continue;
      try {
        const doc = JSON.parse(line) as { timestamp?: unknown; payload?: unknown; rate_limits?: unknown };
        const payload = doc.payload && typeof doc.payload === 'object'
          ? (doc.payload as { rate_limits?: unknown }).rate_limits ?? doc.payload
          : doc.rate_limits;
        const parsed = parseRateLimitsPayload(payload);
        if (parsed) {
          const ts = typeof doc.timestamp === 'string' ? Date.parse(doc.timestamp) : NaN;
          record = { ...parsed, atMs: Number.isFinite(ts) ? ts : statSync(file).mtimeMs };
        }
      } catch { /* 截断行跳过 */ }
    }
    if (!record) continue;
    const windows: QuotaWindow[] = [];
    const push = (w: { usedPercent: number; resetsAt: number } | null, fiveHour: boolean, name: string | null): void => {
      if (!w) return;
      // 窗口已过期(重置时刻在过去超过 1h)说明快照陈旧,不采用
      if (w.resetsAt > 0 && w.resetsAt < now - 3_600_000) return;
      windows.push({
        window: `local_${fiveHour ? '5h' : 'weekly'}`,
        label: name ? `${name}·${fiveHour ? '5h' : '周'}限额` : (fiveHour ? '5小时限额' : '周限额'),
        used: null,
        total: null,
        unit: 'percent',
        percentage: clampPct(w.usedPercent),
        resetAt: w.resetsAt > 0 ? w.resetsAt : null,
        note: null,
      });
    };
    push(record.primary, true, record.limitName);
    push(record.secondary, false, record.limitName);
    if (windows.length > 0) return windows;
  }
  return [];
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
    const windows = normalizeCodex(json);
    // prolite 的 5h 窗口只在活跃用量时出现在 usage 响应里;缺它时用本地
    // rollout 快照补(CLI 每轮都写),失败静默——周限额仍然来自 usage
    const hasFiveHour = windows.some((w) => w.window === 'rolling_5h' || w.window.startsWith('extra_5h'));
    if (!hasFiveHour) {
      try {
        for (const local of harvestLocalRateLimits()) {
          if (!windows.some((w) => w.label === local.label)) windows.push(local);
        }
      } catch { /* 本地收割是 best-effort */ }
    }
    return windows;
  },
};
