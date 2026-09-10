import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { openMemoryDb } from '../src/db.ts';
import {
  extractOpencodeDb,
  messagesFromOpencodeDb,
  touchesFromOpencodeDb,
  commitWitnessesFromOpencodeDb,
  turnsFromOpencodeDb,
} from '../src/opencode-session.ts';
import {
  extractAmpThread,
  messagesFromAmpThread,
  touchesFromAmpThread,
  commitWitnessesFromAmpThread,
  turnsFromAmpThread,
} from '../src/amp-session.ts';
import { collectSessionCatalog } from '../src/sessions.ts';
import { materializeRequirements } from '../src/requirements.ts';
import { parseTrailers } from '../src/session-repos.ts';
import { resumeCommand } from '../src/resume.ts';
import { isRelevantWatchName } from '../src/watcher.ts';

function tempRoot(): string {
  const dir = join(tmpdir(), `pop-test-opencode-amp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('OpenCode session integration', () => {
  test('extractOpencodeDb parses sessions, subagents, and tokens', () => {
    const root = tempRoot();
    const dbPath = join(root, 'opencode.db');
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          parent_id TEXT,
          title TEXT,
          directory TEXT,
          path TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          tokens_input INTEGER,
          tokens_output INTEGER,
          tokens_reasoning INTEGER
        );
      `);
      db.query(`
        INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ses_root', 'p1', null, 'Implement user auth', '/workspace/auth-project', null, 1700000000000, 1700000010000, 100, 50, 20);
      db.query(`
        INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ses_sub', 'p1', 'ses_root', 'Subagent task', '/workspace/auth-project', null, 1700000005000, 1700000008000, 30, 10, 5);
      db.close();

      const rows = extractOpencodeDb(dbPath, Date.now());
      expect(rows).toHaveLength(2);

      const rootRow = rows.find((r) => r.nativeId === 'ses_root');
      expect(rootRow).toBeDefined();
      expect(rootRow?.id).toBe('opencode:ses_root');
      expect(rootRow?.provider).toBe('opencode');
      expect(rootRow?.origin).toBe('user');
      expect(rootRow?.parentId).toBeNull();
      expect(rootRow?.cwd).toBe('/workspace/auth-project');
      expect(rootRow?.title).toBe('Implement user auth');
      expect(rootRow?.totalTokens).toBe(170);

      const subRow = rows.find((r) => r.nativeId === 'ses_sub');
      expect(subRow).toBeDefined();
      expect(subRow?.origin).toBe('subagent');
      expect(subRow?.parentId).toBe('opencode:ses_root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('messages, touches, commit witnesses, and turns extraction from OpenCode db', () => {
    const root = tempRoot();
    const dbPath = join(root, 'opencode.db');
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          title TEXT,
          directory TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          time_created INTEGER,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          session_id TEXT,
          time_created INTEGER,
          data TEXT
        );
      `);

      db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
        'ses_1', null, 'Build CLI', '/workspace/repo', 1000, 5000,
      );

      // Message 1: user prompt
      db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_1', 'ses_1', 1000, JSON.stringify({ role: 'user' }));
      db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('prt_1', 'msg_1', 'ses_1', 1001, JSON.stringify({
        type: 'text',
        text: 'Please write the cli tool and commit it',
      }));

      // Message 2: assistant writes file and runs git commit
      db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_2', 'ses_1', 2000, JSON.stringify({ role: 'assistant' }));
      db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('prt_2', 'msg_2', 'ses_1', 2001, JSON.stringify({
        type: 'tool',
        tool: 'write_file',
        state: { input: { file_path: 'src/cli.ts' }, status: 'completed' },
      }));
      db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('prt_3', 'msg_2', 'ses_1', 2002, JSON.stringify({
        type: 'tool',
        tool: 'bash',
        state: {
          input: { command: 'git commit -m "feat: initial cli"' },
          output: '[main abc1234] feat: initial cli\n 1 file changed, 10 insertions(+)',
          time: { start: 2002, end: 2005 },
        },
      }));
      db.close();

      const msgs = messagesFromOpencodeDb(dbPath, 'ses_1', 'opencode:ses_1');
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      expect(msgs[0]?.text).toBe('Please write the cli tool and commit it');
      expect(msgs[0]?.role).toBe('user');

      const touches = touchesFromOpencodeDb(dbPath, 'ses_1', 'opencode:ses_1', '/workspace/repo');
      expect(touches).toHaveLength(1);
      expect(touches[0]?.filePath).toBe('/workspace/repo/src/cli.ts');
      expect(touches[0]?.toolName).toBe('write_file');

      const witnesses = commitWitnessesFromOpencodeDb(dbPath, 'ses_1', 'opencode:ses_1');
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]?.sha).toBe('abc1234');

      const turns = turnsFromOpencodeDb(dbPath, 'ses_1');
      expect(turns.length).toBeGreaterThanOrEqual(2);
      expect(turns[0]?.role).toBe('user');
      expect(turns[1]?.role).toBe('tool');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('OpenCode resume command', () => {
    const session = {
      id: 'opencode:ses_abc',
      provider: 'opencode',
      nativeId: 'ses_abc',
      cwd: '/workspace/test',
    } as any;
    const res = resumeCommand(session);
    expect(res).not.toBeNull();
    expect(res?.argv).toContain('-s');
    expect(res?.argv).toContain('ses_abc');
    expect(res?.label).toBe('打开 OpenCode');
  });
});

describe('Amp session integration', () => {
  test('extractAmpThread parses thread JSON with git info and tokens', () => {
    const root = tempRoot();
    const threadPath = join(root, 'T-019c0000-0000-7000-8000-000000000001.json');
    try {
      const threadData = {
        id: 'T-019c0000-0000-7000-8000-000000000001',
        created: 1700000000000,
        title: 'Optimize Postgres indexes',
        env: {
          initial: {
            trees: [
              {
                uri: 'file:///workspace/backend',
                displayName: 'backend-repo',
                repository: {
                  type: 'git',
                  url: 'git@github.com:company/backend.git',
                },
              },
            ],
          },
        },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Optimize queries' }],
          },
          {
            role: 'assistant',
            usage: { inputTokens: 500, outputTokens: 200 },
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'create_file',
                input: { path: 'db/migrations/001_index.sql' },
              },
              {
                type: 'tool_use',
                id: 'call_2',
                name: 'Bash',
                input: { cmd: 'git commit -m "add index"' },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_result',
                toolUseID: 'call_2',
                run: {
                  result: {
                    output: '[master ffedcba] add index\n 1 file changed',
                  },
                },
              },
            ],
          },
        ],
      };
      writeFileSync(threadPath, JSON.stringify(threadData), 'utf8');

      const rec = extractAmpThread(threadPath, Date.now());
      expect(rec).not.toBeNull();
      expect(rec?.id).toBe('amp:T-019c0000-0000-7000-8000-000000000001');
      expect(rec?.provider).toBe('amp');
      expect(rec?.cwd).toBe('/workspace/backend');
      expect(rec?.gitUrl).toBe('git@github.com:company/backend.git');
      expect(rec?.gitName).toBe('backend-repo');
      expect(rec?.title).toBe('Optimize Postgres indexes');
      expect(rec?.totalTokens).toBe(700);
      expect(rec?.origin).toBe('user');

      const msgs = messagesFromAmpThread(threadPath, rec!.nativeId, rec!.id);
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      expect(msgs[0]?.text).toBe('Optimize queries');

      const touches = touchesFromAmpThread(threadPath, rec!.nativeId, rec!.id, rec!.cwd);
      expect(touches).toHaveLength(1);
      expect(touches[0]?.filePath).toBe('/workspace/backend/db/migrations/001_index.sql');

      const witnesses = commitWitnessesFromAmpThread(threadPath, rec!.nativeId, rec!.id);
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]?.sha).toBe('ffedcba');

      const turns = turnsFromAmpThread(threadPath);
      expect(turns.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Amp-Thread trailer is recognized as declared attribution', () => {
    const commitBody = 'feat: add metrics\n\nAmp-Thread: T-019c0000-0000-7000-8000-000000000001';
    const trailers = parseTrailers(commitBody);
    expect(trailers).toHaveLength(1);
    expect(trailers[0]?.key).toBe('Amp-Thread');
    expect(trailers[0]?.value).toBe('T-019c0000-0000-7000-8000-000000000001');
  });

  test('Amp resume command', () => {
    const session = {
      id: 'amp:T-123',
      provider: 'amp',
      nativeId: 'T-123',
      cwd: '/workspace/test',
    } as any;
    const res = resumeCommand(session);
    expect(res).not.toBeNull();
    expect(res?.argv).toContain('threads');
    expect(res?.argv).toContain('continue');
    expect(res?.argv).toContain('T-123');
    expect(res?.label).toBe('打开 Amp');
  });
});

describe('Watcher relevance', () => {
  test('isRelevantWatchName accepts opencode and amp files', () => {
    expect(isRelevantWatchName('opencode.db')).toBe(true);
    expect(isRelevantWatchName('opencode.db-wal')).toBe(true);
    expect(isRelevantWatchName('opencode-next.db')).toBe(true);
    expect(isRelevantWatchName('opencode-next.db-wal')).toBe(true);
    expect(isRelevantWatchName('T-019ba628-c454-718b-84c5-927fa8d968d0.json')).toBe(true);
    expect(isRelevantWatchName('random.txt')).toBe(false);
    expect(isRelevantWatchName('temp.json')).toBe(false);
  });
});

describe('Catalog collection and requirement materialization', () => {
  test('collects opencode and amp sessions into catalog and materializes requirements', async () => {
    const root = tempRoot();
    const store = openMemoryDb();
    try {
      const opencodeDir = join(root, 'opencode');
      mkdirSync(opencodeDir, { recursive: true });
      const opencodeDbPath = join(opencodeDir, 'opencode.db');
      const db = new Database(opencodeDbPath);
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          title TEXT,
          directory TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          time_created INTEGER,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          session_id TEXT,
          time_created INTEGER,
          data TEXT
        );
      `);
      const now = Date.now();
      db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
        'ses_scan_1', null, 'Fix race condition in store', '/workspace/store', now - 2000, now - 1000,
      );
      db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'ses_scan_1', now - 2000, JSON.stringify({ role: 'user' }));
      db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm1', 'ses_scan_1', now - 1900, JSON.stringify({
        type: 'text',
        text: '修复 store 里的死锁竞争',
      }));
      db.close();

      const ampDir = join(root, 'amp');
      mkdirSync(ampDir, { recursive: true });
      const ampPath = join(ampDir, 'T-019c9999-0000-7000-8000-000000000001.json');
      writeFileSync(ampPath, JSON.stringify({
        id: 'T-019c9999-0000-7000-8000-000000000001',
        created: now - 1500,
        title: 'Refactor HTTP router',
        env: {
          initial: {
            trees: [{ uri: 'file:///workspace/router', displayName: 'router' }],
          },
        },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '重构 HTTP 路由以支持正则匹配' }],
          },
        ],
      }), 'utf8');

      const count = await collectSessionCatalog(store, {
        since: now - 86400000,
        until: now + 10000,
        messageRetentionDays: 0,
        claudeRoots: [join(root, 'dummy-claude')],
        codexRoot: join(root, 'dummy-codex'),
        grokRoot: join(root, 'dummy-grok'),
        dshRoot: join(root, 'dummy-dsh'),
        kimiRoot: join(root, 'dummy-kimi'),
        droidRoot: join(root, 'dummy-droid'),
        zcodeRoot: join(root, 'dummy-zcode'),
        antigravityRoot: join(root, 'dummy-agy'),
        opencodeRoot: opencodeDir,
        ampRoot: ampDir,
      });

      expect(count).toBe(2);

      const opencodeRow = store.getSession('opencode:ses_scan_1');
      expect(opencodeRow).not.toBeNull();
      expect(opencodeRow?.title).toBe('Fix race condition in store');

      const ampRow = store.getSession('amp:T-019c9999-0000-7000-8000-000000000001');
      expect(ampRow).not.toBeNull();
      expect(ampRow?.title).toBe('Refactor HTTP router');

      // Now materialize requirements
      const reqCount = materializeRequirements(store);
      expect(reqCount).toBe(2);

      const reqs = store.listRequirements();
      expect(reqs.some((r) => r.text === '修复 store 里的死锁竞争' && r.originLevel === 'user_explicit')).toBe(true);
      expect(reqs.some((r) => r.text === '重构 HTTP 路由以支持正则匹配' && r.originLevel === 'user_explicit')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
