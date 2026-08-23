import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filePathOfInput, normalizeTouchPath, opOfTool, touchesFromRecord } from '../src/file-touches.ts';
import { openMemoryDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';
import { collectSessionCatalog, sessionKey } from '../src/sessions.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionFileTouch } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-touches-'));
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function touchRow(partial: Partial<SessionFileTouch> & Pick<SessionFileTouch, 'id' | 'sessionId' | 'filePath'>): SessionFileTouch {
  return {
    provider: 'claude',
    toolName: 'Read',
    op: 'read',
    ts: null,
    ordinal: 1,
    ...partial,
  };
}

describe('touch extraction helpers', () => {
  test('opOfTool 归类', () => {
    expect(opOfTool('Read')).toBe('read');
    expect(opOfTool('Edit')).toBe('edit');
    expect(opOfTool('MultiEdit')).toBe('edit');
    expect(opOfTool('apply_patch')).toBe('edit');
    expect(opOfTool('Grep')).toBe('search');
    expect(opOfTool('WebFetch')).toBe('webfetch');
  });

  test('filePathOfInput 只认结构化字段', () => {
    expect(filePathOfInput({ file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(filePathOfInput({ path: 'src/db.ts' })).toBe('src/db.ts');
    expect(filePathOfInput({ notebook_path: '/a.ipynb' })).toBe('/a.ipynb');
    expect(filePathOfInput({ command: 'cat /etc/hosts' })).toBeNull();
    expect(filePathOfInput('string')).toBeNull();
    expect(filePathOfInput(null)).toBeNull();
  });

  test('normalizeTouchPath:绝对路径直通,相对路径基于 cwd resolve', () => {
    expect(normalizeTouchPath('/a/./b.ts', null)).toBe('/a/b.ts');
    expect(normalizeTouchPath('src/db.ts', '/repo')).toBe('/repo/src/db.ts');
    expect(normalizeTouchPath('../out.ts', '/repo/sub')).toBe('/repo/out.ts');
  });
});

describe('touchesFromRecord', () => {
  test('claude: tool_use 块的 file_path,相对路径按 record cwd resolve,Bash 跳过', () => {
    const touches = touchesFromRecord('claude', 'claude:s1', {
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-08-20T01:00:00.000Z',
      cwd: '/repo',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/db.ts' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/abs/x.ts' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'cat /etc/hosts' } },
          { type: 'tool_use', id: 't4', name: 'Grep', input: { pattern: 'foo', path: 'src' } },
        ],
      },
    }, 7, null);
    expect(touches.map((t) => `${t.op}:${t.filePath}`)).toEqual([
      'read:/repo/src/db.ts',
      'edit:/abs/x.ts',
      'search:/repo/src',
    ]);
    expect(touches[0]?.id).toBe('claude:s1:7:0');
    expect(touches[0]?.ts).toBe(Date.parse('2026-08-20T01:00:00.000Z'));
  });

  test('codex: function_call 的 arguments JSON 字符串解析出 path,shell 跳过', () => {
    const touches = touchesFromRecord('codex', 'codex:s1', {
      type: 'response_item',
      timestamp: '2026-08-20T01:00:00.000Z',
      payload: { type: 'function_call', name: 'read_file', arguments: '{"path":"/a/b.ts"}' },
    }, 3, '/repo');
    expect(touches).toHaveLength(1);
    expect(touches[0]?.filePath).toBe('/a/b.ts');
    expect(touches[0]?.op).toBe('read');

    const shell = touchesFromRecord('codex', 'codex:s1', {
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls /tmp"}' },
    }, 4, '/repo');
    expect(shell).toHaveLength(0);
  });

  test('kimi: loop_event 的 tool.call', () => {
    const touches = touchesFromRecord('kimi', 'kimi:s1', {
      type: 'context.append_loop_event',
      event: { type: 'tool.call', name: 'Edit', args: { file_path: 'src/app.ts' } },
    }, 5, '/repo');
    expect(touches.map((t) => `${t.op}:${t.filePath}`)).toEqual(['edit:/repo/src/app.ts']);
  });

  test('dsh: tool/call 的 arguments JSON 字符串', () => {
    const touches = touchesFromRecord('dsh', 'dsh:s1', {
      type: 'tool/call',
      data: { name: 'read_file', arguments: '{"path":"a.md"}' },
    }, 2, '/ws');
    expect(touches.map((t) => `${t.op}:${t.filePath}`)).toEqual(['read:/ws/a.md']);
  });
});

describe('session_file_touches store', () => {
  test('fileTouchSessions:精确 + 后缀匹配,ops 聚合,按 lastTs 倒排', () => {
    const store = openMemoryDb();
    const now = Date.now();
    store.upsertSessions([{
      id: 'claude:s1', provider: 'claude', nativeId: 's1', cwd: '/repo', title: '改 db',
      sourceFile: '/tmp/a.jsonl', startedAt: now - 60_000, updatedAt: now - 30_000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: now,
    }]);
    store.upsertSessionTouches([
      touchRow({ id: 'claude:s1:1:0', sessionId: 'claude:s1', filePath: '/repo/src/db.ts', op: 'read', ts: now - 5000 }),
      touchRow({ id: 'claude:s1:2:0', sessionId: 'claude:s1', filePath: '/repo/src/db.ts', op: 'edit', ts: now - 1000 }),
      touchRow({ id: 'claude:s1:3:0', sessionId: 'claude:s1', filePath: '/repo/README.md', op: 'read', ts: now - 2000 }),
      touchRow({ id: 'claude:s2:1:0', sessionId: 'claude:s2', provider: 'claude', filePath: '/other/src/db.ts', op: 'edit', ts: now - 3000 }),
    ]);
    const exact = store.fileTouchSessions('/repo/src/db.ts');
    // 后缀语义是按整个查询串结尾匹配:/other/src/db.ts 不以 /repo/src/db.ts 结尾
    expect(exact.map((row) => row.sessionId)).toEqual(['claude:s1']);
    const s1 = exact.find((row) => row.sessionId === 'claude:s1');
    expect(s1?.title).toBe('改 db');
    expect(s1?.touches).toBe(2);
    expect(s1?.ops).toEqual(['edit', 'read']);
    expect(s1?.lastTs).toBe(now - 1000);
    // 相对路径后缀匹配
    const rel = store.fileTouchSessions('src/db.ts');
    expect(rel.map((row) => row.sessionId).sort()).toEqual(['claude:s1', 'claude:s2']);
    // LIKE 通配符注入不炸
    expect(() => store.fileTouchSessions('%.ts')).not.toThrow();
    // 时间线
    const timeline = store.listSessionTouches('claude:s1');
    expect(timeline.map((t) => t.filePath)).toEqual(['/repo/src/db.ts', '/repo/src/db.ts', '/repo/README.md']);
  });

  test('deleteSession 级联删除 touches', () => {
    const store = openMemoryDb();
    store.upsertSessionTouches([
      touchRow({ id: 'claude:s1:1:0', sessionId: 'claude:s1', filePath: '/a.ts' }),
    ]);
    expect(store.listSessionTouches('claude:s1')).toHaveLength(1);
    store.deleteSession('claude:s1');
    expect(store.listSessionTouches('claude:s1')).toHaveLength(0);
  });
});

describe('collectSessionCatalog touch indexing', () => {
  const claudeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function makeRoots(root: string) {
    return {
      since: Date.now() - 86_400_000,
      until: Date.now() + 1000,
      claudeRoots: [join(root, 'claude')],
      codexRoot: join(root, 'missing-codex'),
      grokRoot: join(root, 'missing-grok'),
      dshRoot: join(root, 'missing-dsh'),
      kimiRoot: join(root, 'missing-kimi'),
      droidRoot: join(root, 'missing-factory'),
      zcodeRoot: join(root, 'missing-zcode'),
    };
  }

  test('同趟解析落 touches;parser 版本不一致触发全量重扫', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    const dir = join(root, 'claude');
    const file = join(dir, `${claudeId}.jsonl`);
    const sessionId = sessionKey('claude', claudeId);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, jsonl([
        { type: 'user', uuid: 'u1', timestamp: '2026-08-20T01:00:00.000Z', message: { content: [{ type: 'text', text: '看下 db 层' }] }, cwd: '/repo' },
        {
          type: 'assistant', uuid: 'u2', timestamp: '2026-08-20T01:01:00.000Z', cwd: '/repo',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/db.ts' } }] },
        },
      ]));
      await collectSessionCatalog(store, makeRoots(root));
      const touches = store.listSessionTouches(sessionId);
      expect(touches).toHaveLength(1);
      expect(touches[0]?.filePath).toBe('/repo/src/db.ts');

      // 老水位(parserVersion=1)不被信任 → 全量重扫,不重复
      store.upsertSessionIndexState({
        path: file,
        mtimeMs: 0,
        size: 0,
        parsedBytes: 0,
        lines: 0,
        parserVersion: 1,
      });
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.listSessionTouches(sessionId)).toHaveLength(1);
      expect(store.countSessionMessages(sessionId)).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('touch query endpoints', () => {
  async function seededServer() {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const now = Date.now();
    store.upsertSessions([{
      id: 'claude:s1', provider: 'claude', nativeId: 's1', cwd: '/repo', title: '改 db 层',
      sourceFile: '/tmp/a.jsonl', startedAt: now - 60_000, updatedAt: now - 30_000,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: now,
    }]);
    store.upsertSessionTouches([
      touchRow({ id: 'claude:s1:1:0', sessionId: 'claude:s1', filePath: '/repo/src/db.ts', op: 'read', ts: now - 5000, ordinal: 1000 }),
      touchRow({ id: 'claude:s1:2:0', sessionId: 'claude:s1', filePath: '/repo/src/db.ts', op: 'edit', ts: now - 1000, ordinal: 2000 }),
    ]);
    return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
  }

  test('GET /api/files/sessions 按路径聚合 session', async () => {
    const server = await seededServer();
    const response = await server.request('http://localhost/api/files/sessions?path=src/db.ts');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      path: string;
      sessions: Array<{ sessionId: string; title: string; touches: number; ops: string[] }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ sessionId: 'claude:s1', title: '改 db 层', touches: 2, ops: ['edit', 'read'] });

    const missing = await server.request('http://localhost/api/files/sessions');
    expect(missing.status).toBe(400);
  });

  test('GET /api/sessions/:provider/:id/touches 返回时间线', async () => {
    const server = await seededServer();
    const response = await server.request('http://localhost/api/sessions/claude/s1/touches');
    expect(response.status).toBe(200);
    const body = await response.json() as { sessionId: string; touches: Array<{ filePath: string; op: string }> };
    expect(body.sessionId).toBe('claude:s1');
    expect(body.touches.map((t) => t.op)).toEqual(['read', 'edit']);

    const unknown = await server.request('http://localhost/api/sessions/claude/nope/touches');
    expect(unknown.status).toBe(404);
  });
});
