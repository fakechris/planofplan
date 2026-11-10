import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  extractWorkBuddySession,
  isWorkBuddySessionFile,
  messagesFromWorkBuddyRecord,
  parseWorkBuddyHead,
  readWorkBuddyDbSessions,
  workBuddyNumericUsage,
} from '../src/workbuddy-session.ts';
import { extractSessionFile, sessionKey } from '../src/sessions.ts';
import { scanWorkBuddyLogs } from '../src/usage.ts';
import { modelPriceFor } from '../src/pricing.ts';
import { messagesFromRecord } from '../src/transcript.ts';
import { touchesFromRecord } from '../src/file-touches.ts';

const SESSION_ID = '57fbc6db-68c8-4c50-9baa-85b2761d61fd';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-workbuddy-'));
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** 脱敏 fixture:行结构取自 ~/.workbuddy/projects 真实样本(2026-11-09)。 */
function sampleSession(): unknown[] {
  return [
    { type: 'session-meta', id: '01a1babd-f8c5-77ad-9677-a93a74a34ee7', sessionId: SESSION_ID, timestamp: 1794134374597, meta: { 'codebuddy.ai/hostKind': 'unopted' } },
    {
      id: '01a1babd-fad0-7d97-82ea-8020b8b6c8e3', timestamp: 1794134372770, type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder data-role="user-context">\n<user_info>OS Version: darwin</user_info>\n</system-reminder>' }],
    },
    {
      id: '01a1babd-fad1-7d97-82ea-8020b8b6c8e4', timestamp: 1794134372900, type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '评估项目是否适合比赛底座,顺便看下 PDF' }], sessionId: SESSION_ID, cwd: '/Users/chris/source/research/hyperknow',
    },
    { id: 'd921bedd-df2a-4572-825c-6eff5083ca80', timestamp: 1794134376250, type: 'ai-title', aiTitle: '评估项目是否适合比赛底座', sessionId: SESSION_ID, cwd: '/Users/chris/source/research/hyperknow' },
    {
      id: '01a1babe-480b-7f3d-a690-ed18699bc0f9', parentId: '01a1babe-4720-7faa-a2ed-c87842fc07d0', timestamp: 1794134394890, type: 'function_call',
      callId: 'chatcmpl-tool-9315712fe7bda281', name: 'Read', arguments: JSON.stringify({ file_path: '/Users/chris/source/research/hyperknow/README.md' }),
      sessionId: SESSION_ID, cwd: '/Users/chris/source/research/hyperknow',
      providerData: {
        conversationRequestId: '01a1babdf1807189b31a0ba95552a2e9', model: 'hy4-free', requestModelId: 'hy4free', requestModelName: 'Hy4',
        usage: { requests: 1, inputTokens: 46275, outputTokens: 221, totalTokens: 46496, inputTokensDetails: [{ cached_tokens: 44096 }], outputTokensDetails: [{ reasoning_tokens: 8 }] },
      },
    },
    {
      id: '01a1babf-0010-7f3d-a690-ed18699bc0aa', timestamp: 1794134490000, type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '结论:适合作为底座,理由如下…' }], sessionId: SESSION_ID, cwd: '/Users/chris/source/research/hyperknow',
      providerData: { model: 'hy4-free', requestModelId: 'hy4free' },
    },
  ];
}

describe('workbuddy session 提取(INV-1789)', () => {
  test('头部解析:ai-title 官方标题优先,信封 user 文本不做标题,cwd 取结构化字段', () => {
    const root = tempRoot();
    const file = join(root, `${SESSION_ID}.jsonl`);
    try {
      writeFileSync(file, jsonl(sampleSession()), 'utf8');
      const row = extractSessionFile('workbuddy', file, Date.parse('2026-11-04T02:00:00.000Z'));
      expect(row).toMatchObject({
        id: sessionKey('workbuddy', SESSION_ID),
        provider: 'workbuddy',
        nativeId: SESSION_ID,
        cwd: '/Users/chris/source/research/hyperknow',
        title: '评估项目是否适合比赛底座',
        startedAt: 1794134374597,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ai-title 缺席时降级为首条非信封用户输入;sessionId 缺席时用文件名', () => {
    const root = tempRoot();
    const file = join(root, `${SESSION_ID}.jsonl`);
    try {
      const rows = sampleSession().filter((row) => (row as { type?: string }).type !== 'ai-title') as unknown[];
      writeFileSync(file, jsonl(rows.map((row) => {
        const copy = { ...(row as Record<string, unknown>) };
        delete copy.sessionId;
        return copy;
      })), 'utf8');
      const head = parseWorkBuddyHead(file);
      expect(head.sessionId).toBeNull();
      expect(head.firstUserText).toBe('评估项目是否适合比赛底座,顺便看下 PDF');
      const row = extractWorkBuddySession(file, Date.now());
      expect(row?.nativeId).toBe(SESSION_ID);
      expect(row?.title).toBe('评估项目是否适合比赛底座,顺便看下 PDF');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('文件名过滤:uuid 主会话入目录,subagents/tool-results 与 ndjson 不入', () => {
    expect(isWorkBuddySessionFile(`${SESSION_ID}.jsonl`, `/x/projects/slug/${SESSION_ID}.jsonl`)).toBe(true);
    expect(isWorkBuddySessionFile('agent-2330d765.jsonl', `/x/projects/slug/${SESSION_ID}/subagents/agent-2330d765.jsonl`)).toBe(false);
    expect(isWorkBuddySessionFile(`${SESSION_ID}.file-rollback.ndjson`, '/x/projects/slug/x.ndjson')).toBe(false);
    expect(isWorkBuddySessionFile('notes.txt', '/x/projects/slug/notes.txt')).toBe(false);
  });
});

describe('workbuddy usage 行级解析', () => {
  test('OpenAI 风格 usage:inputTokens 全量含 cached,非缓存输入 = 全量 - cached,total 不重复计费', () => {
    const numeric = workBuddyNumericUsage({
      requests: 1, inputTokens: 46275, outputTokens: 221, totalTokens: 46496,
      inputTokensDetails: [{ cached_tokens: 44096 }], outputTokensDetails: [{ reasoning_tokens: 8 }],
    });
    expect(numeric).toEqual({
      inputTokens: 2179,
      cachedInputTokens: 44096,
      cacheCreationInputTokens: 0,
      outputTokens: 221,
      reasoningOutputTokens: 8,
      totalTokens: 46496,
    });
    expect(numeric.inputTokens + numeric.cachedInputTokens + numeric.outputTokens).toBe(numeric.totalTokens);
  });

  test('scanWorkBuddyLogs:function_call 行入账,model 取 requestModelId,sessionId 带行内值', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, `${SESSION_ID}.jsonl`), jsonl(sampleSession()), 'utf8');
      const since = 1794134394890 - 60_000;
      const until = 1794134394890 + 60_000;
      const records = scanWorkBuddyLogs(root, since, until);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        provider: 'workbuddy',
        model: 'hy4free',
        sessionId: SESSION_ID,
        inputTokens: 2179,
        cachedInputTokens: 44096,
        outputTokens: 221,
        totalTokens: 46496,
      });
      expect(records[0]!.estimatedCostUsd).toBeNull(); // hy4free 无价格,不虚构
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('零捏造价格:hy4free 不在价格表 → Unknown(估算 null)', () => {
    expect(modelPriceFor('hy4free')).toBeNull();
    expect(modelPriceFor('hy4-free')).toBeNull();
  });

  test('窗口外/无 usage 的行不入账', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, `${SESSION_ID}.jsonl`), jsonl(sampleSession()), 'utf8');
      // assistant message 行没有 providerData.usage:全窗口扫描也只有 1 条
      const records = scanWorkBuddyLogs(root, 0, Date.now() + 86_400_000);
      expect(records).toHaveLength(1);
      // 时间窗不含 function_call 时间戳 → 0 条
      const early = scanWorkBuddyLogs(root, 0, 1794134394890 - 1);
      expect(early).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workbuddy 消息与文件触碰', () => {
  test('message 正文入索引:user 信封排除,assistant 保留,function_call 出 tool 行', () => {
    const rows = sampleSession().flatMap((record, index) => (
      messagesFromRecord('workbuddy', `workbuddy:${SESSION_ID}`, record as Record<string, unknown>, index + 1)
    ));
    const texts = rows.filter((row) => row.kind === 'text');
    expect(texts).toHaveLength(2); // 信封 user 行被过滤
    expect(texts[0]).toMatchObject({ role: 'user', text: expect.stringContaining('评估项目') });
    expect(texts[1]).toMatchObject({ role: 'assistant', text: expect.stringContaining('结论') });
    const tools = rows.filter((row) => row.kind === 'tool_use');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolName: 'Read', role: 'tool' });
    expect(tools[0]!.text).toContain('README.md');
  });

  test('touchesFromRecord:JSON 字符串 arguments 里的 file_path 被提取', () => {
    const record = sampleSession().find((row) => (row as { type?: string }).type === 'function_call') as Record<string, unknown>;
    const touches = touchesFromRecord('workbuddy', `workbuddy:${SESSION_ID}`, record, 5, null);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({
      filePath: '/Users/chris/source/research/hyperknow/README.md',
      toolName: 'Read',
      op: 'read',
    });
  });
});

describe('workbuddy.db 只读元数据', () => {
  test('readonly 打开 sessions 表;库缺席时返回空 Map(降级不 crash)', () => {
    const root = tempRoot();
    try {
      // 缺席降级
      expect(readWorkBuddyDbSessions(root).size).toBe(0);
      // 只读打开:fixture 建最小 schema
      const db = new Database(join(root, 'workbuddy.db'));
      db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, cwd TEXT, title TEXT, context_window INTEGER)');
      db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)', [SESSION_ID, 'hy4free', '/Users/chris/source/research/hyperknow', '评估项目是否适合比赛底座', 300000]);
      db.close();
      const map = readWorkBuddyDbSessions(root);
      expect(map.get(SESSION_ID)).toEqual({
        model: 'hy4free',
        cwd: '/Users/chris/source/research/hyperknow',
        title: '评估项目是否适合比赛底座',
        contextWindow: 300000,
      });
      // 主库文件损坏/被目录占用 → 优雅降级
      rmSync(join(root, 'workbuddy.db'));
      writeFileSync(join(root, 'workbuddy.db'), 'not a sqlite file', 'utf8');
      expect(readWorkBuddyDbSessions(root).size).toBe(0);
      rmSync(join(root, 'workbuddy.db'));
      mkdirSync(join(root, 'workbuddy.db'), { recursive: true });
      expect(readWorkBuddyDbSessions(root).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
