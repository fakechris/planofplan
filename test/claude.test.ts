import { describe, expect, test } from 'bun:test';
import { normalizeClaude } from '../src/adapters/claude.ts';
import { AdapterError } from '../src/types.ts';

describe('normalizeClaude', () => {
  test('本机实测响应形状：five_hour/seven_day utilization', () => {
    const raw = {
      five_hour: { utilization: 7, limit_dollars: null, used_dollars: null },
      seven_day: { utilization: 18, limit_dollars: null, used_dollars: null },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    };
    const windows = normalizeClaude(raw);
    expect(windows).toHaveLength(2);
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.percentage).toBe(7);
    const week = windows.find((w) => w.window === 'weekly')!;
    expect(week.percentage).toBe(18);
  });

  test('extra_usage 启用且有额定时渲染月度窗口', () => {
    const raw = {
      five_hour: { utilization: 3 },
      seven_day: { utilization: 9 },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100000,
        used_credits: 25000,
        utilization: 25,
      },
    };
    const windows = normalizeClaude(raw);
    expect(windows).toHaveLength(3);
    const month = windows.find((w) => w.window === 'monthly')!;
    expect(month.used).toBe(25000);
    expect(month.total).toBe(100000);
    expect(month.percentage).toBe(25);
    expect(month.unit).toBe('usd');
  });

  test('空响应 → parse 错误', () => {
    expect(() => normalizeClaude({})).toThrow(AdapterError);
    expect(() => normalizeClaude(null)).toThrow(AdapterError);
  });
});
