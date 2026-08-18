import { describe, expect, test } from 'bun:test';
import { normalizeCursorLegacy, normalizeCursorUsd } from '../src/adapters/cursor.ts';

describe('normalizeCursorLegacy', () => {
  test('request-count 模型（Tendo33 格式）：500/月，重置 = startOfMonth+1 月 UTC', () => {
    const w = normalizeCursorLegacy({
      'gpt-4': { maxRequestUsage: 500, numRequests: 120 },
      startOfMonth: '2026-08-01T00:00:00Z',
    });
    expect(w).not.toBeNull();
    expect(w!.window).toBe('requests');
    expect(w!.label).toBe('Requests');
    expect(w!.used).toBe(120);
    expect(w!.total).toBe(500);
    expect(w!.percentage).toBe(24);
    expect(w!.resetAt).toBe(Date.parse('2026-09-01T00:00:00Z'));
  });

  test('maxRequestUsage <= 0 → null（非 legacy 账号）', () => {
    expect(normalizeCursorLegacy({ 'gpt-4': { maxRequestUsage: 0, numRequests: 5 } })).toBeNull();
  });

  test('无 gpt-4 → null', () => {
    expect(normalizeCursorLegacy({})).toBeNull();
  });
});

describe('normalizeCursorUsd', () => {
  test('USD credit 模型：used=limit-remaining，percent 用 totalPercentUsed', () => {
    const w = normalizeCursorUsd({
      planUsage: { limit: 40000, remaining: 35570, totalPercentUsed: 11.075 },
      billingCycleEnd: '1788888888', // 秒 → ms
    });
    expect(w).not.toBeNull();
    expect(w!.window).toBe('monthly');
    expect(w!.unit).toBe('usd');
    expect(w!.used).toBe(4430);
    expect(w!.total).toBe(40000);
    expect(w!.percentage).toBeCloseTo(11.075, 2);
    expect(w!.resetAt).toBe(1788888888);
  });

  test('无 remaining 时用 limit × percent 反推 used（Ultra 场景）', () => {
    const w = normalizeCursorUsd({
      planUsage: { limit: 40000, totalPercentUsed: 86 },
    });
    expect(w!.used).toBe(34400);
    expect(w!.percentage).toBe(86);
  });

  test('空 planUsage → null', () => {
    expect(normalizeCursorUsd({})).toBeNull();
  });
});
