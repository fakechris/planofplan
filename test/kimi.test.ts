import { describe, expect, test } from 'bun:test';
import { normalizeKimi } from '../src/adapters/kimi.ts';
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
