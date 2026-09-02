/**
 * Antigravity CLI (agy) adapter。
 *
 * 调用 `agy -p "/usage" --output-format json` 非交互获取配额（零 token 消耗，
 * 不留会话）。响应 response 字段是 TSV：每组模型两行（Weekly / 5H Limit
 * Remaining），格式 "<group>\t<type>\t<percent>%\t<resetISO>"。
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
import { existsSync } from 'node:fs';

const USAGE_TIMEOUT_MS = 15_000;

interface AgyUsageResponse {
  status?: string;
  response?: string;
  error?: string;
}

/** TSV 行 → QuotaWindow;解析失败返回 null。 */
function parseQuotaLine(line: string): QuotaWindow | null {
  const [group, type, percentStr, resetIso] = line.split('\t');
  if (!group || !type || !percentStr) return null;
  const pct = parseFloat(percentStr.replace('%', ''));
  if (!Number.isFinite(pct)) return null;
  const resetAt = resetIso ? Date.parse(resetIso) : NaN;
  const isWeekly = type.includes('Weekly');
  const modelLabel = group.includes('Gemini') ? 'Gemini' : group.includes('Claude') ? 'Claude/GPT' : group;
  return {
    window: isWeekly ? 'weekly' : 'rolling_5h',
    label: isWeekly ? `${modelLabel} Week` : `${modelLabel} 5H`,
    used: Math.round((100 - pct) * 100) / 100,
    total: 100,
    unit: 'percent',
    percentage: Math.round((100 - pct) * 100) / 100,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    startedAt: null,
    note: null,
  };
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

/** 异步执行命令并取 stdout;超时杀进程。 */
async function execAsync(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => '');
      throw new Error(`exit ${code}: ${stderr.slice(0, 120)}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
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
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('auth') || msg.includes('login')) {
        throw new AdapterError('auth', 'agy 未登录（运行 agy 登录 Google 账号）');
      }
      throw new AdapterError('api', `agy CLI 调用失败：${msg.slice(0, 120)}`);
    }
    let json: AgyUsageResponse;
    try {
      json = JSON.parse(raw) as AgyUsageResponse;
    } catch {
      throw new AdapterError('parse', `agy 输出不是合法 JSON：${raw.slice(0, 80)}`);
    }
    if (json.status !== 'SUCCESS' || typeof json.response !== 'string') {
      throw new AdapterError('api', `agy 返回异常状态：${json.status ?? json.error ?? 'unknown'}`);
    }
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
  },
};
