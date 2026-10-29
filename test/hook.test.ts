import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { installCommitHook, uninstallCommitHook, prepareCommitMsgPath } from '../src/hook.ts';
import type { SessionRecord } from '../src/types.ts';

const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
const NOW = Date.now();

function sessionRow(id: string, cwd: string, gitRoot: string | null, updatedAt: number): SessionRecord {
  return {
    id, nativeId: id.split(':')[1] ?? id, provider: id.split(':')[0] ?? 'claude', cwd,
    title: `t-${id}`, sourceFile: `/tmp/${id}.jsonl`, startedAt: updatedAt - 3_600_000, updatedAt,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: NOW,
    ...(gitRoot ? { gitRoot } : {}),
  };
}

function app(repoDir?: string) {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  store.upsertSessions([
    sessionRow('claude:solo', '/solo/repo', '/solo/repo', NOW - 60_000),
    sessionRow('claude:active', '/work/repo', '/work/repo', NOW - 60_000),
    sessionRow('claude:subdir', '/work/repo/packages/ui', '/work/repo', NOW - 120_000),
    sessionRow('claude:stale', '/work/repo', '/work/repo', NOW - 10 * 3_600_000),
    sessionRow('claude:other', '/work/other', '/work/other', NOW - 30_000),
    // e2e:钩子真跑时命中临时 repo
    ...(repoDir ? [sessionRow('claude:hooked', repoDir, repoDir, NOW - 30_000)] : []),
  ]);
  return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
}

describe('/api/sessions/current', () => {
  test('INV-1428:唯一候选盖章;多候选歧义不盖章且响应不含 sessionId 字段;过期与他人排除', async () => {
    const server = app();
    // 唯一候选:正常返回,钩子可盖章
    const solo = await (await server.request('http://localhost/api/sessions/current?cwd=/solo/repo')).json() as { session: { sessionId: string } | null };
    expect(solo.session?.sessionId).toBe('claude:solo');
    // 多候选(active + subdir 同 repo):不能猜最新,session 必须为 null
    const ambiguous = await (await server.request('http://localhost/api/sessions/current?cwd=/work/repo')).json() as {
      session: null; ambiguous?: boolean; candidates?: Array<{ id: string }>;
    };
    expect(ambiguous.session).toBeNull();
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.candidates?.map((row) => row.id)).toEqual(['claude:active', 'claude:subdir']);
    // 关键兼容性:旧版已安装钩子脚本的 sed 抓 "sessionId"——歧义响应里绝不能出现该字段名
    expect(JSON.stringify(ambiguous)).not.toContain('"sessionId"');
    // 过期(stale)不参与:6h 窗口外
    const none = await (await server.request('http://localhost/api/sessions/current?cwd=/nowhere')).json() as { session: null; ambiguous?: boolean };
    expect(none.session).toBeNull();
    expect(none.ambiguous).toBeUndefined();
    const bad = await server.request('http://localhost/api/sessions/current?cwd=relative');
    expect(bad.status).toBe(400);
  });
});

describe('commit hook 安装管理', () => {
  function gitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pop-hook-'));
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    return dir;
  }

  test('install → already → uninstall 生命周期;拒绝覆盖他人的钩子', () => {
    const repo = gitRepo();
    try {
      const first = installCommitHook(repo, 9291);
      expect(first.ok).toBe(true);
      expect(first.status).toBe('installed');
      const script = readFileSync(prepareCommitMsgPath(repo), 'utf8');
      expect(script).toContain('Harness-Session');
      expect(script).toContain('9291');
      expect(installCommitHook(repo, 9291).status).toBe('already');
      expect(uninstallCommitHook(repo).status).toBe('uninstalled');
      expect(uninstallCommitHook(repo).status).toBe('not-found');

      writeFileSync(prepareCommitMsgPath(repo), '#!/bin/sh\n# husky or custom\n');
      chmodSync(prepareCommitMsgPath(repo), 0o755);
      expect(installCommitHook(repo, 9291).status).toBe('refused');
      expect(uninstallCommitHook(repo).ok).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('非 git 目录拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-nohook-'));
    try {
      expect(installCommitHook(dir, 9291).status).toBe('no-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('INV-1428:linked worktree(.git 为文件)安装到公共 .git/hooks,不再 ENOTDIR', () => {
    const main = mkdtempSync(join(tmpdir(), 'pop-hook-main-'));
    mkdirSync(join(main, '.git', 'hooks'), { recursive: true });
    const wt = mkdtempSync(join(tmpdir(), 'pop-hook-wt-'));
    // linked worktree 的 .git 是文件,gitdir 指向主仓 worktrees 目录
    writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
    try {
      const sharedHook = join(main, '.git', 'hooks', 'prepare-commit-msg');
      expect(prepareCommitMsgPath(wt)).toBe(sharedHook);
      const r = installCommitHook(wt, 9291);
      expect(r.ok).toBe(true);
      expect(r.status).toBe('installed');
      expect(r.path).toBe(sharedHook);
      expect(existsSync(sharedHook)).toBe(true);
      expect(readFileSync(sharedHook, 'utf8')).toContain('Harness-Session');
      expect(installCommitHook(wt, 9291).status).toBe('already');
      expect(uninstallCommitHook(wt).status).toBe('uninstalled');
      expect(existsSync(sharedHook)).toBe(false);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('钩子端到端(真 HTTP + 真 sh)', () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];

  afterAll(() => {
    for (const s of servers) s.stop(true);
  });

  test('agent 提交场景:message 模式盖章,已盖章不重复,merge 模式不动', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pop-hook-e2e-'));
    mkdirSync(join(repo, '.git'), { recursive: true }); // git rev-parse 需要
    const server = Bun.serve({ port: 0, fetch: app(repo).fetch });
    servers.push(server);
    if (server.port == null) throw new Error('no port');
    const port = server.port;
    try {
      installCommitHook(repo, port);
      // spawnSync 会阻塞事件循环,同进程 Bun.serve 就无法应答钩子里的 curl——
      // 必须异步 spawn 让 HTTP 得以处理
      const run = async (mode: string, initial: string): Promise<string> => {
        const msg = join(repo, 'COMMIT_EDITMSG');
        writeFileSync(msg, initial);
        // 模拟 git 调用 prepare-commit-msg: $1=msg $2=mode,cwd 指向 repo
        const proc = Bun.spawn(['sh', prepareCommitMsgPath(repo), msg, mode], { cwd: repo });
        expect(await proc.exited).toBe(0);
        return readFileSync(msg, 'utf8');
      };
      // 有活跃 session 且 cwd 命中 → 盖章
      const stamped = await run('message', 'feat: something\n');
      expect(stamped).toContain('Harness-Session: claude:hooked');
      // 已盖章的消息 → 不重复
      const pre = `feat: something\n\nHarness-Session: claude:hooked\n`;
      const once = await run('message', pre);
      expect(once.match(/Harness-Session/g)?.length ?? 0).toBe(1);
      // merge/squash 模式不盖章(全新消息,merge 模式直接跳过)
      const merged = await run('merge', 'feat: something\n');
      expect(merged.includes('Harness-Session')).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
