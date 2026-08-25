import { describe, expect, test } from 'bun:test';
import { deepseekAdapter, normalizeDeepseekBalance } from '../src/adapters/deepseek.ts';
import { AdapterError } from '../src/types.ts';

describe('normalizeDeepseekBalance', () => {
  test('单币种：正常余额响应', () => {
    const raw = {
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '100.00',
        granted_balance: '50.00',
        topped_up_balance: '50.00',
        available_balance: '62.50',
      }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.planName).toBe('CNY');
    expect(result.window.window).toBe('credits_period');
    expect(result.window.label).toBe('Balance');
    expect(result.window.unit).toBe('usd');
    expect(result.window.used).toBe(37.5);
    expect(result.window.total).toBe(100);
    expect(result.window.percentage).toBe(37.5);
    expect(result.window.resetAt).toBeNull();
    expect(result.window.note).toContain('CNY');
    expect(result.window.note).toContain('62.5');
  });

  test('多币种：选第一笔 + note 标注币种数量', () => {
    const raw = {
      balance_infos: [
        { currency: 'CNY', total_balance: '10', available_balance: '4' },
        { currency: 'USD', total_balance: '5', available_balance: '5' },
      ],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.total).toBe(10);
    expect(result.window.used).toBe(6);
    expect(result.window.percentage).toBe(60);
    expect(result.window.note).toContain('共 2 个币种账户');
  });

  test('数字字符串字段也接受', () => {
    const raw = {
      balance_infos: [{ currency: 'CNY', total_balance: 8, available_balance: 2 }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.used).toBe(6);
    expect(result.window.total).toBe(8);
  });

  test('余额 100% 已用 → percentage=100', () => {
    const raw = {
      balance_infos: [{ currency: 'CNY', total_balance: '10', available_balance: '0' }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.percentage).toBe(100);
    expect(result.window.used).toBe(10);
  });

  test('响应不是对象 → parse 错误', () => {
    expect(() => normalizeDeepseekBalance('not json' as unknown)).toThrow(AdapterError);
  });

  test('balance_infos 为空 → parse 错误', () => {
    try {
      normalizeDeepseekBalance({ balance_infos: [] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AdapterError).kind).toBe('parse');
    }
  });

  test('必要字段缺失 → parse 错误', () => {
    try {
      normalizeDeepseekBalance({ balance_infos: [{ currency: 'CNY' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AdapterError).kind).toBe('parse');
    }
  });

  test('available_balance 缺失：用 granted + topped_up 兜底', () => {
    // DeepSeek 部分账号类型不返回 available_balance；实际响应：
    // total_balance ≈ granted_balance + topped_up_balance
    const raw = {
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '1861.70',
        granted_balance: '1854.06',
        topped_up_balance: '7.63',
      }],
    };
    const result = normalizeDeepseekBalance(raw);
    // available = 1854.06 + 7.63 ≈ 1861.69，used ≈ 0.01（rounding）
    expect(result.window.total).toBe(1861.7);
    expect(result.window.used).toBeLessThan(0.05);
    expect(result.window.percentage).toBeLessThan(1);
  });

  test('available_balance + granted/topped_up 都缺：用 total 兜底，used=0', () => {
    const raw = {
      balance_infos: [{ currency: 'CNY', total_balance: '100' }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.total).toBe(100);
    expect(result.window.used).toBe(0);
    expect(result.window.percentage).toBe(0);
  });
});

describe('deepseekAdapter', () => {
  test('slug & credentialHint', () => {
    expect(deepseekAdapter.slug).toBe('deepseek');
    expect(deepseekAdapter.credentialHint).toContain('DEEPSEEK_API_KEY');
  });

  test('detectCredentials: env 优先', async () => {
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-test-123';
    const cred = await deepseekAdapter.detectCredentials({
      plan: { slug: 'deepseek', name: 'DeepSeek', adapter: 'deepseek', enabled: true, pollIntervalSec: 60, extra: {} },
      now: () => Date.now(),
      log: () => {},
    });
    expect(cred).toEqual({ kind: 'bearer', value: 'sk-test-123', source: 'env' });
    if (prev != null) process.env.DEEPSEEK_API_KEY = prev;
    else delete process.env.DEEPSEEK_API_KEY;
  });
});
