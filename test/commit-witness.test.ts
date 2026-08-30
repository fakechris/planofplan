import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../src/db.ts';
import { collectSessionCatalog, sessionKey } from '../src/sessions.ts';
import { collectSessionCommits } from '../src/commit-attribution.ts';
import {
  commitWitnessesFromRecord,
  isGitCommitCommand,
  witnessMatchesSha,
  type WitnessPairing,
} from '../src/commit-witness.ts';
import type { SessionRecord } from '../src/types.ts';

const UUID = 'cccccccc-dddd-4eee-8888-999999999999';
const SESSION_ID = `claude:${UUID}`;

function pairing(): WitnessPairing {
  return new Map();
}

describe('isGitCommitCommand', () => {
  test('认得各种形态,拒绝浏览型命令', () => {
    expect(isGitCommitCommand('git commit -m "x"')).toBe(true);
    expect(isGitCommitCommand('git -C /repo commit -am "x"')).toBe(true);
    expect(isGitCommitCommand('git add a.ts && git commit -m "feat: x\n\n多行消息\n含 && 与 | 符号"')).toBe(true);
    expect(isGitCommitCommand('rtk proxy git add a && rtk proxy git commit -m x')).toBe(true);
    expect(isGitCommitCommand('cd /a && git commit -m y')).toBe(true);
    expect(isGitCommitCommand('git commit')).toBe(true);
    expect(isGitCommitCommand('git log --oneline')).toBe(false);
    expect(isGitCommitCommand('git log --grep commit -5')).toBe(false);
    expect(isGitCommitCommand('git status')).toBe(false);
    expect(isGitCommitCommand('git show HEAD~1')).toBe(false);
    expect(isGitCommitCommand('echo git commit')).toBe(false);
  });
});

describe('claude 目击提取(配对制)', () => {
  test('tool_use git commit ↔ tool_result 输出 sha → 目击', () => {
    const p = pairing();
    const use = commitWitnessesFromRecord('claude', SESSION_ID, {
      type: 'assistant', uuid: 'a1', timestamp: '2026-08-29T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git commit -m "feat: x"' } }] },
    }, p);
    expect(use).toEqual([]);
    expect(p.get('toolu_1')).toBe(true);
    const result = commitWitnessesFromRecord('claude', SESSION_ID, {
      type: 'user', uuid: 'u1', timestamp: '2026-08-29T10:00:01.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[main a1b2c3d4e] feat: x\n 2 files changed' }] },
    }, p);
    expect(result).toEqual([{ sessionId: SESSION_ID, sha: 'a1b2c3d4e', ts: Date.parse('2026-08-29T10:00:01.000Z') }]);
    // 配对消费后不可重放
    expect(p.has('toolu_1')).toBe(false);
  });

  test('git log 的输出不算目击(无配对);非 commit 命令不登记', () => {
    const p = pairing();
    commitWitnessesFromRecord('claude', SESSION_ID, {
      type: 'assistant', uuid: 'a1',
      message: { content: [{ type: 'tool_use', id: 'toolu_log', name: 'Bash', input: { command: 'git log --oneline -5' } }] },
    }, p);
    const result = commitWitnessesFromRecord('claude', SESSION_ID, {
      type: 'user', uuid: 'u1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_log', content: 'a1b2c3d first\nb2c3d4e second' }] },
    }, p);
    expect(result).toEqual([]);
    expect(p.size).toBe(0);
  });

  test('root-commit 输出形态也能取到 sha', () => {
    const p = pairing();
    p.set('toolu_2', true);
    const result = commitWitnessesFromRecord('claude', SESSION_ID, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: '[main (root-commit) 99aabbccdd] init' }] },
    }, p);
    expect(result[0]?.sha).toBe('99aabbccdd');
  });
});

describe('codex 目击提取', () => {
  test('function_call(shell git commit) ↔ function_call_output 配对', () => {
    const p = pairing();
    commitWitnessesFromRecord('codex', 'codex:s1', {
      type: 'response_item', timestamp: '2026-08-29T10:00:00.000Z',
      payload: {
        type: 'function_call', call_id: 'call_1', name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'git commit -m "y"'] }),
      },
    }, p);
    expect(p.get('call_1')).toBe(true);
    const result = commitWitnessesFromRecord('codex', 'codex:s1', {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: '[main fedcba98765] y' }) },
    }, p);
    expect(result[0]?.sha).toBe('fedcba98765');
  });
});

describe('归因级联 declared > witnessed > candidate', () => {
  function seededStore() {
    const store = openMemoryDb();
    const now = Date.now();
    const base = (id: string, nativeId: string): SessionRecord => ({
      id, nativeId, provider: 'claude', cwd: '/repo', title: id, sourceFile: `/tmp/${nativeId}.jsonl`,
      startedAt: now - 7200_000, updatedAt: now - 1000, inputTokens: 0, outputTokens: 0,
      totalTokens: 0, estimatedCostUsd: null, seenAt: now, gitRoot: '/repo',
    });
    store.upsertSessions([base('claude:w', 'w'), base('claude:c', 'c')]);
    store.replaceSessionRepos('claude:w', [{ sessionId: 'claude:w', role: 'work', url: 'https://x/repo.git', root: '/repo', name: 'repo', evidenceKind: 'observed' }]);
    store.replaceSessionRepos('claude:c', [{ sessionId: 'claude:c', role: 'work', url: 'https://x/repo.git', root: '/repo', name: 'repo', evidenceKind: 'observed' }]);
    return store;
  }

  const FULL = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  function fakeGit(commits: Array<{ sha: string; subject: string; body?: string }>): (args: string[]) => string {
    const iso = new Date(Date.now() - 60_000).toISOString();
    return () => commits
      .map((c) => `${c.sha}\x00${iso}\x00${c.subject}\x00${c.body ?? ''}\x00`)
      .join('');
  }

  test('目击 session 拿 witnessed,未目击的退回 candidate;trailer 仍最高', async () => {
    const store = seededStore();
    store.upsertSessionCommitWitnesses([{ sessionId: 'claude:w', sha: FULL.slice(0, 10), ts: Date.now() }]);
    const sha2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await collectSessionCommits(store, {
      git: fakeGit([
        { sha: FULL, subject: 'feat: witnessed one' },
        { sha: sha2, subject: 'chore: plain candidate', body: `Harness-Session: ${'claude:c'}` },
      ]),
    });
    const rows = store.listSessionCommits();
    const w = rows.find((r) => r.sha === FULL && r.sessionId === 'claude:w');
    expect(w?.kind).toBe('witnessed');
    // 目击 commit 不再给其它 session 发 candidate
    expect(rows.filter((r) => r.sha === FULL)).toHaveLength(1);
    const d = rows.find((r) => r.sha === sha2);
    expect(d?.kind).toBe('declared');
    expect(d?.sessionId).toBe('claude:c');
  });

  test('witnessMatchesSha 前缀语义', () => {
    expect(witnessMatchesSha('a1b2c3d', FULL)).toBe(true);
    expect(witnessMatchesSha(FULL, FULL)).toBe(true);
    expect(witnessMatchesSha('a1b2c3', FULL)).toBe(false); // <7 位不算
    expect(witnessMatchesSha('ffffffff', FULL)).toBe(false);
  });
});

describe('扫描集成:fixture 文件 → witness 落库', () => {
  test('claude jsonl 里的 commit 对话产出目击行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pop-witness-'));
    try {
      const dir = join(root, 'claude', 'projects', '-Users-test-demo');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${UUID}.jsonl`), [
        JSON.stringify({ type: 'user', uuid: 'u0', message: { content: '把目击归因做出来并写测试' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-08-29T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'git commit -m "feat: witness"' } }] } }),
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-08-29T10:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '[main 1234567abc] feat: witness\n 1 file changed' }] } }),
      ].join('\n') + '\n');
      const store = openMemoryDb();
      await collectSessionCatalog(store, {
        claudeRoots: [join(root, 'claude', 'projects')],
        codexRoot: join(root, 'codex'),
        grokRoot: join(root, 'grok'),
        dshRoot: join(root, 'dsh'),
        kimiRoot: join(root, 'kimi'),
        droidRoot: join(root, 'factory'),
        zcodeRoot: join(root, 'zcode'),
        since: Date.now() - 86_400_000,
        until: Date.now() + 86_400_000,
      });
      const witnesses = store.listCommitWitnesses();
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]).toMatchObject({ sessionId: SESSION_ID, sha: '1234567abc' });
      expect(sessionKey('claude', UUID)).toBe(SESSION_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});
