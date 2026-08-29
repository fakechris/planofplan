import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  loadPricingSnapshot,
  priceFromSnapshot,
  refreshPricingSnapshot,
  snapshotFromLiteLLM,
  type PricingSnapshot,
} from '../src/pricing.ts';

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'pop-pricing-')), name);
}

describe('快照读取与匹配', () => {
  test('损坏/缺失的快照返回 null(走家族表兜底)', () => {
    expect(loadPricingSnapshot(tempFile('missing.json'))).toBeNull();
    const corrupt = tempFile('corrupt.json');
    writeFileSync(corrupt, '{not json');
    expect(loadPricingSnapshot(corrupt)).toBeNull();
    const empty = tempFile('empty.json');
    writeFileSync(empty, JSON.stringify({ source: 'litellm', fetchedAt: 1, models: {} }));
    const snapshot = loadPricingSnapshot(empty);
    expect(snapshot).not.toBeNull();
    expect(priceFromSnapshot(snapshot!, 'any-model')).toBeNull();
  });

  test('精确匹配 → 去 provider 前缀 → 去日期后缀,逐级回退', () => {
    const snapshot: PricingSnapshot = {
      source: 'test',
      fetchedAt: 1,
      models: {
        'claude-test-opus': { input: 10, cached: 1, cacheCreation: 12, output: 40 },
        'gpt-test-5': { input: 2, cached: 0.2, cacheCreation: 2, output: 8 },
      },
    };
    expect(priceFromSnapshot(snapshot, 'claude-test-opus')?.input).toBe(10);
    expect(priceFromSnapshot(snapshot, 'anthropic/claude-test-opus')?.input).toBe(10);
    expect(priceFromSnapshot(snapshot, 'gpt-test-5-2026-08-29')?.input).toBe(2);
    expect(priceFromSnapshot(snapshot, 'Claude-Test-Opus')?.input).toBe(10);
    expect(priceFromSnapshot(snapshot, 'unknown-model')).toBeNull();
  });

  test('LiteLLM payload 映射:per-token ×1e6,跳过无价/按字符计费条目', () => {
    const snapshot = snapshotFromLiteLLM({
      'provider/good-model': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
      },
      'embedding-only': { input_cost_per_token: 0.0000001 },
      'by-char': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, input_cost_per_character: 0.000003 },
    });
    expect(Object.keys(snapshot.models)).toEqual(['provider/good-model']);
    const price = snapshot.models['provider/good-model']!;
    expect(price.input).toBeCloseTo(3);
    expect(price.output).toBeCloseTo(15);
    expect(price.cached).toBeCloseTo(0.3);
    expect(price.cacheCreation).toBeCloseTo(3.75);
  });
});

describe('refresh 落盘', () => {
  test('注入 fetch 的刷新:写文件 + 立即可查 + 失败不落盘', async () => {
    const path = tempFile('snapshot.json');
    const ok = await refreshPricingSnapshot(
      'https://example.test/prices',
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ 'm1': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000003 } }),
      }),
      path,
    );
    expect(ok.ok).toBe(true);
    expect(ok.models).toBe(1);
    const snapshot = loadPricingSnapshot(path);
    expect(priceFromSnapshot(snapshot!, 'm1')?.output).toBeCloseTo(3);

    const failPath = tempFile('should-not-exist.json');
    const fail = await refreshPricingSnapshot('https://example.test/x', async () => ({ ok: false, status: 503, json: async () => ({}) }), failPath);
    expect(fail.ok).toBe(false);
    expect(fail.error).toBe('HTTP 503');
    expect(loadPricingSnapshot(failPath)).toBeNull();
    rmSync(dirname(path), { recursive: true, force: true });
  });
});
