import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { handleMcpBody } from '../src/mcp.ts';
import {
  REPO_HISTORY_ANALYZER_VERSION,
  analyzeRepoHistory,
  attributeCommits,
  buildFileSuffixMatcher,
  createScanContext,
  extractApplyPatchWrites,
  extractDeltaLines,
  extractPrNumber,
  extractTrailers,
  parseGitLogWithDiffs,
  readCachedRepoHistory,
  readFactorySessionModel,
  resolveRelPath,
  scanSessionFileIntoContext,
  trailerToAgent,
  trailerToModel,
  type RawCommitDiff,
} from '../src/repo-history.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const REPO_URL = 'https://github.com/fakechris/demo.git';

describe('repo-history 纯函数解析与去噪(INV-2195)', () => {
  test('extractDeltaLines: Edit 只取 new - old 纯增量行,排除未改动的上下文行', () => {
    const oldStr = [
      'export function existingHelper(x: number) {',
      '  const unchangedContextLine = computeStableValue(x);',
      '  return unchangedContextLine;',
      '}',
    ].join('\n');
    const newStr = [
      'export function existingHelper(x: number) {',
      '  const unchangedContextLine = computeStableValue(x);',
      '  const brandNewGuardCheck = validateThreshold(unchangedContextLine);',
      '  return brandNewGuardCheck;',
      '}',
    ].join('\n');
    const delta = extractDeltaLines(newStr, oldStr);
    expect(delta.has('const brandNewGuardCheck = validateThreshold(unchangedContextLine);')).toBe(true);
    expect(delta.has('const unchangedContextLine = computeStableValue(x);')).toBe(false);
  });

  test('trailer 解析覆盖 Claude / Devin / Droid / Cursor / 模型名与 PR 编号', () => {
    const body = [
      'Some PR description',
      'Co-authored-by: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>',
      'Co-authored-by: Cursor <cursoragent@cursor.com>',
    ].join('\n');
    const trailers = extractTrailers(body);
    expect(trailers.length).toBe(4);
    expect(trailers.map((t) => trailerToAgent(t.value))).toEqual(['devin', 'claude', 'factory', 'cursor']);
    expect(trailerToModel(trailers[1]!.value)).toBe('claude-opus-5.5');
    expect(extractPrNumber('feat: add commit archaeology (#833)')).toBe(833);
    expect(extractPrNumber('chore: no pr number')).toBeNull();
  });

  test('resolveRelPath: worktree 兄弟目录路径能对齐主仓库相对路径', () => {
    const byBase = buildFileSuffixMatcher(['src/evals/compare.ts', 'docs/104-axiomatic-design.md']);
    expect(resolveRelPath('/Users/chris/source/research/grokbot/agentbox-doc104-20261126/docs/104-axiomatic-design.md', byBase))
      .toBe('docs/104-axiomatic-design.md');
    expect(resolveRelPath('/Users/chris/.claude/worktrees/fix-1/src/evals/compare.ts', byBase))
      .toBe('src/evals/compare.ts');
    expect(resolveRelPath('/unrelated/other/compare.ts', byBase)).toBeNull();
  });

  test('extractApplyPatchWrites: 解析 Codex 原始 patch 与 JS 转义字符串内嵌 patch', () => {
    const rawExec = 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /repo/src/core.ts\\n@@\\n-const oldVal = 1;\\n+const newlyAddedCodexFeature = computeMatrix(42);\\n*** End Patch"))';
    const patches = extractApplyPatchWrites(rawExec);
    expect(patches.length).toBe(1);
    expect(patches[0]!.filePath).toBe('/repo/src/core.ts');
    expect(patches[0]!.lines.has('const newlyAddedCodexFeature = computeMatrix(42);')).toBe(true);
  });

  test('readFactorySessionModel: 读取同目录 .settings.json 中的 model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-factory-'));
    try {
      const jsonl = join(dir, 'sess-1.jsonl');
      writeFileSync(jsonl, '{"type":"session_start"}\n');
      writeFileSync(join(dir, 'sess-1.settings.json'), JSON.stringify({ model: 'gemini-4-carbon' }));
      expect(readFactorySessionModel(jsonl)).toBe('gemini-4-carbon');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('四层归因、因果窗、接力拆解与只读分离', () => {
  test('严格区分 pr-merge(不冒充作者)、read-only reviewers、严格时间因果与多 Agent 接力', () => {
    const tCommit = Date.parse('2026-11-20T12:00:00Z');
    const claudeLines = [
      'export function claudeWrittenPipelineStepOne(input: string): string {',
      '  const normalizedClaudePayload = sanitizePayloadStrictly(input);',
      '  const claudeStageTwoResult = transformStageTwo(normalizedClaudePayload);',
      '  const claudeStageThreeResult = verifyInvariantStageThree(claudeStageTwoResult);',
      '  const claudeFinalOutput = serializeFinalStageOutput(claudeStageThreeResult);',
      '  return claudeFinalOutput;',
    ];
    const codexLines = [
      'export function codexWrittenValidatorStepOne(record: Record<string, unknown>): boolean {',
      '  const codexNormalizedKey = canonicalizeRecordKey(record);',
      '  const codexSignatureCheck = verifyCryptographicSignature(codexNormalizedKey);',
      '  const codexBoundaryCheck = enforceStrictBoundaryLimit(codexSignatureCheck);',
      '  const codexFinalVerdict = finalizeValidatorVerdict(codexBoundaryCheck);',
      '  return codexFinalVerdict;',
    ];

    const commits: RawCommitDiff[] = [
      // Commit A: Claude + Codex 跨 Agent 代码接力(各写 ≥5 条强特征行)
      {
        sha: SHA_A, authorTs: tCommit, commitTs: tCommit, authorName: 'Chris',
        subject: 'feat: relay pipeline (#101)', body: '', trailers: [], prNumber: 101,
        files: ['src/pipeline.ts', 'src/validator.ts'],
        addedByFile: new Map([
          ['src/pipeline.ts', claudeLines],
          ['src/validator.ts', codexLines],
        ]),
        totalDistLines: claudeLines.length + codexLines.length,
      },
      // Commit B: 仅被 Claude gh pr merge,无代码写证据 → merged-only,不冒充作者
      {
        sha: SHA_B, authorTs: tCommit + 60_000, commitTs: tCommit + 60_000, authorName: 'Chris',
        subject: 'chore: external pr (#102)', body: '', trailers: [], prNumber: 102,
        files: ['src/ext.ts'],
        addedByFile: new Map([['src/ext.ts', ['export const externalUnmatchedImplementationLine = 123456;']]]),
        totalDistLines: 1,
      },
      // Commit C: 云端 Devin AI trailer + 无关的 Claude 1 行撞车应被屏蔽
      {
        sha: SHA_C, authorTs: tCommit + 120_000, commitTs: tCommit + 120_000, authorName: 'Chris',
        subject: 'fix: devin cloud fix (#103)',
        body: 'Co-authored-by: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>',
        trailers: [{ key: 'Co-authored-by', value: 'Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>' }],
        prNumber: 103,
        files: ['src/devin.ts'],
        addedByFile: new Map([['src/devin.ts', [
          'const sharedTinyLineCollision = computeDefaultOption();',
          'export const devinExclusiveImplementationBlock = createDevinFix();',
        ]]]),
        totalDistLines: 2,
      },
      // Commit D: 事后写入(write_ts > commit_ts + 60s)不得偷走早先 commit 的行
      {
        sha: SHA_D, authorTs: tCommit - 3_600_000, commitTs: tCommit - 3_600_000, authorName: 'dependabot[bot]',
        subject: 'Bump deps (#104)', body: '', trailers: [], prNumber: 104,
        files: ['package.json'],
        addedByFile: new Map([['package.json', ['  "hono": "^4.14.0", // future session should not steal this']]]),
        totalDistLines: 1,
      },
    ];

    const byBase = buildFileSuffixMatcher(['src/pipeline.ts', 'src/validator.ts', 'src/ext.ts', 'src/devin.ts', 'package.json']);
    const ctx = createScanContext('demo', byBase);

    // Claude 写 src/pipeline.ts(commit A 前 10 分钟)
    ctx.writesByFile.set('src/pipeline.ts', [{
      provider: 'claude', sessionId: 'claude:s1', isSubagent: false, model: 'claude-opus-5-5',
      ts: tCommit - 600_000, lines: new Set(claudeLines), tool: 'Write',
    }]);
    // Codex 写 src/validator.ts(commit A 前 5 分钟)
    ctx.writesByFile.set('src/validator.ts', [{
      provider: 'codex', sessionId: 'codex:s2', isSubagent: false, model: 'gpt-6.1-sol',
      ts: tCommit - 300_000, lines: new Set(codexLines), tool: 'apply_patch',
    }]);
    // Factory 只读了 src/pipeline.ts(review 角色,不得进 authors)
    ctx.readsByFile.set('src/pipeline.ts', [{
      provider: 'factory', sessionId: 'factory:rev1', model: 'gemini-4-carbon', ts: tCommit + 60_000,
    }]);
    // Claude 仅合并了 PR #102
    ctx.witnessesPr.set(102, [{
      prNumber: 102, provider: 'claude', sessionId: 'claude:merger', model: 'claude-opus-5-5', ts: tCommit + 60_000, kind: 'pr-merge',
    }]);
    // Claude 偶发 1 行撞到 Commit C(Devin)
    ctx.writesByFile.set('src/devin.ts', [{
      provider: 'claude', sessionId: 'claude:noise', isSubagent: false, model: 'claude-opus-5-5',
      ts: tCommit + 100_000, lines: new Set(['const sharedTinyLineCollision = computeDefaultOption();']), tool: 'Edit',
    }]);
    // 事后 10 分钟写入 package.json(不得偷走 Commit D)
    ctx.writesByFile.set('package.json', [{
      provider: 'claude', sessionId: 'claude:late', isSubagent: false, model: 'claude-opus-5-5',
      ts: tCommit - 3_600_000 + 600_000, lines: new Set(['  "hono": "^4.14.0", // future session should not steal this']), tool: 'Edit',
    }]);

    const res = attributeCommits(REPO_URL, commits, ctx, tCommit + 1_000_000);
    const bySha = new Map(res.map((r) => [r.sha, r]));

    // A: cross-agent-code relay + factory only in reviewers
    const a = bySha.get(SHA_A)!;
    expect(a.tier).toBe('hunk-matched');
    expect(a.relayKind).toBe('cross-agent-code');
    expect(a.matchedDistLines).toBe(claudeLines.length + codexLines.length);
    expect(a.authors.map((x) => x.provider).sort()).toEqual(['claude', 'codex']);
    expect(a.reviewers).toEqual(['factory']);

    // B: merged-only, authors empty
    const b = bySha.get(SHA_B)!;
    expect(b.tier).toBe('merged-only');
    expect(b.authors).toEqual([]);
    expect(b.primaryProvider).toBeNull();
    expect(b.mergedBy).toEqual(['claude:pr-merge']);

    // C: devin declared, claude 1-line noise suppressed
    const c = bySha.get(SHA_C)!;
    expect(c.primaryProvider).toBe('devin');
    expect(c.authors.map((x) => x.provider)).toEqual(['devin']);

    // D: dependabot bot author, late session blocked by temporal causality
    const d = bySha.get(SHA_D)!;
    expect(d.tier).toBe('declared');
    expect(d.primaryProvider).toBe('dependabot');
    expect(d.matchedDistLines).toBe(0);
  });
});

describe('L0 文件扫描、增量缓存、HTTP API 与只读 MCP repo_history', () => {
  test('端到端:增量 SHA 缓存 + L0 只读不变 + HTTP /history + MCP repo_history 隐藏会话隔离', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pop-rh-e2e-'));
    try {
      const repoDir = join(tmp, 'demo');
      mkdirSync(join(repoDir, '.git'), { recursive: true });
      const home = join(tmp, 'home');
      const claudeDir = join(home, '.claude', 'projects', '-tmp-demo');
      mkdirSync(claudeDir, { recursive: true });
      const sessionFile = join(claudeDir, 'sess-claude-1.jsonl');
      const tCommit = Date.now() - 3_600_000;
      const addedLine = 'export const verifiedRetrospectiveLine = computeProvenanceProof(99);';
      const jsonlBody = [
        JSON.stringify({
          type: 'user',
          timestamp: new Date(tCommit - 120_000).toISOString(),
          message: { role: 'user', content: 'Implement provenance proof feature for demo repo' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(tCommit - 60_000).toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{
              type: 'tool_use', id: 'tu1', name: 'Write',
              input: { file_path: join(repoDir, 'src/proof.ts'), content: `${addedLine}\n` },
            }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(tCommit - 30_000).toISOString(),
          message: {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{
              type: 'tool_use', id: 'tu2', name: 'Bash',
              input: { command: 'gh pr create --title "proof"' },
            }],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: new Date(tCommit - 20_000).toISOString(),
          message: {
            role: 'user',
            content: [{
              type: 'tool_result', tool_use_id: 'tu2',
              content: 'https://github.com/fakechris/demo/pull/42',
            }],
          },
        }),
      ].join('\n') + '\n';
      writeFileSync(sessionFile, jsonlBody);
      const beforeDigest = createHash('sha256').update(readFileSync(sessionFile)).digest('hex');

      const fakeGit = (args: string[]): string => {
        if (args.includes('log') && !args.includes('-p')) {
          return `${SHA_A}\x1f${new Date(tCommit).toISOString()}\n`;
        }
        return [
          `<<<POP_COMMIT>>>${SHA_A}\x1f${new Date(tCommit).toISOString()}\x1f${new Date(tCommit).toISOString()}\x1fChris\x1ffeat: provenance proof (#42)\x1f<<<POP_BODYEND>>>`,
          'diff --git a/src/proof.ts b/src/proof.ts',
          '+++ b/src/proof.ts',
          `+${addedLine}`,
        ].join('\n');
      };

      const store = openMemoryDb();
      for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
      store.upsertSessions([{
        id: 'claude:sess-claude-1', provider: 'claude', nativeId: 'sess-claude-1',
        cwd: repoDir, title: 'Implement provenance proof', sourceFile: sessionFile,
        startedAt: tCommit - 120_000, updatedAt: tCommit,
        inputTokens: 0, outputTokens: 0, totalTokens: 100, estimatedCostUsd: null, seenAt: Date.now(),
      }]);
      store.replaceSessionRepos('claude:sess-claude-1', [{
        sessionId: 'claude:sess-claude-1', role: 'work', url: REPO_URL, root: repoDir, name: 'demo', evidenceKind: 'observed',
      }]);
      store.materializeProjects();

      // 首次扫描:分析 1 个新 commit 并落表
      const r1 = analyzeRepoHistory(store, {
        repoUrl: REPO_URL, repoRoot: repoDir, repoName: 'demo', days: 30, homeDir: home, git: fakeGit,
      });
      expect(r1.summary.totalCommits).toBe(1);
      expect(r1.summary.newlyAnalyzedCommits).toBe(1);
      expect(r1.summary.cachedCommits).toBe(0);
      expect(r1.records[0]!.tier).toBe('hunk-matched');
      expect(r1.records[0]!.primaryProvider).toBe('claude');
      expect(r1.records[0]!.primaryModel).toBe('claude-opus-5-5');
      expect(r1.records[0]!.witnessedAuthor).toContain('claude:pr-create');
      expect(store.getCachedProvenanceShas(REPO_URL, REPO_HISTORY_ANALYZER_VERSION).has(SHA_A)).toBe(true);

      // 二次运行:SHA 已缓存,0 新分析,0 扫描会话
      const r2 = analyzeRepoHistory(store, {
        repoUrl: REPO_URL, repoRoot: repoDir, repoName: 'demo', days: 30, homeDir: home, git: fakeGit,
      });
      expect(r2.summary.cachedCommits).toBe(1);
      expect(r2.summary.newlyAnalyzedCommits).toBe(0);
      expect(r2.summary.sessionsScanned).toBe(0);

      // L0 文件只读不变量
      const afterDigest = createHash('sha256').update(readFileSync(sessionFile)).digest('hex');
      expect(afterDigest).toBe(beforeDigest);

      // HTTP GET /api/projects/:id/history 直读缓存
      const project = store.listProjects()[0]!;
      const app = createServer(store, { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) } as never, { port: 9291, plans: DEFAULT_PLANS });
      const res = await app.request(`http://localhost/api/projects/${project.id}/history?days=30`);
      expect(res.status).toBe(200);
      const body = await res.json() as { cached: boolean; summary: { totalCommits: number; authorAttributed: number } };
      expect(body.cached).toBe(true);
      expect(body.summary.totalCommits).toBe(1);
      expect(body.summary.authorAttributed).toBe(1);

      // MCP repo_history 只读查询
      const mcpRes = handleMcpBody(store, { port: 9291, plans: DEFAULT_PLANS }, {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'repo_history', arguments: { repo: 'demo', days: 30 } },
      }) as { result?: { content?: Array<{ text: string }> } };
      const text = mcpRes.result?.content?.[0]?.text ?? '';
      expect(text).toContain('demo commit provenance');
      expect(text).toContain('claude/claude-opus-5-5');
      expect(text).toContain('#42');

      // 读缓存工具函数验证
      const cachedOnly = readCachedRepoHistory(store, { repoUrl: REPO_URL, repoRoot: repoDir, repoName: 'demo' }, 30);
      expect(cachedOnly.cached).toBe(true);
      expect(cachedOnly.records.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('parseGitLogWithDiffs: 正确切分多条 commit diff 与新增特征行', () => {
    const sample = [
      `<<<POP_COMMIT>>>${SHA_A}\x1f2026-11-20T10:00:00Z\x1f2026-11-20T10:00:00Z\x1fChris\x1ffirst (#1)\x1fbody1<<<POP_BODYEND>>>`,
      '+++ b/src/a.ts',
      '+export const firstFeatureImplementationLine = 1;',
      `<<<POP_COMMIT>>>${SHA_B}\x1f2026-11-21T10:00:00Z\x1f2026-11-21T10:00:00Z\x1fChris\x1fsecond (#2)\x1fbody2<<<POP_BODYEND>>>`,
      '+++ b/src/b.ts',
      '+export const secondFeatureImplementationLine = 2;',
    ].join('\n');
    const parsed = parseGitLogWithDiffs(sample);
    expect(parsed.length).toBe(2);
    expect(parsed[0]!.prNumber).toBe(1);
    expect(parsed[1]!.prNumber).toBe(2);
    expect(parsed[1]!.addedByFile.get('src/b.ts')).toEqual(['export const secondFeatureImplementationLine = 2;']);
  });

  test('scanSessionFileIntoContext: 覆盖 Codex custom_tool_call:exec 内嵌 patch 与 Factory Edit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pop-scan-'));
    try {
      const codexFile = join(tmp, 'rollout-1.jsonl');
      writeFileSync(codexFile, [
        JSON.stringify({ type: 'turn_context', timestamp: '2026-11-20T10:00:00Z', payload: { model: 'gpt-6.1-sol' } }),
        JSON.stringify({
          type: 'response_item', timestamp: '2026-11-20T10:01:00Z',
          payload: {
            type: 'custom_tool_call', name: 'exec', call_id: 'c1',
            input: 'tools.apply_patch("*** Begin Patch\\n*** Update File: /repo/src/x.ts\\n+export const codexLineForTest = computeValue(7);\\n*** End Patch")',
          },
        }),
      ].join('\n') + '\n');

      const factoryFile = join(tmp, 'droid-1.jsonl');
      writeFileSync(join(tmp, 'droid-1.settings.json'), JSON.stringify({ model: 'gemini-4-carbon' }));
      writeFileSync(factoryFile, JSON.stringify({
        type: 'assistant', timestamp: '2026-11-20T10:02:00Z',
        message: {
          content: [{
            type: 'tool_use', name: 'Edit',
            input: {
              file_path: '/worktree/repo-wt/src/y.ts',
              old_str: 'const keepOldContextLine = 1;',
              new_str: 'const keepOldContextLine = 1;\nexport const factoryLineForTest = computeDroid(8);',
            },
          }],
        },
      }) + '\n');

      const byBase = buildFileSuffixMatcher(['src/x.ts', 'src/y.ts']);
      const ctx = createScanContext('repo', byBase);
      scanSessionFileIntoContext('codex', codexFile, false, ctx);
      scanSessionFileIntoContext('factory', factoryFile, false, ctx);

      expect(ctx.writesByFile.get('src/x.ts')?.[0]?.model).toBe('gpt-6.1-sol');
      expect(ctx.writesByFile.get('src/x.ts')?.[0]?.lines.has('export const codexLineForTest = computeValue(7);')).toBe(true);
      expect(ctx.writesByFile.get('src/y.ts')?.[0]?.model).toBe('gemini-4-carbon');
      expect(ctx.writesByFile.get('src/y.ts')?.[0]?.lines.has('export const factoryLineForTest = computeDroid(8);')).toBe(true);
      expect(ctx.writesByFile.get('src/y.ts')?.[0]?.lines.has('const keepOldContextLine = 1;')).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('HTTP POST /api/projects/:id/history/scan: 文件库走单飞子进程派发,不阻塞主线程', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pop-rh-sub-'));
    try {
      const dbPath = join(tmp, 'test.db');
      const repoDir = join(tmp, 'repo');
      mkdirSync(join(repoDir, '.git'), { recursive: true });
      const store = openDb(dbPath);
      for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
      store.upsertSessions([{
        id: 'claude:s-sub', provider: 'claude', nativeId: 's-sub', cwd: repoDir,
        title: 'sub', sourceFile: null, startedAt: Date.now() - 10_000, updatedAt: Date.now(),
        inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: Date.now(),
      }]);
      store.replaceSessionRepos('claude:s-sub', [{
        sessionId: 'claude:s-sub', role: 'work', url: REPO_URL, root: repoDir, name: 'demo', evidenceKind: 'observed',
      }]);
      store.materializeProjects();
      const project = store.listProjects()[0]!;

      const spawnedArgs: string[][] = [];
      let releaseChild!: () => void;
      const childExited = new Promise<number>((resolve) => {
        releaseChild = () => resolve(0);
      });
      const app = createServer(
        store,
        { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) } as never,
        { port: 9291, plans: DEFAULT_PLANS },
        {
          spawnScan: (args) => {
            spawnedArgs.push(args);
            return { exited: childExited };
          },
        },
      );

      // 并发触发两次同一项目的 30 天扫描:单飞锁应合并为 1 次子进程
      const p1 = app.request(`http://localhost/api/projects/${project.id}/history/scan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 30 }),
      });
      const p2 = app.request(`http://localhost/api/projects/${project.id}/history/scan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 30 }),
      });
      await Promise.resolve();
      releaseChild();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(spawnedArgs.length).toBe(1);
      expect(spawnedArgs[0]).toEqual(['repo-history', repoDir, '--days', '30', '--db', dbPath]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('INV-2197: listRequirementsForRepo 单仓查询与 GET /api/projects/:id 聚合精确等价', async () => {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const now = Date.now();
    store.upsertSessions([
      {
        id: 'claude:p1', provider: 'claude', nativeId: 'p1', cwd: '/repo/demo',
        title: 'demo user task', sourceFile: null, startedAt: now - 30_000, updatedAt: now - 10_000,
        inputTokens: 0, outputTokens: 0, totalTokens: 500, estimatedCostUsd: null, seenAt: now, origin: 'user',
      },
      {
        id: 'codex:p2', provider: 'codex', nativeId: 'p2', cwd: '/repo/demo',
        title: 'demo subagent', sourceFile: null, startedAt: now - 20_000, updatedAt: now - 5_000,
        inputTokens: 0, outputTokens: 0, totalTokens: 300, estimatedCostUsd: null, seenAt: now, origin: 'subagent',
      },
      {
        id: 'claude:other', provider: 'claude', nativeId: 'other', cwd: '/repo/other',
        title: 'other repo', sourceFile: null, startedAt: now - 20_000, updatedAt: now - 5_000,
        inputTokens: 0, outputTokens: 0, totalTokens: 900, estimatedCostUsd: null, seenAt: now, origin: 'user',
      },
    ]);
    store.replaceSessionRepos('claude:p1', [{ sessionId: 'claude:p1', role: 'work', url: REPO_URL, root: '/repo/demo', name: 'demo', evidenceKind: 'observed' }]);
    store.replaceSessionRepos('codex:p2', [{ sessionId: 'codex:p2', role: 'work', url: REPO_URL, root: '/repo/demo', name: 'demo', evidenceKind: 'observed' }]);
    store.replaceSessionRepos('claude:other', [{ sessionId: 'claude:other', role: 'work', url: 'https://github.com/fakechris/other.git', root: '/repo/other', name: 'other', evidenceKind: 'observed' }]);
    store.replaceAllRequirements([
      { id: 'req:demo:1', sessionId: 'claude:p1', seq: 1, text: 'demo 需求', originLevel: 'user_explicit', ts: now - 25_000, repos: [REPO_URL] },
      { id: 'req:other:1', sessionId: 'claude:other', seq: 1, text: 'other 需求', originLevel: 'user_explicit', ts: now - 15_000, repos: ['https://github.com/fakechris/other.git'] },
    ]);
    store.upsertSessionCommits([
      { sessionId: 'claude:p1', repo: REPO_URL, sha: SHA_A, kind: 'declared', ts: now - 8_000, summary: 'feat: demo', fileOverlap: true },
      { sessionId: 'codex:p2', repo: REPO_URL, sha: SHA_A, kind: 'witnessed', ts: now - 8_000, summary: 'feat: demo', fileOverlap: true },
    ]);
    store.materializeProjects();

    expect(store.listRequirementsForRepo(REPO_URL).map((r) => r.id)).toEqual(['req:demo:1']);

    const demoProject = store.listProjects().find((p) => p.url === REPO_URL)!;
    const app = createServer(store, { refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }) } as never, { port: 9291, plans: DEFAULT_PLANS });
    const res = await app.request(`http://localhost/api/projects/${demoProject.id}?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessionCount: number;
      userSessionCount: number;
      commitCount: number;
      requirementCount: number;
      agents: Array<{ provider: string; sessions: number; userSessions: number; automatedSessions: number; tokens: number }>;
      requirements: Array<{ id: string }>;
    };
    expect(body.sessionCount).toBe(2);
    expect(body.userSessionCount).toBe(1);
    expect(body.commitCount).toBe(1);
    expect(body.requirementCount).toBe(1);
    expect(body.requirements.map((r) => r.id)).toEqual(['req:demo:1']);
    expect(body.agents.find((a) => a.provider === 'claude')?.tokens).toBe(500);
    expect(body.agents.find((a) => a.provider === 'codex')?.automatedSessions).toBe(1);
  });

  test('INV-2197: web/app.js renderProjects 对同一项目同窗口具备 renderedProjectKey 防闪烁守卫', () => {
    const appJs = readFileSync(join(import.meta.dir, '../web/app.js'), 'utf8');
    expect(appJs).toContain('if (!forceDetail && renderedProjectKey === wantKey) return;');
    expect(appJs).toContain('if (seq !== projectDetailSeq || openProjectId !== id) return;');
  });
});
