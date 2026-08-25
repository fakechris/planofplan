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
    expect(five.label).toBe('5小时限额');
    expect(five.resetAt).toBe(1735401600 * 1000); // 秒 → 毫秒
    const weekly = windows.find((w) => w.window === 'weekly')!;
    expect(weekly.percentage).toBe(5);
    expect(weekly.label).toBe('周限额');
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

  test('2026-08 新嵌套形态:prolite 顶层=周,5h 在 additional 的 rate_limit 里', () => {
    // 真实响应缩影:chatgpt.com/backend-api/wham/usage,plan_type=prolite
    const windows = normalizeCodex({
      plan_type: 'prolite',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1788275961 },
        secondary_window: null,
        additional_rate_limits: [
          {
            limit_name: 'GPT-5.3-Codex-Spark',
            metered_feature: 'codex_bengalfox',
            rate_limit: {
              primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1787689161 },
              secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1788275961 },
            },
          },
        ],
      },
      credits: { has_credits: false },
    });
    // 顶层周限额 + Spark 5h + Spark 周
    expect(windows.map((w) => `${w.label}:${w.percentage}`)).toEqual([
      '周限额:0',
      'Spark·5h限额:42',
      'Spark·周限额:7',
    ]);
    const spark5h = windows[1]!;
    expect(spark5h.resetAt).toBe(1787689161 * 1000);
  });

  test('uses the API window duration when primary is the weekly limit', () => {
    const windows = normalizeCodex({
      rate_limit: {
        primary_window: {
          used_percent: 37,
          reset_at: 1_735_401_600,
          limit_window_seconds: 604800,
        },
      },
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      window: 'weekly',
      label: '周限额',
      percentage: 37,
    });
  });

  test('空响应 → parse 错误', () => {
    expect(() => normalizeCodex({})).toThrow(AdapterError);
    expect(() => normalizeCodex(null)).toThrow(AdapterError);
  });
});
