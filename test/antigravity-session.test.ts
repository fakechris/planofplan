import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { extractAntigravitySession, antigravityTranscriptPath, messagesFromAntigravityRecord } from '../src/antigravity-session.ts';

function varintBytes(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}
function lenField(num: number, payload: number[] | string): number[] {
  const bytes = typeof payload === 'string' ? [...Buffer.from(payload)] : payload;
  return [...varintBytes((num << 3) | 2), ...varintBytes(bytes.length), ...bytes];
}

function fixture(): { dbPath: string; transcriptPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'pop-agy-sess-'));
  const convRoot = join(root, 'conversations');
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  mkdirSync(convRoot, { recursive: true });
  const dbPath = join(convRoot, `${id}.db`);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
  // field1 payload:{1=workspace,2=workspace,3{1=slug},4=branch}——故意乱序放 4 在前(字段序不保证)
  const inner = [
    ...lenField(4, 'main'),
    ...lenField(1, 'file:///work/demo'),
    ...lenField(3, [...lenField(1, 'org/demo')]),
  ];
  const blob = Uint8Array.from(lenField(1, inner));
  db.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', blob);
  db.close();
  const transcriptPath = join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(join(transcriptPath, '..'), { recursive: true });
  writeFileSync(transcriptPath, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-31T03:32:12Z', content: '<USER_REQUEST>\n调研一下图谱渲染方案\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' }),
    JSON.stringify({ step_index: 1, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-08-31T03:32:13Z', content: '{{ CHECKPOINT }}' }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-31T03:32:20Z', thinking: '...', tool_calls: [{ name: 'run_shell', args: { CommandLine: 'git status -s' } }] }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-31T03:35:00Z', content: '调研完成,结论如下…' }),
  ].join('\n') + '\n');
  return { dbPath, transcriptPath };
}

describe('antigravity session catalog', () => {
  test('git 身份(乱序字段) + 标题剥信封 + 时间窗', () => {
    const { dbPath, transcriptPath } = fixture();
    const row = extractAntigravitySession(dbPath, transcriptPath, Date.now());
    expect(row).toMatchObject({
      id: 'antigravity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cwd: '/work/demo',
      // fixture 无 https remote → 不虚构(字段缺省)
      title: '调研一下图谱渲染方案',
      sourceFile: transcriptPath,
    });
    expect(row?.startedAt).toBe(Date.parse('2026-08-31T03:32:12Z'));
    expect(row?.updatedAt).toBe(Date.parse('2026-08-31T03:35:00Z'));
    expect(antigravityTranscriptPath(dbPath, join(dbPath, '..'))).toBe(transcriptPath);
    rmSync(join(dbPath, '../..'), { recursive: true, force: true });
  });

  test('消息行:用户剥信封/PLANNER 的 tool_calls 与 content/SYSTEM 跳过', () => {
    const sid = 'antigravity:x';
    const user = messagesFromAntigravityRecord(sid, { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-08-31T03:32:12Z', content: '<USER_REQUEST>\n调研图谱渲染\n</USER_REQUEST>' }, 1);
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ role: 'user', kind: 'text', text: '调研图谱渲染' });
    const planner = messagesFromAntigravityRecord(sid, { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-08-31T03:32:20Z', tool_calls: [{ name: 'run_shell', args: { CommandLine: 'git status -s' } }], content: '结论' }, 2);
    expect(planner).toHaveLength(2);
    expect(planner.find((r) => r.kind === 'tool_use')?.toolName).toBe('run_shell');
    expect(planner.find((r) => r.kind === 'text')?.role).toBe('assistant');
    expect(messagesFromAntigravityRecord(sid, { step_index: 1, source: 'SYSTEM', type: 'CHECKPOINT', content: '{{X}}' }, 3)).toHaveLength(0);
    expect(user[0]?.id).toBe('antigravity:x:t0:u'); // step_index 稳定身份
  });
});
