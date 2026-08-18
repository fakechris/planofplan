/**
 * Moonshot Kimi Code adapter（M2.4）
 *
 * 规格出处：CodexBar docs/kimi.md + Sources/.../Kimi/KimiUsageFetcher.swift
 * - 凭据优先级：API Key（kimi.com/code/console 创建，KIMI_CODE_API_KEY）→ Kimi Code CLI
 *   ~/.kimi-code/credentials/kimi-code.json 的 access_token（只读不刷新；过期提示重新登录）
 * - 端点：GET {base}/coding/v1/usages（base 默认 https://api.kimi.com，KIMI_CODE_BASE_URL 可覆写）
 * - CLI 凭据需带设备头：x-msh-device-id（JWT device_id 或 ~/.kimi-code/device_id）、
 *   x-msh-session-id（JWT ssid）、x-traffic-id（JWT sub）
 * - 响应：usage{limit,used,remaining,resetTime}=周额度；limits[0].detail=5h 限流(200/5h)
 * - 注意：月度会员池仅 Web 会话可取（本实现不支持，见设计 §9）；值均为字符串需转数字
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
}

interface CliCredentialFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

function readCliCredential(): CliCredentialFile | null {
  const file = join(kimiHome(), 'credentials', 'kimi-code.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CliCredentialFile;
  } catch {
    return null;
  }
}

interface JwtClaims {
  device_id?: string;
  ssid?: string;
  sub?: string;
  exp?: number;
}

function jwtClaims(token: string): JwtClaims {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    const padded = payload + '='.repeat((-payload.length % 4 + 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return {};
  }
}

function deviceIdFile(): string | null {
  const f = join(kimiHome(), 'device_id');
  if (!existsSync(f)) return null;
  try {
    const v = readFileSync(f, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

interface StriDetail {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
}

interface KimiResponse {
  usage?: StriDetail;
  limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: StriDetail }>;
}

function toNum(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-01-09T15:23:13.716839300Z" → epoch ms（归一化 9 位小数） */
function parseResetTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const normalized = iso.replace(/\.(\d{3})\d+/, '.$1');
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

export function normalizeKimi(raw: unknown): QuotaWindow[] {
  if (raw == null || typeof raw !== 'object') {
    throw new AdapterError('parse', 'Kimi 响应不是 JSON 对象');
  }
  const root = raw as KimiResponse;
  const windows: QuotaWindow[] = [];

  const usage = root.usage;
  if (usage && typeof usage === 'object') {
    const total = toNum(usage.limit);
    const used = toNum(usage.used);
    if (total != null && total > 0 && used != null) {
      windows.push({
        window: 'weekly',
        label: 'Week',
        used,
        total,
        unit: 'requests',
        percentage: Math.min(100, Math.max(0, (used / total) * 100)),
        resetAt: parseResetTime(usage.resetTime),
        note: null,
      });
    }
  }

  const rateLimit = Array.isArray(root.limits) ? root.limits[0] : undefined;
  const detail = rateLimit?.detail;
  if (detail && typeof detail === 'object') {
    const total = toNum(detail.limit);
    const used = toNum(detail.used);
    if (total != null && total > 0 && used != null) {
      windows.push({
        window: 'rolling_5h',
        label: '5H',
        used,
        total,
        unit: 'requests',
        percentage: Math.min(100, Math.max(0, (used / total) * 100)),
        resetAt: parseResetTime(detail.resetTime),
        note: null,
      });
    }
  }

  if (windows.length === 0) {
    throw new AdapterError('parse', 'Kimi 响应没有可用窗口');
  }
  return windows;
}

export const kimiAdapter: PlanAdapter = {
  slug: 'kimi',
  credentialHint:
    '缺少凭据：重新登录 Kimi Code CLI（kimi-code login），或设置 KIMI_CODE_API_KEY，或 planofplan auth set kimi --key <key>',

  async detectCredentials(ctx: AdapterContext): Promise<Credential | null> {
    if (ctx.plan.credRef) {
      const { readCredential } = await import('../auth.ts');
      const stored = readCredential(ctx.plan.credRef);
      if (stored) return { kind: 'bearer', value: stored.value, source: 'manual' };
    }
    const apiKey = process.env.KIMI_CODE_API_KEY;
    if (apiKey && apiKey.trim()) return { kind: 'bearer', value: apiKey.trim(), source: 'env' };

    const cli = readCliCredential();
    if (cli?.access_token) {
      const expSec = toNum(cli.expires_at);
      // 过期或临过期 → 视为不可用，引导重新登录
      if (expSec != null && expSec * 1000 < Date.now() + 60_000) {
        return null;
      }
      return { kind: 'bearer', value: cli.access_token, source: 'auto' };
    }
    return null;
  },

  async fetchUsage(ctx: AdapterContext, cred: Credential): Promise<QuotaWindow[]> {
    const base = (process.env.KIMI_CODE_BASE_URL ?? ctx.plan.extra.baseUrl ?? 'https://api.kimi.com').replace(/\/+$/, '');
    const url = `${base}/coding/v1/usages`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.value}`,
      accept: 'application/json',
    };
    if (cred.source === 'auto') {
      // CLI 凭据：带设备身份头（与官方 CLI 一致）
      const claims = jwtClaims(cred.value);
      const deviceId = claims.device_id ?? deviceIdFile();
      if (deviceId) headers['x-msh-device-id'] = deviceId;
      if (claims.ssid) headers['x-msh-session-id'] = claims.ssid;
      if (claims.sub) headers['x-traffic-id'] = claims.sub;
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
        throw new AdapterError('network', `Kimi 请求超时：${url}`);
      }
      throw new AdapterError('network', `Kimi 网络错误：${String(e instanceof Error ? e.message : e)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterError(
        'auth',
        `Kimi 鉴权失败(HTTP ${res.status})：请重新登录 Kimi Code CLI 或换 KIMI_CODE_API_KEY`,
      );
    }
    if (!res.ok) {
      if (res.status === 429) throw new AdapterError('api', 'Kimi 请求被限流(HTTP 429)');
      throw new AdapterError('api', `Kimi API 错误(HTTP ${res.status})`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdapterError('parse', `Kimi 响应不是合法 JSON：${url}`);
    }
    return normalizeKimi(json);
  },
};
