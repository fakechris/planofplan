import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import {
  ExperienceValidationError,
  isValidEvidenceRef,
  saveExperienceNode,
  synthesizeExperienceGraph,
  validateExperienceNode,
  visibleInvariants,
} from '../src/experience-graph.ts';
import type { ExperienceNodeInput } from '../src/experience-graph.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { createServer } from '../src/server.ts';
import type { RequirementRecord, SessionRecord } from '../src/types.ts';

const SID = 'claude:exp1';
const REPO = 'git@x:exp.git';
const ROOT = '/repo/exp';
const t0 = Date.now() - 60_000;

function session(partial: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SID, provider: 'claude', nativeId: 'exp1', cwd: ROOT, title: 'exp', sourceFile: null,
    startedAt: t0 - 10_000, updatedAt: t0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    estimatedCostUsd: null, seenAt: t0, ...partial,
  };
}

function requirement(seq: number, text: string): RequirementRecord {
  return { id: `req:exp:${seq}`, sessionId: SID, seq, text, originLevel: 'user_explicit', ts: t0 - 9000 + seq, repos: [REPO] };
}

/** 一个最小事实底座:1 会话 + 1 仓库 + N 需求 + touch + commit + 1 张 reviewed 卡。 */
function fixture(requirements: RequirementRecord[]) {
  const store = openMemoryDb();
  store.upsertSessions([session()]);
  store.replaceSessionRepos(SID, [
    { sessionId: SID, role: 'work', url: REPO, root: ROOT, name: 'exp', evidenceKind: 'observed' },
  ]);
  store.replaceAllRequirements(requirements);
  store.upsertSessionTouches([
    // ordinal 与 seq 同轴(seq*1000 + 子序):req seq=1 → 触碰须 ≥1000 才落在 span 内
    { id: 'touch:1', sessionId: SID, provider: 'claude', filePath: `${ROOT}/src/config.ts`, toolName: 'Edit', op: 'edit', ts: t0 + 100, ordinal: 1500 },
  ]);
  store.upsertSessionCommits([{
    sessionId: SID, repo: REPO, sha: 'a'.repeat(40), kind: 'declared',
    ts: t0 + 200, summary: 'feat: config to sqlite', fileOverlap: true, pushed: true,
  }]);
  store.upsertKnowledgeCard({
    id: 'kc1', kind: 'constraint', problem: '配置文件只读', action: '禁止写 config.json',
    preconditions: null, repo: 'exp', scopePaths: [], repoRevision: null, versionRange: null,
    sourceRefs: [{ ref: `@session:{${SID}}` }], counterexamples: [],
    status: 'reviewed', reviewer: 'chris', reviewedAt: t0, expiresAt: null, createdAt: 0, updatedAt: 0,
  });
  return store;
}

function nodeInput(overrides: Partial<ExperienceNodeInput> = {}): ExperienceNodeInput {
  return {
    nodeKind: 'leaf',
    repo: REPO,
    path: 'req:exp:1',
    parentId: 'exp-index:x',
    summary: '把配置迁移到 SQLite',
    interface: ['src/config.ts ×1'],
    invariants: [{ text: '[constraint] 配置文件只读 → 禁止写 config.json', evidence: [{ ref: `@session:{${SID}}`, level: 'reviewed' as const }] }],
    sideEffects: [],
    sources: { requirementId: 'req:exp:1' },
    ...overrides,
  };
}

describe('证据引用与节点校验(schema 单测)', () => {
  test('isValidEvidenceRef:七类合法格式与非法输入', () => {
    for (const ref of [
      `@session:{${SID}}`,
      'pop:claude:abc-123#m1@sha256:deadbeef',
      'req:exp:1',
      'inv:INV-2169',
      'ovp://source/abc123',
      'deadbeefdead',
      'https://example.com/spec',
    ]) {
      expect(isValidEvidenceRef(ref)).toBe(true);
    }
    for (const ref of ['', '随便一句话', '@session:claude:abc', 'inv:2169', 'xyz://nope']) {
      expect(isValidEvidenceRef(ref)).toBe(false);
    }
  });

  test('无证据断言拒绝入库;格式不符拒绝;必填字段缺失拒绝', () => {
    expect(() => validateExperienceNode(nodeInput({ invariants: [{ text: '断言', evidence: [] }] })))
      .toThrow(ExperienceValidationError);
    expect(() => validateExperienceNode(nodeInput({ invariants: [{ text: '断言', evidence: [{ ref: '不是引用', level: 'reviewed' }] }] })))
      .toThrow(/证据引用格式不符/);
    expect(() => validateExperienceNode(nodeInput({ invariants: [{ text: '断言', evidence: [{ ref: `@session:{${SID}}`, level: 'bogus' as never }] }] })))
      .toThrow(/证据等级非法/);
    expect(() => validateExperienceNode(nodeInput({ summary: '' }))).toThrow(/summary 必填/);
    expect(() => validateExperienceNode(nodeInput({ repo: '' }))).toThrow(/repo 必填/);
    // 合法输入通过
    expect(() => validateExperienceNode(nodeInput())).not.toThrow();
  });

  test('saveExperienceNode:同内容幂等;内容变更 superseded 不删除;回退复活', () => {
    const store = openMemoryDb();
    try {
      const first = saveExperienceNode(store, nodeInput());
      expect(first.action).toBe('created');
      // 同内容重跑:unchanged,不产生新行
      const again = saveExperienceNode(store, nodeInput());
      expect(again.action).toBe('unchanged');
      expect(again.id).toBe(first.id);
      expect(store.listExperienceNodes({ includeSuperseded: true })).toHaveLength(1);
      // 内容变更:旧行 superseded(保留),新行 active
      const second = saveExperienceNode(store, nodeInput({ summary: '把配置迁移到 SQLite(修订)' }));
      expect(second.action).toBe('superseded');
      expect(second.id).not.toBe(first.id);
      const rows = store.listExperienceNodes({ includeSuperseded: true });
      expect(rows).toHaveLength(2);
      const oldRow = rows.find((row) => row.id === first.id)!;
      expect(oldRow.status).toBe('superseded');
      expect(oldRow.supersededBy).toBe(second.id);
      // active 唯一:自然键只有一行
      expect(store.listExperienceNodes()).toHaveLength(1);
      // 内容回退:旧行复活,接管 active 位
      const reverted = saveExperienceNode(store, nodeInput());
      expect(reverted.action).toBe('resurrected');
      expect(reverted.id).toBe(first.id);
      expect(store.listExperienceNodes()).toHaveLength(1);
      expect(store.listExperienceNodes()[0]!.id).toBe(first.id);
    } finally {
      store.close();
    }
  });
});

describe('合成管道(确定性骨架)', () => {
  test('合成产出 index+leaf 五元组;invariants 带证据;幂等重跑零新增', () => {
    const store = fixture([requirement(1, '把配置迁移到 SQLite')]);
    try {
      const first = synthesizeExperienceGraph(store);
      expect(first.status).toBe('ok');
      expect(first.created).toBe(2); // 1 index + 1 leaf
      expect(first.discovered).toBe(2);
      const nodes = store.listExperienceNodes();
      expect(nodes).toHaveLength(2);
      const leaf = store.listExperienceNodes({ nodeKind: 'leaf' })[0]!;
      const index = store.listExperienceNodes({ nodeKind: 'index' })[0]!;
      // summary = 需求原话(零捏造,不截断改写)
      expect(leaf.summary).toBe('把配置迁移到 SQLite');
      // parentId 是逻辑键(exp-index:<repo>),稳定于内容变更
      expect(leaf.parentId).toBe(`exp-index:${REPO}`);
      // 接触面是仓库相对路径
      expect(leaf.interface.join('\n')).toContain('src/config.ts');
      // commit 副作用带等级
      expect(leaf.sideEffects.join('\n')).toContain('aaaaaaaa');
      expect(leaf.sideEffects.join('\n')).toContain('[declared]');
      // 知识卡断言带证据引用与等级
      expect(leaf.invariants).toHaveLength(1);
      expect(leaf.invariants[0]!.evidence[0]!.ref).toBe(`@session:{${SID}}`);
      expect(leaf.invariants[0]!.evidence[0]!.level).toBe('reviewed');
      // index 无断言,聚合文件面
      expect(index.invariants).toHaveLength(0);
      // 幂等:重跑全部 unchanged
      const second = synthesizeExperienceGraph(store);
      expect(second.status).toBe('ok');
      expect(second.created).toBe(0);
      expect(second.unchanged).toBe(2);
      expect(store.listExperienceNodes({ includeSuperseded: true })).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test('安全门:超阈值暂停请求确认;confirm 越门;maxNodes 可配', () => {
    const store = fixture(Array.from({ length: 15 }, (_, i) => requirement(i + 1, `需求 ${i + 1}`)));
    try {
      // 15 leaf + 1 index = 16 > 15(默认):暂停,未写任何行
      const gated = synthesizeExperienceGraph(store);
      expect(gated.status).toBe('confirmation-required');
      expect(gated.discovered).toBe(16);
      expect(store.listExperienceNodes({ includeSuperseded: true })).toHaveLength(0);
      // confirm 越门
      const confirmed = synthesizeExperienceGraph(store, { confirm: true });
      expect(confirmed.status).toBe('ok');
      expect(confirmed.created).toBe(16);
      // maxNodes 放宽阈值:20 节点直接通过
      const store2 = fixture(Array.from({ length: 19 }, (_, i) => requirement(i + 1, `需求 ${i + 1}`)));
      try {
        const wide = synthesizeExperienceGraph(store2, { maxNodes: 20 });
        expect(wide.status).toBe('ok');
        expect(wide.discovered).toBe(20);
      } finally {
        store2.close();
      }
    } finally {
      store.close();
    }
  });

  test('无证据来源的卡断言拒绝并计数;隐藏会话的需求与断言合成期过滤', () => {
    const store = fixture([requirement(1, '把配置迁移到 SQLite')]);
    try {
      // 无 source_refs 的卡:断言不入库,记入 skippedCards
      store.upsertKnowledgeCard({
        id: 'kc2', kind: 'decision', problem: '无来源卡', action: '不应入库',
        preconditions: null, repo: 'exp', scopePaths: [], repoRevision: null, versionRange: null,
        sourceRefs: [], counterexamples: [], status: 'reviewed', reviewer: 'chris', reviewedAt: t0,
        expiresAt: null, createdAt: 0, updatedAt: 0,
      });
      // 引用格式全不合法的卡:断言拒绝,计数
      store.upsertKnowledgeCard({
        id: 'kc3', kind: 'decision', problem: '坏引用卡', action: '拒绝',
        preconditions: null, repo: 'exp', scopePaths: [], repoRevision: null, versionRange: null,
        sourceRefs: [{ ref: '不是合法引用' }], counterexamples: [], status: 'reviewed', reviewer: 'chris',
        reviewedAt: t0, expiresAt: null, createdAt: 0, updatedAt: 0,
      });
      const result = synthesizeExperienceGraph(store);
      expect(result.status).toBe('ok');
      expect(result.skippedCards).toContain('kc2');
      expect(result.rejectedInvariants).toBe(1);
      const leaf = store.listExperienceNodes({ nodeKind: 'leaf' })[0]!;
      expect(leaf.invariants).toHaveLength(1); // 只有 kc1
      // 隐藏会话:需求整体过滤,不产节点
      store.setSessionHidden(SID, true);
      const hiddenRun = synthesizeExperienceGraph(store);
      expect(hiddenRun.discovered).toBe(0);
    } finally {
      store.close();
    }
  });

  test('L0 只读:合成前后源文件指纹不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planofplan-exp-l0-'));
    try {
      const l0Path = join(dir, 'session.jsonl');
      writeFileSync(l0Path, `{"ts":${t0},"role":"user","text":"把配置迁移到 SQLite"}\n`, 'utf8');
      const hashBefore = createHash('sha256').update(readFileSync(l0Path)).digest('hex');
      const store = fixture([requirement(1, '把配置迁移到 SQLite')]);
      try {
        const result = synthesizeExperienceGraph(store);
        expect(result.status).toBe('ok');
      } finally {
        store.close();
      }
      const hashAfter = createHash('sha256').update(readFileSync(l0Path)).digest('hex');
      expect(hashAfter).toBe(hashBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function callMcp(store: ReturnType<typeof openMemoryDb>, args: Record<string, unknown> = {}): string {
  const body = handleMcpBody(store, { port: 9291, plans: [] }, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'experience_graph', arguments: args },
  }) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
  expect(body.error).toBeUndefined();
  expect(body.result).toBeDefined();
  return body.result!.content[0]!.text;
}

describe('MCP experience_graph 读取面', () => {
  test('输出带引用的节点摘要;隐藏会话的断言读取期滤除;截断告知', () => {
    const store = fixture([
      requirement(1, '把配置迁移到 SQLite'),
      requirement(2, '导出周报为 Markdown'),
    ]);
    try {
      synthesizeExperienceGraph(store, { confirm: true });
      const text = callMcp(store);
      expect(text).toContain('[index]');
      expect(text).toContain('[leaf]');
      expect(text).toContain('把配置迁移到 SQLite');
      expect(text).toContain(`@session:{${SID}}[reviewed]`);
      // 合成后隐藏:节点仍在(历史产物),断言读取期滤除并明示
      store.setSessionHidden(SID, true);
      const hiddenText = callMcp(store);
      expect(hiddenText).toContain('[leaf]');
      expect(hiddenText).not.toContain('@session:{claude:exp1}[reviewed]');
      expect(hiddenText).toContain('整条滤除');
      // 读取期滤除与 visibleInvariants 一致
      const leaf = store.listExperienceNodes({ nodeKind: 'leaf' })[0]!;
      expect(visibleInvariants(leaf, new Set([SID]))).toHaveLength(0);
      // 截断告知
      const truncated = callMcp(store, { limit: 1 });
      expect(truncated).toContain('showing 1 of');
    } finally {
      store.close();
    }
  });
});

describe('server 端点与单飞子进程', () => {
  test('POST /api/experience/synthesize 经 scanQueue 单飞派发子进程;GET nodes 只读直查', async () => {
    const store = fixture([requirement(1, '把配置迁移到 SQLite')]);
    try {
      const spawned: string[][] = [];
      const scheduler = { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) };
      const app = createServer(store, scheduler as never, { port: 9291, plans: [] }, {
        spawnScan: (args) => {
          spawned.push(args);
          return { exited: Promise.resolve(0) } as Pick<Bun.Subprocess, 'exited'>;
        },
      });
      const queued = await (await app.request('http://localhost/api/experience/synthesize', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxNodes: 20, confirm: true }),
      })).json() as { ok: boolean; queued: boolean };
      expect(queued.ok).toBe(true);
      expect(queued.queued).toBe(true);
      // 子进程参数:experience --refresh --max-nodes 20 --yes(单飞队列排空后执行)
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(spawned.length).toBeGreaterThanOrEqual(1);
      expect(spawned[0]!.slice(0, 2)).toEqual(['experience', '--refresh']);
      expect(spawned[0]).toContain('--max-nodes');
      expect(spawned[0]).toContain('20');
      expect(spawned[0]).toContain('--yes');
      const nodes = await (await app.request('http://localhost/api/experience/nodes')).json() as {
        ok: boolean; nodes: Array<{ nodeKind: string }>;
      };
      expect(nodes.ok).toBe(true);
      expect(nodes.nodes).toHaveLength(0); // 子进程是 mock,没有真的写库;直查为空
    } finally {
      store.close();
    }
  });
});
