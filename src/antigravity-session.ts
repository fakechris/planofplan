import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SessionRecord } from './types.ts';
import { sessionKey } from './sessions.ts';

// ── Antigravity session catalog(新版 IDE,2026-08-31 实证) ──────────
// 身份与 git 归属:conversations/<uuid>.db 的 trajectory_metadata_blob
// (protobuf:id='main' 行,field1{1=workspace file:// URI,2=同上},
// 2=repo slug,3=git remote,4=branch)。正文:brain/<uuid>/.system_generated/
// logs/transcript.jsonl(明文事件流)。
// 行形状:{step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type:
//   USER_INPUT|PLANNER_RESPONSE|GENERIC|CHECKPOINT|SYSTEM_MESSAGE,
//   created_at(ISO), content?, thinking?, tool_calls?[{name,args}]}
// 无消息 uuid:step_index 做稳定身份(append-only)。tool_calls 的 args 是
// 结构化参数而非 shell 命令——witness 盲区,trailer 钩子兜底。

interface AntigravityGit {
  cwd: string | null;
  gitUrl: string | null;
  repoSlug: string | null;
  branch: string | null;
}


/**
 * trajectory_metadata_blob → cwd/git 归属。blob 里字段顺序不保证(proto 可
 * 重复编号,手读字段号会错位——实测踩过),直接对原始字节串取:第一个
 * file:// URI 是 workspace,第一个 https://….git 是 remote。任何失败返回
 * 空壳(不阻塞 catalog)。
 */
function gitIdentityFromDb(dbPath: string): AntigravityGit {
  const empty: AntigravityGit = { cwd: null, gitUrl: null, repoSlug: null, branch: null };
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query('SELECT data FROM trajectory_metadata_blob LIMIT 1').get() as { data?: Uint8Array | Buffer } | null;
    if (!row?.data) return empty;
    const raw = Buffer.from(row.data);
    const cwd = /file:\/\/(\/[^\x00"\x01-\x1f]{2,200})/.exec(raw.toString('latin1'))?.[1] ?? null;
    const gitUrl = /(https:\/\/[A-Za-z0-9./_-]{4,200}\.git)/.exec(raw.toString('utf8'))?.[1] ?? null;
    return { cwd, gitUrl, repoSlug: gitUrl ? gitUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '') : null, branch: null };
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}

/** brain transcript 路径(conversations/<uuid>.db → 同 id 的 brain 目录)。 */
export function antigravityTranscriptPath(dbPath: string, conversationsRoot: string): string {
  const id = basename(dbPath).replace(/\.db$/i, '');
  return join(dirname(conversationsRoot), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

interface TranscriptEvent {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  created_at?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

function readTranscript(path: string): TranscriptEvent[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as TranscriptEvent;
      } catch {
        return {} as TranscriptEvent;
      }
    });
  } catch {
    return [];
  }
}

/**
 * 从 .db(+配套 brain transcript)抽 session 目录行。消息正文走 sourceFile
 * (transcript.jsonl)的流式索引,这里只抽元数据与首条用户输入做标题。
 */
export function extractAntigravitySession(
  dbPath: string,
  transcriptPath: string,
  mtimeMs: number,
): SessionRecord | null {
  const nativeId = basename(dbPath).replace(/\.db$/i, '');
  const git = gitIdentityFromDb(dbPath);
  const events = readTranscript(transcriptPath);
  let title: string | null = null;
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  for (const event of events) {
    const ts = typeof event.created_at === 'string' ? Date.parse(event.created_at) : NaN;
    if (Number.isFinite(ts)) {
      if (startedAt == null || ts < startedAt) startedAt = ts;
      if (updatedAt == null || ts > updatedAt) updatedAt = ts;
    }
    if (!title && event.type === 'USER_INPUT' && event.source === 'USER_EXPLICIT' && typeof event.content === 'string') {
      const inner = USER_REQUEST_RE.exec(event.content)?.[1] ?? '';
      const text = inner.trim() || event.content.trim();
      if (text && !text.startsWith('<')) title = text.slice(0, 80);
    }
  }
  if (updatedAt == null) updatedAt = mtimeMs;
  return {
    id: sessionKey('antigravity', nativeId),
    provider: 'antigravity',
    nativeId,
    cwd: git.cwd,
    title,
    sourceFile: existsSync(transcriptPath) ? transcriptPath : dbPath,
    startedAt,
    updatedAt,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    // blob 的 git 身份做兜底;attachGit 的本地 walk-up 找到时覆盖
    ...(git.gitUrl ? { gitUrl: git.gitUrl } : {}),
    ...(git.repoSlug ? { gitName: git.repoSlug.split('/').pop() ?? null } : {}),
  };
}

/** 消息行:USER_INPUT(剥信封)与 PLANNER_RESPONSE(content/tool_calls)。 */
export function messagesFromAntigravityRecord(
  sessionId: string,
  record: Record<string, unknown>,
  seq: number,
): Array<{ id: string; sessionId: string; seq: number; role: 'user' | 'assistant' | 'tool'; kind: 'text' | 'tool_use'; toolName: string | null; text: string; timestamp: number | null; model: null; inputTokens: null; outputTokens: null }> {
  const type = record.type;
  const source = record.source;
  const step = typeof record.step_index === 'number' ? record.step_index : seq;
  const ts = typeof record.created_at === 'string' ? Date.parse(record.created_at) : null;
  const rows: Array<{ id: string; sessionId: string; seq: number; role: 'user' | 'assistant' | 'tool'; kind: 'text' | 'tool_use'; toolName: string | null; text: string; timestamp: number | null; model: null; inputTokens: null; outputTokens: null }> = [];
  const push = (suffix: string, role: 'user' | 'assistant' | 'tool', kind: 'text' | 'tool_use', text: string, toolName: string | null): void => {
    const trimmed = text.trim().slice(0, 10_000);
    if (!trimmed) return;
    rows.push({ id: `${sessionId}:t${step}:${suffix}`, sessionId, seq, role, kind, toolName, text: trimmed, timestamp: ts, model: null, inputTokens: null, outputTokens: null });
  };
  if (type === 'USER_INPUT' && source === 'USER_EXPLICIT' && typeof record.content === 'string') {
    const inner = USER_REQUEST_RE.exec(record.content)?.[1] ?? '';
    push('u', 'user', 'text', inner || '', null);
    return rows;
  }
  if (type === 'PLANNER_RESPONSE' && source === 'MODEL') {
    if (typeof record.content === 'string') push('a', 'assistant', 'text', record.content, null);
    if (Array.isArray(record.tool_calls)) {
      record.tool_calls.forEach((call, i) => {
        if (!call || typeof call !== 'object') return;
        const item = call as { name?: unknown; args?: unknown };
        if (typeof item.name !== 'string') return;
        push(`c${i}`, 'tool', 'tool_use', JSON.stringify(item.args ?? {}).slice(0, 2000), item.name);
      });
    }
  }
  return rows;
}
