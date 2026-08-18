import { describe, expect, test } from 'bun:test';
import { normalizeKimi, normalizeKimiMonthly, shouldRefreshCliToken } from '../src/adapters/kimi.ts';
import { AdapterError } from '../src/types.ts';

describe('normalizeKimi', () => {
  test('kimi.md 样例：weekly(usage) + 5h(limits[0].detail)，字符串值转数字', () => {
    const raw = {
      usage: {
        limit: '2048',
        used: '214',
        remaining: '1834',
        resetTime: '2026-01-09T15:23:13.716839300Z',
      },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: {
            limit: '200',
            used: '139',
            remaining: '61',
            resetTime: '2026-01-06T13:33:02.717479433Z',
          },
        },
      ],
    };
    const windows = normalizeKimi(raw);
    expect(windows).toHaveLength(2);
    const weekly = windows.find((w) => w.window === 'weekly')!;
    expect(weekly.used).toBe(214);
    expect(weekly.total).toBe(2048);
    expect(weekly.percentage).toBeCloseTo(10.449, 1);
    expect(weekly.resetAt).toBe(Date.parse('2026-01-09T15:23:13.716Z'));
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.used).toBe(139);
    expect(five.total).toBe(200);
    expect(five.percentage).toBe(69.5);
  });

  test('实测（2026-08-18）：5h detail 只有 limit+remaining（无 used）→ 用 remaining 反推', () => {
    const raw = {
      usage: null,
      limits: [
        {
          window: { duration: 300 },
          detail: {
            limit: '100',
            remaining: '3',
            resetTime: '2026-08-18T09:03:40Z',
          },
        },
      ],
    };
    const windows = normalizeKimi(raw);
    expect(windows).toHaveLength(1);
    const five = windows[0]!;
    expect(five.window).toBe('rolling_5h');
    expect(five.used).toBe(97);
    expect(five.total).toBe(100);
    expect(five.percentage).toBe(97);
    expect(five.resetAt).toBe(Date.parse('2026-08-18T09:03:40Z'));
  });

  test('数字类型值也能解析', () => {
    const raw = {
      usage: { limit: 1024, used: 512, resetTime: '2026-01-09T00:00:00Z' },
      limits: [],
    };
    const windows = normalizeKimi(raw);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.percentage).toBe(50);
  });

  test('空响应 → parse 错误', () => {
    expect(() => normalizeKimi({})).toThrow(AdapterError);
    expect(() => normalizeKimi(null)).toThrow(AdapterError);
  });
});

describe('normalizeKimiMonthly（GetSubscriptionStats → subscriptionBalance）', () => {
  test('amountUsedRatio(0-1) + expireTime → Month 窗口（×100）', () => {
    const w = normalizeKimiMonthly({
      subscriptionBalance: {
        feature: 'FEATURE_OMNI',
        type: 'SUBSCRIPTION',
        amountUsedRatio: 0.42,
        expireTime: '2026-09-01T00:00:00Z',
      },
    });
    expect(w).not.toBeNull();
    expect(w!.window).toBe('monthly');
    expect(w!.label).toBe('Month');
    expect(w!.percentage).toBeCloseTo(42, 5);
    expect(w!.resetAt).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(w!.note).toContain('Total usage');
  });

  test('amountUsedRatio 已为百分制（>1.5）→ 不再 ×100', () => {
    const w = normalizeKimiMonthly({ subscriptionBalance: { amountUsedRatio: 42 } });
    expect(w!.percentage).toBe(42);
  });

  test('超界钳制：ratio > 1 或负值 → 0-100', () => {
    expect(normalizeKimiMonthly({ subscriptionBalance: { amountUsedRatio: 1.2 } })!.percentage).toBe(100);
    expect(normalizeKimiMonthly({ subscriptionBalance: { amountUsedRatio: -0.3 } })!.percentage).toBe(0);
  });

  test('非 OMNI 或非 SUBSCRIPTION 订阅池 → null（Code 专属池会重复周额度）', () => {
    expect(
      normalizeKimiMonthly({ subscriptionBalance: { feature: 'FEATURE_CODING', amountUsedRatio: 0.5 } }),
    ).toBeNull();
    expect(normalizeKimiMonthly({ subscriptionBalance: { type: 'CREDIT', amountUsedRatio: 0.5 } })).toBeNull();
  });

  test('无 subscriptionBalance / 非对象响应 → null', () => {
    expect(normalizeKimiMonthly({})).toBeNull();
    expect(normalizeKimiMonthly({ data: {} })).toBeNull();
    expect(normalizeKimiMonthly(null)).toBeNull();
    expect(normalizeKimiMonthly('x')).toBeNull();
  });
});

describe('shouldRefreshCliToken（可选 KIMI_USE_REFRESH=1）', () => {
  const now = Date.now();
  test('开启且过期 → true', () => {
    const cli = { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(now / 1000) - 100 };
    expect(shouldRefreshCliToken(cli, now, true)).toBe(true);
  });
  test('默认关闭 → false；token 仍有效 → false', () => {
    const cli = {
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Math.floor(now / 1000) + 600,
    };
    expect(shouldRefreshCliToken(cli, now, false)).toBe(false);
    expect(shouldRefreshCliToken(cli, now, true)).toBe(false);
  });
  test('无 refresh_token → false', () => {
    expect(shouldRefreshCliToken({ access_token: 'a' }, now, true)).toBe(false);
    expect(shouldRefreshCliToken(null, now, true)).toBe(false);
  });
});
