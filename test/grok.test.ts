import { describe, expect, test } from 'bun:test';
import { normalizeGrok, grokExpiryMs } from '../src/adapters/grok.ts';
import { AdapterError } from '../src/types.ts';

describe('normalizeGrok', () => {
  test('creditUsagePercent 直出 + currentPeriod.end 重置时间', () => {
    const raw = {
      config: {
        creditUsagePercent: 12.5,
        currentPeriod: { end: '2026-08-24T00:00:00Z' },
      },
    };
    const w = normalizeGrok(raw);
    expect(w).toHaveLength(1);
    expect(w[0]!.window).toBe('credits_period');
    expect(w[0]!.percentage).toBe(12.5);
    expect(w[0]!.resetAt).toBe(Date.parse('2026-08-24T00:00:00Z'));
  });

  test('无百分比时用 onDemandUsed/Cap 比值', () => {
    const raw = {
      config: { billingPeriodEnd: '2026-08-31T00:00:00Z' },
      onDemandUsed: { val: 25 },
      onDemandCap: { val: 100 },
    };
    const w = normalizeGrok(raw);
    expect(w[0]!.percentage).toBe(25);
    expect(w[0]!.resetAt).toBe(Date.parse('2026-08-31T00:00:00Z'));
  });

  test('可解析周期但无值 → 0%（CodexBar 规则）', () => {
    const w = normalizeGrok({ config: { currentPeriod: { end: '2026-08-24T00:00:00Z' } } });
    expect(w[0]!.percentage).toBe(0);
  });

  test('非对象 → parse 错误', () => {
    expect(() => normalizeGrok(null)).toThrow(AdapterError);
  });
});

describe('grok 凭据过期解析（grok login 实际写 ISO 字符串）', () => {
  test('ISO 字符串 → ms', () => {
    expect(grokExpiryMs({ expires_at: '2026-08-17T20:26:28.149076Z' })).toBe(
      Date.parse('2026-08-17T20:26:28.149076Z'),
    );
  });

  test('数字 epoch 秒 → ms', () => {
    expect(grokExpiryMs({ expires_at: 1_787_000_000 })).toBe(1_787_000_000_000);
  });

  test('缺失 → null（CodexBar：无过期字段视为可用）', () => {
    expect(grokExpiryMs({})).toBeNull();
    expect(grokExpiryMs({ expires_at: 'not-a-date' })).toBeNull();
  });
});
