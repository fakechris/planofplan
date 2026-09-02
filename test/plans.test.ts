import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import {
  discoverPlanFiles,
  isSummaryMessage,
  materializePlanFiles,
  materializeProgressNotes,
  materializeTodoSnapshots,
  parsePlanMarkdown,
  parseTodoToolText,
  planFileId,
  planKindOf,
} from '../src/plans.ts';
import { createServer } from '../src/server.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
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
  return { kind: 'tool_use', toolName: 'TodoWrite', timestamp: null, model: null, inputTokens: null, outputTokens: null, ...partial };
}

const TASK_PLAN = `# Task Plan: 把入口页重构为列表式布局

## Goal

把设置页从一大坨改为分组列表,可验收:三组以下、每组可折叠。

## Current Phase

Phase 2 — in_progress

## Phases

### Phase 1: 事实核对

- [x] 核对现有配置项
- [x] 列出重复项
**Status:** complete

### Phase 2: 重构

- [x] 新建分组组件
- [ ] 迁移三项配置
- [ ] 删掉旧样式
**Status:** in_progress

### Phase 3: 验收

- [ ] 截图对比
**Status:** pending
`;

describe('parsePlanMarkdown', () => {
  test('task_plan.md:标题/Goal/当前阶段/小节状态/checkbox 统计', async () => {
    const parsed = parsePlanMarkdown(TASK_PLAN);
    expect(parsed.title).toBe('把入口页重构为列表式布局');
    expect(parsed.goal).toContain('分组列表');
    expect(parsed.currentPhase).toBe('Phase 2 — in_progress');
    expect(parsed.checkboxChecked).toBe(3);
    expect(parsed.checkboxTotal).toBe(6);
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0]).toMatchObject({ status: 'complete', checked: 2, total: 2 });
    expect(parsed.sections[1]).toMatchObject({ status: 'in_progress', checked: 1, total: 3 });
    expect(parsed.sections[2]).toMatchObject({ status: 'pending', checked: 0, total: 1 });
  });

  test('progress.md 的 Session 节同构复用', async () => {
    const parsed = parsePlanMarkdown('# Progress Log\n\n## Session: 2026-07-17\n\n### Phase 1: 核对\n\n- **Status:** complete\n- Actions taken:\n  - 核对配置\n');
    expect(parsed.sections[0]).toMatchObject({ heading: 'Phase 1: 核对', status: 'complete' });
  });
});

describe('parseTodoToolText', () => {
  test('claude(content)与 zcode(title)两种形态统一;坏行文返回 null', async () => {
    expect(parseTodoToolText('{"todos":[{"content":"验证 web 健康","status":"in_progress"},{"content":"检查 env","status":"pending"}]}'))
      .toEqual([
        { title: '验证 web 健康', status: 'in_progress' },
        { title: '检查 env', status: 'pending' },
      ]);
    expect(parseTodoToolText('{"todos":[{"title":"分析引擎","status":"completed"}]}'))
      .toEqual([{ title: '分析引擎', status: 'completed' }]);
    expect(parseTodoToolText('not json')).toBeNull();
    expect(parseTodoToolText('{"todos":[]}')).toBeNull();
    expect(parseTodoToolText('{"other":1}')).toBeNull();
  });
});

describe('materializeTodoSnapshots', () => {
  test('从消息表抽取两种工具形态,幂等;级联随 session', async () => {
    const store = openMemoryDb();
    store.upsertSessions([
      session({ id: 'claude:t1', provider: 'claude', nativeId: 't1' }),
      session({ id: 'zcode:t2', provider: 'zcode', nativeId: 't2' }),
    ]);
    store.upsertSessionMessages([
      msg({ id: 'm1', sessionId: 'claude:t1', seq: 3, role: 'tool', text: '{"todos":[{"content":"A","status":"in_progress"}]}' }),
      msg({ id: 'm2', sessionId: 'claude:t1', seq: 5, role: 'tool', text: '{"todos":[{"content":"A","status":"completed"},{"content":"B","status":"in_progress"}]}' }),
      msg({ id: 'm3', sessionId: 'zcode:t2', seq: 1, role: 'tool', toolName: 'TodoList', text: '{"todos":[{"title":"C","status":"pending"}]}' }),
      msg({ id: 'm4', sessionId: 'claude:t1', seq: 7, role: 'tool', text: 'broken{' }),
    ]);
    expect(materializeTodoSnapshots(store)).toBe(3);
    expect(store.todoSnapshotsForSession('claude:t1')).toHaveLength(2);
    expect(store.todoSnapshotsForSession('claude:t1')[1]?.items[0]).toMatchObject({ title: 'A', status: 'completed' });
    expect(store.todoSnapshotsForSession('zcode:t2')[0]?.items[0]?.title).toBe('C');
    materializeTodoSnapshots(store); // 幂等
    expect(store.todoSnapshotsForSession('claude:t1')).toHaveLength(2);
    store.deleteSession('claude:t1');
    expect(store.todoSnapshotsForSession('claude:t1')).toHaveLength(0);
  });
});

describe('④ 尾总结抽取', () => {
  test('isSummaryMessage:强前缀 + ≥40 字;短句/普通回复不算', async () => {
    expect(isSummaryMessage('已完成源 PDF 六份的视觉渲染与财务报表页初步查看;当前未遇到渲染阻塞。现在重新用浏览器打开。')).toBe(true);
    expect(isSummaryMessage('本轮已提交:`57a72d4 补充架构包审计与离线入口`。当前工作树干净,无遗留修改。')).toBe(true);
    expect(isSummaryMessage('总结:这一轮做了三件事,剩下验证和文档两步。')).toBe(false); // 长度不足 40
    expect(isSummaryMessage('好的,我来处理')).toBe(false);
    expect(isSummaryMessage('这一步我们需要先理解需求的本质,然后再决定怎么拆分与交付,先把范围收敛下来再动手。')).toBe(true);
  });

  test('物化 + 端点(带 commitCount 对账素材)+ 级联', async () => {
    const store = openMemoryDb();
    store.upsertSessions([session({ id: 'claude:n1', provider: 'claude', nativeId: 'n1' })]);
    store.upsertSessionMessages([
      {
        id: 's1', sessionId: 'claude:n1', seq: 2, role: 'assistant', kind: 'text', toolName: null,
        text: '已完成入口页重构:分组组件、三项配置迁移和旧样式删除,提交为 `abc1234`。剩余验收截图未做。',
        timestamp: Date.now() - 1000, model: null, inputTokens: null, outputTokens: null,
      },
      {
        id: 's2', sessionId: 'claude:n1', seq: 3, role: 'assistant', kind: 'text', toolName: null,
        text: '好的,继续', timestamp: Date.now(), model: null, inputTokens: null, outputTokens: null,
      },
    ]);
    expect(materializeProgressNotes(store)).toBe(1);
    materializeProgressNotes(store); // 幂等
    expect(store.progressNotesForSession('claude:n1')).toHaveLength(1);
    expect(store.progressNotesForSession('claude:n1')[0]?.text).toContain('abc1234');

    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    const res = await server.request('http://localhost/api/sessions/claude:n1/notes');
    expect(res.status).toBe(200);
    const body = await res.json() as { notes: Array<{ text: string }>; commitCount: number };
    expect(body.notes).toHaveLength(1);
    expect(body.commitCount).toBe(0); // 无归因 commit → 前端对账黄标素材

    store.deleteSession('claude:n1');
    expect(store.progressNotesForSession('claude:n1')).toHaveLength(0);
  });
});

describe('materializePlanFiles', () => {
  function seededStore(cwd: string) {
    const store = openMemoryDb();
    store.upsertSessions([session({ id: 'claude:p1', provider: 'claude', nativeId: 'p1', cwd })]);
    return store;
  }

  test('发现/解析/快照幂等(mtime 门控);演进追加快照;消失置 missing_since', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-plans-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
      writeFileSync(join(root, 'docs', 'plans', 'entry-refactor.plan.md'), '# Plan: 入口改造\n\n- [ ] 步骤一\n');
      writeFileSync(join(root, 'HANDOFF-rc9.md'), '# HANDOFF rc9\n\nnext: 收尾\n');
      writeFileSync(join(root, 'HANDOFF.md'), '# HANDOFF\n\n当前状态\n'); // 无分隔符的标准名
      const store = seededStore(root);

      expect(await materializePlanFiles(store, { spotlight: false })).toBe(4);
      const files = store.listPlanFiles();
      expect(files).toHaveLength(4);
      const taskPlan = files.find((file) => file.path.endsWith('task_plan.md'));
      expect(taskPlan).toMatchObject({
        id: planFileId(join(root, 'task_plan.md')),
        kind: 'task_plan',
        title: '把入口页重构为列表式布局',
        currentPhase: 'Phase 2 — in_progress',
        repo: root, // 非 git 目录:以发现根为身份(目录即项目)
      });
      expect(files.find((file) => file.path.includes('docs/plans'))?.kind).toBe('detailed_plan');
      expect(files.filter((file) => file.path.includes('HANDOFF')).every((file) => file.kind === 'handoff')).toBe(true);
      expect(store.planSnapshots(taskPlan!.id)[0]).toMatchObject({ checkboxChecked: 3, checkboxTotal: 6 });
      expect(store.planSnapshotCount(taskPlan!.id)).toBe(1);

      // mtime 未变 → 只续命,不追加快照
      materializePlanFiles(store, { spotlight: false });
      expect(store.planSnapshotCount(taskPlan!.id)).toBe(1);

      // 内容演进(勾掉一项,mtime 推后)→ 新快照,确定性 id 不冲突
      const evolved = TASK_PLAN.replace('- [ ] 删掉旧样式', '- [x] 删掉旧样式');
      const mtime = statSync(join(root, 'task_plan.md')).mtimeMs + 5000;
      writeFileSync(join(root, 'task_plan.md'), evolved);
      utimesSync(join(root, 'task_plan.md'), mtime / 1000, mtime / 1000);
      materializePlanFiles(store, { spotlight: false });
      expect(store.planSnapshotCount(taskPlan!.id)).toBe(2);
      expect(store.planSnapshots(taskPlan!.id)[0]).toMatchObject({ checkboxChecked: 4, checkboxTotal: 6 });
      // 同内容重扫(只 bump mtime)→ 快照幂等(同 raw_hash 同 id)
      const again = statSync(join(root, 'task_plan.md')).mtimeMs + 8000;
      utimesSync(join(root, 'task_plan.md'), again / 1000, again / 1000);
      materializePlanFiles(store, { spotlight: false });
      expect(store.planSnapshotCount(taskPlan!.id)).toBe(2);

      // 文件消失 → missing_since,行与历史快照保留
      rmSync(join(root, 'HANDOFF-rc9.md'));
      materializePlanFiles(store, { spotlight: false });
      const handoff = store.listPlanFiles().find((file) => file.path.includes('HANDOFF'));
      expect(handoff?.missingSince).not.toBeNull();
      expect(store.planSnapshotCount(handoff!.id)).toBe(1);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });

  test('归因桥:detail 端点带触碰 session 与其需求', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-plans-api-'));
    try {
      writeFileSync(join(root, 'task_plan.md'), TASK_PLAN);
      const store = seededStore(root);
      materializePlanFiles(store, { spotlight: false });
      // 模拟该 session 触碰过 plan 文件 + 有需求实体
      store.upsertSessionTouches([{
        id: 't1', sessionId: 'claude:p1', provider: 'claude',
        filePath: join(root, 'task_plan.md'), toolName: 'Edit', op: 'edit', ts: null, ordinal: 2000,
      }]);
      store.upsertSessionMessages([{
        id: 'm1', sessionId: 'claude:p1', seq: 1, role: 'user', kind: 'text',
        toolName: null, text: '把设置页重构成分组列表,要可验收', timestamp: Date.now() - 5000,
        model: null, inputTokens: null, outputTokens: null,
      }]);
      const { materializeRequirements } = await import('../src/requirements.ts');
      materializeRequirements(store);
      const plan = store.listPlanFiles()[0]!;

      const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
      const list = await server.request('http://localhost/api/planfiles?days=30');
      const listBody = await list.json() as { plans: Array<{ id: string; checkboxTotal: number; activeAt: number }> };
      expect(listBody.plans[0]).toMatchObject({ id: plan.id, checkboxTotal: 6 });
      expect(listBody.plans[0]!.activeAt).toBeGreaterThan(Date.now() - 86_400_000);

      const detail = await server.request(`http://localhost/api/planfiles/${plan.id}`);
      const detailBody = await detail.json() as {
        snapshots: Array<{ checkboxTotal: number }>;
        sessions: Array<{ id: string; requirement: { text: string } | null }>;
        requirements: Array<{ text: string }>;
        commits: Array<{ sha: string }>;
        project: { id: string; name: string } | null;
      };
      expect(detailBody.snapshots[0]?.checkboxTotal).toBe(6);
      expect(detailBody.sessions[0]?.id).toBe('claude:p1');
      expect(detailBody.sessions[0]?.requirement?.text).toContain('分组列表');
      // 跨实体关联:plan → requirement(触碰 session 的需求)+ project
      expect(detailBody.requirements[0]?.text).toContain('分组列表');
      expect(detailBody.project).toBeNull(); // 非 git 目录

      // 跨实体关联:session → plan / requirement → plan / project → plan
      const sessionDetail = await server.request('http://localhost/api/sessions/claude:p1');
      const sessionBody = await sessionDetail.json() as { plans: Array<{ id: string }> };
      expect(sessionBody.plans[0]?.id).toBe(plan.id);

      const reqDetail = await server.request(`http://localhost/api/requirements/${encodeURIComponent('req:claude:p1:1')}`);
      const reqBody = await reqDetail.json() as { plans: Array<{ id: string }> };
      expect(reqBody.plans[0]?.id).toBe(plan.id);

      const missing = await server.request('http://localhost/api/planfiles/nope');
      expect(missing.status).toBe(404);
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });

  test('发现:直接名 + docs/plans + HANDOFF + 泛计划命名(IMPLEMENTATION_PLAN/roadmap/plans 目录),排除 README 类', async () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-discover-'));
    try {
      writeFileSync(join(root, 'progress.md'), '# P\n');
      writeFileSync(join(root, 'notes.md'), '# N\n'); // 非候选
      writeFileSync(join(root, 'README.md'), '# r\n'); // 明确排除
      writeFileSync(join(root, 'IMPLEMENTATION_PLAN.md'), '# impl\n'); // planofplan/lumen 家族约定
      writeFileSync(join(root, '._task_plan.md'), 'junk\n'); // AppleDouble 垃圾
      mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
      writeFileSync(join(root, 'docs', 'plans', 'a.md'), '# a\n');
      mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'specs', 'b-spec.md'), '# b\n'); // specs 目录全收
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'roadmap.md'), '# rm\n'); // 深度 1 泛匹配
      const found = discoverPlanFiles(root).map((path) => path.split('/').pop()).sort();
      expect(found).toEqual(['IMPLEMENTATION_PLAN.md', 'a.md', 'b-spec.md', 'progress.md', 'roadmap.md']);
      expect(planKindOf('/x/docs/plans/a.md')).toBe('detailed_plan');
      expect(planKindOf('/x/docs/specs/b.md')).toBe('detailed_plan');
      expect(planKindOf('/x/HANDOFF_x.md')).toBe('handoff');
      expect(planKindOf('/x/IMPLEMENTATION_PLAN.md')).toBe('plan');
      expect(planKindOf('/x/roadmap.md')).toBe('roadmap');
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
});
