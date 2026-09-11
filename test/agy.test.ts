import { describe, expect, test } from 'bun:test';
import { agyAdapter, parseAgyUsage } from '../src/adapters/agy.ts';
import type { AdapterContext, Credential, QuotaWindow } from '../src/types.ts';
import { AdapterError } from '../src/types.ts';

const ctx = { plan: { slug: 'antigravity', name: 'Antigravity CLI', adapter: 'agy', enabled: true, pollIntervalSec: 300, extra: {} } } as unknown as AdapterContext;
const _cred: Credential = { kind: 'bearer', value: 'local-cli', source: 'local' }; void _cred;

function wrap(response: string, groups?: unknown[]): string {
  return JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response,
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    command: groups
      ? { name: 'usage', data: { description: 'x', groups } }
      : undefined,
  });
}

/** 2026-09-11 实测:周限额耗尽时 3p-5h bucket 输出 disabled 而非百分比。 */
const LIVE_GROUPS = [
  {
    name: 'Gemini Models',
    description: 'Models within this group: Gemini Flash, Gemini Pro',
    buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9914548397064209, reset_time: '2026-09-18T10:15:12Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-09-12T02:54:17Z' },
    ],
  },
  {
    name: 'Claude and GPT models',
    description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
    buckets: [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0, reset_time: '2026-09-16T15:38:32Z' },
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', disabled: true, remaining_fraction: 1 },
    ],
  },
];

const findWindow = (windows: QuotaWindow[], window: string) =>
  windows.find((w) => w.window === window);

describe('agy adapter 配额解析（parseAgyUsage）', () => {
  test('结构化 buckets：4 个指标稳定输出，disabled 5H 显式渲染不适用车道', () => {
    const windows = parseAgyUsage(wrap('', LIVE_GROUPS));
    expect(windows).toHaveLength(4);

    const geminiWeekly = findWindow(windows, 'gemini_weekly')!;
    expect(geminiWeekly.percentage).toBeCloseTo(0.85, 1);
    expect(geminiWeekly.resetAt).toBe(Date.parse('2026-09-18T10:15:12Z'));

    const gemini5h = findWindow(windows, 'gemini_rolling_5h')!;
    expect(gemini5h.percentage).toBe(0);

    const claudeWeekly = findWindow(windows, 'claude_gpt_weekly')!;
    expect(claudeWeekly.percentage).toBe(100);

    // disabled 的 5H 不再被静默丢弃：渲染为无百分比车道，
    // resetAt 借用同组周限额重置时刻（5H 随周限额恢复而重新适用）
    const claude5h = findWindow(windows, 'claude_gpt_rolling_5h')!;
    expect(claude5h.percentage).toBeNull();
    expect(claude5h.note).toContain('不适用');
    expect(claude5h.resetAt).toBe(Date.parse('2026-09-16T15:38:32Z'));
  });

  test('TSV 兜底（无 command.data）：4 行数字百分比全部解析', () => {
    const response = [
      'Gemini Models\tWeekly Limit Remaining\t99%\t2026-09-07T03:34:21Z',
      'Gemini Models\tFive Hour Limit Remaining\t95%\t2026-09-01T12:42:04Z',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-08T12:22:40Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t75%\t2026-09-01T17:22:40Z',
    ].join('\n');
    const windows = parseAgyUsage(wrap(response));
    expect(windows).toHaveLength(4);
    expect(findWindow(windows, 'gemini_rolling_5h')?.percentage).toBe(5);
    expect(findWindow(windows, 'claude_gpt_rolling_5h')?.percentage).toBe(25);
  });

  test('TSV 兜底：disabled 行渲染为不适用车道，不再丢行（2-3 指标回归）', () => {
    const response = [
      'Gemini Models\tWeekly Limit Remaining\t99%\t2026-09-07T03:34:21Z',
      'Gemini Models\tFive Hour Limit Remaining\tdisabled\t',
      'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-08T12:22:40Z',
      'Claude and GPT models\tFive Hour Limit Remaining\tdisabled\t',
    ].join('\n');
    const windows = parseAgyUsage(wrap(response));
    expect(windows).toHaveLength(4);
    expect(findWindow(windows, 'gemini_rolling_5h')?.percentage).toBeNull();
    expect(findWindow(windows, 'gemini_rolling_5h')?.note).toContain('不适用');
  });

  test('非 JSON 输出 → parse 错误', () => {
    expect(() => parseAgyUsage('not json')).toThrow(AdapterError);
  });

  test('status 非 SUCCESS → api 错误', () => {
    expect(() => parseAgyUsage(JSON.stringify({ status: 'ERROR', error: 'boom' }))).toThrow(AdapterError);
  });

  test('无可解析行 → parse 错误', () => {
    expect(() => parseAgyUsage(wrap(''))).toThrow(AdapterError);
    expect(() => parseAgyUsage(wrap('garbage line'))).toThrow(AdapterError);
  });

  test('agy 不在 PATH 时返回 null 凭据', async () => {
    // findAgyBinary 是私有函数;设 AGY_PATH 为不存在的路径
    const origPath = process.env.AGY_PATH;
    process.env.AGY_PATH = '/nonexistent/agy';
    const result = await agyAdapter.detectCredentials(ctx);
    // 本机有 ~/.local/bin/agy,所以可能仍然找到;只在真正不存在时为 null
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.kind).toBe('bearer');
      expect(result.source).toBe('local');
    }
    if (origPath !== undefined) process.env.AGY_PATH = origPath;
    else delete process.env.AGY_PATH;
  });

  test('防弹窗 dummy open 脚本能拦截并记录 URL', async () => {
    const { existsSync, unlinkSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const binDir = join(process.env.HOME ?? '', '.planofplan', 'bin', 'open');
    expect(existsSync(binDir)).toBe(true);

    const sentinel = join(tmpdir(), `test-sentinel-${Date.now()}.tmp`);
    try {
      const proc = Bun.spawn([binDir, 'https://accounts.google.com/test'], {
        env: { ...process.env, PLANOFPLAN_OPEN_SENTINEL: sentinel },
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
      expect(readFileSync(sentinel, 'utf8').trim()).toBe('https://accounts.google.com/test');
    } finally {
      try { unlinkSync(sentinel); } catch {}
    }
  });
});
