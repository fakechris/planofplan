import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractMinimaxCodeSession,
  isMinimaxCodeEnvelope,
  isMinimaxCodeSessionFile,
  messagesFromMinimaxCodeRecord,
  minimaxCodeNumericUsage,
  minimaxNativeIdOf,
} from '../src/minimax-code-session.ts';
import { extractSessionFile, extractSessionRecords, sessionKey } from '../src/sessions.ts';
import { scanMinimaxCodeLogs } from '../src/usage.ts';
import { messagesFromRecord } from '../src/transcript.ts';

const DAY_DIR = '2026/11/10';
const SESSION_DIR = '12-43-51-847-session_bXZzX2UzNWIzM2ViZjg4YTQ3ZWI5NGI5NzZjMTFiZmYzMTEy';

/** 脱敏 fixture:行结构取自 ~/.minimax/v2/sessions 真实样本(2026-11-11)。 */
function sampleSession(): unknown[] {
  return [
    {
      message_id: 'm-1', turn_id: 't-1',
      message: {
        role: 'user', timestamp: 1794314634307,
        content: [{ type: 'text', text: '<system-reminder>\nUse `tool_search` to discover permitted tools.\n</system-reminder>' }],
      },
    },
    {
      message_id: 'm-2', turn_id: 't-1',
      message: {
        role: 'user', timestamp: 1794314634350,
        content: [{ type: 'text', text: '解压这个 RAR 并把里面的种子转成磁力链' }],
      },
    },
    {
      message_id: 'm-3', turn_id: 't-1',
      message: {
        role: 'assistant', model: 'MiniMax-M3.1-Flash', provider: 'minimax', api: 'anthropic-messages',
        timestamp: 1794314634408, stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'The user wants me to extract a RAR file.' },
          {
            type: 'toolCall', id: 'call_abaa77876231cb9a063f29f9', name: 'bash',
            arguments: { command: 'ls -la /Users/chris/Downloads' },
          },
        ],
        usage: { input: 46854, output: 236, cacheRead: 368, cacheWrite: 0, totalTokens: 47458, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    },
    {
      message_id: 'm-4', turn_id: 't-1',
      message: {
        role: 'toolResult', toolName: 'bash', toolCallId: 'call_abaa77876231cb9a063f29f9', isError: false,
        timestamp: 1794314638483,
        content: [{ type: 'text', text: 'total 168240' }],
      },
    },
    {
      message_id: 'm-5', turn_id: 't-2',
      message: {
        role: 'assistant', model: 'MiniMax-M3.1-Flash', provider: 'minimax', api: 'anthropic-messages',
        timestamp: 1794314640000, stopReason: 'stop',
        content: [{ type: 'text', text: '已解压完成,磁力链如下…' }],
        usage: { input: 395, output: 376, cacheRead: 47222, cacheWrite: 0, totalTokens: 47993 },
      },
    },
    {
      message_id: 'm-6', turn_id: 't-2',
      message: { role: 'compactionSummary', timestamp: 1794314650000, content: [{ type: 'text', text: '会话摘要:RAR 解压与磁力链转换。' }] },
    },
  ];
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-minimax-code-'));
}

function writeSession(root: string, rows: unknown[]): string {
  const dir = join(root, 'v2', 'sessions', DAY_DIR, SESSION_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'messages.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

describe('minimax-code 会话提取(INV-1816)', () => {
  test('目录名 base64 解 nativeId;标题取首条非信封用户输入;startedAt 毫秒', () => {
    const root = tempRoot();
    try {
      const file = writeSession(root, sampleSession());
      expect(minimaxNativeIdOf(file)).toBe('mvs_e35b33ebf88a47eb94b976c11bff3112');
      const row = extractSessionFile('minimax-code', file, Date.parse('2026-11-10T12:00:00Z'));
      expect(row).toMatchObject({
        id: sessionKey('minimax-code', 'mvs_e35b33ebf88a47eb94b976c11bff3112'),
        provider: 'minimax-code',
        title: '解压这个 RAR 并把里面的种子转成磁力链',
        startedAt: 1794314634307,
        cwd: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('目录名无 base64 段时用目录名兜底;缺席文件返回 null', () => {
    expect(minimaxNativeIdOf('/x/v2/sessions/2026/11/10/plain-dir/messages.jsonl')).toBe('plain-dir');
    expect(extractMinimaxCodeSession(join(tmpdir(), 'no-such-file.jsonl'), Date.now())).toBeNull();
  });

  test('discover:仅收 messages.jsonl 且排除 observability', () => {
    expect(isMinimaxCodeSessionFile('messages.jsonl', '/x/v2/sessions/2026/11/10/s/messages.jsonl')).toBe(true);
    expect(isMinimaxCodeSessionFile('runtime-events.jsonl', '/x/v2/observability/events/runtime-events.jsonl')).toBe(false);
    const root = tempRoot();
    try {
      writeSession(root, sampleSession());
      const rows = extractSessionRecords('minimax-code', join(root, 'v2', 'sessions', DAY_DIR, SESSION_DIR, 'messages.jsonl'), Date.now());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe('minimax-code');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('信封判定', () => {
    expect(isMinimaxCodeEnvelope('<system-reminder>\nfoo')).toBe(true);
    expect(isMinimaxCodeEnvelope('解压这个 RAR')).toBe(false);
  });
});

describe('minimax-code usage 行级解析', () => {
  test('四字段不相交(total = input+output+cacheRead 实测成立),不拆列', () => {
    const numeric = minimaxCodeNumericUsage({ input: 46854, output: 236, cacheRead: 368, cacheWrite: 0, totalTokens: 47458 });
    expect(numeric).toEqual({
      inputTokens: 46854,
      cachedInputTokens: 368,
      cacheCreationInputTokens: 0,
      outputTokens: 236,
      reasoningOutputTokens: 0,
      totalTokens: 47458,
    });
    expect(numeric.inputTokens + numeric.cachedInputTokens + numeric.outputTokens).toBe(numeric.totalTokens);
  });

  test('scanMinimaxCodeLogs:仅 assistant 行入账,model 取 message.model', () => {
    const root = tempRoot();
    try {
      writeSession(root, sampleSession());
      const since = 1794314634307 - 1;
      const records = scanMinimaxCodeLogs(root, since, 1794314640001 + 60_000);
      expect(records).toHaveLength(2); // 两条 assistant
      expect(records[0]).toMatchObject({
        provider: 'minimax-code',
        model: 'MiniMax-M3.1-Flash',
        inputTokens: 46854,
        cachedInputTokens: 368,
        outputTokens: 236,
        totalTokens: 47458,
      });
      expect(records[1]).toMatchObject({ inputTokens: 395, cachedInputTokens: 47222, outputTokens: 376 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('坏行/窗口外不入账', () => {
    const root = tempRoot();
    try {
      const dir = join(root, 'v2', 'sessions', DAY_DIR, SESSION_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'messages.jsonl'), '{broken json\n{"message":{"role":"assistant","timestamp":1794314634408,"model":"MiniMax-M3.1-Flash","usage":{"input":10,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":11}}}\n', 'utf8');
      const records = scanMinimaxCodeLogs(root, 1794314634407, 1794314634409);
      expect(records).toHaveLength(1);
      const none = scanMinimaxCodeLogs(root, 0, 1794314634407);
      expect(none).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('minimax-code 消息索引', () => {
  test('user 信封排除;assistant text+toolCall;thinking/toolResult/compactionSummary 处理正确', () => {
    const sessionId = 'minimax-code:mvs_x';
    const rows = sampleSession().flatMap((record, index) => (
      messagesFromRecord('minimax-code', sessionId, record as Record<string, unknown>, index + 1)
    ));
    const texts = rows.filter((r) => r.kind === 'text');
    expect(texts).toHaveLength(2); // 信封 user 行被滤,assistant text 1 条 + compactionSummary 是 summary 不算 text
    expect(texts[0]).toMatchObject({ role: 'user', text: expect.stringContaining('解压') });
    expect(texts[1]).toMatchObject({ role: 'assistant', model: 'MiniMax-M3.1-Flash' });
    const tools = rows.filter((r) => r.kind === 'tool_use');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: 'bash' });
    expect(tools[0]!.text).toContain('ls -la');
    const summaries = rows.filter((r) => r.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ role: 'system', text: expect.stringContaining('会话摘要') });
    // thinking 块不入消息
    expect(JSON.stringify(rows)).not.toContain('extract a RAR');
    // toolResult 不出工具行
    expect(rows.filter((r) => r.toolName === 'toolResult')).toHaveLength(0);
  });
});
