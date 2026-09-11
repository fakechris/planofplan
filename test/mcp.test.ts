import { describe, expect, test } from 'bun:test';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';
import type { RequirementRecord, SessionMessageRow, UsageRecord } from '../src/types.ts';

const scheduler = {
  refreshPlan: async () => ({ ok: true, slug: 'kimi', windows: [] }),
};

const NOW = Date.now();

function app() {
  const store = openMemoryDb();
  for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
  // 一条有需求、有 FTS 消息、有 commit 的 claude session
  const sessionId = 'claude:s1';
  store.upsertSessions([{
    id: sessionId, provider: 'claude', nativeId: 's1', cwd: '/repo/demo',
    title: '部署脚本修复', sourceFile: '/tmp/s1.jsonl',
    startedAt: NOW - 3_600_000, updatedAt: NOW - 1_000_000,
    inputTokens: 0, outputTokens: 0, totalTokens: 100, estimatedCostUsd: null, seenAt: NOW,
  }]);
  // 第二条同 repo 会话:repo_lineage 截断告知测试需要 >limit 的命中
  store.upsertSessions([{
    id: 'claude:s2', provider: 'claude', nativeId: 's2', cwd: '/repo/demo',
    title: '另一个会话', sourceFile: '/tmp/s2.jsonl',
    startedAt: NOW - 2_000_000, updatedAt: NOW - 900_000,
    inputTokens: 0, outputTokens: 0, totalTokens: 50, estimatedCostUsd: null, seenAt: NOW,
  }]);
  store.replaceSessionRepos('claude:s2', [
    { sessionId: 'claude:s2', role: 'work', url: 'git@example.com:org/demo.git', root: '/repo/demo', name: 'demo', evidenceKind: 'observed' },
  ]);
  store.replaceSessionRepos(sessionId, [
    { sessionId, role: 'work', url: 'git@example.com:org/demo.git', root: '/repo/demo', name: 'demo', evidenceKind: 'observed' },
  ]);
  const requirement: RequirementRecord = {
    id: `req:${sessionId}:1`, sessionId, seq: 1,
    text: '把部署脚本改成幂等的', originLevel: 'user_explicit',
    ts: NOW - 3_600_000, repos: ['git@example.com:org/demo.git'],
  };
  store.replaceAllRequirements([requirement]);
  const message: SessionMessageRow = {
    id: 'm1', sessionId, seq: 1, role: 'user', kind: 'text', toolName: null,
    text: '部署脚本幂等化改造的需求在这里', timestamp: NOW - 3_600_000,
    model: null, inputTokens: null, outputTokens: null,
  };
  store.upsertSessionMessages([
    message,
    { id: 'm2', sessionId, seq: 2, role: 'assistant', kind: 'text', toolName: null,
      text: '好的,我来把部署脚本改成幂等的', timestamp: NOW - 3_500_000,
      model: 'claude-fable-5', inputTokens: null, outputTokens: null },
    { id: 'm3', sessionId, seq: 3, role: 'tool', kind: 'tool_use', toolName: 'Edit',
      text: '{"file_path":"/repo/deploy.sh","old_string":"x"}', timestamp: NOW - 3_400_000,
      model: null, inputTokens: null, outputTokens: null },
    { id: 'm4', sessionId, seq: 4, role: 'user', kind: 'text', toolName: null,
      text: 'y'.repeat(2_500), timestamp: NOW - 3_300_000,
      model: null, inputTokens: null, outputTokens: null },
  ]);
  store.upsertSessionCommits([{
    sessionId, repo: 'git@example.com:org/demo.git',
    sha: 'abcdef1234567890abcdef1234567890abcdef12', kind: 'declared',
    ts: NOW - 500_000, summary: 'fix: make deploy idempotent', fileOverlap: true,
  }]);
  const record: UsageRecord = {
    id: 'local:test:1', day: new Date(NOW).toISOString().slice(0, 10), timestamp: NOW - 60_000,
    provider: 'claude', model: 'claude-fable-5',
    inputTokens: 1000, cachedInputTokens: 0, cacheCreationInputTokens: 0,
    outputTokens: 500, reasoningOutputTokens: 0, totalTokens: 1500,
    billableTokens: null, estimatedCostUsd: 0.01,
    source: 'local', confidence: 'measured', fetchedAt: undefined,
  };
  store.upsertUsageRecords([record]);
  store.upsertSessionTouches([{
    id: 'tw1', sessionId, provider: 'claude', filePath: '/repo/web/login.tsx',
    toolName: 'Edit', op: 'edit', ts: NOW - 30_000, ordinal: 1,
  }]);
  return createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
}

async function rpc(server: ReturnType<typeof app>, method: string, params?: unknown, id: unknown = 1): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const res = await server.request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json() as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
}

async function callTool(server: ReturnType<typeof app>, name: string, args: Record<string, unknown>): Promise<string> {
  const body = await rpc(server, 'tools/call', { name, arguments: args });
  const result = body.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  expect(body.error).toBeUndefined();
  expect(result?.isError ?? false).toBe(false);
  return (result?.content ?? []).map((block) => block.text).join('\n');
}

describe('mcp handshake', () => {
  test('initialize 回显协议版本并声明 tools 能力', async () => {
    const body = await rpc(app(), 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const result = body.result as { protocolVersion?: string; serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } | undefined;
    expect(result?.protocolVersion).toBe('2025-06-18');
    expect(result?.serverInfo?.name).toBe('planofplan');
    expect(result?.capabilities?.tools).toBeDefined();
  });

  test('未知协议版本回退到支持的最新版', async () => {
    const body = await rpc(app(), 'initialize', { protocolVersion: '2099-01-01' });
    expect((body.result as { protocolVersion?: string }).protocolVersion).toBe('2025-06-18');
  });

  test('tools/list 暴露十个只读工具,全部带只读注解', async () => {
    const body = await rpc(app(), 'tools/list', {});
    const tools = ((body.result as {
      tools?: Array<{ name: string; title?: string; inputSchema: unknown; annotations?: Record<string, unknown> }>;
    }).tools) ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'lineage_report', 'plan_quota_status', 'planofplan_project_context', 'planofplan_search_skills',
      'read_session', 'recent_edits', 'repo_lineage', 'requirement_status', 'session_search', 'usage_summary',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false });
    }
  });



  test('notifications 回 202,未知方法 -32601', async () => {
    const server = app();
    const note = await server.request('http://localhost/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(note.status).toBe(202);
    const missing = await rpc(server, 'resources/list', {});
    expect(missing.error?.code).toBe(-32601);
  });
});

describe('mcp tools', () => {
  test('plan_quota_status 列出 plan 与窗口', async () => {
    const text = await callTool(app(), 'plan_quota_status', {});
    expect(text).toContain(DEFAULT_PLANS[0]!.slug);
  });

  test('usage_summary 汇总本地 token 记录', async () => {
    const text = await callTool(app(), 'usage_summary', { days: 7 });
    expect(text).toContain('1.5K');
    expect(text).toContain('claude');
  });

  test('session_search 命中消息正文 FTS', async () => {
    const text = await callTool(app(), 'session_search', { q: '幂等化改造' });
    expect(text).toContain('claude:s1');
    expect(text).toContain('content hit');
  });

  test('repo_lineage 列出会话与 commit', async () => {
    const text = await callTool(app(), 'repo_lineage', { repo: 'demo' });
    expect(text).toContain('把部署脚本改成幂等的');
    expect(text).toContain('abcdef12');
    expect(text).toContain('[declared]');
  });

  test('requirement_status 列出需求与落地状态', async () => {
    const text = await callTool(app(), 'requirement_status', { days: 14 });
    expect(text).toContain('把部署脚本改成幂等的');
    expect(text).toContain('1 commit(s)');
  });

  test('未知工具 -32602;缺参返回 isError 结果', async () => {
    const server = app();
    const unknown = await rpc(server, 'tools/call', { name: 'nope', arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
    const badArgs = await rpc(server, 'tools/call', { name: 'session_search', arguments: {} });
    const result = badArgs.result as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain('q is required');
  });

  test('Host 头校验覆盖 /mcp', async () => {
    const res = await app().request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'evil.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('mcp session_search 自指防护', () => {
  test('exclude 排除指定 session 的元数据与 FTS 命中', async () => {
    const server = app();
    const withSelf = await callTool(server, 'session_search', { q: '幂等化改造' });
    expect(withSelf).toContain('claude:s1');
    const excluded = await callTool(server, 'session_search', { q: '幂等化改造', exclude: 'claude:s1' });
    expect(excluded).not.toContain('claude:s1');
    expect(excluded).toContain('No sessions match');
  });
});

describe('mcp 新工具', () => {
  test('recent_edits 返回文件流', async () => {
    const text = await callTool(app(), 'recent_edits', { days: 7 });
    expect(text).toContain('/repo/web/login.tsx');
  });

  test('lineage_report 返回汇总与条目', async () => {
    const text = await callTool(app(), 'lineage_report', { days: 7 });
    expect(text).toContain('谱系周报');
    expect(text).toContain('把部署脚本改成幂等的');
    expect(text).toContain('声明');
  });

  test('planofplan_search_skills 跨技能库检索(支持别名 search_skills)', async () => {
    const textPrefixed = await callTool(app(), 'planofplan_search_skills', { q: 'obsidian' });
    expect(textPrefixed).toContain('Skill');
    expect(textPrefixed).toContain('obsidian');

    const textAlias = await callTool(app(), 'search_skills', { q: 'obsidian' });
    expect(textAlias).toContain('Skill');
  });

  test('planofplan_project_context 返回项目上下文与 zg 状态(支持别名 inspect_project_context)', async () => {
    const textPrefixed = await callTool(app(), 'planofplan_project_context', { project: 'demo' });
    expect(textPrefixed).toContain('项目上下文透视: demo');
    expect(textPrefixed).toContain('代码语义索引 (.zvec-grep)');
    expect(textPrefixed).toContain('最近开发需求/用户意图');

    const textAlias = await callTool(app(), 'inspect_project_context', { project: 'demo' });
    expect(textAlias).toContain('项目上下文透视: demo');
  });
});

describe('mcp read_session(offset 续读协议)', () => {
  test('首页包含会话头信息、角色行与 End of session', async () => {
    const text = await callTool(app(), 'read_session', { session_id: 'claude:s1' });
    expect(text).toContain('Session claude:s1 · claude · 部署脚本修复 · cwd /repo/demo');
    expect(text).toContain('Showing messages 1-4 of 4.');
    expect(text).toContain('[1] user');
    expect(text).toContain('[2] assistant (claude-fable-5)');
    expect(text).toContain('[3] tool:Edit');
    expect(text).toContain('(End of session — 4 message(s) total.)');
  });

  test('超长消息行截断到 2000 字符并注明', async () => {
    const text = await callTool(app(), 'read_session', { session_id: 'claude:s1' });
    expect(text).toContain('line truncated to 2000 chars');
    expect(text).not.toContain('y'.repeat(2_100));
  });

  test('limit 截断给出 Use offset=N 续读指示,续页后穷尽', async () => {
    const server = app();
    const page1 = await callTool(server, 'read_session', { session_id: 'claude:s1', limit: 2 });
    expect(page1).toContain('Showing messages 1-2 of 4.');
    expect(page1).toContain('Use offset=3 to continue.');
    const page2 = await callTool(server, 'read_session', { session_id: 'claude:s1', offset: 3, limit: 2 });
    expect(page2).toContain('Showing messages 3-4 of 4.');
    expect(page2).toContain('(End of session — 4 message(s) total.)');
  });

  test('offset 越界给出重启指示', async () => {
    const text = await callTool(app(), 'read_session', { session_id: 'claude:s1', offset: 9 });
    expect(text).toContain('No messages at offset 9');
    expect(text).toContain('Use offset=1');
  });

  test('role 过滤只统计同口径消息', async () => {
    const text = await callTool(app(), 'read_session', { session_id: 'claude:s1', role: 'assistant' });
    expect(text).toContain('Showing messages 1-1 of 1 (role=assistant).');
    expect(text).toContain('[1] assistant (claude-fable-5)');
  });

  test('未知 session 返回 isError 与查找建议', async () => {
    const body = await rpc(app(), 'tools/call', { name: 'read_session', arguments: { session_id: 'claude:nope' } });
    const result = body.result as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain('session not found');
    expect(result?.content?.[0]?.text).toContain('session_search');
  });
});

describe('mcp 截断告知(sourcebot 实践)', () => {
  test('repo_lineage 命中超过 limit 时尾部给出可执行建议', async () => {
    const text = await callTool(app(), 'repo_lineage', { repo: 'demo', limit: 1 });
    expect(text).toContain('(showing 1 of 2 — pass a higher limit (max 50) or shorten days)');
  });

  test('穷尽时不追加截断噪音', async () => {
    const text = await callTool(app(), 'repo_lineage', { repo: 'demo' });
    expect(text).toContain('showing 2):');
    expect(text).not.toContain('of 2 —');
  });
});

describe('mcp 隐藏边界贯穿所有出口', () => {
  test('dashboard 隐藏的 session 在 search/lineage/read 三处都不可见', async () => {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const server = createServer(store, scheduler as never, { port: 9291, plans: DEFAULT_PLANS });
    // 复用 app() 的种子数据构造(store 层直接种,便于隐藏后复用同一 server)
    store.upsertSessions([{
      id: 'claude:h1', provider: 'claude', nativeId: 'h1', cwd: '/repo/demo',
      title: '隐藏会话', sourceFile: '/tmp/h1.jsonl',
      startedAt: NOW - 3_600_000, updatedAt: NOW - 1_000_000,
      inputTokens: 0, outputTokens: 0, totalTokens: 10, estimatedCostUsd: null, seenAt: NOW,
    }]);
    store.upsertSessionMessages([{
      id: 'hm1', sessionId: 'claude:h1', seq: 1, role: 'user', kind: 'text', toolName: null,
      text: '隐藏会话的正文包含独特关键词xyzzy', timestamp: NOW - 3_600_000,
      model: null, inputTokens: null, outputTokens: null,
    }]);

    // 隐藏前可见
    expect(await callTool(server, 'session_search', { q: 'xyzzy' })).toContain('claude:h1');
    // 隐藏后:search(FTS+元数据)、repo_lineage、read_session 三处全部挡掉
    store.setSessionHidden('claude:h1', true);
    expect(await callTool(server, 'session_search', { q: 'xyzzy' })).toContain('No sessions match');
    expect(await callTool(server, 'repo_lineage', { repo: 'demo' })).not.toContain('claude:h1');
    const denied = await rpc(server, 'tools/call', { name: 'read_session', arguments: { session_id: 'claude:h1' } });
    const deniedResult = denied.result as { isError?: boolean; content?: Array<{ text: string }> };
    expect(deniedResult?.isError).toBe(true);
    expect(deniedResult?.content?.[0]?.text).toContain('hidden');
  });
});


