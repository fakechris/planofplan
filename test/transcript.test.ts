import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { readTranscript } from '../src/transcript.ts';
import { resumeFor } from '../src/resume.ts';
import type { SessionRecord } from '../src/types.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-transcript-'));
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'provider' | 'nativeId' | 'sourceFile'>): SessionRecord {
  return {
    cwd: '/tmp/demo',
    title: 'demo',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    ...partial,
  };
}

describe('transcript readers', () => {
  test('Claude user/assistant/tool_use become turns', async () => {
    const root = tempRoot();
    const file = join(root, 'sess.jsonl');
    try {
      writeFileSync(file, jsonl([
        { type: 'user', message: { content: [{ type: 'text', text: '列出 session 目录' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '开始扫盘' }, { type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] } },
      ]));
      const result = await readTranscript(session({
        id: 'claude:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        provider: 'claude',
        nativeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sourceFile: file,
      }));
      expect(result.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool']);
      expect(result.turns[0]?.text).toContain('列出 session 目录');
      expect(result.turns[2]?.toolName).toBe('Read');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Codex response_item user/assistant parse', async () => {
    const root = tempRoot();
    const file = join(root, 'rollout.jsonl');
    try {
      writeFileSync(file, jsonl([
        { type: 'session_meta', payload: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } },
        { type: 'response_item', payload: { role: 'user', content: [{ text: '打开 catalog' }] } },
        { type: 'response_item', payload: { role: 'assistant', content: [{ text: '好的' }] } },
      ]));
      const result = await readTranscript(session({
        id: 'codex:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        provider: 'codex',
        nativeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        sourceFile: file,
      }));
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0]?.role).toBe('user');
      expect(result.turns[1]?.text).toBe('好的');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Grok reads sibling chat_history.jsonl from summary.json', async () => {
    const root = tempRoot();
    const dir = join(root, '01a01dca-bbc8-7101-b5ae-4bca7f34c894');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id: 'x' } }));
      writeFileSync(join(dir, 'chat_history.jsonl'), jsonl([
        { type: 'system', content: 'ignore' },
        { type: 'user', content: [{ type: 'text', text: '看一下 dsh-track' }] },
        { type: 'assistant', content: [{ type: 'text', text: '先读实现' }] },
      ]));
      const result = await readTranscript(session({
        id: 'grok:01a01dca-bbc8-7101-b5ae-4bca7f34c894',
        provider: 'grok',
        nativeId: '01a01dca-bbc8-7101-b5ae-4bca7f34c894',
        sourceFile: join(dir, 'summary.json'),
      }));
      expect(result.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DSH user/assistant/tool events map to turns', async () => {
    const root = tempRoot();
    const file = join(root, 'session.jsonl');
    try {
      writeFileSync(file, jsonl([
        { type: 'session', id: 'session-1' },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先落设计文档' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '开始写' }] } } },
        { type: 'tool/call', data: { name: 'read_file', arguments: '{"path":"a"}' } },
      ]));
      const result = await readTranscript(session({
        id: 'dsh:session-1',
        provider: 'dsh',
        nativeId: 'session-1',
        sourceFile: file,
      }));
      expect(result.turns.map((turn) => `${turn.role}:${turn.toolName ?? ''}`)).toEqual([
        'user:',
        'assistant:',
        'tool:read_file',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resume availability', () => {
  test('unknown provider is not advertised', () => {
    const info = resumeFor(session({
      id: 'nope:1',
      provider: 'nope',
      nativeId: '1',
      sourceFile: '/tmp/x',
    }));
    expect(info.available).toBe(false);
    expect(info.command).toBeNull();
    expect(info.reason).toContain('没有已知的 resume CLI');
  });

  test('claude resume is advertised only when the binary exists', () => {
    const info = resumeFor(session({
      id: 'claude:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      provider: 'claude',
      nativeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sourceFile: '/tmp/x',
    }));
    if (info.available) {
      expect(info.command).toContain('--resume');
      expect(info.command).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    } else {
      expect(info.reason).toContain('claude');
    }
  });
});
