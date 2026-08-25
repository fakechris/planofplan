import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { buildHandoffPackage, deliverHandoff } from '../src/handoff.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { materializePlanFiles, materializeProgressNotes, materializeTodoSnapshots } from '../src/plans.ts';
import { materializeRequirements } from '../src/requirements.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'provider' | 'nativeId'>): SessionRecord {
  return {
    cwd: null,
    title: null,
    sourceFile: null,
    startedAt: null,
    updatedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    ...partial,
  };
}

function msg(partial: Partial<SessionMessageRow> & Pick<SessionMessageRow, 'id' | 'sessionId' | 'seq' | 'role' | 'text'>): SessionMessageRow {
  return { kind: 'text', toolName: null, timestamp: null, model: null, inputTokens: null, outputTokens: null, ...partial };
}

const LINK = 'http://localhost:9291/#sessions/x';

/** 一个带全量证据的源:需求 + 计划文件 + touch + todo + 尾总结 + commit。 */
function seededStore(root: string) {
  const store = openMemoryDb();
  const t0 = Date.now() - 60_000;
  store.upsertSessions([session({ id: 'claude:h1', provider: 'claude', nativeId: 'h1', cwd: root, updatedAt: t0 + 5000 })]);
  store.replaceSessionRepos('claude:h1', [
    { sessionId: 'claude:h1', role: 'work', url: 'git@x:h.git', root: '/repo/h', name: 'h', evidenceKind: 'observed' },
  ]);
  store.upsertSessionMessages([
    msg({ id: 'm1', sessionId: 'claude:h1', seq: 1, role: 'user', text: '把设置页重构成分组列表,要可验收', timestamp: t0 }),
    msg({ id: 'm2', sessionId: 'claude:h1', seq: 6, role: 'tool', kind: 'tool_use', toolName: 'TodoWrite', text: '{"todos":[{"content":"迁移配置","status":"completed"},{"content":"删旧样式","status":"in_progress"}]}', timestamp: t0 + 1000 }),
    msg({ id: 'm3', sessionId: 'claude:h1', seq: 9, role: 'assistant', text: '已完成分组组件与三项配置迁移,提交为 `deadbee`。剩余旧样式删除与验收截图。', timestamp: t0 + 2000 }),
  ]);
  store.upsertSessionTouches([
    { id: 't1', sessionId: 'claude:h1', provider: 'claude', filePath: join(root, 'task_plan.md'), toolName: 'Edit', op: 'edit', ts: t0 + 500, ordinal: 3000 },
  ]);
  store.upsertSessionCommits([{
    sessionId: 'claude:h1', repo: 'git@x:h.git', sha: 'deadbeefdead', kind: 'declared',
    ts: t0 + 3000, summary: 'feat: grouped settings', fileOverlap: true, pushed: true,
  }]);
  materializeRequirements(store);
  materializeTodoSnapshots(store);
  materializeProgressNotes(store);
  materializePlanFiles(store);
  return store;
}

const TASK_PLAN = `# Task Plan: 设置页分组重构

## Goal

把设置页改成分组列表,三组以下,可验收。

## Current Phase

Phase 2 — in_progress

## Phases

### Phase 1: 盘点

- [x] 列出全部配置项
**Status:** complete

### Phase 2: 重构

- [x] 分组组件
- [ ] 迁移配置
**Status:** in_progress
`;

describe('buildHandoffPackage', () => {
  test('session 源:目标/计划快照/Todo/尾总结/commit/deep link 全进包', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = seededStore(root);
      const pkg = buildHandoffPackage(store, 'session', 'claude:h1', LINK);
      expect(pkg).not.toBeNull();
      expect(pkg!.markdown).toContain('# Handoff:把设置页重构成分组列表');
      expect(pkg!.markdown).toContain(LINK);
      expect(pkg!.markdown).toContain('设置页分组重构'); // 计划标题
      expect(pkg!.markdown).toContain('Phase 2 — in_progress');
      expect(pkg!.markdown).toContain('[x] 迁移配置'); // todo 快照
      expect(pkg!.markdown).toContain('deadbeef'); // commit sha + 尾总结里的 sha
      expect(pkg!.markdown).toContain('task_plan.md'); // 涉及文件
      expect(pkg!.defaultDir).toBe(root);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });

  test('requirement / planfile 源也可生成;未知源 404 语义(null)', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff2-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = seededStore(root);
      const reqPkg = buildHandoffPackage(store, 'requirement', 'req:claude:h1:1', 'http://localhost:9291/#requirements/req:claude:h1:1');
      expect(reqPkg).not.toBeNull();
      expect(reqPkg!.markdown).toContain('设置页重构成分组列表');
      const plans = store.listPlanFiles();
      const planPkg = buildHandoffPackage(store, 'planfile', plans[0]!.id, 'http://localhost:9291/#planfiles/x');
      expect(planPkg).not.toBeNull();
      expect(planPkg!.markdown).toContain('Phase 2 — in_progress');
      expect(buildHandoffPackage(store, 'session', 'nope', LINK)).toBeNull();
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
});

describe('deliverHandoff', () => {
  test('file 模式:导出 + handoffs 记录;agent 模式:注入式 launcher 被调用', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff3-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = seededStore(root);
      const pkg = buildHandoffPackage(store, 'session', 'claude:h1', LINK)!;

      const outDir = mkdtempSync(join(tmpdir(), 'planofplan-handoff-out-'));
      const fileResult = deliverHandoff(store, pkg, { mode: 'file', targetDir: outDir });
      expect(fileResult.ok).toBe(true);
      expect(readFileSync(fileResult.path!, 'utf8')).toContain('# Handoff:');
      expect(store.handoffsFor('session', 'claude:h1')).toHaveLength(1);

      const launches: Array<{ provider: string; targetDir: string; pkgPath: string }> = [];
      const agentResult = deliverHandoff(store, pkg, {
        mode: 'agent',
        provider: 'codex',
        targetDir: root,
        launcher: (provider, _bin, targetDir, pkgPath) => {
          launches.push({ provider, targetDir, pkgPath });
          return { ok: true, command: `cd ${targetDir} && codex "$(cat ${pkgPath})"` };
        },
      });
      expect(agentResult.ok).toBe(true);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.provider).toBe('codex');
      expect(launches[0]?.targetDir).toBe(root);
      expect(readFileSync(launches[0]!.pkgPath, 'utf8')).toContain('# Handoff:');
      expect(store.handoffsFor('session', 'claude:h1')).toHaveLength(2);
      expect(store.handoffsFor('session', 'claude:h1')[0]?.mode).toBe('agent');
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
});

describe('handoff 端点', () => {
  test('预览带 providers/history;deliver file;未知源 404', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff-api-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = seededStore(root);
      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });

      const preview = await server.request('http://localhost/api/handoff/session/claude:h1');
      expect(preview.status).toBe(200);
      const body = await preview.json() as { markdown: string; providers: string[]; deepLink: string };
      expect(body.markdown).toContain('# Handoff:');
      expect(body.providers).toContain('claude');
      expect(body.deepLink).toContain('#sessions/claude%3Ah1');

      const outDir = mkdtempSync(join(tmpdir(), 'planofplan-handoff-api-out-'));
      const deliver = await server.request('http://localhost/api/handoff/session/claude:h1/deliver', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'file', targetDir: outDir }),
      });
      expect(deliver.status).toBe(200);
      const deliverBody = await deliver.json() as { ok: boolean; path: string };
      expect(deliverBody.ok).toBe(true);
      expect(readFileSync(deliverBody.path, 'utf8')).toContain('# Handoff:');

      const missing = await server.request('http://localhost/api/handoff/session/nope');
      expect(missing.status).toBe(404);
      rmSync(root, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
});
