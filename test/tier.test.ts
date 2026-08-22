import { describe, expect, test } from 'bun:test';
import {
  annotateWindowsWithTier,
  epochFromLocal,
  getTier,
  isTierPricingEnabled,
  partsInTimezone,
  planWantsTierPricing,
} from '../src/tier.ts';

/** 在测试中注入一个固定 Asia/Shanghai 时刻的 epoch 毫秒（避开 DST 计算误差）。 */
function shanghaiAt(year: number, month: number, day: number, hour: number, minute: number): number {
  return epochFromLocal('Asia/Shanghai', year, month, day, hour, minute);
}

describe('partsInTimezone', () => {
  test('Asia/Shanghai UTC+8 换算', () => {
    const parts = partsInTimezone(Date.UTC(2026, 7, 19, 2, 30, 0), 'Asia/Shanghai');
    expect(parts).toEqual({ year: 2026, month: 8, day: 19, weekday: 3, hour: 10, minute: 30 });
  });

  test('epochFromLocal 与 partsInTimezone 互逆', () => {
    const epoch = shanghaiAt(2026, 8, 22, 14, 0);
    const back = partsInTimezone(epoch, 'Asia/Shanghai');
    expect(back).toEqual({ year: 2026, month: 8, day: 22, weekday: 6, hour: 14, minute: 0 });
  });
});

describe('getTier deepseek', () => {
  test('Wed 10:30 (上午高峰内) → peak, nextChangeAt = 12:00 同日', () => {
    const now = shanghaiAt(2026, 8, 19, 10, 30);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('peak');
    expect(t.multiplier).toBe(1.0);
    expect(t.label).toBe('DeepSeek 高峰');
    expect(t.timezone).toBe('Asia/Shanghai');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 12, 0));
  });

  test('Wed 11:30 (上午高峰末段) → peak, nextChangeAt = 12:00', () => {
    const now = shanghaiAt(2026, 8, 19, 11, 30);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('peak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 12, 0));
  });

  test('Wed 12:00 (整点切换为 offpeak) → offpeak, nextChangeAt = 14:00', () => {
    const now = shanghaiAt(2026, 8, 19, 12, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('offpeak');
    expect(t.multiplier).toBe(0.5);
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 14, 0));
  });

  test('Wed 13:00 (中午空闲) → offpeak, nextChangeAt = 14:00', () => {
    const now = shanghaiAt(2026, 8, 19, 13, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 14, 0));
  });

  test('Wed 17:30 (下午高峰内) → peak, nextChangeAt = 18:00', () => {
    const now = shanghaiAt(2026, 8, 19, 17, 30);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('peak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 18, 0));
  });

  test('Wed 18:00 (高峰结束) → offpeak, nextChangeAt = 次日 09:00', () => {
    const now = shanghaiAt(2026, 8, 19, 18, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 20, 9, 0));
  });

  test('Sat 14:00 (周末下午高峰) → peak, 与 weekday 无关', () => {
    const now = shanghaiAt(2026, 8, 22, 14, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('peak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 22, 18, 0));
  });

  // 2026-08-23 00:00 起 DeepSeek 周末全天低谷（新规则生效前费用仍按旧规则）
  test('新规生效日 Sun 2026-08-23 10:00 → offpeak，下一高峰为周一 09:00', () => {
    const now = shanghaiAt(2026, 8, 23, 10, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('offpeak');
    expect(t.multiplier).toBe(0.5);
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 24, 9, 0));
  });

  test('新规后 Sat 2026-08-29 14:00 → offpeak，下一高峰为 Mon 09:00', () => {
    const now = shanghaiAt(2026, 8, 29, 14, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 31, 9, 0));
  });

  test('新规后周一高峰不变：Mon 2026-08-24 10:00 → peak', () => {
    const now = shanghaiAt(2026, 8, 24, 10, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('peak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 24, 12, 0));
  });

  test('Wed 03:00 (凌晨空闲) → offpeak, nextChangeAt = 当日 09:00', () => {
    const now = shanghaiAt(2026, 8, 19, 3, 0);
    const t = getTier('deepseek', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 9, 0));
  });
});

describe('getTier glm', () => {
  test('Mon 14:00 (高峰起) → peak', () => {
    const now = shanghaiAt(2026, 8, 17, 14, 0);
    const t = getTier('glm', now);
    expect(t.tier).toBe('peak');
    expect(t.label).toBe('GLM 高峰');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 17, 18, 0));
  });

  test('Fri 17:30 (周五高峰末) → peak, nextChangeAt = Fri 18:00 (高峰结束)', () => {
    const now = shanghaiAt(2026, 8, 21, 17, 30);
    const t = getTier('glm', now);
    expect(t.tier).toBe('peak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 21, 18, 0));
  });

  test('Sat 14:00 (周末非高峰) → offpeak, nextChangeAt = Mon 14:00', () => {
    const now = shanghaiAt(2026, 8, 22, 14, 0);
    const t = getTier('glm', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 24, 14, 0));
  });

  test('Wed 19:00 (工作日晚上空闲) → offpeak, nextChangeAt = 次日 14:00', () => {
    const now = shanghaiAt(2026, 8, 19, 19, 0);
    const t = getTier('glm', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 20, 14, 0));
  });

  test('Wed 13:30 (上午空闲) → offpeak, nextChangeAt = 当日 14:00', () => {
    const now = shanghaiAt(2026, 8, 19, 13, 30);
    const t = getTier('glm', now);
    expect(t.tier).toBe('offpeak');
    expect(t.nextChangeAt).toBe(shanghaiAt(2026, 8, 19, 14, 0));
  });
});

describe('getTier 未知 provider', () => {
  test('未注册 provider → 所有字段 null', () => {
    const t = getTier('openai-unknown', Date.now());
    expect(t).toEqual({ tier: null, nextChangeAt: null, multiplier: null, label: null, timezone: null });
  });
});

describe('annotateWindowsWithTier', () => {
  test('peak 时刻给 5H/Week 窗口打 tier 注解', () => {
    const windows = [
      { window: 'rolling_5h', label: '5H' },
      { window: 'weekly', label: 'Week' },
      { window: 'mcp', label: 'MCP' },
    ];
    const result = annotateWindowsWithTier('deepseek', windows, shanghaiAt(2026, 8, 19, 10, 0));
    expect(result[0]).toMatchObject({ tier: 'peak', tierMultiplier: 1.0 });
    expect(result[1]).toMatchObject({ tier: 'peak', tierMultiplier: 1.0 });
    // MCP 窗口与时段无关，跳过注解
    expect(result[2]).toEqual({ window: 'mcp', label: 'MCP' });
  });

  test('offpeak 时刻 5H/Week 注解为 offpeak + 0.5x', () => {
    const windows = [{ window: 'rolling_5h', label: '5H' }];
    const result = annotateWindowsWithTier('glm', windows, shanghaiAt(2026, 8, 22, 14, 0));
    expect(result[0]).toMatchObject({ tier: 'offpeak', tierMultiplier: 0.5 });
  });
});

describe('开关', () => {
  test('planWantsTierPricing 显式开关优先；glm/deepseek 未写 flag 时默认打开', () => {
    expect(planWantsTierPricing(undefined)).toBe(false);
    expect(planWantsTierPricing({})).toBe(false);
    expect(planWantsTierPricing({ peakPricing: 'true' })).toBe(true);
    expect(planWantsTierPricing({ peakPricing: 'false' })).toBe(false);
    expect(planWantsTierPricing({}, 'glm')).toBe(true);
    expect(planWantsTierPricing({}, 'deepseek')).toBe(true);
    expect(planWantsTierPricing({ peakPricing: 'false' }, 'glm')).toBe(false);
    expect(planWantsTierPricing({}, 'codex')).toBe(false);
  });

  test('isTierPricingEnabled 默认开启，PLANOFPPLAN_TIER_PRICING=0 关闭', () => {
    // 默认值由测试运行时未设置 env 决定
    const prev = process.env.PLANOFPPLAN_TIER_PRICING;
    process.env.PLANOFPPLAN_TIER_PRICING = '0';
    expect(isTierPricingEnabled()).toBe(false);
    process.env.PLANOFPPLAN_TIER_PRICING = 'false';
    expect(isTierPricingEnabled()).toBe(false);
    delete process.env.PLANOFPPLAN_TIER_PRICING;
    expect(isTierPricingEnabled()).toBe(true);
    if (prev != null) process.env.PLANOFPPLAN_TIER_PRICING = prev;
  });
});
