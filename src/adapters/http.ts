/**
 * 配额轮询的共享限流感知 fetch（sourcebot fetchWithRetry 实践，
 * docs/sourcebot-code-context-research.md §8）。
 *
 * 只重试「值得重试」的失败：429 与 5xx/网络错误。401/403 与其余 4xx
 * 原样返回 Response，由各 adapter 自己的鉴权链处理（claude 的 token
 * 刷新、kimi 的 cookie 续期都不在这层做）。
 *
 * 等待时长优先级：x-ratelimit-reset（epoch 秒）> retry-after（秒或
 * HTTP 日期）> 指数退避 + jitter。短等待（默认 ≤20s）在同一轮 poll 内
 * 就地重试；长等待不空转——抛 AdapterError('api') 并带 retryAfterSec，
 * 由 core.ts 的调度器把 paused_until 推到服务端明示的恢复时刻。
 *
 * 5xx 重试耗尽后返回 Response（各 adapter 既有的 !res.ok 分支接管），
 * 只有 429 会以异常形式抛出——因为 429 是「我们知道何时能再来」的
 * 唯一信号，必须把恢复时间带给调度器。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AdapterError } from '../types.ts';

const DEFAULT_RETRIES = 2;                 // 1 次原始尝试 + 2 次重试
const DEFAULT_MAX_INLINE_WAIT_MS = 20_000; // 就地重试的等待上限
const RETRY_AFTER_CAP_SEC = 10 * 60;       // 透传给调度器的冷却封顶：再长的 hint 也只信 10 分钟
const EXP_BACKOFF_BASE_MS = 3_000;
const JITTER_MS = 500;

export interface QuotaFetchOptions {
  retries?: number;
  maxInlineWaitMs?: number;
  /** 测试注入睡眠；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** retry-after 头：秒数或 HTTP 日期（RFC 9110 两种形态都合法）。 */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = Number(trimmed);
    return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date - now : null;
}

/** x-ratelimit-reset 头：GitHub 风格 epoch 秒（容忍 ms 形态）。返回等待 ms，已过期为 0。 */
export function parseRateLimitResetMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^\d{9,13}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  const ms = trimmed.length >= 12 ? n : n * 1000;
  return Math.max(0, ms - now);
}

function waitMsFromHeaders(headers: Headers, attempt: number, now: number): number {
  const reset = parseRateLimitResetMs(headers.get('x-ratelimit-reset'), now);
  if (reset != null) return reset;
  const retryAfter = parseRetryAfterMs(headers.get('retry-after'), now);
  if (retryAfter != null) return Math.max(0, retryAfter);
  return EXP_BACKOFF_BASE_MS * 2 ** attempt + Math.random() * JITTER_MS;
}

function fmtWait(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

// ── provider 级出站代理（INV-2015）─────────────────────────────────────
// Bun fetch 原生支持 init.proxy（http/https，凭据可嵌 URL）。代理值经
// AsyncLocalStorage 随刷新上下文传播：Scheduler.refreshPlan 以 plan 解析
// 出的代理进入上下文，其 await 链上的 fetchQuota 统一注入——并发刷新
// 不同 plan 互不串扰。代理 URL 可能内嵌用户名密码：任何日志不得打印该值。

/** Bun 专属请求选项（标准 RequestInit 无 proxy 字段）。 */
export type ProxyRequestInit = RequestInit & { proxy?: string };

const quotaProxyStorage = new AsyncLocalStorage<string | null>();

/** 代理 URL 校验：http(s):// 开头视为有效；空/非法按直连（返回 null）。 */
export function normalizeQuotaProxy(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

/** 以指定代理进入配额请求上下文：work 内（含其 await 链）的 fetchQuota /
 * applyQuotaProxy 都取到该代理。null/undefined 表示显式直连。 */
export function withQuotaProxy<T>(proxy: string | null | undefined, work: () => T): T {
  return quotaProxyStorage.run(normalizeQuotaProxy(proxy), work);
}

/** 给裸 fetch 的 init 注入当前上下文代理（claude OAuth refresh 用）；
 * 无代理上下文时原样返回。 */
export function applyQuotaProxy(init: RequestInit): ProxyRequestInit {
  const proxy = quotaProxyStorage.getStore();
  return proxy ? ({ ...init, proxy } as ProxyRequestInit) : init;
}

export async function fetchQuota(
  url: string | URL,
  init?: RequestInit,
  options: QuotaFetchOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxInlineWaitMs = options.maxInlineWaitMs ?? DEFAULT_MAX_INLINE_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  // 代理在进入重试循环前注入一次：整个重试链都在同一 async 上下文里
  const proxiedInit = applyQuotaProxy(init ?? {});

  let lastRes: Response | null = null;
  let lastWaitMs = 0;
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, proxiedInit as RequestInit);
    } catch (e) {
      // 网络层失败最多就地补一次（断线重连的量级），再多就是环境问题
      if (attempt < 1) {
        await sleep(EXP_BACKOFF_BASE_MS);
        continue;
      }
      throw new AdapterError('network', `网络错误：${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status !== 429 && res.status < 500) return res;
    lastRes = res;
    lastWaitMs = waitMsFromHeaders(res.headers, attempt, now());
    if (attempt >= retries || lastWaitMs > maxInlineWaitMs) break;
    await sleep(lastWaitMs);
  }

  if (lastRes != null && lastRes.status !== 429) {
    // 5xx 耗尽：交回 Response，走各 adapter 既有的 !res.ok 分支
    return lastRes;
  }
  const retryAfterSec = Math.max(1, Math.min(Math.ceil(lastWaitMs / 1000), RETRY_AFTER_CAP_SEC));
  throw new AdapterError(
    'api',
    `端点限流(HTTP 429)，服务端提示约 ${fmtWait(retryAfterSec)}后恢复`,
    retryAfterSec,
  );
}
