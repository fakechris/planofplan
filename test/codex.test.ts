import { describe, expect, test } from 'bun:test';
import { harvestLocalRateLimits, normalizeCodex } from '../src/adapters/codex.ts';
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

  test('2026-08 真实 API 响应:additional_rate_limits 挂在根对象', () => {
    // 真实响应:chatgpt.com/backend-api/wham/usage
    const windows = normalizeCodex({
      plan_type: 'prolite',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1788856298 },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: 'GPT-5.3-Codex-Spark',
          metered_feature: 'codex_bengalfox',
          rate_limit: {
            primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1788269498 },
            secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1788856298 },
          },
        },
      ],
      credits: { has_credits: false },
    });
    expect(windows.map((w) => `${w.label}:${w.percentage}`)).toEqual([
      '周限额:0',
      'Spark·5h限额:0',
      'Spark·周限额:0',
    ]);
  });

  test('本地 rollout 收割:按 window_minutes 正确识别 5h 与周限额，不把周限额误判为 5h', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const root = mkdtempSync(j(tmpdir(), 'planofplan-codex-local-weekly-'));
    try {
      const day = j(root, 'sessions', '2026', '08', '28');
      mkdirSync(day, { recursive: true });
      const now = Date.now();
      // prolite rollout: primary 是 window_minutes=10080(周限额)
      const line = JSON.stringify({
        timestamp: new Date(now - 60_000).toISOString(),
        payload: {
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: { used_percent: 15, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 500_000 },
            secondary: null,
          },
        },
      });
      writeFileSync(j(day, 'rollout-weekly.jsonl'), line);
      const windows = harvestLocalRateLimits(root, now);
      expect(windows).toHaveLength(1);
      expect(windows[0]).toMatchObject({
        window: 'local_weekly',
        label: '周限额',
        percentage: 15,
      });
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });

  test('本地 rollout 收割:解析最后一条 rate_limits,过期窗口丢弃', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const root = mkdtempSync(j(tmpdir(), 'planofplan-codex-local-'));
    try {
      const day = j(root, 'sessions', '2026', '08', '25');
      mkdirSync(day, { recursive: true });
      const now = Date.now();
      const line = (pct: number, resetSec: number) => JSON.stringify({
        timestamp: new Date(now - 60_000).toISOString(),
        payload: {
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: pct, window_minutes: 300, resets_at: resetSec },
            secondary: { used_percent: pct / 2, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 500_000 },
          },
        },
      });
      writeFileSync(j(day, 'rollout-x.jsonl'), [
        line(99, Math.floor(now / 1000) - 9_000), // 旧记录(会被后面覆盖)
        line(41, Math.floor(now / 1000) + 3_000), // 最新:5h 41%
      ].join('\n'));
      const windows = harvestLocalRateLimits(root, now);
      expect(windows.map((w) => `${w.label}:${w.percentage}`)).toEqual(['Spark·5h限额:41', 'Spark·周限额:20.5']);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
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
