import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLANS, normalizePlanSet } from '../src/config.ts';

describe('plan configuration', () => {
  test('默认配置只暴露一个 GLM plan，且不要求 region', () => {
    const glm = DEFAULT_PLANS.filter((plan) => plan.adapter === 'glm');
    expect(glm).toHaveLength(1);
    expect(glm[0]!.slug).toBe('glm');
    expect(glm[0]!.extra.region).toBeUndefined();
  });

  test('旧版 legacy/current GLM 配置归一化为一个 plan', () => {
    const plans = normalizePlanSet([
      { ...DEFAULT_PLANS[1]!, slug: 'glm_legacy', name: 'GLM legacy' },
      { ...DEFAULT_PLANS[1]!, slug: 'glm_current', name: 'GLM current' },
    ]);
    const glm = plans.filter((plan) => plan.adapter === 'glm');
    expect(glm).toHaveLength(1);
    expect(glm[0]!.slug).toBe('glm');
  });
});
