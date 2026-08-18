import { describe, expect, test } from 'bun:test';
import { normalizeGlm } from '../src/adapters/glm.ts';
import { AdapterError } from '../src/types.ts';

const NOW = 1_770_000_000_000;
const in5h = NOW + 5 * 3_600_000;

describe('normalizeGlm', () => {
  test('JinHanAI 实测样例：TOKENS_LIMIT(5h) + TIME_LIMIT(MCP)，双窗口', () => {
    const raw = {
      code: 200,
      msg: '操作成功',
      data: {
        limits: [
          { type: 'TIME_LIMIT', percentage: 33, nextResetTime: in5h },
          { type: 'TOKENS_LIMIT', percentage: 32, nextResetTime: in5h },
        ],
        level: 'pro',
      },
    };
    const { windows, planName } = normalizeGlm(raw, NOW);
    expect(planName).toBe('pro');
    expect(windows).toHaveLength(2);
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.label).toBe('5H');
    expect(five.percentage).toBe(32);
    expect(five.resetAt).toBe(in5h);
    const mcp = windows.find((w) => w.window === 'mcp')!;
    expect(mcp.label).toBe('MCP');
    expect(mcp.percentage).toBe(33);
  });

  test('legacy 单 TOKENS_LIMIT → 只有 5H 主窗口', () => {
    const raw = {
      code: 200,
      data: {
        limits: [{ type: 'TOKENS_LIMIT', percentage: 41, nextResetTime: NOW + 2 * 3_600_000 }],
      },
    };
    const { windows } = normalizeGlm(raw, NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.window).toBe('rolling_5h');
    expect(windows[0]!.label).toBe('5H');
    expect(windows[0]!.percentage).toBe(41);
  });

  test('两个 TOKENS_LIMIT：短(5h)在前、长(周)在后，按 nextResetTime 排序', () => {
    const raw = {
      code: 0,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: NOW + 6 * 86_400_000 }, // 周，应排后
          { type: 'TOKENS_LIMIT', percentage: 20, nextResetTime: NOW + 3 * 3_600_000 }, // 5h，应排前
        ],
      },
    };
    const { windows } = normalizeGlm(raw, NOW);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.window).toBe('rolling_5h');
    expect(windows[0]!.percentage).toBe(20);
    expect(windows[1]!.window).toBe('weekly');
    expect(windows[1]!.label).toBe('Week');
    expect(windows[1]!.percentage).toBe(10);
  });

  test('unit=3/6 显式分类（opencode-quota 语义）优先于时长排序', () => {
    const raw = {
      code: 200,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 6, percentage: 15, nextResetTime: NOW + 3 * 3_600_000 },
          { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, nextResetTime: NOW + 7 * 86_400_000 },
        ],
      },
    };
    const { windows } = normalizeGlm(raw, NOW);
    expect(windows).toHaveLength(2);
    // 排序按 nextResetTime（unit6 那条 3h 重置排前面），但窗口归属按 unit：unit3→5h、unit6→周
    const five = windows.find((w) => w.window === 'rolling_5h')!;
    expect(five.percentage).toBe(25);
    const week = windows.find((w) => w.window === 'weekly')!;
    expect(week.percentage).toBe(15);
  });

  test('percentage 超界钳制：130 → 100、-5 → 0', () => {
    const raw = {
      code: 0,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 130, nextResetTime: in5h }] },
    };
    expect(normalizeGlm(raw, NOW).windows[0]!.percentage).toBe(100);
    const raw2 = {
      code: 0,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: -5, nextResetTime: in5h }] },
    };
    expect(normalizeGlm(raw2, NOW).windows[0]!.percentage).toBe(0);
  });

  test('percentageIsRemaining 选项：把百分比当剩余值翻转', () => {
    const raw = {
      code: 200,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: in5h }] },
    };
    const { windows } = normalizeGlm(raw, NOW, { percentageIsRemaining: true });
    expect(windows[0]!.percentage).toBe(70);
  });

  test('错误 code → api 错误', () => {
    const raw = { code: 500, msg: 'server error', data: null };
    expect(() => normalizeGlm(raw, NOW)).toThrow(AdapterError);
    try {
      normalizeGlm(raw, NOW);
    } catch (e) {
      expect((e as AdapterError).kind).toBe('api');
    }
  });

  test('鉴权相关 msg/code → auth 错误', () => {
    const raw = { code: 401, msg: 'invalid authorization token', data: null };
    try {
      normalizeGlm(raw, NOW);
    } catch (e) {
      expect((e as AdapterError).kind).toBe('auth');
    }
  });

  test('data 缺失或 limits 为空 → parse 错误', () => {
    expect(() => normalizeGlm({ code: 200, data: undefined }, NOW)).toThrow(AdapterError);
    expect(() => normalizeGlm({ code: 200, data: { limits: [] } }, NOW)).toThrow(AdapterError);
  });
});
