import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import {
  buildUsageReport,
  collectUsageReport,
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
        // prompt_tokens(70)是含 cached 的全量,入库前拆列:非缓存输入 55
        inputTokens: 55,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 90,
        sessionId: 'grok-session',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Grok CLI 模型回填:catalog 事件就近 + 全文件唯一模型作默认', () => {
    const root = tempRoot();
    try {
      const file = join(root, 'unified.jsonl');
      writeFileSync(file, jsonl([
        // 首条 usage 在任何 catalog 事件之前:默认模型由全文件唯一 current_model_id 回填
        { ts: `${DAY}T10:00:00.000Z`, ctx: { prompt_tokens: 10, completion_tokens: 2 } },
        { ts: `${DAY}T10:00:01.000Z`, ctx: { current_model_id: 'grok-4.7', model_count: 4 } },
        { ts: `${DAY}T10:00:02.000Z`, ctx: { prompt_tokens: 20, completion_tokens: 3 } },
      ]), 'utf8');
      const records = scanGrokLogs(file, SINCE, UNTIL);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ model: 'grok-4.7' });
      expect(records[1]).toMatchObject({ model: 'grok-4.7' });
      // 无 catalog 事件的文件保持 unknown(不虚构)
      const other = join(root, 'other.jsonl');
      writeFileSync(other, jsonl([{ ts: `${DAY}T10:00:03.000Z`, ctx: { prompt_tokens: 5, completion_tokens: 1 } }]), 'utf8');
      const lone = scanGrokLogs(other, SINCE, UNTIL);
      expect(lone[0]).toMatchObject({ model: 'unknown' });
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

  test('Codex last 直加不受 resume 链 total 延续影响;subagent 重放段被跳过', () => {
    const root = tempRoot();
    try {
      const dir = join(root, '2026', '08', '19');
      mkdirSync(dir, { recursive: true });
      const subagentFile = join(dir, 'rollout-sub.jsonl');
      writeFileSync(subagentFile, jsonl([
        // subagent:session_meta 带 thread_spawn;创建分钟 10:05
        { type: 'session_meta', timestamp: `${DAY}T10:05:00.000Z`, payload: { source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } } } },
        // 重放段(与创建同分钟):父历史 last 会被双计,必须跳过
        { type: 'event_msg', timestamp: `${DAY}T10:05:00.000Z`, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 90, total_tokens: 990 } } } },
        // 边界后:subagent 自己的量,正常入账
        { type: 'turn_context', timestamp: `${DAY}T10:06:00.000Z`, payload: { model: 'gpt-5' } },
        { type: 'event_msg', timestamp: `${DAY}T10:06:30.000Z`, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2, total_tokens: 22 } } } },
      ]), 'utf8');
      // resume 文件:total 从父终值 990 延续(990→992),但 last 是本 turn 真实值
      const resumeFile = join(dir, 'rollout-resume.jsonl');
      writeFileSync(resumeFile, jsonl([
        { type: 'session_meta', payload: { session_id: 's-resume' } },
        { type: 'turn_context', timestamp: `${DAY}T10:07:00.000Z`, payload: { model: 'gpt-5' } },
        { type: 'event_msg', timestamp: `${DAY}T10:07:01.000Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 992, output_tokens: 95, total_tokens: 1087 }, last_token_usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 5, total_tokens: 7 } } } },
      ]), 'utf8');

      const records = scanCodexLogs(root, SINCE, UNTIL);
      // 重放的 990M 被跳过;只留 resume 1 条 + subagent 自己 1 条
      // (文件名字典序 rollout-resume 先于 rollout-sub)
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ inputTokens: 1, cachedInputTokens: 1, outputTokens: 5 });
      expect(records[1]).toMatchObject({ inputTokens: 15, cachedInputTokens: 5, outputTokens: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('jsonlFiles 收跨天常驻文件(路径日期早但 mtime 新)', () => {
    const root = tempRoot();
    try {
      // 老日期目录里的文件,mtime 设为现在(codex resume 常驻会话形态)
      const dir = join(root, '2026', '07', '01');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'rollout-old.jsonl');
      // 事件时间戳用动态时刻(窗口也是动态 7 天)
      const eventTs = new Date(Date.now() - 3_600_000).toISOString();
      writeFileSync(file, jsonl([
        { type: 'turn_context', timestamp: eventTs, payload: { model: 'gpt-5' } },
        { type: 'event_msg', timestamp: eventTs, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } } },
      ]), 'utf8');
      const now = Date.now() / 1000;
      utimesSync(file, now, now);
      const records = scanCodexLogs(root, Date.now() - 7 * 86_400_000, Date.now());
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ inputTokens: 10, outputTokens: 1 });
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
              total_token_usage: {
                input_tokens: 8,
                cached_input_tokens: 2,
                output_tokens: 2,
                reasoning_output_tokens: 1,
                total_tokens: 10,
              },
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
              total_token_usage: {
                input_tokens: 8,
                cached_input_tokens: 2,
                output_tokens: 2,
                reasoning_output_tokens: 1,
                total_tokens: 10,
              },
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
              total_token_usage: {
                input_tokens: 15,
                cached_input_tokens: 4,
                output_tokens: 5,
                reasoning_output_tokens: 2,
                total_tokens: 20,
              },
              last_token_usage: {
                input_tokens: 7,
                cached_input_tokens: 2,
                output_tokens: 3,
                reasoning_output_tokens: 1,
                total_tokens: 10,
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
              total_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 4,
                output_tokens: 6,
                reasoning_output_tokens: 2,
                total_tokens: 26,
              },
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

      expect(records).toHaveLength(4);
      // v3(INV-1789 后续对账 ccusage):last_token_usage 优先直加(每 turn 完整值,
      // 不受 resume 链 total 延续影响);OpenAI 语义 input 含 cached,入库前拆列。
      // 4 条 last: (8-2)+(8-2)+(7-2)+(5-0) = 6+6+5+5 = 22
      expect(records.reduce((sum, record) => sum + record.inputTokens, 0)).toBe(22);
      expect(records.reduce((sum, record) => sum + record.outputTokens, 0)).toBe(8);
      expect(records[1]).toMatchObject({
        provider: 'codex',
        model: 'gpt-5',
        inputTokens: 6,
        cachedInputTokens: 2,
        outputTokens: 2,
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
  test('incremental collection replaces changed files without duplicating old rows', async () => {
    const root = tempRoot();
    const zcodeRoot = join(root, 'zcode');
    mkdirSync(zcodeRoot, { recursive: true });
    const file = join(zcodeRoot, 'model-io.jsonl');
    const row = (requestId: string, outputTokens: number) => ({
      type: 'model_io',
      requestId,
      completedAt: `${DAY}T10:00:00.000Z`,
      model: { modelId: 'glm-5.3' },
      response: { usage: { inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens } },
    });

    try {
      writeFileSync(file, jsonl([row('request-1', 2), row('request-2', 3)]), 'utf8');
      const store = openMemoryDb();
      const options = {
        since: SINCE,
        until: UNTIL,
        includeOfficial: false,
        codexRoot: join(root, 'codex'),
        claudeRoots: [join(root, 'claude')],
        zcodeRoot,
        kimiRoot: join(root, 'kimi'),
        grokRoot: join(root, 'grok'),
        dshRoot: join(root, 'dsh'),
        droidRoot: join(root, 'droid'),
        antigravityRoot: join(root, 'antigravity'),
        opencodeRoot: join(root, 'opencode'),
        ampRoot: join(root, 'amp'),
        workbuddyRoot: join(root, 'workbuddy'),
        doubaoRoot: join(root, 'doubao'),
      };

      await collectUsageReport(store, options);
      expect(store.getUsageRecords(SINCE, UNTIL)).toHaveLength(2);

      writeFileSync(file, jsonl([row('request-2', 3)]), 'utf8');
      await collectUsageReport(store, options);

      const records = store.getUsageRecords(SINCE, UNTIL);
      expect(records).toHaveLength(1);
      expect(records[0]?.id).toContain('request-2');
      expect(records[0]?.totalTokens).toBe(13);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex append collection resumes from the persisted byte cursor', async () => {
    const root = tempRoot();
    const codexRoot = join(root, 'codex');
    const codexDay = join(codexRoot, '2026', '08', '18');
    mkdirSync(codexDay, { recursive: true });
    const file = join(codexDay, 'rollout.jsonl');
    const event = (inputTokens: number, outputTokens: number) => JSON.stringify({
      type: 'event_msg',
      timestamp: `${DAY}T10:00:00.000Z`,
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } },
      },
    }) + '\n';

    try {
      writeFileSync(file, JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5', turn_id: 'turn-1' },
      }) + '\n' + event(10, 1), 'utf8');
      const store = openMemoryDb();
      const options = {
        since: SINCE,
        until: UNTIL,
        includeOfficial: false,
        codexRoot,
        claudeRoots: [],
        zcodeRoot: join(root, 'zcode'),
        kimiRoot: join(root, 'kimi'),
        grokRoot: join(root, 'grok'),
        dshRoot: join(root, 'dsh'),
        droidRoot: join(root, 'droid'),
        antigravityRoot: join(root, 'antigravity'),
        opencodeRoot: join(root, 'opencode'),
        ampRoot: join(root, 'amp'),
        workbuddyRoot: join(root, 'workbuddy'),
        doubaoRoot: join(root, 'doubao'),
      };

      await collectUsageReport(store, options);
      const cursor = store.getUsageScanFiles('codex')[0];
      expect(cursor?.parsedBytes).toBeGreaterThan(0);
      expect(cursor?.cursorJson).toContain('"eventIndex":1');

      appendFileSync(file, event(15, 2), 'utf8');
      await collectUsageReport(store, options);

      const records = store.getUsageRecords(SINCE, UNTIL);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.totalTokens)).toEqual([11, 6]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

describe('2026-11 价格家族补录(gpt-6.1-sol / grok-4.7 / 混元 hy4)', () => {
  test('三家官方牌价命中,单位 USD/MTok,来源见 usage.ts 注释', () => {
    const mk = (model: string, input: number, cached: number, output: number) =>
      scanRecordsFor(model, input, cached, output);
    // gpt-6.1-sol: $2 / $0.10 / $10 → (1M 输入 + 1M cached + 1M 输出) = $12.10
    expect(mk('gpt-6.1-sol', 1e6, 1e6, 1e6)!.estimatedCostUsd).toBeCloseTo(12.1, 6);
    // gpt-6-astra: $10 / $1.00 / $50 → $61(官方同页)
    expect(mk('gpt-6-astra', 1e6, 1e6, 1e6)!.estimatedCostUsd).toBeCloseTo(61, 6);
    // claude-opus-5-5 走 opus 5 系现价 $5/$0.50/$6.25/$25;claude 是 Anthropic
    // 语义(input 天然不含 cache read,不拆列): 5+0.5+25 = $30.5
    // (旧 /opus/ 兜底是 Opus 3 价 $15/$1.5/$18.75/$75 = $92.25,虚高 3 倍)
    expect(mk('claude-opus-5-5', 1e6, 1e6, 1e6)!.estimatedCostUsd).toBeCloseTo(30.5, 6);
    // 初代 opus-4 仍是 $15/$75 老价(未降价型号):15+1.5+75 = $91.5
    expect(mk('claude-opus-4-20250514', 1e6, 1e6, 1e6)!.estimatedCostUsd).toBeCloseTo(91.5, 6);
    // grok-4.7(<200K 档): $2.20 / $0.55 / $6.60 → $9.35
    expect(mk('grok-4.7', 1e6, 1e6, 1e6)!.estimatedCostUsd).toBeCloseTo(9.35, 6);
    // 混元 hy4(hy4free):¥6/¥0.3/¥18 ≈ $0.83/$0.04/$2.50 → $3.37
    expect(mk('hy4free', 1e6, 1e6, 1e6)!.estimatedCostUsd).toBeCloseTo(3.37, 6);
    // 无价格家族仍为 null(不虚构)
    expect(mk('mystery-model', 1e6, 0, 1e6)!.estimatedCostUsd).toBeNull();
  });

  function scanRecordsFor(model: string, input: number, cached: number, output: number) {
    const root = tempRoot();
    try {
      const file = join(root, 'session.jsonl');
      writeFileSync(file, jsonl([{
        type: 'assistant',
        timestamp: `${DAY}T10:00:00.000Z`,
        message: { id: `m-${model}`, model, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      }]), 'utf8');
      return scanClaudeLogs(root, SINCE, UNTIL)[0] ?? null;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('usage byPlan 归属', () => {
  test('claude provider 下的 glm/MiniMax 模型归入对应 plan，top models 按量排序', () => {
    const base = { day: '2026-08-19', source: 'local' as const, confidence: 'measured' as const,
      inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0,
      reasoningOutputTokens: 0, billableTokens: null, estimatedCostUsd: null, sourceFile: null };
    const now = Date.now();
    const records = [
      { ...base, id: 'a', timestamp: now, provider: 'claude', model: 'claude-opus-5', totalTokens: 100 },
      { ...base, id: 'b', timestamp: now, provider: 'claude', model: 'claude-fable-5', totalTokens: 50 },
      { ...base, id: 'c', timestamp: now, provider: 'claude', model: 'glm-5.2', totalTokens: 30 },
      { ...base, id: 'd', timestamp: now, provider: 'zcode', model: 'GLM-5.3', totalTokens: 20 },
      { ...base, id: 'e', timestamp: now, provider: 'claude', model: 'MiniMax-M3', totalTokens: 10 },
      { ...base, id: 'f', timestamp: now, provider: 'codex', model: 'kimi-k3', totalTokens: 5 },
      { ...base, id: 'g', timestamp: now, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 200 },
      { ...base, id: 'h', timestamp: now, provider: 'claude', model: 'qwen-max', totalTokens: 7 },
      { ...base, id: 'i', timestamp: now, provider: 'claude', model: 'claude-fable-5', totalTokens: 40 },
    ];
    const report = buildUsageReport(records, { since: now - 1000, until: now + 1000 });
    const plans = Object.fromEntries(report.byPlan.map((row) => [row.plan, row]));
    expect(plans.claude.totalTokens).toBe(190);           // claude 壳下只认 Anthropic 家族（fable 50+40）
    expect(plans.claude.topModels.map((m) => m.model)).toContain('claude-fable-5');
    expect(report.byPlan.some((row) => row.topModels.some((m) => m.model === 'qwen-max'))).toBeFalse(); // 未识别第三方不归属
    expect(plans.claude.topModels.map((m) => m.model)).toEqual(['claude-opus-5', 'claude-fable-5']);
    expect(plans.glm.totalTokens).toBe(50);          // claude/glm-5.2 + zcode/GLM-5.3
    expect(plans.minimax.totalTokens).toBe(10);
    expect(plans.kimi.totalTokens).toBe(5);           // codex provider 下的 kimi 模型
    expect(plans.deepseek.totalTokens).toBe(200);
    expect(report.byPlan[0]!.plan).toBe('deepseek');  // 按总量降序
    expect(plans.factory).toBeUndefined();            // 无归属数据不计入
  });
});

describe('byPlan recentSessions 与 dsh 深链', () => {
  test('dsh 会话生成 /s/<sessionId> 深链，claude 会话无 url，按时间降序取 3', () => {
    const base = { day: '2026-08-20', source: 'local' as const, confidence: 'measured' as const,
      inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0,
      reasoningOutputTokens: 0, billableTokens: null, estimatedCostUsd: null, sourceFile: null, project: null };
    const now = Date.now();
    const records = [
      { ...base, id: '1', timestamp: now - 1000, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 10, sessionId: 'session-aaa' },
      { ...base, id: '2', timestamp: now - 2000, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 10, sessionId: 'session-aaa' },
      { ...base, id: '3', timestamp: now - 3000, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 10, sessionId: 'session-bbb' },
      { ...base, id: '4', timestamp: now - 4000, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 10, sessionId: 'session-ccc' },
      { ...base, id: '5', timestamp: now - 4000, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 10, sessionId: 'session-ddd' },
      { ...base, id: '6', timestamp: now, provider: 'claude', model: 'claude-opus-5', totalTokens: 10, sessionId: '739f0942' },
    ];
    const { byPlan } = buildUsageReport(records, { since: now - 10_000, until: now + 1000 });
    const dsh = byPlan.find((row) => row.plan === 'deepseek')!;
    expect(dsh.recentSessions.map((s) => s.sessionId)).toEqual(['session-aaa', 'session-bbb', 'session-ccc']);
    expect(dsh.recentSessions[0]!.url).toMatch(/\/s\/session-aaa$/);
    expect(dsh.recentSessions[0]!.timestamp).toBe(now - 1000);
    const claude = byPlan.find((row) => row.plan === 'claude')!;
    expect(claude.recentSessions[0]!.url).toBeNull();
    const raw = buildUsageReport(
      [{ ...base, id: '9', timestamp: now, provider: 'dsh', model: 'deepseek-v4-flash', totalTokens: 1, sessionId: '739f0942' }],
      { since: now - 1000, until: now + 1000 },
    );
    expect(raw.byPlan[0]!.recentSessions[0]!.url).toBeNull(); // 缺 session- 前缀不生成深链
  });
});
