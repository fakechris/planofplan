import { describe, expect, test } from 'bun:test';
import { fetchOfficialUsage } from '../src/official-usage.ts';

describe('official analytics usage', () => {
  test('normalizes Anthropic and Factory daily model data as official records', async () => {
    const previousFetch = globalThis.fetch;
    const previousAnthropic = process.env.ANTHROPIC_ADMIN_API_KEY;
    const previousFactory = process.env.FACTORY_API_KEY;
    process.env.ANTHROPIC_ADMIN_API_KEY = 'test-anthropic';
    process.env.FACTORY_API_KEY = 'test-factory';
    globalThis.fetch = (async (input: string | Request | URL) => {
      const url = String(input);
      if (url.includes('anthropic.com')) {
        return Response.json({
          data: [{
            date: '2026-08-17',
            model_breakdown: [{
              model: 'claude-sonnet-4',
              tokens: { input: 100, output: 20, cache_read: 5, cache_creation: 2 },
              estimated_cost: { amount: 12 },
            }],
          }],
        });
      }
      return Response.json({
        data: [{
          date: '2026-08-17',
          billable_tokens: 80,
          by_model: [{
            model: 'droid-standard',
            input_tokens: 60,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
          }],
        }],
      });
    }) as typeof fetch;
    try {
      const records = await fetchOfficialUsage({
        since: Date.parse('2026-08-17T00:00:00.000Z'),
        until: Date.parse('2026-08-18T00:00:00.000Z'),
      });
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.source === 'official' && record.confidence === 'official')).toBe(true);
      expect(records.find((record) => record.provider === 'claude')).toMatchObject({
        totalTokens: 120,
        estimatedCostUsd: 0.12,
      });
      expect(records.find((record) => record.provider === 'factory')).toMatchObject({
        totalTokens: 80,
        billableTokens: 80,
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousAnthropic == null) delete process.env.ANTHROPIC_ADMIN_API_KEY;
      else process.env.ANTHROPIC_ADMIN_API_KEY = previousAnthropic;
      if (previousFactory == null) delete process.env.FACTORY_API_KEY;
      else process.env.FACTORY_API_KEY = previousFactory;
    }
  });
});
