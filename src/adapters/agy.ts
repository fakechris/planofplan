/**
 * Antigravity CLI (agy) adapter。
 *
 * 调用 `agy -p "/usage" --output-format json` 非交互获取配额（零 token 消耗，
 * 不留会话）。新版 CLI 在 `command.data.groups[].buckets[]` 提供结构化数据
 * （remaining_fraction / disabled / reset_time），优先解析；旧版退回
 * `response` 字段的 TSV：每组模型两行（Weekly / 5H Limit Remaining），
 * 格式 "<group>\t<type>\t<percent>%\t<resetISO>"。周限额耗尽时 5H 行的
 * 百分比列输出 "disabled"——渲染为显式「不适用」车道，保证 4 个指标稳定。
 *
 * 凭据：不需要手动 key——agy 自身已通过 Google OAuth 登录，
 * detectCredentials 返回固定 credential 标识"本地 CLI 登录态"。
 * agy 不在 PATH 时报 credential 错误提示安装。
 *
 * ⚠️ 必须用异步 spawn(Bun.spawn + await exited):execFileSync 会阻塞
 * Bun 事件循环,每 5 分钟的 poll 会把 daemon 卡死最长 18 秒——实测导致
 * 全部 API 无响应(含 /api/build-info),用户 menubar 一天不更新。
 */
import type { AdapterContext, Credential, PlanAdapter, QuotaWindow } from '../types.ts';
import { AdapterError } from '../types.ts';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USAGE_TIMEOUT_MS = 45_000;  // 实测 agy 启动+查询 ≈18s;15s 会 kill 导致 context canceled

interface AgyBucket {
  id?: string;
  name?: string;
  window?: string; // 'weekly' | '5h'
  remaining_fraction?: number; // 0..1
  reset_time?: string; // ISO
  disabled?: boolean;
  description?: string;
}

interface AgyGroup {
  name?: string;
  description?: string;
  buckets?: AgyBucket[];
}

interface AgyUsageResponse {
  status?: string;
  response?: string;
  error?: string;
  command?: { name?: string; data?: { groups?: AgyGroup[] } };
}

/** 模型组 → 窗口前缀（window 必须全局唯一:latestByPlan 的 SQL 按窗口分区去重）。 */
function groupWindowSlug(groupName: string): string {
  if (/gemini/i.test(groupName)) return 'gemini';
  if (/claude|gpt/i.test(groupName)) return 'claude_gpt';
  return 'other';
}

function groupLabel(groupName: string): string {
  if (/gemini/i.test(groupName)) return 'Gemini';
  if (/claude|gpt/i.test(groupName)) return 'Claude/GPT';
  return groupName;
}

function parseReset(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 优先解析 `command.data.groups[].buckets[]` 结构化数据（含 remaining_fraction
 * 与 disabled 标志）；旧版 CLI 无结构化数据时退回 TSV。
 *
 * disabled 的 5H 车道（周限额已耗尽时 5H 不适用）必须显式渲染成一条
 * 「不适用」车道而不是静默丢行——否则 UI 上 4 个指标会变成 2-3 个。
 */
function parseStructured(json: AgyUsageResponse): QuotaWindow[] | null {
  const groups = json.command?.data?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const out: QuotaWindow[] = [];
  for (const group of groups) {
    if (group == null || typeof group !== 'object') continue;
    const slug = groupWindowSlug(group.name ?? '');
    const label = groupLabel(group.name ?? '');
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    const weeklyReset = parseReset(buckets.find((b) => b?.window === 'weekly')?.reset_time);
    for (const bucket of buckets) {
      if (bucket == null || typeof bucket !== 'object') continue;
      const isWeekly = bucket.window === 'weekly';
      const window = `${slug}_${isWeekly ? 'weekly' : 'rolling_5h'}`;
      const laneLabel = isWeekly ? `${label} Week` : `${label} 5H`;
      if (bucket.disabled) {
        out.push({
          window,
          label: laneLabel,
          used: null,
          total: null,
          unit: 'percent',
          percentage: null,
          // 5H 不适用时,恢复点取同组周限额的重置时刻(5H 随周限额恢复而重新适用)
          resetAt: isWeekly ? parseReset(bucket.reset_time) : weeklyReset,
          startedAt: null,
          note: '不适用（周限额已耗尽）',
        });
        continue;
      }
      const rf = bucket.remaining_fraction;
      if (typeof rf !== 'number' || !Number.isFinite(rf)) continue;
      const usedPct = round2(Math.min(100, Math.max(0, (1 - rf) * 100)));
      out.push({
        window,
        label: laneLabel,
        used: usedPct,
        total: 100,
        unit: 'percent',
        percentage: usedPct,
        resetAt: parseReset(bucket.reset_time),
        startedAt: null,
        note: null,
      });
    }
  }
  return out.length > 0 ? out : null;
}

/** TSV 行 → QuotaWindow;`disabled` 值显式渲染为不适用车道,其余解析失败返回 null。 */
function parseQuotaLine(line: string): QuotaWindow | null {
  const [group, type, percentStr, resetIso] = line.split('\t');
  if (!group || !type || !percentStr) return null;
  const pct = parseFloat(percentStr.replace('%', ''));
  const resetAt = resetIso ? Date.parse(resetIso) : NaN;
  const isWeekly = type.includes('Weekly');
  const modelLabel = group.includes('Gemini') ? 'Gemini' : group.includes('Claude') ? 'Claude/GPT' : group;
  // window 必须全局唯一:latestByPlan 的 SQL 按窗口分区去重,
  // 两组模型共用 'weekly' 会互相覆盖(实测踩过:Gemini 窗口被 Claude 覆盖)
  const windowSlug = group.includes('Gemini') ? 'gemini' : group.includes('Claude') ? 'claude_gpt' : 'other';
  if (!Number.isFinite(pct)) {
    // 周限额耗尽时 agy 在百分比列输出 "disabled"(5H 不适用)——渲染为显式车道
    if (!/disabled/i.test(percentStr)) return null;
    return {
      window: `${windowSlug}_${isWeekly ? 'weekly' : 'rolling_5h'}`,
      label: isWeekly ? `${modelLabel} Week` : `${modelLabel} 5H`,
      used: null,
      total: null,
      unit: 'percent',
      percentage: null,
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
      startedAt: null,
      note: '不适用（周限额已耗尽）',
    };
  }
  return {
    window: `${windowSlug}_${isWeekly ? 'weekly' : 'rolling_5h'}`,
    label: isWeekly ? `${modelLabel} Week` : `${modelLabel} 5H`,
    used: round2(100 - pct),
    total: 100,
    unit: 'percent',
    percentage: round2(100 - pct),
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    startedAt: null,
    note: null,
  };
}

/** agy /usage JSON 输出 → QuotaWindow[]；解析/状态异常抛 AdapterError。 */
export function parseAgyUsage(raw: string): QuotaWindow[] {
  let json: AgyUsageResponse;
  try {
    json = JSON.parse(raw) as AgyUsageResponse;
  } catch {
    throw new AdapterError('parse', `agy 输出不是合法 JSON：${raw.slice(0, 80)}`);
  }
  if (json.status !== 'SUCCESS' || typeof json.response !== 'string') {
    throw new AdapterError('api', `agy 返回异常状态：${json.status ?? json.error ?? 'unknown'}`);
  }
  const structured = parseStructured(json);
  if (structured) return structured;
  const windows = json.response
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseQuotaLine)
    .filter((w): w is QuotaWindow => w !== null);
  if (windows.length === 0) {
    throw new AdapterError('parse', 'agy 配额响应无可解析行');
  }
  return windows;
}

/** 异步找 agy 二进制(只查文件存在性,不 exec --version——避免阻塞)。 */
function findAgyBinary(): string | null {
  const candidates = [
    process.env.AGY_PATH?.trim(),
    `${process.env.HOME}/.local/bin/agy`,
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 缓存系统代理探测结果(1 分钟)。 */
let cachedProxyEnv: { env: Record<string, string>; expiresAt: number } | null = null;

/** 检测系统代理(优先继承 process.env,兜底读取 macOS scutil --proxy)。 */
function getProxyEnv(): Record<string, string> {
  const explicit =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;
  if (explicit) {
    const res: Record<string, string> = {};
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
      if (process.env[key]) res[key] = process.env[key]!;
    }
    return res;
  }

  const now = Date.now();
  if (cachedProxyEnv && cachedProxyEnv.expiresAt > now) {
    return cachedProxyEnv.env;
  }

  const env: Record<string, string> = {};
  if (process.platform === 'darwin') {
    try {
      const out = execSync('/usr/sbin/scutil --proxy', { encoding: 'utf8', timeout: 1500 });
      const httpEnabled = /HTTPEnable\s*:\s*1/.test(out);
      const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(out);
      const socksEnabled = /SOCKSEnable\s*:\s*1/.test(out);
      const httpHost = out.match(/HTTPProxy\s*:\s*([^\s]+)/)?.[1];
      const httpPort = out.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
      const httpsHost = out.match(/HTTPSProxy\s*:\s*([^\s]+)/)?.[1];
      const httpsPort = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      const socksHost = out.match(/SOCKSProxy\s*:\s*([^\s]+)/)?.[1];
      const socksPort = out.match(/SOCKSPort\s*:\s*(\d+)/)?.[1];

      if (httpEnabled && httpHost && httpPort) {
        const url = `http://${httpHost}:${httpPort}`;
        env.HTTP_PROXY = url;
        env.http_proxy = url;
      }
      if (httpsEnabled && httpsHost && httpsPort) {
        const url = `http://${httpsHost}:${httpsPort}`;
        env.HTTPS_PROXY = url;
        env.https_proxy = url;
      }
      if (socksEnabled && socksHost && socksPort) {
        const url = `socks5://${socksHost}:${socksPort}`;
        env.ALL_PROXY = url;
        env.all_proxy = url;
      }
    } catch {
      // 静默容错
    }
  }

  cachedProxyEnv = { env, expiresAt: now + 60_000 };
  return env;
}

/**
 * 确保本地无头 dummy open 脚本存在。
 * agy 在静默鉴权超时/失效时会尝试通过 open 唤起默认浏览器走交互 OAuth。
 * 将 dummy open 脚本置于 PATH 最前端并设置 BROWSER 环境变量:
 * 1) 彻底阻断弹窗骚扰用户;
 * 2) 捕获 OAuth 请求并快速中断进程,避免白等 45s 超时。
 */
function ensureNoopOpenBin(): string {
  const binDir = join(process.env.HOME ?? '', '.planofplan', 'bin');
  const openScript = join(binDir, 'open');
  if (!existsSync(openScript)) {
    mkdirSync(binDir, { recursive: true });
    const scriptContent = [
      '#!/bin/sh',
      'if [ -n "$PLANOFPLAN_OPEN_SENTINEL" ]; then',
      '  echo "$@" > "$PLANOFPLAN_OPEN_SENTINEL"',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(openScript, scriptContent, { mode: 0o755 });
  }
  return binDir;
}

/** 异步执行命令并取 stdout;超时杀进程。 */
async function execAsync(bin: string, args: string[], timeoutMs: number): Promise<string> {
  // daemon 的 launchd PATH 只有 /usr/bin:/bin — agy 需要更完整的环境
  // 启动子进程(language server 等)。补齐常见路径 + 继承 HOME。
  const home = process.env.HOME ?? '';
  const noopBinDir = ensureNoopOpenBin();
  const proxyEnv = getProxyEnv();
  const sentinelPath = join(tmpdir(), `pop-agy-sentinel-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);

  const env: Record<string, string> = {
    ...process.env,
    ...proxyEnv,
    HOME: home,
    BROWSER: join(noopBinDir, 'open'),
    PLANOFPLAN_OPEN_SENTINEL: sentinelPath,
    PATH: [
      noopBinDir,
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      process.env.PATH ?? '',
    ].filter(Boolean).join(':'),
  };

  const proc = Bun.spawn([bin, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env,
  });

  const intercepted: { url: string | null } = { url: null };
  const checkTimer = setInterval(() => {
    try {
      if (existsSync(sentinelPath)) {
        intercepted.url = readFileSync(sentinelPath, 'utf8').trim();
        proc.kill();
      }
    } catch {}
  }, 200);

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    // 并发读 stdout/stderr:串行读在进程快速退出时会错过 pipe 数据
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text().catch(() => ''),
    ]);
    const code = await proc.exited;

    if (intercepted.url !== null) {
      const target = intercepted.url ? ` (${intercepted.url.slice(0, 60)}...)` : '';
      throw new AdapterError(
        'auth',
        `agy 鉴权失效并尝试打开浏览器登录${target}，已自动拦截防打扰（请在终端手动运行 agy 重新登录）`,
      );
    }

    if (code !== 0) {
      // agy 可能把错误打到 stdout(如 auth 错误输出 JSON),两个都带上
      const diag = (stderr || stdout || '').slice(0, 160);
      throw new Error(`exit ${code}: ${diag}`);
    }
    return stdout;
  } finally {
    clearInterval(checkTimer);
    clearTimeout(timer);
    try { unlinkSync(sentinelPath); } catch {}
  }
}

export const agyAdapter: PlanAdapter = {
  slug: 'agy',

  credentialHint: 'agy CLI 登录态（本地 Google OAuth，无需手动 key）',

  async detectCredentials(_ctx: AdapterContext): Promise<Credential | null> {
    const bin = findAgyBinary();
    if (!bin) return null;
    return { kind: 'bearer', value: 'local-cli', source: 'local' };
  },

  async fetchUsage(_ctx: AdapterContext, _cred: Credential): Promise<QuotaWindow[]> {
    const bin = findAgyBinary();
    if (!bin) {
      throw new AdapterError('auth', '未找到 agy CLI（安装：Google Antigravity 或设 AGY_PATH）');
    }
    let raw: string;
    try {
      raw = await execAsync(bin, ['-p', '/usage', '--output-format', 'json'], USAGE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('auth') || msg.includes('login')) {
        throw new AdapterError('auth', 'agy 未登录（运行 agy 登录 Google 账号）');
      }
      throw new AdapterError('api', `agy CLI 调用失败：${msg.slice(0, 120)}`);
    }
    return parseAgyUsage(raw);
  },
};
