import { describe, expect, test } from 'bun:test';
import { normalizeGrok, grokExpiryMs } from '../src/adapters/grok.ts';
import { AdapterError, type AdapterContext } from '../src/types.ts';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('Grok mature CLI fallback', () => {
  test('HTTP token rejection falls back to grok agent stdio billing RPC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planofplan-grok-'));
    const binary = join(root, 'grok');
    await writeFile(
      binary,
      `#!/bin/sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"1"}}'
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"config":{"creditUsagePercent":37,"currentPeriod":{"end":"2026-09-01T00:00:00Z"}}}}'
`,
      { mode: 0o700 },
    );
    await chmod(binary, 0o700);
    await writeFile(
      join(root, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::supergrok': {
          key: 'expired-auth-file-token',
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    );

    const previousFetch = globalThis.fetch;
    const previousBinary = process.env.GROK_CLI_BINARY;
    const previousHome = process.env.GROK_HOME;
    process.env.GROK_CLI_BINARY = binary;
    process.env.GROK_HOME = root;
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    try {
      const { grokAdapter } = await import('../src/adapters/grok.ts');
      const ctx = {
        plan: { slug: 'grok', name: 'Grok', adapter: 'grok', enabled: true, pollIntervalSec: 300, extra: {} },
        now: Date.now,
        log: () => {},
      } as AdapterContext;
      await expect(grokAdapter.detectCredentials(ctx)).resolves.toMatchObject({ source: 'cli' });
      const windows = await grokAdapter.fetchUsage(ctx, {
        kind: 'bearer',
        value: 'expired-auth-file-token',
        source: 'auto',
      });
      expect(windows[0]?.percentage).toBe(37);
      expect(windows[0]?.resetAt).toBe(Date.parse('2026-09-01T00:00:00Z'));
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBinary == null) delete process.env.GROK_CLI_BINARY;
      else process.env.GROK_CLI_BINARY = previousBinary;
      if (previousHome == null) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
