import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { collectSessionCatalog } from '../src/sessions.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { SessionRecord } from '../src/types.ts';

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_ID = `claude:${UUID}`;

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

function row(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'nativeId'>): SessionRecord {
  const now = Date.now();
  // updatedAt 回拨 1s:列表窗口是 updatedAt < until(严格小于),同毫秒会被误排除
  return {
    provider: 'claude',
    cwd: '/tmp/demo',
    title: 'demo',
    sourceFile: '/tmp/demo/s1.jsonl',
    startedAt: now - 1000,
    updatedAt: now - 1000,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: now,
    ...partial,
  };
}

describe('session_user_meta store', () => {
  test('star/hide 写入与读取', () => {
    const store = openMemoryDb();
    store.setSessionStar('claude:s1', true);
    store.setSessionHidden('claude:s1', true);
    const meta = store.getSessionUserMetaMap().get('claude:s1');
    expect(meta?.starred).toBe(true);
    expect(meta?.hidden).toBe(true);
    expect(meta?.deletedAt).toBeNull();
  });

  test('星标在索引行删除重扫后幸存(L1 可重建,用户意图独立存放)', () => {
    const store = openMemoryDb();
    const session = row({ id: 'claude:s1', nativeId: 's1' });
    store.upsertSessions([session]);
    store.setSessionStar('claude:s1', true);
    // 模拟重建:行被清掉再扫回来
    store.deleteSession('claude:s1');
    store.upsertSessions([session]);
    expect(store.getSessionUserMetaMap().get('claude:s1')?.starred).toBe(true);
  });

  test('tombstoneSession 同时落墓碑双键并清掉 L1 行', () => {
    const store = openMemoryDb();
    store.upsertSessions([row({ id: 'claude:s1', nativeId: 's1', sourceFile: '/tmp/a.jsonl' })]);
    store.tombstoneSession('claude:s1', '/tmp/a.jsonl');
    expect(store.getSession('claude:s1')).toBeNull();
    const info = store.tombstonedSessionInfo();
    expect(info.ids.has('claude:s1')).toBe(true);
    expect(info.paths.has('/tmp/a.jsonl')).toBe(true);
    expect(store.listTombstonedSessions()).toHaveLength(1);
  });

  test('restoreSession 清墓碑', () => {
    const store = openMemoryDb();
    store.tombstoneSession('claude:s1', '/tmp/a.jsonl');
    store.restoreSession('claude:s1');
    expect(store.tombstonedSessionInfo().ids.size).toBe(0);
    expect(store.listTombstonedSessions()).toHaveLength(0);
  });
});

describe('catalog 尊重墓碑(重建不复活)', () => {
  function tempRoot(): string {
    return mkdtempSync(join(tmpdir(), 'planofplan-usermeta-'));
  }

  function makeRoots(root: string) {
    return {
      claudeRoots: [join(root, 'claude')],
      codexRoot: join(root, 'codex'),
      grokRoot: join(root, 'grok'),
      dshRoot: join(root, 'dsh'),
      kimiRoot: join(root, 'kimi'),
      droidRoot: join(root, 'factory'),
      zcodeRoot: join(root, 'zcode'),
      since: Date.now() - 86_400_000,
      until: Date.now() + 86_400_000,
    };
  }

  function seedClaudeSession(root: string): void {
    const dir = join(root, 'claude', '-Users-test-demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${UUID}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: '用户需求文本' }] } })}\n`,
    );
  }

  test('删除后重扫不复活,恢复后回归', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    try {
      seedClaudeSession(root);
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(SESSION_ID)).not.toBeNull();

      store.tombstoneSession(SESSION_ID, store.getSession(SESSION_ID)?.sourceFile ?? null);
      expect(store.getSession(SESSION_ID)).toBeNull();

      // 重扫:文件还在,但墓碑必须拦住复活
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(SESSION_ID)).toBeNull();

      // 恢复:墓碑清掉,下一轮扫描自然回归
      store.restoreSession(SESSION_ID);
      await collectSessionCatalog(store, makeRoots(root));
      expect(store.getSession(SESSION_ID)).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('session user meta API', () => {
  function app() {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const now = Date.now();
    store.upsertSessions([
      row({ id: 'claude:s1', nativeId: 's1', seenAt: now, updatedAt: now }),
      row({ id: 'claude:s2', nativeId: 's2', seenAt: now, updatedAt: now }),
    ]);
    return { store, server: createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS }) };
  }

  // Bun 对快速顺序 app.request 偶发返回空响应(多请求连发测试实测 ~1/10,加任何
  // 时序扰动即消失的 runner 竞态);让步 1ms 规避,断言本身不放松
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

  async function listSessions(server: ReturnType<typeof app>['server'], query = ''): Promise<{ sessions: Array<{ id: string; starred?: boolean; hidden?: boolean }> }> {
    await tick();
    const res = await server.request(`http://localhost/api/sessions${query}`);
    expect(res.status).toBe(200);
    return res.json() as Promise<{ sessions: Array<{ id: string; starred?: boolean; hidden?: boolean }> }>;
  }

  test('hidden 默认排除,hidden=1 才包含;starred/hidden 标志随行返回', async () => {
    const { store, server } = app();
    store.setSessionHidden('claude:s2', true);
    store.setSessionStar('claude:s1', true);

    const defaultList = await listSessions(server);

    expect(defaultList.sessions.map((s) => s.id)).toEqual(['claude:s1']);
    expect(defaultList.sessions[0].starred).toBe(true);

    const withHidden = await listSessions(server, '?hidden=1');
    expect(withHidden.sessions.map((s) => s.id).sort()).toEqual(['claude:s1', 'claude:s2']);
    expect(withHidden.sessions.find((s) => s.id === 'claude:s2')?.hidden).toBe(true);
  });

  test('star/hide/delete/restore 端点闭环', async () => {
    const { server } = app();

    const star = await server.request('http://localhost/api/sessions/claude:s1/star', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    });
    expect(star.status).toBe(200);

    const badBody = await server.request('http://localhost/api/sessions/claude:s1/star', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ starred: 'yes' }),
    });
    expect(badBody.status).toBe(400);

    const hide = await server.request('http://localhost/api/sessions/claude:s1/hide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hidden: true }),
    });
    expect(hide.status).toBe(200);
    const hiddenList = await listSessions(server);
    expect(hiddenList.sessions).toHaveLength(1); // s1 隐藏后只剩 s2

    const remove = await server.request('http://localhost/api/sessions/claude:s2', { method: 'DELETE' });
    expect(remove.status).toBe(200);
    const deletedList = await server.request('http://localhost/api/sessions/deleted');
    const deleted = await deletedList.json() as { deleted: Array<{ sessionId: string }> };
    expect(deleted.deleted.map((d) => d.sessionId)).toEqual(['claude:s2']);

    const restore = await server.request('http://localhost/api/sessions/claude:s2/restore', { method: 'POST' });
    expect(restore.status).toBe(200);
    const afterRestore = await server.request('http://localhost/api/sessions/deleted');
    const afterRestoreBody = await afterRestore.json() as { deleted: unknown[] };
    expect(afterRestoreBody.deleted).toHaveLength(0);
  });
});
