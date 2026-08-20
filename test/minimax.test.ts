import { describe, expect, test } from 'bun:test';
import { normalizeMiniMax } from '../src/adapters/minimax.ts';
import { AdapterError } from '../src/types.ts';

const NOW = 1_770_000_000_000;

describe('normalizeMiniMax', () => {
  test('legacy 单 5h 窗口：usage_count 是剩余值，used = total - remaining，resetAt = end_time', () => {
    const raw = {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          start_time: NOW - 3_600_000,
          end_time: NOW + 7_200_000,
          remains_time: 7_200_000,
          current_interval_total_count: 800,
          current_interval_usage_count: 200, // 剩余 200
          model_name: 'MiniMax-M2.5',
        },
      ],
    };
    const { windows } = normalizeMiniMax(raw, NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.window).toBe('rolling_5h');
    expect(windows[0]!.label).toBe('5H');
    expect(windows[0]!.used).toBe(600);
    expect(windows[0]!.total).toBe(800);
    expect(windows[0]!.percentage).toBe(75);
    expect(windows[0]!.resetAt).toBe(NOW + 7_200_000);
  });

  test('有 weekly 车道时渲染第二个窗口（仅当 weekly total > 0）', () => {
    const raw = {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          current_interval_total_count: 100,
          current_interval_usage_count: 40,
          current_interval_remaining_percent: 40,
          current_weekly_total_count: 4000,
          current_weekly_usage_count: 3600,
          current_weekly_remaining_percent: 90,
          weekly_end_time: NOW + 86_400_000 * 3,
          model_name: 'MiniMax-M2.5',
        },
      ],
    };
    const { windows } = normalizeMiniMax(raw, NOW);
    expect(windows).toHaveLength(2);
    const weekly = windows.find((w) => w.window === 'weekly')!;
    expect(weekly.total).toBe(4000);
    // 用 remainingPercent 优先：90% 剩 → 10% 用
    expect(weekly.percentage).toBe(10);
    expect(weekly.resetAt).toBe(NOW + 86_400_000 * 3);
  });

  test('status 3 的占位车道（总量/剩余缺失、剩余 100%）被跳过', () => {
    const raw = {
      base_resp: { status_code: 0 },
      model_remains: [
        { current_interval_status: 3, model_name: 'M2.5' }, // 占位
        {
          current_interval_total_count: 100,
          current_interval_usage_count: 30,
          model_name: 'M2.5',
        },
      ],
    };
    const { windows } = normalizeMiniMax(raw, NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.used).toBe(70);
  });

  test('remainingPercent 优先于 count 计算百分比', () => {
    const raw = {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          current_interval_total_count: 100,
          current_interval_usage_count: 50,
          current_interval_remaining_percent: 20, // 剩 20% → 用 80%
          model_name: 'M2.5',
        },
      ],
    };
    const { windows } = normalizeMiniMax(raw, NOW);
    expect(windows[0]!.percentage).toBe(80);
    expect(windows[0]!.used).toBe(80);
  });

  test('status_code 1004 → auth 错误', () => {
    const raw = {
      base_resp: { status_code: 1004, status_msg: 'please login' },
      model_remains: [],
    };
    expect(() => normalizeMiniMax(raw, NOW)).toThrow(AdapterError);
    try {
      normalizeMiniMax(raw, NOW);
    } catch (e) {
      expect((e as AdapterError).kind).toBe('auth');
    }
  });

  test('无 model_remains → parse 错误', () => {
    expect(() => normalizeMiniMax({ base_resp: { status_code: 0 } }, NOW)).toThrow(
      AdapterError,
    );
  });

  test('模型列表为空 → parse 错误', () => {
    expect(() => normalizeMiniMax(null, NOW)).toThrow(AdapterError);
  });
});

describe('normalizeMiniMax 新版不限量套餐（2026-08 实测响应）', () => {
  const raw = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      {
        model_name: 'general',
        start_time: NOW - 1.2 * 3_600_000,
        end_time: NOW + 3 * 3_600_000,
        remains_time: 13_305_076,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 91,
        current_interval_status: 1,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
        weekly_end_time: NOW + 3 * 86_400_000,
      },
      {
        model_name: 'video',
        end_time: NOW + 12 * 3_600_000,
        remains_time: 45_705_076,
        current_interval_total_count: 3,
        current_interval_usage_count: 3,
        current_interval_remaining_percent: 100,
        current_interval_status: 1,
        current_weekly_total_count: 21,
        current_weekly_usage_count: 21,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 100,
        weekly_end_time: NOW + 3 * 86_400_000,
      },
    ],
  };

  test('general 5h 纯百分比制（counts 为 0 也能得到已用百分比）', () => {
    const { windows } = normalizeMiniMax(raw, NOW);
    const general = windows.find((w) => w.window === 'rolling_5h' && w.label === '5H');
    expect(general?.percentage).toBe(9);
    expect(general?.used).toBeNull();
  });

  test('weekly 不限量显式渲染 ∞ 车道，而不是隐藏', () => {
    const { windows } = normalizeMiniMax(raw, NOW);
    const unlimited = windows.find((w) => w.window === 'weekly_unlimited');
    expect(unlimited?.note).toBe('不限量');
    expect(unlimited?.percentage).toBeNull();
    expect(unlimited?.resetAt).toBe(NOW + 3 * 86_400_000);
  });

  test('video 车道用「视频·」前缀，不再占用裸 Week 标签', () => {
    const { windows } = normalizeMiniMax(raw, NOW);
    expect(windows.find((w) => w.label === '视频·5H')?.total).toBe(3);
    expect(windows.find((w) => w.label === '视频·周')?.total).toBe(21);
    expect(windows.find((w) => w.label === 'Week')?.window).toBe('weekly_unlimited');
  });
});
