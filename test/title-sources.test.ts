import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { collectSessionCatalog, extractSessionRecords } from '../src/sessions.ts';
import { isCodexMetaUserText, messagesFromRecord } from '../src/transcript.ts';

const UUID = '12345678-1234-5678-1234-123456789abc';
const SESSION_ID = `claude:${UUID}`;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-titles-'));
}

function makeRoots(root: string) {
  return {
    claudeRoots: [join(root, 'claude', 'projects')],
    codexRoot: join(root, 'codex', 'sessions'),
    grokRoot: join(root, 'grok'),
    dshRoot: join(root, 'dsh'),
    kimiRoot: join(root, 'kimi'),
    droidRoot: join(root, 'factory'),
    zcodeRoot: join(root, 'zcode'),
    since: Date.now() - 86_400_000,
    until: Date.now() + 86_400_000,
  };
}

function claudeSessionFile(root: string, lines: unknown[]): string {
  const dir = join(root, 'claude', 'projects', '-Users-test-demo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${UUID}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

describe('is_meta 判定', () => {
  test('codex 系统信封:清单内为真,普通文本与未知标签为假', () => {
    expect(isCodexMetaUserText('<environment_context>unix - home</environment_context>')).toBe(true);
    expect(isCodexMetaUserText('<codex_internal_context source="goal">…')).toBe(true);
    expect(isCodexMetaUserText('<image name=[Image #1]>')).toBe(true);
    expect(isCodexMetaUserText('帮我把冒烟测试跑通')).toBe(false);
    expect(isCodexMetaUserText('<div>用户粘贴的 HTML 是真实输入</div>')).toBe(false);
    expect(isCodexMetaUserText('')).toBe(false);
  });

  test('信封用户消息不进消息索引,普通消息照常', () => {
    const envelope = messagesFromRecord('codex', 'codex:s1', {
      type: 'response_item',
      payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>unix</environment_context>' }] },
    }, 1);
    expect(envelope).toEqual([]);
    const real = messagesFromRecord('codex', 'codex:s1', {
      type: 'response_item',
      payload: { role: 'user', content: [{ type: 'input_text', text: '修一下部署脚本' }] },
    }, 2);
    expect(real).toHaveLength(1);
    expect(real[0].text).toBe('修一下部署脚本');
  });

  test('claude isMeta 注入不进消息索引', () => {
    const meta = messagesFromRecord('claude', SESSION_ID, {
      type: 'user', uuid: 'm1', isMeta: true,
      message: { content: 'You MUST call the StructuredOutput tool to complete this request.' },
    }, 1);
    expect(meta).toEqual([]);
    const real = messagesFromRecord('claude', SESSION_ID, {
      type: 'user', uuid: 'm2',
      message: { content: '真正的用户消息' },
    }, 2);
    expect(real).toHaveLength(1);
  });
});

describe('claude 标题来源', () => {
  test('ai-title 记录优先于首条用户消息启发式;isMeta 注入不抢标题', () => {
    const root = tempRoot();
    try {
      const path = claudeSessionFile(root, [
        { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'You MUST call the StructuredOutput tool.' } },
        { type: 'user', uuid: 'm2', message: { content: '修复登录超时' } },
        { type: 'ai-title', aiTitle: 'fix-login-timeout', sessionId: UUID },
      ]);
      const rows = extractSessionRecords('claude', path, Date.now());
      expect(rows[0].title).toBe('fix-login-timeout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('无 ai-title 时启发式照常,isMeta 记录被跳过', () => {
    const root = tempRoot();
    try {
      const path = claudeSessionFile(root, [
        { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'You MUST call the StructuredOutput tool.' } },
        { type: 'user', uuid: 'm2', message: { content: '把标题来源多元化这件事做完并补上回归测试' } },
      ]);
      const rows = extractSessionRecords('claude', path, Date.now());
      expect(rows[0].title).toBe('把标题来源多元化这件事做完并补上回归测试');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ai-title 超出头部解析范围时由消息索引的流式读捕获', async () => {
    const root = tempRoot();
    try {
      // 填料把 ai-title 推到 256KB 头部窗口之外:头部解析拿不到,流式全量读拿得到
      const filler = { type: 'assistant', uuid: 'f', message: { content: 'x'.repeat(2000) } };
      const lines: unknown[] = [
        { type: 'user', uuid: 'm1', message: { content: '头部可见的启发式标题' } },
        ...Array.from({ length: 150 }, () => filler),
        { type: 'ai-title', aiTitle: 'streamed-title-wins', sessionId: UUID },
      ];
      claudeSessionFile(root, lines);
      const store = openMemoryDb();
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(SESSION_ID)?.title).toBe('streamed-title-wins');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('history.jsonl 兜底无标题 session(信封开头的会话)', async () => {
    const root = tempRoot();
    try {
      claudeSessionFile(root, [
        { type: 'user', uuid: 'm1', message: { content: '<command-compact>auto</command-compact>' } },
      ]);
      mkdirSync(join(root, 'claude'), { recursive: true });
      writeFileSync(join(root, 'claude', 'history.jsonl'), jsonl([
        { display: '<command-compact>auto</command-compact>', timestamp: 1, sessionId: UUID },
        { display: '立项开始做 grokbot 调研', timestamp: 2, sessionId: UUID },
      ]));
      const store = openMemoryDb();
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(SESSION_ID)?.title).toBe('立项开始做 grokbot 调研');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('codex 官方线程名', () => {
  test('session_index.jsonl 的 thread_name 优先于启发式', async () => {
    const root = tempRoot();
    try {
      const dir = join(root, 'codex', 'sessions', '2026', '08', '29');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-08-29T00-00-00-${UUID}.jsonl`),
        jsonl([
          { timestamp: '2026-08-29T00:00:00.000Z', type: 'session_meta', payload: { id: UUID, cwd: '/tmp/repo', timestamp: '2026-08-29T00:00:00.000Z' } },
          { timestamp: '2026-08-29T00:00:01.000Z', type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>unix</environment_context>' }] } },
        ]),
      );
      mkdirSync(join(root, 'codex'), { recursive: true });
      writeFileSync(join(root, 'codex', 'session_index.jsonl'), jsonl([
        { id: UUID, thread_name: '部署脚本修复', updated_at: '2026-08-29T00:01:00Z' },
      ]));
      const store = openMemoryDb();
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(`codex:${UUID}`)?.title).toBe('部署脚本修复');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
