import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionFileTouch, SessionRecord } from '../src/types.ts';

const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };

function row(id: string, nativeId: string, title: string): SessionRecord {
  const now = Date.now();
  return {
    id, nativeId, provider: 'claude', cwd: '/repo', title, sourceFile: `/tmp/${nativeId}.jsonl`,
    startedAt: now - 3_600_000, updatedAt: now - 1_000, inputTokens: 0, outputTokens: 0,
    totalTokens: 0, estimatedCostUsd: null, seenAt: now,
  };
}

function touch(id: string, sessionId: string, filePath: string, ts: number | null): SessionFileTouch {
  return { id, sessionId, provider: 'claude', filePath, toolName: 'Edit', op: 'edit', ts, ordinal: 1 };
}

function app() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  store.upsertSessions([row('claude:a', 'a', '改登录页'), row('claude:b', 'b', '写部署脚本')]);
  const now = Date.now();
  store.upsertSessionTouches([
    touch('t1', 'claude:a', '/repo/web/login.tsx', now - 60_000),
    touch('t2', 'claude:a', '/repo/web/login.tsx', now - 30_000),
    touch('t3', 'claude:b', '/repo/web/login.tsx', now - 10_000),
    touch('t4', 'claude:b', '/repo/scripts/deploy.sh', now - 5_000),
    touch('t5', 'claude:b', '/repo/old/legacy.ts', now - 40 * 86_400_000),
  ]);
  return { store, server: createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS }) };
}

describe('recent-edits API', () => {
  test('按文件聚合、按最近 touch 排序、窗口过滤、会话关联', async () => {
    const { server } = app();
    const res = await server.request('http://localhost/api/recent-edits?days=7');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      files: Array<{ path: string; lastTs: number | null; sessionCount: number; sessions: Array<{ id: string; title: string | null }> }>;
    };
    const paths = body.files.map((f) => f.path);
    // legacy.ts 在 40 天前,窗口外
    expect(paths).toEqual(['/repo/scripts/deploy.sh', '/repo/web/login.tsx']);
    const login = body.files.find((f) => f.path === '/repo/web/login.tsx')!;
    expect(login.sessionCount).toBe(2);
    expect(login.sessions.map((s) => s.id).sort()).toEqual(['claude:a', 'claude:b']);
    expect(login.sessions[0].title).toBeTruthy();
  });

  test('隐藏 session 的文件不出现在 feed(全部命中都被隐藏时)', async () => {
    const { store, server } = app();
    store.setSessionHidden('claude:b', true);
    const res = await server.request('http://localhost/api/recent-edits?days=7');
    const body = await res.json() as { files: Array<{ path: string; sessions: Array<{ id: string }> }> };
    const deploy = body.files.find((f) => f.path === '/repo/scripts/deploy.sh');
    expect(deploy).toBeUndefined(); // deploy.sh 只有 claude:b 碰过
    const login = body.files.find((f) => f.path === '/repo/web/login.tsx');
    expect(login?.sessions.map((s) => s.id)).toEqual(['claude:a']); // a 未隐藏仍在
  });
});
