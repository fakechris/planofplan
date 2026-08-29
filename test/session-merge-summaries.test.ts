import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { extractSessionRecords } from '../src/sessions.ts';
import { messagesFromRecord } from '../src/transcript.ts';

const UUID = 'bbbbbbbb-cccc-4ddd-8888-eeeeeeeeeeee';
const SESSION_ID = `claude:${UUID}`;

describe('compact 续跑摘要重分类', () => {
  test('isCompactSummary → kind=summary/role=system:FTS 可搜,不进用户文本', () => {
    const store = openMemoryDb();
    const rows = [
      ...messagesFromRecord('claude', SESSION_ID, {
        type: 'user', uuid: 'sum-1', isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: 1. Primary Request and Intent: 修复登录态刷新链路' },
      }, 1),
      ...messagesFromRecord('claude', SESSION_ID, {
        type: 'user', uuid: 'u1',
        message: { role: 'user', content: '继续把登录态的测试补上' },
      }, 2),
    ];
    expect(rows).toHaveLength(2);
    const summary = rows.find((row) => row.kind === 'summary');
    expect(summary?.role).toBe('system');
    expect(summary?.text).toContain('修复登录态刷新链路');

    store.upsertSessionMessages(rows);
    // FTS(v11 条件触发器)含 summary:压缩后的会话仍可搜到早期意图
    expect(store.searchSessionMessages('修复登录态刷新链路')).toHaveLength(1);
    // 用户文本层排除:需求抽取不受摘要污染
    const userTexts = store.db.query(
      "SELECT text FROM session_messages WHERE role = 'user' AND kind = 'text'",
    ).all() as Array<{ text: string }>;
    expect(userTexts.map((row) => row.text)).toEqual(['继续把登录态的测试补上']);
  });

  test('compact 摘要不当标题(真实用户消息优先)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-compact-title-'));
    try {
      const dir = join(root, 'claude', 'projects', '-Users-test-demo');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${UUID}.jsonl`);
      writeFileSync(path, [
        JSON.stringify({ type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: 1. Primary Request and Intent: something entirely different' } }),
        JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: '把谱系周报的静态汇总版本做完再补测试' } }),
      ].map((line) => line).join('\n') + '\n');
      const rows = extractSessionRecords('claude', path, Date.now());
      expect(rows[0].title).toBe('把谱系周报的静态汇总版本做完再补测试');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('session 合并语义(MIN/MAX,参照 obelisk persist)', () => {
  test('started_at 取 MIN、updated_at 取 MAX,不被续写文件回退', () => {
    const store = openMemoryDb();
    const base = {
      provider: 'claude' as const, nativeId: 'x1', cwd: '/r', title: 't',
      sourceFile: '/r/a.jsonl', inputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: null as number | null, seenAt: 1,
    };
    store.upsertSessions([{ ...base, id: 'claude:x1', startedAt: 100, updatedAt: 200 }]);
    // 第二个 rollout 文件:开始更晚、mtime 更早(轮换/复制场景)
    store.upsertSessions([{ ...base, id: 'claude:x1', startedAt: 150, updatedAt: 120 }]);
    const merged = store.getSession('claude:x1');
    expect(merged?.startedAt).toBe(100);
    expect(merged?.updatedAt).toBe(200);
    // 真实续写:更新时间前进,开始时间不动
    store.upsertSessions([{ ...base, id: 'claude:x1', startedAt: 150, updatedAt: 300 }]);
    const resumed = store.getSession('claude:x1');
    expect(resumed?.startedAt).toBe(100);
    expect(resumed?.updatedAt).toBe(300);
  });

  test('started_at 为 null 时 fill-if-null(updated_at 恒非空,无此态)', () => {
    const store = openMemoryDb();
    const base = {
      provider: 'claude' as const, nativeId: 'x2', cwd: '/r', title: 't',
      sourceFile: '/r/b.jsonl', inputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: null as number | null, seenAt: 1, id: 'claude:x2',
    };
    store.upsertSessions([{ ...base, startedAt: null, updatedAt: 100 }]);
    // 续写文件带回了真实的开始时间:MIN 语义下 null 侧补值,不回退已有 updated_at
    store.upsertSessions([{ ...base, startedAt: 50, updatedAt: 120 }]);
    const merged = store.getSession('claude:x2');
    expect(merged?.startedAt).toBe(50);
    expect(merged?.updatedAt).toBe(120);
  });
});
