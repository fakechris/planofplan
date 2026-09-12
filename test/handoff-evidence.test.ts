import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { buildHandoffPackage } from '../src/handoff.ts';
import { handleMcpBody } from '../src/mcp.ts';
import { createServer } from '../src/server.ts';
import type { RequirementRecord } from '../src/types.ts';

const SID = 'claude:two-intents';
const REPO = 'https://example.test/acme/alpha.git';
const now = Date.now() - 1000;

function call(store: ReturnType<typeof openMemoryDb>, name: string, args: Record<string, unknown> = {}) {
  const body = handleMcpBody(store, { port: 9291, plans: [] }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (!body || Array.isArray(body)) throw new Error('expected one MCP response');
  expect(body.error).toBeUndefined();
  return body.result as { content: Array<{ text: string }>; isError?: boolean };
}

function fixture() {
  const store = openMemoryDb();
  store.upsertSessions([{
    id: SID, provider: 'claude', nativeId: 'two-intents', cwd: '/repo/alpha',
    title: 'Two intentions', sourceFile: null, startedAt: now - 10000, updatedAt: now,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: now,
  }]);
  store.replaceSessionRepos(SID, [{ sessionId: SID, role: 'work', url: REPO, root: '/repo/alpha', name: 'alpha', evidenceKind: 'observed' }]);
  const requirements: RequirementRecord[] = [
    { id: 'req:A', sessionId: SID, seq: 1, text: 'A: repair authentication', originLevel: 'user_explicit', ts: now - 9000, repos: [REPO] },
    { id: 'req:B', sessionId: SID, seq: 10, text: 'B: export invoices', originLevel: 'user_explicit', ts: now - 5000, repos: [REPO] },
  ];
  store.replaceAllRequirements(requirements);
  store.replaceAllTodoSnapshots([
    { id: 'todo:A', sessionId: SID, seq: 3, ts: now - 8000, items: [{ title: 'A pending authentication', status: 'in_progress' }] },
    { id: 'todo:B', sessionId: SID, seq: 13, ts: now - 3000, items: [{ title: 'B exported invoices', status: 'completed' }] },
  ]);
  store.replaceAllProgressNotes([
    { id: 'note:A', sessionId: SID, seq: 4, ts: now - 7000, text: 'A still needs verification' },
    { id: 'note:B', sessionId: SID, seq: 14, ts: now - 2000, text: 'B completed successfully' },
  ]);
  return { store, requirements };
}

describe('requirement evidence at handoff boundaries', () => {
  test('a title-inferred requirement without a sequence anchor does not inherit session file activity', () => {
    const { store, requirements } = fixture();
    try {
      store.replaceAllRequirements([{ ...requirements[0]!, seq: -1, originLevel: 'system_inferred', ts: null }]);
      store.upsertSessionTouches([{ id: 'touch:unscoped', sessionId: SID, provider: 'claude', filePath: '/repo/alpha/unrelated.ts', toolName: 'Edit', op: 'edit', ts: now - 8000, ordinal: 3000 }]);
      const text = buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/')!.markdown;
      expect(text).toContain('system_inferred');
      expect(text).not.toContain('unrelated.ts');
      expect(text).not.toContain('B completed successfully');
    } finally { store.close(); }
  });
  test('session_handoff exports scoped history locally and rejects hidden or ambiguous sources', () => {
    const { store } = fixture();
    try {
      const result = call(store, 'session_handoff', { requirement_id: 'req:A' });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain('A still needs verification');
      expect(result.content[0]!.text).not.toContain('B completed successfully');
      expect(store.handoffsFor('requirement', 'req:A')).toEqual([]);
      expect(call(store, 'session_handoff', { session_id: SID }).content[0]!.text).toContain('B: export invoices');
      expect(call(store, 'session_handoff', { session_id: SID, requirement_id: 'req:A' }).isError).toBe(true);
      expect(call(store, 'session_handoff').isError).toBe(true);
      expect(call(store, 'session_handoff', { session_id: 123 }).isError).toBe(true);
      store.setSessionHidden(SID, true);
      const hidden = call(store, 'session_handoff', { requirement_id: 'req:A' });
      expect(hidden.isError).toBe(true);
      expect(hidden.content[0]!.text).not.toContain('authentication');
    } finally { store.close(); }
  });
  test('hidden and tombstoned sessions cannot be exported through the package or HTTP', async () => {
    const { store } = fixture();
    try {
      const app = createServer(store, { refreshPlan: async () => ({ ok: true, slug: 'test', windows: [] }) } as never, { port: 9291, plans: [] });
      store.setSessionHidden(SID, true);
      expect(buildHandoffPackage(store, 'session', SID, 'http://localhost/')).toBeNull();
      expect(buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/')).toBeNull();
      expect((await app.request(`http://localhost/api/handoff/session/${encodeURIComponent(SID)}`)).status).toBe(404);
      expect((await app.request('http://localhost/api/handoff/requirement/req%3AA/deliver', { method: 'POST' })).status).toBe(404);
      store.setSessionHidden(SID, false);
      store.tombstoneSession(SID, null);
      expect(buildHandoffPackage(store, 'session', SID, 'http://localhost/')).toBeNull();
    } finally { store.close(); }
  });
  test('session-wide handoff preserves both goals and identifies latest progress as session-wide', () => {
    const { store } = fixture();
    try {
      const text = buildHandoffPackage(store, 'session', SID, 'http://localhost/')!.markdown;
      expect(text).toContain('A: repair authentication');
      expect(text).toContain('B: export invoices');
      expect(text).toContain('req:B');
      expect(text).toContain('会话级最新自报');
    } finally { store.close(); }
  });
  test('project context includes newer intent and only the selected repository commit evidence', () => {
    const { store, requirements } = fixture();
    try {
      const beta = 'https://example.test/acme/beta.git';
      store.replaceAllRequirements([...requirements, { ...requirements[1]!, id: 'req:C', seq: 20, ts: now - 1000, text: 'C: unrelated beta task', repos: [beta] }]);
      store.replaceSessionRepos(SID, [
        { sessionId: SID, role: 'work', url: REPO, root: '/repo/alpha', name: 'alpha', evidenceKind: 'observed' },
        { sessionId: SID, role: 'touch', url: beta, root: '/repo/beta', name: 'beta', evidenceKind: 'observed' },
      ]);
      store.upsertSessionCommits([
        { sessionId: SID, repo: REPO, sha: 'c'.repeat(40), kind: 'candidate', ts: now - 7000, summary: 'possible authentication fix', fileOverlap: true },
        { sessionId: SID, repo: beta, sha: 'f'.repeat(40), kind: 'witnessed', ts: now - 1000, summary: 'foreign repo change', fileOverlap: true },
      ]);
      const text = call(store, 'planofplan_project_context', { project: '/repo/alpha' }).content[0]!.text;
      expect(text).toContain('B: export invoices');
      expect(text.indexOf('B: export invoices')).toBeLessThan(text.indexOf('A: repair authentication'));
      expect(text).not.toContain('C: unrelated beta task');
      expect(text).toContain('[candidate]');
      expect(text).not.toContain('ffffffff');
      expect(text).not.toContain('落地');
      expect(text).toContain('Unknown');
    } finally { store.close(); }
  });
  test('requirement handoff excludes foreign-repo and undated commits with an explicit gap', () => {
    const { store } = fixture();
    try {
      store.upsertSessionCommits([
        { sessionId: SID, repo: 'https://example.test/acme/beta.git', sha: 'f'.repeat(40), kind: 'witnessed', ts: now - 7000, summary: 'foreign repo change', fileOverlap: true },
        { sessionId: SID, repo: REPO, sha: 'e'.repeat(40), kind: 'declared', ts: null, summary: 'undated change', fileOverlap: true },
      ]);
      const text = buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/')!.markdown;
      expect(text).not.toContain('ffffffff');
      expect(text).not.toContain('eeeeeeee');
      expect(text).toContain('未分配');
    } finally { store.close(); }
  });
  test('MCP lists both requirements and scopes commit evidence without claiming completion', () => {
    const { store } = fixture();
    try {
      store.upsertSessionCommits([{ sessionId: SID, repo: REPO, sha: 'c'.repeat(40), kind: 'candidate', ts: now - 7000, summary: 'possible authentication fix', fileOverlap: true }]);
      const result = call(store, 'requirement_status');
      expect(result.isError).not.toBe(true);
      const text = result.content[0]!.text;
      expect(text).toContain('2 requirement(s)');
      expect(text).toContain('req:A');
      expect(text).toContain('req:B');
      expect(text).toContain('1 candidate');
      expect(text).not.toContain('landed');
      const b = text.split('\n').find((line) => line.includes('req:B'))!;
      expect(b).toContain('no scoped commits');
      expect(b).toContain('Unknown');
    } finally { store.close(); }
  });
  test('missing or reversed timestamps cannot assign later commits to A', () => {
    const { store, requirements } = fixture();
    try {
      store.upsertSessionCommits([{ sessionId: SID, repo: REPO, sha: 'd'.repeat(40), kind: 'declared', ts: now - 1000, summary: 'later unrelated change', fileOverlap: true }]);
      for (const ts of [null, now - 10000]) {
        store.replaceAllRequirements([requirements[0]!, { ...requirements[1]!, ts }]);
        const a = buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/')!;
        expect(a.markdown).not.toContain('dddddddd');
        expect(a.markdown).toContain('时间边界不完整或不单调');
      }
      store.replaceAllRequirements([{ ...requirements[0]!, ts: null }, requirements[1]!]);
      const a = buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/')!;
      expect(a.markdown).not.toContain('dddddddd');
    } finally { store.close(); }
  });
  test('candidate commit stays a candidate rather than a verified outcome', () => {
    const { store } = fixture();
    try {
      store.upsertSessionCommits([{ sessionId: SID, repo: REPO, sha: 'c'.repeat(40), kind: 'candidate', ts: now - 7000, summary: 'possible authentication fix', fileOverlap: true }]);
      const a = buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/')!;
      expect(a.markdown).toContain('[candidate]');
      expect(a.markdown).toContain('验证状态：Unknown');
      expect(a.markdown).not.toContain('产出 commit');
    } finally { store.close(); }
  });
  test('handoff for A never inherits B completion in the same session', () => {
    const { store } = fixture();
    try {
      const a = buildHandoffPackage(store, 'requirement', 'req:A', 'http://localhost/#requirements/req:A')!;
      expect(a.markdown).toContain('A pending authentication');
      expect(a.markdown).toContain('A still needs verification');
      expect(a.markdown).not.toContain('B exported invoices');
      expect(a.markdown).not.toContain('B completed successfully');
    } finally { store.close(); }
  });
});
