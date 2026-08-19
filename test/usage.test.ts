import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import {
  buildUsageReport,
  scanClaudeLogs,
  scanCodexLogs,
  scanDroidLogs,
  scanDshLogs,
  scanGrokLogs,
  scanKimiCliLogs,
  scanZcodeLogs,
} from '../src/usage.ts';
import type { UsageRecord } from '../src/types.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-usage-'));
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\nnot-json\n';
}

const DAY = '2026-08-18';
const SINCE = Date.parse(`${DAY}T00:00:00.000Z`);
const UNTIL = Date.parse('2026-08-19T00:00:00.000Z');

describe('local token usage scanners', () => {
  test('ZCode model-io records normalize camelCase usage fields', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'model-io-sess-1.jsonl'), jsonl([{
        type: 'model_io',
        startedAt: `${DAY}T09:00:00.000Z`,
        sessionId: 'z-session',
        model: { modelId: 'claude-sonnet-4', providerId: 'anthropic' },
        response: {
          modelId: 'claude-sonnet-4',
          usage: {
            inputTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            outputTokens: 30,
            reasoningTokens: 4,
            totalTokens: 155,
          },
        },
      }]), 'utf8');

      const records = scanZcodeLogs(root, SINCE, UNTIL);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        provider: 'zcode',
        model: 'claude-sonnet-4',
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 5,
        outputTokens: 30,
        reasoningOutputTokens: 4,
        totalTokens: 155,
        sessionId: 'z-session',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Kimi CLI usage.record maps input cache dimensions', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'wire.jsonl'), jsonl([{
        type: 'usage.record',
        time: Date.parse(`${DAY}T09:30:00.000Z`),
        model: 'kimi-k2',
        usageScope: 'turn',
        usage: {
          inputOther: 40,
          inputCacheRead: 10,
          inputCacheCreation: 2,
          output: 8,
        },
      }]), 'utf8');

      const records = scanKimiCliLogs(root, SINCE, UNTIL);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        provider: 'kimi-cli',
        model: 'kimi-k2',
        inputTokens: 40,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 2,
        outputTokens: 8,
        totalTokens: 60,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Grok CLI unified events normalize ctx token counters', () => {
    const root = tempRoot();
    try {
      const file = join(root, 'unified.jsonl');
      writeFileSync(file, jsonl([{
        ts: `${DAY}T10:00:00.000Z`,
        sid: 'grok-session',
        ctx: {
          prompt_tokens: 70,
          cached_prompt_tokens: 15,
          completion_tokens: 20,
          reasoning_tokens: 5,
        },
      }]), 'utf8');

      const records = scanGrokLogs(file, SINCE, UNTIL);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        provider: 'grok-cli',
        cachedInputTokens: 15,
        inputTokens: 70,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 90,
        sessionId: 'grok-session',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DSH assistant/message records normalize usage from JSONL', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'session.jsonl'), jsonl([{
        type: 'assistant/message',
        time: Date.parse(`${DAY}T10:30:00.000Z`),
        data: {
          message: { source: { provider: 'deepseek', model: 'deepseek-v3' } },
          usage: {
            inputTokens: 80,
            cacheReadTokens: 10,
            outputTokens: 12,
            reasoningTokens: 3,
          },
        },
      }]), 'utf8');

      const records = scanDshLogs(root, SINCE, UNTIL);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        provider: 'dsh',
        model: 'deepseek-v3',
        inputTokens: 80,
        cachedInputTokens: 10,
        outputTokens: 12,
        reasoningOutputTokens: 3,
        totalTokens: 102,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Droid session metadata does not become fake token usage', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'session.jsonl'), jsonl([
        { type: 'session_start', sessionId: 'droid-session' },
        { type: 'message', message: { modelId: 'factory-model' } },
        { type: 'compaction_state', summaryTokens: 999999 },
      ]), 'utf8');

      expect(scanDroidLogs(root, SINCE, UNTIL)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex cumulative token_count records are emitted as deltas', () => {
    const root = tempRoot();
    try {
      const file = join(root, '2026', '08', '19', 'rollout.jsonl');
      mkdirSync(join(root, '2026', '08', '19'), { recursive: true });
      const session = [
        { type: 'session_meta', payload: { session_id: 'session-1' } },
        { type: 'turn_context', timestamp: `${DAY}T10:00:00.000Z`, payload: { model: 'gpt-5', turn_id: 'turn-1' } },
        {
          type: 'event_msg',
          timestamp: `${DAY}T10:01:00.000Z`,
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 8,
                cached_input_tokens: 2,
                output_tokens: 2,
                reasoning_output_tokens: 1,
                total_tokens: 10,
              },
            },
          },
        },
        {
          type: 'event_msg',
          timestamp: `${DAY}T10:01:01.000Z`,
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 8,
                cached_input_tokens: 2,
                output_tokens: 2,
                reasoning_output_tokens: 1,
                total_tokens: 10,
              },
            },
          },
        },
        {
          type: 'event_msg',
          timestamp: `${DAY}T10:02:00.000Z`,
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 15,
                cached_input_tokens: 4,
                output_tokens: 5,
                reasoning_output_tokens: 2,
                total_tokens: 20,
              },
            },
          },
        },
        { type: 'turn_context', timestamp: `${DAY}T10:03:00.000Z`, payload: { model: 'gpt-5', turn_id: 'turn-2' } },
        {
          type: 'event_msg',
          timestamp: `${DAY}T10:03:01.000Z`,
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 5,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
                total_tokens: 6,
              },
            },
          },
        },
      ];
      writeFileSync(file, jsonl(session), 'utf8');

      const records = scanCodexLogs(root, SINCE, UNTIL);

      expect(records).toHaveLength(3);
      expect(records.reduce((sum, record) => sum + record.inputTokens, 0)).toBe(20);
      expect(records.reduce((sum, record) => sum + record.outputTokens, 0)).toBe(6);
      expect(records[1]).toMatchObject({
        provider: 'codex',
        model: 'gpt-5',
        inputTokens: 7,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        totalTokens: 10,
        source: 'local',
        confidence: 'measured',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Claude streaming assistant records are deduplicated by message and request', () => {
    const root = tempRoot();
    try {
      const file = join(root, 'project.jsonl');
      writeFileSync(
        file,
        jsonl([
          {
            type: 'assistant',
            timestamp: `${DAY}T11:00:00.000Z`,
            requestId: 'request-1',
            message: {
              id: 'message-1',
              model: 'claude-sonnet-4-20250514',
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 2,
                cache_creation_input_tokens: 1,
                output_tokens: 3,
              },
            },
          },
          {
            type: 'assistant',
            timestamp: `${DAY}T11:00:01.000Z`,
            requestId: 'request-1',
            message: {
              id: 'message-1',
              model: 'claude-sonnet-4-20250514',
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 2,
                cache_creation_input_tokens: 1,
                output_tokens: 8,
              },
            },
          },
          {
            type: 'assistant',
            timestamp: `${DAY}T11:01:00.000Z`,
            requestId: 'request-2',
            message: {
              id: 'message-2',
              model: 'claude-haiku-4-5-20251001',
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          },
        ]),
        'utf8',
      );

      const records = scanClaudeLogs(root, SINCE, UNTIL);

      expect(records).toHaveLength(2);
      expect(records.find((record) => record.model.includes('sonnet'))).toMatchObject({
        inputTokens: 10,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
        outputTokens: 8,
        totalTokens: 21,
        source: 'local',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('usage report', () => {
  test('aggregates local and official records without merging their provenance', () => {
    const records: UsageRecord[] = [
      {
        id: 'local-1',
        day: DAY,
        timestamp: Date.parse(`${DAY}T10:00:00.000Z`),
        provider: 'codex',
        model: 'gpt-5',
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationInputTokens: 0,
        outputTokens: 30,
        reasoningOutputTokens: 10,
        totalTokens: 130,
        billableTokens: null,
        estimatedCostUsd: 0.5,
        source: 'local',
        confidence: 'measured',
      },
      {
        id: 'official-1',
        day: DAY,
        timestamp: SINCE + 12 * 60 * 60 * 1000,
        provider: 'factory',
        model: 'all',
        inputTokens: 200,
        cachedInputTokens: 50,
        cacheCreationInputTokens: 5,
        outputTokens: 40,
        reasoningOutputTokens: 0,
        totalTokens: 240,
        billableTokens: 240,
        estimatedCostUsd: null,
        source: 'official',
        confidence: 'official',
      },
    ];

    const report = buildUsageReport(records, {
      since: SINCE,
      until: UNTIL,
      generatedAt: UNTIL,
    });

    expect(report.totals).toMatchObject({
      inputTokens: 300,
      outputTokens: 70,
      totalTokens: 370,
      estimatedCostUsd: 0.5,
    });
    expect(report.daily).toHaveLength(1);
    expect(report.models.map((model) => `${model.provider}:${model.model}`)).toEqual([
      'codex:gpt-5',
      'factory:all',
    ]);
      expect(report.sources.map((source) => source.source)).toEqual(['official', 'local']);
  });

  test('Store persists records and returns an aggregated report', () => {
    const store = openMemoryDb();
    const record: UsageRecord = {
      id: 'local-1',
      day: DAY,
      timestamp: Date.parse(`${DAY}T10:00:00.000Z`),
      provider: 'claude',
      model: 'claude-sonnet-4',
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheCreationInputTokens: 5,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      totalTokens: 125,
      billableTokens: null,
      estimatedCostUsd: 0.2,
      source: 'local',
      confidence: 'measured',
    };

    store.upsertUsageRecords([record]);
    expect(store.getUsageReport(SINCE, UNTIL).totals)
      .toMatchObject({ totalTokens: 125, outputTokens: 20 });
    store.upsertUsageRecords([{ ...record, outputTokens: 25, totalTokens: 130 }]);
    expect(store.getUsageReport(SINCE, UNTIL).totals.totalTokens)
      .toBe(130);
  });
});
