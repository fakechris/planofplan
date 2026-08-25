import { describe, expect, test } from 'bun:test';
import { deepseekAdapter, normalizeDeepseekBalance } from '../src/adapters/deepseek.ts';
import { AdapterError } from '../src/types.ts';

describe('normalizeDeepseekBalance', () => {
  test('单币种 CNY：unit=CNY、percentage=null、note 拆分赠额/充值', () => {
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
    expect(result.window.unit).toBe('CNY');
    expect(result.window.percentage).toBeNull();
    expect(result.window.used).toBe(62.5);
    expect(result.window.total).toBe(62.5);
    expect(result.window.resetAt).toBeNull();
    expect(result.window.note).toContain('¥50.00');
    // 中文金额符号 + 千分位 + 两位小数
    expect(result.window.note).toContain('赠额 ¥50.00');
    expect(result.window.note).toContain('充值 ¥50.00');
  });

  test('单币种 USD：unit=USD、note 用 $', () => {
    const raw = {
      is_available: true,
      balance_infos: [{
        currency: 'USD',
        total_balance: '25.00',
        granted_balance: '10.00',
        topped_up_balance: '15.00',
      }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.planName).toBe('USD');
    expect(result.window.unit).toBe('USD');
    expect(result.window.note).toContain('$10.00');
    expect(result.window.note).toContain('$15.00');
    expect(result.window.percentage).toBeNull();
  });

  test('币种代码大小写：currency=cny → 归一为 CNY', () => {
    const raw = {
      balance_infos: [{ currency: 'cny', total_balance: '5', granted_balance: '5', topped_up_balance: '0' }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.unit).toBe('CNY');
    expect(result.planName).toBe('CNY');
  });

  test('币种字段缺失：默认 CNY', () => {
    const raw = {
      balance_infos: [{ total_balance: '3', granted_balance: '3', topped_up_balance: '0' }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.unit).toBe('CNY');
    expect(result.planName).toBe('CNY');
  });

  test('多币种：选第一笔 + note 标注币种数量', () => {
    const raw = {
      balance_infos: [
        { currency: 'CNY', total_balance: '10', granted_balance: '4', topped_up_balance: '6' },
        { currency: 'USD', total_balance: '5', granted_balance: '5', topped_up_balance: '0' },
      ],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.used).toBe(10);
    expect(result.window.total).toBe(10);
    expect(result.window.unit).toBe('CNY');
    expect(result.window.note).toContain('共 2 个币种账户');
  });

  test('数字字符串字段也接受', () => {
    const raw = {
      balance_infos: [{ currency: 'CNY', total_balance: 8, available_balance: 2 }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.used).toBe(2);
    expect(result.window.total).toBe(2);
    expect(result.window.percentage).toBeNull();
  });

  test('balance 为 0：仍然能解析，金额显示 0.00', () => {
    const raw = {
      balance_infos: [{ currency: 'CNY', total_balance: '10', granted_balance: '0', topped_up_balance: '0' }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.used).toBe(0);
    expect(result.window.total).toBe(0);
    expect(result.window.note).toContain('赠额 ¥0.00');
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
    expect(result.window.used).toBe(1861.69);
    expect(result.window.total).toBe(1861.69);
    expect(result.window.percentage).toBeNull();
    // 千分位 + 2 位小数
    expect(result.window.note).toContain('赠额 ¥1,854.06');
    expect(result.window.note).toContain('充值 ¥7.63');
  });

  test('available_balance + granted/topped_up 都缺：用 total 兜底，note 为空', () => {
    const raw = {
      balance_infos: [{ currency: 'CNY', total_balance: '100' }],
    };
    const result = normalizeDeepseekBalance(raw);
    expect(result.window.used).toBe(100);
    expect(result.window.total).toBe(100);
    expect(result.window.percentage).toBeNull();
    // 没有 granted/topped_up 时 note 退回到 null
    expect(result.window.note).toBeNull();
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