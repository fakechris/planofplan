import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { buildHandoffPackage, deliverHandoff, extractSessionRefs, repairHandoffReferences, sessionRef } from '../src/handoff.ts';
import { handleMcpBody } from '../src/mcp.ts';
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
async function seededStore(root: string) {
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
  await materializePlanFiles(store, { spotlight: false });
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
  test('planfile 包排除隐藏会话的总结、引用及关联提交', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff-hidden-plan-'));
    const store = await (async () => {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      return seededStore(root);
    })();
    try {
      store.setSessionHidden('claude:h1', true);
      const plan = store.listPlanFiles()[0]!;
      const pkg = buildHandoffPackage(store, 'planfile', plan.id, LINK)!;
      expect(pkg.markdown).not.toContain('deadbeef');
      expect(pkg.markdown).not.toContain('claude:h1');
      expect(pkg.markdown).not.toContain('剩余旧样式删除与验收截图');
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('session 源:目标/计划快照/Todo/尾总结/commit/deep link 全进包', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = await seededStore(root);
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

  test('requirement / planfile 源也可生成;未知源 404 语义(null)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff2-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = await seededStore(root);
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

describe('会话引用协议(@session:{id})', () => {
  test('交接包的相关会话行带规范引用,可被 extractSessionRefs 反解', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff-ref-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = await seededStore(root);
      const pkg = buildHandoffPackage(store, 'session', 'claude:h1', LINK)!;
      expect(pkg.markdown).toContain(sessionRef('claude:h1'));
      expect(pkg.markdown).toContain('read_session');
      expect(extractSessionRefs(pkg.markdown)).toContain('claude:h1');
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });

  test('repairHandoffReferences 修复 LLM 常见畸形:裸引用/全角括号/未闭合', () => {
    expect(repairHandoffReferences('见 @session:claude:abc-123 的记录'))
      .toBe('见 @session:{claude:abc-123} 的记录');
    expect(repairHandoffReferences('见 @session:｛claude:abc｝ 的记录'))
      .toBe('见 @session:{claude:abc} 的记录');
    expect(repairHandoffReferences('续 @session:{claude:abc 后面还有字'))
      .toBe('续 @session:{claude:abc} 后面还有字');
    // 已规范的引用与句尾标点不被破坏
    const canonical = `规范 ${sessionRef('claude:abc')} 与句尾 ${sessionRef('claude:def')}.`;
    expect(repairHandoffReferences(canonical)).toBe(canonical);
    expect(extractSessionRefs(canonical)).toEqual(['claude:abc', 'claude:def']);
  });
});

describe('交接信封三段结构(INV-2168)', () => {
  const CORE_HEADER = '## Core(自包含,零上下文可读)';
  const REFERENCES_HEADER = '## References(显式引用清单,由收包方逐跳展开)';
  const EXCLUDED_HEADER = '## Excluded(排除项及原因)';

  /** 信封用 fixture:需求文本带 URL 与跨系统引用;触碰含越界路径;边界 = cwd + /repo/e。 */
  async function envelopeStore(root: string) {
    const store = openMemoryDb();
    const t0 = Date.now() - 60_000;
    store.upsertSessions([session({ id: 'claude:e1', provider: 'claude', nativeId: 'e1', cwd: root, updatedAt: t0 + 5000 })]);
    store.replaceSessionRepos('claude:e1', [
      { sessionId: 'claude:e1', role: 'work', url: 'git@x:e.git', root: '/repo/e', name: 'e', evidenceKind: 'observed' },
    ]);
    store.upsertSessionMessages([
      msg({ id: 'e1', sessionId: 'claude:e1', seq: 1, role: 'user', text: '按 https://example.com/spec 分组设置页,关联 inv:INV-2166 与 ovp://source/abc123,依据 pop:claude:e1#e1@sha256:dead', timestamp: t0 }),
      msg({ id: 'e2', sessionId: 'claude:e1', seq: 5, role: 'assistant', text: '分组完成,提交为 beefcafe。', timestamp: t0 + 1000 }),
    ]);
    store.upsertSessionTouches([
      { id: 'et1', sessionId: 'claude:e1', provider: 'claude', filePath: join(root, 'task_plan.md'), toolName: 'Edit', op: 'edit', ts: t0 + 500, ordinal: 3000 },
      { id: 'et2', sessionId: 'claude:e1', provider: 'claude', filePath: '/elsewhere/outside.md', toolName: 'Edit', op: 'edit', ts: t0 + 600, ordinal: 3001 },
    ]);
    store.upsertSessionCommits([{
      sessionId: 'claude:e1', repo: 'git@x:e.git', sha: 'beefcafebeef', kind: 'declared',
      ts: t0 + 3000, summary: 'feat: grouped settings', fileOverlap: true, pushed: true,
    }]);
    materializeRequirements(store);
    return store;
  }

  test('三段结构存在;会话行带 source_revision;引用可反解;core 不含内联引用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-envelope-'));
    try {
      const store = await envelopeStore(root);
      const pkg = buildHandoffPackage(store, 'session', 'claude:e1', LINK)!;
      const core = pkg.markdown.slice(pkg.markdown.indexOf(CORE_HEADER), pkg.markdown.indexOf(REFERENCES_HEADER));
      expect(pkg.markdown).toContain(CORE_HEADER);
      expect(pkg.markdown).toContain(REFERENCES_HEADER);
      expect(pkg.markdown).toContain(EXCLUDED_HEADER);
      // 段序:Core → References → Excluded → (尾对话仅显式预算) → 复述验收
      expect(pkg.markdown.indexOf(CORE_HEADER)).toBeLessThan(pkg.markdown.indexOf(REFERENCES_HEADER));
      expect(pkg.markdown.indexOf(REFERENCES_HEADER)).toBeLessThan(pkg.markdown.indexOf(EXCLUDED_HEADER));
      // 会话引用行带会话级 source_revision,且可被 extractSessionRefs 反解
      expect(pkg.markdown).toContain(`source_revision=sha256:`);
      expect(pkg.markdown).toContain(sessionRef('claude:e1'));
      expect(extractSessionRefs(pkg.markdown)).toContain('claude:e1');
      // commit 行带证据等级
      expect(pkg.markdown).toContain('[declared]');
      // core 段不含内联引用内容:无会话引用、无深链、无 commit sha
      // (需求原话里的 URL 属于意图文本的一部分,保留原样;物化与否由 Excluded 声明)
      expect(core).not.toContain('@session:{');
      expect(core).not.toContain(LINK);
      expect(core).not.toContain('beefcafe');
      // 跨系统引用进 References 作为可寻址条目(需求原话里的引用按合同原样保留在 Core,
      // 不改写不脱链;References 负责让收包方逐条展开)
      const references = pkg.markdown.slice(pkg.markdown.indexOf(REFERENCES_HEADER), pkg.markdown.indexOf(EXCLUDED_HEADER));
      expect(references).toContain('inv:INV-2166');
      expect(references).toContain('ovp://source/abc123');
      expect(references).toContain('pop:claude:e1');
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('越界路径与未物化 URL 进 Excluded 并带原因;深链作为引用在 References', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-envelope-oob-'));
    try {
      const store = await envelopeStore(root);
      const pkg = buildHandoffPackage(store, 'session', 'claude:e1', LINK)!;
      const references = pkg.markdown.slice(pkg.markdown.indexOf(REFERENCES_HEADER), pkg.markdown.indexOf(EXCLUDED_HEADER));
      const excluded = pkg.markdown.slice(pkg.markdown.indexOf(EXCLUDED_HEADER));
      // 边界内文件进 References
      expect(references).toContain(join(root, 'task_plan.md'));
      expect(references).not.toContain('/elsewhere/outside.md');
      // 越界路径进 Excluded 且写明原因与边界根
      expect(excluded).toContain('/elsewhere/outside.md');
      expect(excluded).toContain('越界');
      expect(excluded).toContain(root);
      // 未物化 URL 进 Excluded;深链(导出方生成的)留在 References 并标注自行展开
      expect(excluded).toContain('https://example.com/spec');
      expect(excluded).toContain('URL 引用未物化');
      expect(references).toContain(LINK);
      expect(references).toContain('由收包方自行展开');
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('复述验收模板固定在包尾;默认无尾对话,尾对话(显式预算)在信封之外', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-envelope-gate-'));
    try {
      const store = await envelopeStore(root);
      const plain = buildHandoffPackage(store, 'session', 'claude:e1', LINK)!.markdown;
      expect(plain).toContain('## 复述验收');
      expect(plain).toContain('What this proposes');
      expect(plain).toContain('How the current system works');
      expect(plain.indexOf(EXCLUDED_HEADER)).toBeLessThan(plain.indexOf('## 复述验收'));
      // 默认(不给 tailChars)包内没有可由引用恢复的尾对话
      expect(plain).not.toContain('## 最近对话');
      expect(plain).not.toContain('分组完成,提交为'); // assistant 原文不内联
      const tailed = buildHandoffPackage(store, 'session', 'claude:e1', LINK, { tailChars: 4000 })!.markdown;
      expect(tailed).toContain('## 最近对话');
      // 尾对话在信封三段之后、复述验收之前(信封之外的附录)
      expect(tailed.indexOf(EXCLUDED_HEADER)).toBeLessThan(tailed.indexOf('## 最近对话'));
      expect(tailed.indexOf('## 最近对话')).toBeLessThan(tailed.indexOf('## 复述验收'));
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('两出口一致:MCP session_handoff 与 HTTP /api/handoff 都带三段与复述门', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-envelope-exits-'));
    try {
      const store = await envelopeStore(root);
      const mcp = handleMcpBody(store, { port: 9291, plans: [] }, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'session_handoff', arguments: { session_id: 'claude:e1' } },
      }) as { result?: { content: Array<{ text: string }> } };
      const mcpText = mcp.result!.content[0]!.text;
      for (const marker of [CORE_HEADER, REFERENCES_HEADER, EXCLUDED_HEADER, '## 复述验收', 'source_revision=sha256:']) {
        expect(mcpText).toContain(marker);
      }
      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
      const http = await (await server.request('http://localhost/api/handoff/session/claude:e1')).json() as { markdown: string };
      for (const marker of [CORE_HEADER, REFERENCES_HEADER, EXCLUDED_HEADER, '## 复述验收', 'source_revision=sha256:']) {
        expect(http.markdown).toContain(marker);
      }
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('隐藏会话仍整包拒绝(信封不放松 INV-277 边界)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-envelope-hidden-'));
    try {
      const store = await envelopeStore(root);
      store.setSessionHidden('claude:e1', true);
      expect(buildHandoffPackage(store, 'session', 'claude:e1', LINK)).toBeNull();
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deliverHandoff', () => {
  test('file 模式:导出 + handoffs 记录;agent 模式:注入式 launcher 被调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-handoff3-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = await seededStore(root);
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
      const store = await seededStore(root);
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
