import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, openMemoryDb, REDACT_BACKFILL_STATE_PATH } from '../src/db.ts';
import { redactSecrets } from '../src/redact.ts';
import type { SessionMessageRow, SessionRecord } from '../src/types.ts';

// Shaped like real keys, assembled so the test file itself holds no literal key.
const fake = {
  anthropic: 'sk-ant-' + 'api03-' + 'A1b2C3d4E5'.repeat(4),
  openai: 'sk-' + 'proj-' + 'Z9y8X7w6V5'.repeat(4),
  github: 'gh' + 'p_' + 'a1B2c3D4e5'.repeat(4),
  githubPat: 'github_' + 'pat_' + '11AAAAAAA0'.repeat(4),
  slack: 'xox' + 'b-' + '123456789012-abcdefABCDEF',
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  google: 'AIza' + 'Sy' + 'A'.repeat(33),
  involute: 'inv_' + 'agent_' + 'Q'.repeat(40),
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 's'.repeat(20),
  pem: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END ' + 'OPENSSH PRIVATE KEY-----',
};

describe('redactSecrets: keys recognised by their own shape (INV-898)', () => {
  for (const [name, secret] of Object.entries(fake)) {
    test(`${name} pasted into prose is replaced`, () => {
      const out = redactSecrets(`here it is: ${secret} — use it`);
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED]');
      expect(out).toContain('here it is:');
    });
  }

  test('ordinary text is left alone', () => {
    for (const text of [
      'input token: 500, output token: 42',
      'the sk-learn docs and sk-1 are not keys',
      'git checkout -b feat/inv-898-message-search',
      'AKIA is a prefix, AKIA123 is too short',
      'max_tokens=500 and ghp_short',
      '部署到 oracle_5 的 /opt/involute',
    ]) expect(redactSecrets(text)).toBe(text);
  });
});

function msg(partial: Partial<SessionMessageRow> & { id: string; text: string }): SessionMessageRow {
  return { sessionId: 'claude:s1', seq: 1, role: 'user', kind: 'text', toolName: null, timestamp: 1, model: null,
    inputTokens: null, outputTokens: null, fullText: partial.text, parserVersion: 9, ...partial };
}

function session(title: string): SessionRecord {
  return { id: 'claude:s1', provider: 'claude', nativeId: 's1', cwd: '/tmp', title, sourceFile: null, startedAt: 1,
    updatedAt: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: null, seenAt: 1 };
}

describe('the index stores no key (INV-898)', () => {
  test('messages, tool input and titles are redacted on the way in; FTS cannot find the key', () => {
    const store = openMemoryDb();
    store.upsertSessions([session(`deploy with ${fake.anthropic}`)]);
    store.upsertSessionMessages([
      msg({ id: 'm1', text: `my key is ${fake.anthropic} please keep it` }),
      msg({ id: 'm2', seq: 2, role: 'tool', kind: 'tool_use', toolName: 'Bash', fullText: null,
        text: JSON.stringify({ command: `curl -H "Authorization: Bearer ${fake.github}" https://api.github.com` }) }),
    ]);
    const rows = store.db.query('SELECT text, full_text AS fullText FROM session_messages ORDER BY seq').all() as Array<{ text: string; fullText: string | null }>;
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(fake.anthropic);
    expect(stored).not.toContain(fake.github);
    expect(rows[0]!.text).toContain('please keep it');
    expect(store.searchSessionMessages('sk-ant-api03')).toHaveLength(0);
    expect(store.searchSessionMessages('please keep it')).toHaveLength(1);
    const title = (store.db.query('SELECT title FROM sessions').get() as { title: string }).title;
    expect(title).toBe('deploy with [REDACTED]');
  });

  test('re-upserting the same message does not resurrect plaintext through the unchanged-row shortcut', () => {
    const store = openMemoryDb();
    store.upsertSessionMessages([msg({ id: 'm1', text: `key ${fake.openai}` })]);
    expect(store.upsertSessionMessages([msg({ id: 'm1', text: `key ${fake.openai}` })])).toBe(0);
    expect(JSON.stringify(store.db.query('SELECT text, full_text FROM session_messages').all())).not.toContain(fake.openai);
  });

  test('stored plaintext from an older build is redacted once on open, keyed by a sentinel, not user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pop-redact-'));
    try {
      const path = join(dir, 'planofplan.db');
      const old = openDb(path);
      // What an older build left behind: plaintext written straight into the tables, no sentinel.
      old.db.query(`INSERT INTO session_messages (id, session_id, seq, role, kind, text, full_text, timestamp, parser_version)
        VALUES ('m1', 'claude:s1', 1, 'user', 'text', ?, ?, 1, 8)`).run(`token ${fake.involute} here`, `token ${fake.involute} here`);
      old.db.query(`INSERT INTO sessions (id, provider, native_id, title, updated_at, input_tokens, output_tokens, total_tokens, seen_at)
        VALUES ('claude:s1', 'claude', 's1', ?, 1, 0, 0, 0, 1)`).run(`title ${fake.involute}`);
      old.db.query('DELETE FROM session_index_state WHERE path = ?').run(REDACT_BACKFILL_STATE_PATH);
      // Whatever user_version an unknown build left must not close the gate.
      old.setUserVersion(16);
      expect(old.searchSessionMessages(fake.involute.slice(0, 20))).toHaveLength(1);
      old.close();

      const upgraded = openDb(path);
      expect(JSON.stringify(upgraded.db.query('SELECT text, full_text FROM session_messages').all())).not.toContain(fake.involute);
      expect((upgraded.db.query('SELECT title FROM sessions').get() as { title: string }).title).toBe('title [REDACTED]');
      expect(upgraded.searchSessionMessages(fake.involute.slice(0, 20))).toHaveLength(0);
      expect(upgraded.searchSessionMessages('here')).toHaveLength(1);
      const marker = upgraded.getSessionIndexState(REDACT_BACKFILL_STATE_PATH);
      expect(marker?.lines).toBe(2);
      upgraded.close();

      // Once: a later open does not walk the table again.
      const again = openDb(path);
      expect(again.getSessionIndexState(REDACT_BACKFILL_STATE_PATH)?.mtimeMs).toBe(marker?.mtimeMs);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
