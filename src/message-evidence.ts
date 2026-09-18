import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Store } from './db.ts';
import type { Hono } from 'hono';

export interface SourceRef {
  provider: string;
  session_id: string;
  message_id: string;
  source_seq: number;
  source_revision: string;
  parser_version: number | null;
}
export const SOURCE_REF_SCHEMA = {
  type: 'object',
  properties: {
    provider: { type: 'string' }, session_id: { type: 'string' }, message_id: { type: 'string' },
    source_seq: { type: 'integer' }, source_revision: { type: 'string' }, parser_version: { type: ['integer', 'null'] },
  },
  required: ['provider', 'session_id', 'message_id', 'source_seq', 'source_revision', 'parser_version'],
  additionalProperties: false,
};

export interface MessageEvidenceRow {
  id: string; sessionId: string; seq: number; role: string; kind: string;
  text: string; fullText: string | null; parserVersion: number | null;
  timestamp: number | null; provider: string;
  model: string | null; toolName: string | null;
  sourceFile: string | null; indexedAt: number;
}
const COLUMNS = `m.id, m.session_id AS sessionId, m.seq, m.role, m.kind,
  m.text, m.full_text AS fullText, m.parser_version AS parserVersion,
  m.timestamp, s.provider, m.model, m.tool_name AS toolName, s.source_file AS sourceFile, s.seen_at AS indexedAt`;
const VISIBLE = `NOT EXISTS (SELECT 1 FROM session_user_meta u WHERE u.session_id=s.id
  AND (u.hidden=1 OR u.deleted_at IS NOT NULL))`;

export class MessageEvidenceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 404 | 409 = 400) { super(message); }
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new MessageEvidenceError('INVALID_ARGUMENT', `Expected integer ${min}..${max}`);
  return n;
}

export const MESSAGE_FILTER_SCHEMA = {
  project: { type: 'string', description: 'Exact repository name, URL, root or session cwd' },
  provider: { type: 'string' },
  role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
  kind: { type: 'string', enum: ['text', 'summary', 'tool_use'] },
  since: { description: 'Inclusive message timestamp: epoch milliseconds or ISO date', type: ['number', 'string'] },
  until: { description: 'Exclusive message timestamp: epoch milliseconds or ISO date', type: ['number', 'string'] },
  exclude: { type: 'string', description: 'Session ID to exclude' },
};

function whereFilters(args: Record<string, unknown>, params: Array<string | number>): string {
  const clauses = [VISIBLE];
  for (const [key, column] of [['provider', 's.provider'], ['role', 'm.role'], ['kind', 'm.kind'], ['exclude', 's.id']]) {
    if (args[key!] === undefined) continue;
    const value = args[key!];
    if (typeof value !== 'string' || !value.trim()) throw new MessageEvidenceError('INVALID_ARGUMENT', `${key} must be non-empty text`);
    if (key === 'role' && !['user', 'assistant', 'system', 'tool'].includes(value)) throw new MessageEvidenceError('INVALID_ARGUMENT', 'Invalid role');
    if (key === 'kind' && !['text', 'summary', 'tool_use'].includes(value)) throw new MessageEvidenceError('INVALID_ARGUMENT', 'Invalid kind');
    clauses.push(`${column} ${key === 'exclude' ? '!=' : '='} ?`);
    params.push(value.trim());
  }
  if (args.project !== undefined) {
    if (typeof args.project !== 'string' || !args.project.trim()) throw new MessageEvidenceError('INVALID_ARGUMENT', 'project must be non-empty text');
    const project = args.project.trim();
    // Build the project session set once, rather than repeating repository lookups
    // for every message hit in a large history.
    clauses.push(`s.id IN (SELECT ps.id FROM sessions ps
      WHERE ps.cwd=? OR ps.git_root=? OR ps.git_url=? OR ps.git_name=? OR ps.id IN
      (SELECT r.session_id FROM session_repos r WHERE r.root=? OR r.url=? OR r.name=?))`);
    params.push(...Array(7).fill(project));
  }
  for (const key of ['since', 'until']) {
    if (args[key] === undefined) continue;
    const value = args[key];
    const ts = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(ts) || ts < 0) throw new MessageEvidenceError('INVALID_ARGUMENT', `${key} must be epoch milliseconds or an ISO date`);
    clauses.push(`m.timestamp ${key === 'since' ? '>=' : '<'} ?`);
    params.push(ts);
  }
  for (const key of ['active_since', 'active_until']) {
    if (args[key] === undefined) continue;
    const ts = integer(args[key], 0, 0, Number.MAX_SAFE_INTEGER);
    clauses.push(`s.updated_at ${key === 'active_since' ? '>=' : '<'} ?`);
    params.push(ts);
  }
  return clauses.join(' AND ');
}

function sourceRef(row: MessageEvidenceRow): SourceRef {
  const revision = createHash('sha256').update(JSON.stringify([
    row.provider, row.sessionId, row.id, row.seq, row.role, row.kind, row.timestamp,
    row.fullText ?? row.text, row.fullText != null, row.parserVersion,
  ])).digest('hex');
  return { provider: row.provider, session_id: row.sessionId, message_id: row.id, source_seq: row.seq,
    source_revision: `sha256:${revision}`, parser_version: row.parserVersion };
}

function sourceStatus(store: Store, row: MessageEvidenceRow): string {
  if (!row.sourceFile) return 'index_only';
  try {
    const stat = statSync(row.sourceFile);
    const watermark = store.getSessionIndexState(row.sourceFile);
    if (!watermark) return 'present_unverified';
    return stat.size === watermark.size && stat.mtimeMs === watermark.mtimeMs ? 'indexed_metadata_matches' : 'changed_since_index';
  } catch { return 'missing'; }
}

export function eligibleMessageSessionIds(store: Store, args: Record<string, unknown>): Set<string> {
  const params: Array<string | number> = [];
  const where = whereFilters(args, params);
  const rows = store.db.query(`SELECT DISTINCT s.id FROM sessions s LEFT JOIN session_messages m ON m.session_id=s.id
    WHERE ${where}`).all(...params) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Ordinals are view positions; source_seq and SourceRef remain stable across filters. */
export function listMessageEvidencePage(store: Store, sessionId: string, offset: number, limit: number, args: Record<string, unknown>) {
  const params: Array<string | number> = [];
  const where = whereFilters(args, params) + ' AND m.session_id=?';
  params.push(sessionId);
  const total = (store.db.query(`SELECT count(*) AS n FROM session_messages m JOIN sessions s ON s.id=m.session_id WHERE ${where}`)
    .get(...params) as { n: number }).n;
  const rows = store.db.query(`SELECT ${COLUMNS} FROM session_messages m JOIN sessions s ON s.id=m.session_id WHERE ${where}
    ORDER BY m.seq, m.id LIMIT ? OFFSET ?`).all(...params, limit, offset - 1) as MessageEvidenceRow[];
  return { total, rows: rows.map((row) => ({ ...row, source_ref: sourceRef(row) })) };
}

export function searchMessageEvidence(store: Store, args: Record<string, unknown>) {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  if (!q || q.length > 500) throw new MessageEvidenceError('INVALID_ARGUMENT', 'q must contain 1..500 characters');
  const limit = integer(args.limit, 20, 1, 100);
  const params: Array<string | number> = [];
  const where = whereFilters(args, params);
  const offset = integer(args.offset, 0, 0, 1_000_000);
  const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const like = () => store.db.query(`SELECT ${COLUMNS} FROM session_messages m
    JOIN sessions s ON s.id=m.session_id WHERE ${where} AND m.kind != 'tool_use' AND m.text LIKE ? ESCAPE '\\'
    ORDER BY m.timestamp DESC, m.session_id, m.seq, m.id LIMIT ? OFFSET ?`).all(...params, pattern, limit + 1, offset) as MessageEvidenceRow[];
  let rows: Array<MessageEvidenceRow & { snippet?: string }>;
  let searchMode = 'fts5';
  if ([...q.replace(/\s+/g, '')].length < 3) {
    rows = like();
    searchMode = 'like_short_query';
  } else {
    const ftsQuery = q.split(/\s+/).map((token) => `"${token.replaceAll('"', '""')}"`).join(' ');
    try {
      // FTS5's rank column supports its ranked scan; a separate bm25 + tie sort
      // forces SQLite to sort all common-term matches before applying LIMIT.
      rows = store.db.query(`SELECT ${COLUMNS}, snippet(session_messages_fts, 0, char(1), char(2), '…', 48) AS snippet
        FROM session_messages_fts JOIN session_messages m ON m.rowid=session_messages_fts.rowid
        JOIN sessions s ON s.id=m.session_id
        WHERE ${where} AND m.kind != 'tool_use' AND session_messages_fts MATCH ?
        ORDER BY session_messages_fts.rank LIMIT ? OFFSET ?`)
        .all(...params, ftsQuery, limit + 1, offset) as Array<MessageEvidenceRow & { snippet: string }>;
    } catch {
      rows = like();
      searchMode = 'like_fallback';
    }
  }
  return {
    items: rows.slice(0, limit).map((row) => {
      const at = row.text.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, at - 60);
      return { source_ref: sourceRef(row), role: row.role, kind: row.kind,
        timestamp: row.timestamp, snippet: row.snippet ?? row.text.slice(start, start + 240), content_complete: row.fullText != null,
        source_status: sourceStatus(store, row), indexed_at: row.indexedAt };
    }),
    truncated: rows.length > limit,
    next_offset: rows.length > limit ? offset + limit : null,
    search_mode: searchMode,
    freshness: 'indexed_snapshot',
    warnings: [
      'Search covers the existing indexed text excerpt (visible text up to 10000 characters); read_message can recover retained full text.',
      'Search pagination is a live view; SourceRef pins message content, not the result list.',
      ...(searchMode === 'fts5' ? [] : ['LIKE fallback may scan more rows; narrow project/provider/time for large histories.']),
    ],
  };
}

export function readMessageEvidence(store: Store, args: Record<string, unknown>) {
  let filters = args;
  let ref: unknown = args.source_ref;
  let start = integer(args.char_start, 0, 0, Number.MAX_SAFE_INTEGER);
  if (args.cursor !== undefined) {
    if (args.source_ref !== undefined || args.char_start !== undefined || typeof args.cursor !== 'string' || args.cursor.length > 16000) {
      throw new MessageEvidenceError('INVALID_ARGUMENT', 'cursor cannot be combined with source_ref or char_start');
    }
    try {
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));
      if (cursor.version !== 1) throw new Error('version');
      ref = cursor.source_ref;
      start = integer(cursor.char_start, 0, 0, Number.MAX_SAFE_INTEGER);
      filters = { ...cursor.filters, ...args };
    } catch { throw new MessageEvidenceError('INVALID_CURSOR', 'Invalid message continuation cursor'); }
  }
  if (!ref || typeof ref !== 'object' || typeof (ref as SourceRef).message_id !== 'string' || typeof (ref as SourceRef).session_id !== 'string') {
    throw new MessageEvidenceError('INVALID_ARGUMENT', 'source_ref from message_search or read_session is required');
  }
  const requested = ref as SourceRef;
  const params: Array<string | number> = [];
  const where = whereFilters(filters, params);
  const row = store.db.query(`SELECT ${COLUMNS} FROM session_messages m JOIN sessions s ON s.id=m.session_id
    WHERE ${where} AND m.id=? AND m.session_id=?`).get(...params, requested.message_id, requested.session_id) as MessageEvidenceRow | null;
  if (!row) throw new MessageEvidenceError('SOURCE_MISSING', 'Message source is unavailable', 404);
  const actual = sourceRef(row);
  if (Object.keys(actual).some((key) => actual[key as keyof SourceRef] !== requested[key as keyof SourceRef])) {
    throw new MessageEvidenceError('STALE_SOURCE', 'Message version or identity changed; search again', 409);
  }
  const archived = filters.allow_archived;
  if (archived !== undefined && ![true, false, 'true', 'false'].includes(archived as boolean | string)) {
    throw new MessageEvidenceError('INVALID_ARGUMENT', 'allow_archived must be boolean');
  }
  const status = sourceStatus(store, row);
  if (status === 'missing' && archived !== true && archived !== 'true') {
    throw new MessageEvidenceError('SOURCE_MISSING', 'Original log is missing. Explicitly set allow_archived=true to read the retained indexed snapshot.', 404);
  }
  const content = row.fullText ?? row.text;
  const limit = integer(args.char_limit, 4000, 2, 16000);
  if (start > content.length || (start > 0 && /[\uD800-\uDBFF]/.test(content[start - 1]!) && /[\uDC00-\uDFFF]/.test(content[start] ?? ''))) {
    throw new MessageEvidenceError('INVALID_RANGE', 'char_start is outside the message or splits a surrogate pair');
  }
  let end = Math.min(content.length, start + limit);
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
  const truncated = end < content.length;
  return {
    source_ref: actual, role: row.role, kind: row.kind, text: content.slice(start, end),
    char_start: start, char_end: end, total_chars: content.length, char_unit: 'UTF-16 code units',
    content_complete: row.fullText != null, truncated, freshness: 'indexed_snapshot', source_status: status, indexed_at: row.indexedAt,
    next_cursor: truncated ? Buffer.from(JSON.stringify({ version: 1, source_ref: actual, char_start: end,
      filters: Object.fromEntries([...Object.keys(MESSAGE_FILTER_SCHEMA), 'allow_archived'].filter((key) => filters[key] !== undefined).map((key) => [key, filters[key]])),
    })).toString('base64url') : null,
    warnings: [
      ...(row.fullText == null ? ['Legacy index or tool policy retains an excerpt only; rescan visible text before claiming completeness.'] : []),
      ...(status === 'missing' || status === 'changed_since_index' ? [`Source ${status}; this is retained indexed history, not a fresh read of the original log.`] : []),
    ],
  };
}

export function registerMessageEvidenceRoutes(app: Hono, store: Store): void {
  for (const action of ['search', 'read'] as const) {
    app.get(`/api/messages/${action}`, (c) => {
      try {
        const args: Record<string, unknown> = { ...c.req.query() };
        if (args.source_ref !== undefined) {
          try { args.source_ref = JSON.parse(args.source_ref as string); }
          catch { throw new MessageEvidenceError('INVALID_ARGUMENT', 'source_ref must be JSON'); }
        }
        return c.json(action === 'search' ? searchMessageEvidence(store, args) : readMessageEvidence(store, args));
      } catch (error) {
        if (error instanceof MessageEvidenceError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
        throw error;
      }
    });
  }
}
