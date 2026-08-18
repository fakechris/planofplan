import { describe, expect, test } from 'bun:test';
import { normalizeCodex } from '../src/adapters/codex.ts';
import { AdapterError } from '../src/types.ts';

describe('normalizeCodex', () => {
  test('标准响应（codex-oauth.md 样例）：5h + weekly + credits', () => {
    const raw = {
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 15,
          reset_at: 1735401600,
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used_percent: 5,
          reset_at: 1735920000,
          limit_window_seconds: 604800,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: 150.0 },
    };
    const windows = normalizeCodex(raw);
    expect(windows).toHaveLength(3);
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.percentage).toBe(15);
    expect(five.resetAt).toBe(1735401600 * 1000); // 秒 → 毫秒
    const weekly = windows.find((w) => w.window === 'weekly')!;
    expect(weekly.percentage).toBe(5);
    const credits = windows.find((w) => w.window === 'credits')!;
    expect(credits.unit).toBe('usd');
    expect(credits.used).toBe(150);
    expect(credits.percentage).toBeNull();
  });

  test('无 credits → 只有两个窗口；has_credits=false 不渲染 credits', () => {
    const raw = {
      rate_limit: { primary_window: { used_percent: 45, reset_at: 1735401600 } },
      credits: { has_credits: false },
    };
    const windows = normalizeCodex(raw);
    expect(windows.map((w) => w.window)).toEqual(['rolling_5h']);
  });

  test('additional_rate_limits 附加窗口带序号，避免同 key 覆盖', () => {
    const raw = {
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 100 },
        additional_rate_limits: [
          { used_percent: 33, reset_at: 200 },
          { used_percent: 44, reset_at: 300 },
        ],
      },
    };
    const windows = normalizeCodex(raw);
    const extras = windows.filter((w) => w.window === 'extra');
    expect(extras).toHaveLength(2);
    expect(extras.map((w) => w.label)).toEqual(['Extra1', 'Extra2']);
  });

  test('空响应 → parse 错误', () => {
    expect(() => normalizeCodex({})).toThrow(AdapterError);
    expect(() => normalizeCodex(null)).toThrow(AdapterError);
  });
});
