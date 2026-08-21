/**
 * xAI Grok / SuperGrok adapter（M2.5）
 *
 * 规格出处：CodexBar docs/grok.md
 * - 凭据：~/.grok/auth.json（GROK_HOME 可覆写），条目取 https://auth.x.ai::* 优先、
 *   https://accounts.x.ai/sign-in 兜底；字段 entry.key（bearer）、expires_at（秒，过期不发）
 * - 端点：GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 * - 头：Authorization: Bearer <key>；x-xai-token-auth: xai-grok-cli；Accept: application/json
 * - 解析：config.creditUsagePercent（兜底 onDemandUsed.val/onDemandCap.val*100）；
 *   重置时间 config.currentPeriod.end → config.billingPeriodEnd（ISO）
 * - 套餐名：GET /v1/settings → subscription_tier_display（尽力而为，失败不阻塞）
 * - 注意：token ~7 天过期，刷新归 grok CLI；本端点非官方契约，随 grok CLI 演进
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { clampPct } from './util.ts';

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok');
}

function grokCliPath(): string | null {
  const isExecutable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const configured = process.env.GROK_CLI_BINARY?.trim();
  if (configured && isExecutable(configured)) return configured;
  const pathEntry = (process.env.PATH ?? '')
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => join(part, 'grok'))
    .find(isExecutable);
  if (pathEntry) return pathEntry;
  for (const candidate of [
    join(homedir(), '.local', 'bin', 'grok'),
    '/usr/local/bin/grok',
    '/opt/homebrew/bin/grok',
  ]) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

interface GrokAuthEntry {
  key?: string;
  refresh_token?: string;
  expires_at?: number | string;
  auth_mode?: string;
  email?: string;
  team_id?: string;
}

function readAuthFile(): { entry: GrokAuthEntry | null; namespace: string | null } {
  const file = join(grokHome(), 'auth.json');
  if (!existsSync(file)) return { entry: null, namespace: null };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return { entry: null, namespace: null };
  }
  // 优先 https://auth.x.ai::*（SuperGrok OIDC），兜底 accounts.x.ai（legacy session）
  const authX = Object.keys(data).find((k) => k.startsWith('https://auth.x.ai::'));
  const legacy = Object.keys(data).find((k) => k.startsWith('https://accounts.x.ai'));
  const namespace = authX ?? legacy;
  const entry = namespace ? (data[namespace] as GrokAuthEntry) : null;
  return { entry, namespace: namespace ?? null };
}

export function grokExpiryMs(entry: GrokAuthEntry): number | null {
  const v = entry.expires_at;
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v * 1000 : null; // 数字 = epoch 秒
  }
  // grok login 实际写 ISO 字符串（如 2026-08-17T20:26:28.149076Z）
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

async function fetchGrokCliBillingOnce(): Promise<QuotaWindow[] | null> {
  const executable = grokCliPath();
  if (!executable) return null;
  const child = spawn(executable, ['agent', 'stdio'], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const stdout = child.stdout;
  if (!stdout || !child.stdin) return null;
  const readline = createInterface({ input: stdout });
  const lines = readline[Symbol.asyncIterator]();
  let nextId = 1;

  const readResponse = async (wantedId: number, timeoutMs: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          lines.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('grok RPC timeout')), Math.max(1, remaining));
          }),
        ]);
        if (next.done || !next.value) throw new Error('grok RPC closed stdout');
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(next.value) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id == null || Number(message.id) !== wantedId) continue;
        if (message.error && typeof message.error === 'object') {
          throw new Error('grok RPC returned an error');
        }
        return message;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error('grok RPC timeout');
  };

  const send = (method: string): number => {
    const id = nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: method === 'initialize'
        ? {
            protocolVersion: '1',
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          }
        : {},
    }).replaceAll('\\/', '/');
    child.stdin!.write(`${payload}\n`);
    return id;
  };

  try {
    // auth.json 过期时 CLI 启动要先走一次 token 刷新往返，冷启动可能明显变慢。
    await readResponse(send('initialize'), 20_000);
    const billing = await readResponse(send('x.ai/billing'), 20_000);
    const result = billing.result;
    return result && typeof result === 'object' ? normalizeGrok(result) : null;
  } catch {
    return null;
  } finally {
    readline.close();
    child.stdin.end();
    child.kill();
  }
}

/** CLI 兜底偶发失败（冷启动刷新超时、stdio 竞态），重试一次全新 spawn。 */
async function fetchGrokCliBilling(): Promise<QuotaWindow[] | null> {
  return (await fetchGrokCliBillingOnce()) ?? (await fetchGrokCliBillingOnce());
}

interface GrokBillingConfig {
  creditUsagePercent?: number;
  currentPeriod?: { end?: string };
  billingPeriodEnd?: string;
  onDemandUsed?: { val?: number };
  onDemandCap?: { val?: number };
}

interface GrokBillingResponse {
  config?: GrokBillingConfig;
  onDemandUsed?: { val?: number };
  onDemandCap?: { val?: number };
}

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function parseIsoMs(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function normalizeGrok(raw: unknown): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Grok 响应不是 JSON 对象');
  }
  const root = raw as GrokBillingResponse;
  const cfg = root.config ?? {};

  let percent = num(cfg.creditUsagePercent);
  if (percent == null) {
    const used = num(root.onDemandUsed?.val);
    const cap = num(root.onDemandCap?.val);
    if (used != null && cap != null && cap > 0) {
      percent = (used / cap) * 100;
    } else {
      percent = 0; // 有可解析周期但无百分比值 → 视为 0（CodexBar 同规则）
    }
  }
  percent = clampPct(percent);

  const resetAt =
    parseIsoMs(cfg.currentPeriod?.end) ?? parseIsoMs(cfg.billingPeriodEnd);

  return [
    {
      window: 'credits_period',
      label: 'Credits',
      used: null,
      total: null,
      unit: 'percent',
      percentage: percent,
      resetAt,
      note: null,
    },
  ];
}

export const grokAdapter: PlanAdapter = {
  slug: 'grok',
  credentialHint: '缺少凭据：运行 `grok login`，或设置 GROK_OAUTH_TOKEN',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const envToken = process.env.GROK_OAUTH_TOKEN;
    if (envToken && envToken.trim()) {
      return { kind: 'bearer', value: envToken.trim(), source: 'env' };
    }
    const { entry } = readAuthFile();
    const cli = grokCliPath();
    if (!entry?.key) {
      return cli ? { kind: 'bearer', value: '', source: 'cli' } : null;
    }
    const exp = grokExpiryMs(entry);
    if (exp != null && exp < Date.now() + 60_000) {
      // CodexBar does not send this stale bearer. It asks `grok agent stdio` to
      // use the CLI's own refreshed login state instead.
      return cli ? { kind: 'bearer', value: '', source: 'cli' } : null;
    }
    return { kind: 'bearer', value: entry.key, source: 'auto' };
  },

  async fetchUsage(_ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    if (cred.source === 'cli') {
      const windows = await fetchGrokCliBilling();
      if (windows) return windows;
      throw new AdapterError('auth', 'Grok CLI billing 不可用：请运行 `grok login`');
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.value}`,
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    };

    let res: Response;
    try {
      res = await fetch(BILLING_URL, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new AdapterError('network', `Grok 请求超时：${BILLING_URL}`);
      }
      throw new AdapterError('network', `Grok 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }

    if (res.status === 401 || res.status === 403) {
      // The persisted auth.json token can be stale while the installed CLI has
      // a valid refreshable session. This is the mature CodexBar/onWatch path.
      const windows = await fetchGrokCliBilling();
      if (windows) return windows;
      throw new AdapterError('auth', `Grok 鉴权失败(HTTP ${res.status})：请运行 \`grok login\``);
    }
    if (!res.ok) {
      if (res.status === 429) throw new AdapterError('api', 'Grok 请求被限流(HTTP 429)');
      throw new AdapterError('api', `Grok API 错误(HTTP ${res.status})`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', `Grok 响应不是合法 JSON：${BILLING_URL}`);
    }
    const windows = normalizeGrok(json);

    // 尽力获取套餐名（2s 内，失败不影响主数据）
    try {
      const s = await fetch(SETTINGS_URL, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(2_000),
      });
      if (s.ok) {
        const sj = (await s.json()) as { subscription_tier_display?: string };
        if (sj.subscription_tier_display) {
          windows[0]!.note = sj.subscription_tier_display;
        }
      }
    } catch {
      /* 套餐名获取失败可忽略 */
    }
    return windows;
  },
};
