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
  store.upsertSessionMessages([message]);
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

  test('tools/list 暴露五个只读工具', async () => {
    const body = await rpc(app(), 'tools/list', {});
    const tools = ((body.result as { tools?: Array<{ name: string; inputSchema: unknown }> }).tools) ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'plan_quota_status', 'repo_lineage', 'requirement_status', 'session_search', 'usage_summary',
    ]);
    for (const tool of tools) expect(tool.inputSchema).toBeDefined();
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
