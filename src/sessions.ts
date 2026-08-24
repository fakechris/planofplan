/**
 * Session catalog — WG-M3.
 *
 * Discovers local agent session files, reads only the file head for cwd/title,
 * and upserts `sessions` rows. Token totals are filled from usage_records.
 * L0 files are never copied. See docs/work-graph-design.md.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Store } from './db.ts';
import { buildWorkGraph } from './graph.ts';
import { repoRefOf, sessionProjectNames } from './repos.ts';
import { attachRepos, extractSessionRepos, TOUCH_BYTES } from './session-repos.ts';
import { messagesFromRecord, messagesFromZcodeDb } from './transcript.ts';
import { touchesFromRecord } from './file-touches.ts';
import { collectSessionCommits } from './commit-attribution.ts';
import { applyHerdrOrigin, backfillSessionOrigins, classifyCodexMeta, classifySessionPath } from './session-origin.ts';
import type { SessionCommit, SessionIndexState, SessionList, SessionRecord, SessionRepo } from './types.ts';

/** Subset of usage collect options — kept here to avoid a usage.ts cycle. */
export interface SessionCollectOptions {
  since?: number;
  until?: number;
  codexRoot?: string;
  claudeRoots?: string[];
  droidRoot?: string;
  zcodeRoot?: string;
  kimiRoot?: string;
  grokRoot?: string;
  dshRoot?: string;
}

const DAY_MS = 86_400_000;
const HEAD_BYTES = 256 * 1024;
const ZSTD_MAX_BYTES = 8 * 1024 * 1024;
const SHORT_ACK_MAX = 12;
const TITLE_MAX = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl(?:\.zst)?$/i;
// claude subagent transcript:<proj>/<uuid>/subagents/agent-*.jsonl(文件名不是
// UUID,所以早期发现和标题提取把它们漏了,只能靠 usage stub 入库、无标题)
const CLAUDE_SUBAGENT_RE = /^agent-[\w-]+\.jsonl$/i;

/** claude 文件名是否可入目录:主会话 UUID 或 subagents/ 下的 agent-*.jsonl。 */
function isClaudeSessionFile(name: string, path: string): boolean {
  if (!name.endsWith('.jsonl')) return false;
  if (UUID_RE.test(name.replace(/\.jsonl$/i, ''))) return true;
  return CLAUDE_SUBAGENT_RE.test(name) && path.includes('/subagents/');
}

const USAGE_PROVIDER_ALIAS: Record<string, string> = {
  'grok-cli': 'grok',
  'kimi-cli': 'kimi',
};

export const CATALOG_PROVIDERS = ['claude', 'codex', 'grok', 'dsh', 'kimi', 'zcode', 'factory'] as const;
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

export function sessionKey(provider: string, nativeId: string): string {
  return `${provider}:${nativeId}`;
}

export function catalogProviderOf(usageProvider: string): string {
  return USAGE_PROVIDER_ALIAS[usageProvider] ?? usageProvider;
}

export function isShortAck(text: string): boolean {
  if (text.length >= SHORT_ACK_MAX) return false;
  return !/[。？！?!]$/.test(text);
}

export function titleify(text: string, maxLen = TITLE_MAX): string {
  const cleaned = text
    .replace(/^\s*(?:\d{1,3}[.)、]\s*|\d{1,2}\s+|[-*•]\s*)/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

export { sessionProject } from './repos.ts';

export function attachGit(session: SessionRecord): SessionRecord {
  if (!session.cwd) {
    return { ...session, gitRoot: session.gitRoot ?? null, gitUrl: session.gitUrl ?? null, gitName: session.gitName ?? null };
  }
  const repo = repoRefOf(session.cwd);
  if (!repo) {
    return { ...session, gitRoot: null, gitUrl: null, gitName: null };
  }
  return { ...session, gitRoot: repo.root, gitUrl: repo.url, gitName: repo.name };
}

export function searchSessions(sessions: SessionRecord[], query: string): SessionRecord[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return sessions;
  return sessions.filter((session) => {
    const hay = [
      session.title,
      session.cwd,
      session.gitName,
      session.gitRoot,
      session.gitUrl,
      session.provider,
      session.nativeId,
      ...(session.repos ?? []).flatMap((repo) => [repo.name, repo.root, repo.url, repo.role]),
    ].filter(Boolean).join('\n').toLowerCase();
    return tokens.every((token) => hay.includes(token));
  });
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

function readHeadText(path: string): string {
  if (path.endsWith('.jsonl.zstd') || path.endsWith('.jsonl.zst')) return readZstdHead(path);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function readZstdHead(path: string): string {
  try {
    const zstd = process.env.ZSTD_PATH?.trim()
      || (existsSync('/opt/homebrew/bin/zstd') ? '/opt/homebrew/bin/zstd' : 'zstd');
    const output = execFileSync(zstd, ['-dc', path], {
      encoding: 'utf8',
      maxBuffer: ZSTD_MAX_BYTES,
    });
    return output.slice(0, HEAD_BYTES);
  } catch {
    return '';
  }
}

function parseJsonlHead(path: string): Record<string, unknown>[] {
  const raw = readHeadText(path);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  if (!raw.endsWith('\n') && lines.length > 0) lines.pop();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object') records.push(value as Record<string, unknown>);
    } catch {
      /* truncated or malformed head line */
    }
  }
  return records;
}

function walkFiles(root: string, since: number, match: (name: string, path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  try {
    if (statSync(root).isFile()) return match(basename(root), root) ? [root] : [];
  } catch {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && match(entry.name, path)) {
        try {
          if (statSync(path).mtimeMs >= since - 2 * DAY_MS) files.push(path);
        } catch {
          /* rotated */
        }
      }
    }
  };
  visit(root);
  return files.sort();
}

function claudeTitle(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (record.type !== 'user') continue;
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : record;
    const text = textOf(message.content).trim();
    if (!text || isShortAck(text)) continue;
    if (text.startsWith('<command-') || text.startsWith('<local-command') || text.startsWith('[')) continue;
    const titled = titleify(text);
    if (titled) return titled;
  }
  return null;
}

function claudeCwd(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    for (const key of ['cwd', 'workspaceDir', 'gitRoot']) {
      const value = record[key];
      if (typeof value === 'string' && value.startsWith('/')) return value;
    }
    const git = record.gitBranch ?? record.git;
    if (git && typeof git === 'object') {
      const cwd = (git as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
    }
  }
  return null;
}

function extractClaude(path: string, mtimeMs: number): SessionRecord | null {
  const nativeId = basename(path).replace(/\.jsonl$/i, '');
  // 主会话文件名是 UUID;subagent 是 subagents/ 下的 agent-*(origin 由路径判定)
  const isSubagent = path.includes('/subagents/') && CLAUDE_SUBAGENT_RE.test(basename(path));
  if (!UUID_RE.test(nativeId) && !isSubagent) return null;
  const records = parseJsonlHead(path);
  const started = records
    .map((record) => parseTimestamp(record.timestamp, 0))
    .filter((value) => value > 0);
  return {
    id: sessionKey('claude', nativeId),
    provider: 'claude',
    nativeId,
    cwd: claudeCwd(records),
    title: claudeTitle(records),
    sourceFile: path,
    startedAt: started.length ? Math.min(...started) : null,
    updatedAt: mtimeMs,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    // subagent transcript 布局:<proj>/<uuid>/subagents/agent-*.jsonl
    ...(classifySessionPath('claude', path) ?? {}),
    seenAt: Date.now(),
  };
}

function extractCodex(path: string, mtimeMs: number): SessionRecord | null {
  const fromName = CODEX_ROLLOUT_RE.exec(basename(path))?.[1] ?? null;
  const records = parseJsonlHead(path);
  let nativeId = fromName;
  let cwd: string | null = null;
  let startedAt: number | null = null;
  let title: string | null = null;
  let origin: SessionRecord['origin'];
  let parentId: string | null = null;
  for (const record of records) {
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, unknown>
      : null;
    if (record.type === 'session_meta' && payload) {
      const id = payload.id ?? payload.session_id;
      if (typeof id === 'string') nativeId = id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      startedAt = parseTimestamp(payload.timestamp ?? record.timestamp, mtimeMs);
      // originator/source 判定 session 来源;plain user 返回 null 不动既有值
      const tag = classifyCodexMeta(payload);
      if (tag) {
        origin = tag.origin;
        parentId = tag.parentId ?? null;
      }
    }
    if (!title && record.type === 'response_item' && payload) {
      const role = payload.role;
      if (role === 'user') {
        const text = titleify(textOf(payload.content));
        if (text && !isShortAck(text)) title = text;
      }
    }
  }
  if (!nativeId) return null;
  // 同一 session 拆成多个 rollout 文件时,续写文件的 thread_spawn 可能回指自身 id
  if (parentId && parentId === sessionKey('codex', nativeId)) parentId = null;
  return {
    id: sessionKey('codex', nativeId),
    provider: 'codex',
    nativeId,
    cwd,
    title,
    sourceFile: path,
    startedAt,
    updatedAt: mtimeMs,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    origin,
    parentId,
    seenAt: Date.now(),
  };
}

function extractDsh(path: string, mtimeMs: number): SessionRecord | null {
  const records = parseJsonlHead(path);
  const header = records.find((record) => record.type === 'session');
  const nativeId = typeof header?.id === 'string'
    ? header.id
    : basename(dirname(path));
  if (!nativeId) return null;
  let title: string | null = null;
  for (const record of records) {
    if (record.type !== 'user/message') continue;
    const data = record.data && typeof record.data === 'object'
      ? record.data as Record<string, unknown>
      : {};
    const source = data.source && typeof data.source === 'object'
      ? data.source as { kind?: unknown }
      : {};
    if (source.kind && source.kind !== 'user') continue;
    const text = titleify(textOf(data.content));
    if (text && !isShortAck(text)) {
      title = text;
      break;
    }
  }
  return {
    id: sessionKey('dsh', nativeId),
    provider: 'dsh',
    nativeId,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    title,
    sourceFile: path,
    startedAt: header ? parseTimestamp(header.createdAt ?? header.time, mtimeMs) : null,
    updatedAt: mtimeMs,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  };
}

function extractGrokSummary(path: string, mtimeMs: number): SessionRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;
  const info = doc.info && typeof doc.info === 'object' ? doc.info as Record<string, unknown> : {};
  const nativeId = typeof info.id === 'string' ? info.id : basename(dirname(path));
  if (!nativeId) return null;
  const titleSource = typeof doc.generated_title === 'string' && doc.generated_title.trim()
    ? doc.generated_title
    : typeof doc.session_summary === 'string' ? doc.session_summary : '';
  return {
    id: sessionKey('grok', nativeId),
    provider: 'grok',
    nativeId,
    cwd: typeof info.cwd === 'string' ? info.cwd : null,
    title: titleify(titleSource) || null,
    sourceFile: path,
    startedAt: parseTimestamp(doc.created_at, mtimeMs),
    updatedAt: parseTimestamp(doc.updated_at ?? doc.last_active_at, mtimeMs),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  };
}

function extractKimiState(path: string, mtimeMs: number): SessionRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;
  const nativeId = typeof doc.id === 'string' ? doc.id : basename(dirname(path));
  if (!nativeId) return null;
  const titleSource = typeof doc.title === 'string' && doc.title.trim()
    ? doc.title
    : typeof doc.lastPrompt === 'string' ? doc.lastPrompt : '';
  return {
    id: sessionKey('kimi', nativeId),
    provider: 'kimi',
    nativeId,
    cwd: typeof doc.cwd === 'string' ? doc.cwd : null,
    title: titleify(titleSource) || null,
    sourceFile: path,
    startedAt: parseTimestamp(doc.createdAt, mtimeMs),
    updatedAt: parseTimestamp(doc.updatedAt, mtimeMs),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  };
}

function extractFactory(path: string, mtimeMs: number): SessionRecord | null {
  if (path.endsWith('.settings.json') || path.endsWith('.bak')) return null;
  const records = parseJsonlHead(path);
  const start = records.find((record) => record.type === 'session_start');
  const nativeId = typeof start?.id === 'string' ? start.id : basename(path).replace(/\.jsonl$/i, '');
  if (!nativeId) return null;
  return {
    id: sessionKey('factory', nativeId),
    provider: 'factory',
    nativeId,
    cwd: typeof start?.cwd === 'string' ? start.cwd : null,
    title: typeof start?.title === 'string' ? titleify(start.title) || null : null,
    sourceFile: path,
    startedAt: parseTimestamp(start?.timestamp, mtimeMs),
    updatedAt: mtimeMs,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  };
}

function extractZcodeDb(path: string, mtimeMs: number): SessionRecord[] {
  if (!existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query(
      `SELECT id, title, directory, path, time_created, time_updated, parent_id
       FROM session
       WHERE parent_id IS NULL OR parent_id = ''`,
    ).all() as Array<{
      id: string;
      title: string | null;
      directory: string | null;
      path: string | null;
      time_created: number;
      time_updated: number;
      parent_id: string | null;
    }>;
    return rows.map((row) => ({
      id: sessionKey('zcode', row.id),
      provider: 'zcode',
      nativeId: row.id,
      cwd: row.directory || row.path || null,
      title: titleify(row.title ?? '') || null,
      sourceFile: path,
      startedAt: row.time_created || null,
      updatedAt: row.time_updated || mtimeMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      seenAt: Date.now(),
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function extractSessionFile(provider: string, path: string, mtimeMs: number): SessionRecord | null {
  switch (provider) {
    case 'claude':
      return extractClaude(path, mtimeMs);
    case 'codex':
      return extractCodex(path, mtimeMs);
    case 'dsh':
      return extractDsh(path, mtimeMs);
    case 'grok':
      return extractGrokSummary(path, mtimeMs);
    case 'kimi':
      return extractKimiState(path, mtimeMs);
    case 'factory':
      return extractFactory(path, mtimeMs);
    default:
      return null;
  }
}

export function extractSessionRecords(provider: string, path: string, mtimeMs: number): SessionRecord[] {
  if (provider === 'zcode') return extractZcodeDb(path, mtimeMs);
  const row = extractSessionFile(provider, path, mtimeMs);
  return row ? [row] : [];
}

export interface SessionScanFile {
  provider: string;
  path: string;
  mtimeMs: number;
}

export function discoverSessionFiles(options: SessionCollectOptions, since: number): SessionScanFile[] {
  const home = homedir();
  const claudeRoots = options.claudeRoots ?? [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ].filter(Boolean);
  const grokHome = options.grokRoot ?? process.env.GROK_HOME ?? join(home, '.grok');
  const groups: Array<{ provider: string; files: string[] }> = [
    {
      provider: 'codex',
      files: walkFiles(
        options.codexRoot ?? process.env.CODEX_HOME ?? join(home, '.codex', 'sessions'),
        since,
        (name) => CODEX_ROLLOUT_RE.test(name),
      ),
    },
    ...claudeRoots.map((root) => ({
      provider: 'claude',
      files: walkFiles(root, since, (name, path) => isClaudeSessionFile(name, path)),
    })),
    {
      provider: 'dsh',
      files: walkFiles(
        options.dshRoot ?? process.env.DSH_HOME ?? join(home, '.dsh', 'sessions'),
        since,
        (name) => name === 'session.jsonl.zstd' || name === 'session.jsonl' || name.endsWith('.jsonl.zstd'),
      ),
    },
    {
      provider: 'grok',
      files: walkFiles(join(grokHome, 'sessions'), since, (name, path) => (
        name === 'summary.json' && UUID_RE.test(basename(dirname(path)))
      )),
    },
    {
      provider: 'kimi',
      files: walkFiles(
        options.kimiRoot ?? process.env.KIMI_CODE_HOME ?? join(home, '.kimi-code', 'sessions'),
        since,
        (name) => name === 'state.json',
      ),
    },
    {
      provider: 'factory',
      files: walkFiles(
        options.droidRoot ?? join(home, '.factory', 'sessions'),
        since,
        (name) => name.endsWith('.jsonl') && !name.includes('.settings.'),
      ),
    },
    {
      provider: 'zcode',
      files: (() => {
        const root = options.zcodeRoot ?? process.env.ZCODE_HOME ?? join(home, '.zcode', 'cli');
        return [join(root, 'db', 'db.sqlite'), join(root, 'db.sqlite')].filter((path) => existsSync(path));
      })(),
    },
  ];
  return groups.flatMap(({ provider, files }) => files.flatMap((path) => {
    try {
      return [{ provider, path, mtimeMs: statSync(path).mtimeMs }];
    } catch {
      return [];
    }
  }));
}

const CATALOG_YIELD_BATCH = 8;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── 消息级索引:行级续扫 ─────────────────────────────────────────
// 水位存 session_index_state(path → mtime/parsedBytes/lines/parserVersion)。
// 文件只在尾部增长时从字节偏移续读;压缩文件(zstd)无法按字节续扫,整量重解。

/** 消息抽取规则版本:改 messagesFromX / 加 touch 行为层时 +1,老水位自动失效触发全量重扫。 */
export const MESSAGE_PARSER_VERSION = 2;
const MSG_BATCH = 400;

interface StreamedLine {
  record: Record<string, unknown>;
  /** 绝对行号(1 起,跨续扫段连续)。 */
  line: number;
  /** 该行(含换行)结束处的绝对字节偏移。 */
  end: number;
}

function isCompressedLog(path: string): boolean {
  return path.endsWith('.jsonl.zstd') || path.endsWith('.jsonl.zst');
}

/** 消息索引实际读的路径:kimi/grok 的目录文件重定向到正文日志。 */
function messageReadPath(provider: string, path: string): string {
  if (provider === 'grok' && path.endsWith('summary.json')) {
    const chat = join(dirname(path), 'chat_history.jsonl');
    if (existsSync(chat)) return chat;
  }
  if (provider === 'kimi' && path.endsWith('state.json')) {
    const wire = join(dirname(path), 'agents', 'main', 'wire.jsonl');
    if (existsSync(wire)) return wire;
  }
  return path;
}

/**
 * 从 fromBytes(必须落在行边界,水位由本函数产出保证)流式读 JSONL,
 * 只消费以 \n 结尾的完整行;末尾残行留给下次。批回调里写库。
 */
function streamJsonlFrom(
  path: string,
  fromBytes: number,
  baseLines: number,
  onBatch: (lines: StreamedLine[]) => void,
): { parsedBytes: number; lines: number } {
  if (isCompressedLog(path)) {
    const raw = (() => {
      try {
        const zstd = process.env.ZSTD_PATH?.trim()
          || (existsSync('/opt/homebrew/bin/zstd') ? '/opt/homebrew/bin/zstd' : 'zstd');
        return execFileSync(zstd, ['-dc', path], { encoding: 'utf8', maxBuffer: ZSTD_MAX_BYTES });
      } catch {
        return '';
      }
    })();
    let lines = 0;
    let batch: StreamedLine[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === 'object') {
          batch.push({ record: value as Record<string, unknown>, line: baseLines + lines, end: 0 });
        }
      } catch {
        /* truncated or malformed line */
      }
      if (batch.length >= MSG_BATCH) {
        onBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) onBatch(batch);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      /* rotated */
    }
    // 压缩文件的字节水位没有意义:记成文件大小,后续只要 mtime 变就整量重扫
    return { parsedBytes: size, lines };
  }

  let fd: number | null = null;
  let parsedBytes = fromBytes;
  let lines = 0;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    let pos = Math.min(fromBytes, size);
    let remainder = '';
    let batch: StreamedLine[] = [];
    const buf = Buffer.alloc(256 * 1024);
    let n = 0;
    while ((n = readSync(fd, buf, 0, buf.length, pos)) > 0) {
      pos += n;
      const chunk = remainder + buf.toString('utf8', 0, n);
      const parts = chunk.split('\n');
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        const end = parsedBytes + Buffer.byteLength(line, 'utf8') + 1;
        parsedBytes = end;
        lines += 1;
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as unknown;
          if (value && typeof value === 'object') {
            batch.push({ record: value as Record<string, unknown>, line: baseLines + lines, end });
          }
        } catch {
          /* truncated or malformed line */
        }
      }
      if (batch.length >= MSG_BATCH) {
        onBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) onBatch(batch);
  } catch {
    /* unreadable */
  } finally {
    if (fd != null) closeSync(fd);
  }
  return { parsedBytes, lines };
}

/** 增量合并:已有 repo 优先,新发现的 touch/commit 追加(按 role+url 去重)。 */
function mergeSessionRepos(existing: SessionRepo[], fresh: SessionRepo[]): SessionRepo[] {
  const seen = new Set(existing.map((repo) => `${repo.role} ${repo.url}`));
  const merged = [...existing];
  for (const repo of fresh) {
    const key = `${repo.role} ${repo.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(repo);
  }
  return merged;
}

/**
 * 变动文件的消息级索引:一次流式 parse 同时喂消息行(写 session_messages)
 * 和 repo touch 提取(records 保留前 TOUCH_BYTES,与旧行为一致)。
 * 返回该 session 最终的 repos。
 */
function indexSessionFileMessages(
  store: Store,
  session: SessionRecord,
  readPath: string,
  readMtimeMs: number,
  readSize: number,
  state: SessionIndexState | null,
): SessionRepo[] {
  const canAppend = state != null
    && state.parserVersion === MESSAGE_PARSER_VERSION
    && !isCompressedLog(readPath)
    && state.parsedBytes > 0
    && readSize >= state.size
    && readSize > state.parsedBytes;
  const baseLines = canAppend && state ? state.lines : 0;
  const repoRecords: unknown[] = [];
  // 整个文件的消息/touch 写入包在一个事务里:WAL 下每次 COMMIT 都是一次 fsync,
  // 按批提交会把活跃 session 的续扫拖慢一个数量级
  store.withTransaction(() => {
    if (!canAppend) {
      store.deleteSessionMessages(session.id);
      store.deleteSessionTouches(session.id);
    }
    const r = streamJsonlFrom(readPath, canAppend && state ? state.parsedBytes : 0, baseLines, (lines) => {
      const messages = lines.flatMap(({ record, line }) => (
        messagesFromRecord(session.provider, session.id, record, line)
      ));
      // 同趟 parse 顺手产出文件 touch(从原始入参对象取,不受 text 截断影响)
      const touches = lines.flatMap(({ record, line }) => (
        touchesFromRecord(session.provider, session.id, record, line, session.cwd)
      ));
      try {
        store.upsertSessionMessages(messages);
        store.upsertSessionTouches(touches);
      } catch {
        /* 单批写入失败不拖垮整趟目录扫描 */
      }
      for (const { record, end } of lines) {
        if (end > TOUCH_BYTES && !isCompressedLog(readPath)) continue;
        repoRecords.push(record);
      }
    });
    store.upsertSessionIndexState({
      path: readPath,
      mtimeMs: readMtimeMs,
      size: readSize,
      parsedBytes: r.parsedBytes,
      lines: baseLines + r.lines,
      parserVersion: MESSAGE_PARSER_VERSION,
    });
    return r;
  });
  const fresh = extractSessionRepos(session, { records: repoRecords });
  return canAppend
    ? mergeSessionRepos(store.listSessionRepos(session.id), fresh)
    : fresh;
}

export async function collectSessionCatalog(store: Store, options: SessionCollectOptions = {}): Promise<number> {
  const since = options.since ?? Date.now() - 30 * DAY_MS;
  const until = options.until ?? Date.now();
  const discovered = discoverSessionFiles(options, since);

  // 增量两道闸:目录行按 seenAt 复用(跳过 head 解析);消息级按
  // session_index_state 水位,mtime 未变整体跳过,文件尾部增长则从字节偏移
  // 续扫(只 parse 新增行),截断/轮换/解析器版本变了才全量重扫。
  // zcode 的 db.sqlite 有 WAL,主文件 mtime 不可信,总是重扫(part id 稳定,
  // 消息 upsert 幂等)。
  const existingByFile = new Map<string, SessionRecord[]>();
  for (const row of store.listSessionRows()) {
    if (!row.sourceFile) continue;
    const list = existingByFile.get(row.sourceFile) ?? [];
    list.push(row);
    existingByFile.set(row.sourceFile, list);
  }

  const rows: SessionRecord[] = [];
  let processed = 0;
  let scanned = 0;
  for (const file of discovered) {
    const existingRows = existingByFile.get(file.path);
    const latestSeen = existingRows?.reduce((max, row) => Math.max(max, row.seenAt), 0) ?? 0;
    // 消息级水位:kimi/grok 的正文在重定向文件里,mtime 以实际读取路径为准
    const readPath = messageReadPath(file.provider, file.path);
    let readMtimeMs = file.mtimeMs;
    let readSize = 0;
    try {
      const readStat = statSync(readPath);
      readMtimeMs = readStat.mtimeMs;
      readSize = readStat.size;
    } catch {
      /* 正文文件不存在(如 kimi 尚无 wire.jsonl):只落目录元数据 */
    }
    const state = file.provider === 'zcode' ? null : store.getSessionIndexState(readPath);
    // mtime 同毫秒可能撞车（测试和快速重写都撞过），新鲜度必须 mtime + size 双等
    const indexFresh = state != null
      && state.parserVersion === MESSAGE_PARSER_VERSION
      && state.mtimeMs >= readMtimeMs
      && state.size === readSize
      && readSize > 0;
    if (file.provider !== 'zcode' && existingRows && latestSeen >= file.mtimeMs && indexFresh) {
      rows.push(...existingRows);
      continue;
    }
    scanned += 1;
    for (const row of extractSessionRecords(file.provider, file.path, file.mtimeMs)) {
      const withWork = attachGit(row);
      let repos: SessionRepo[];
      if (file.provider === 'zcode') {
        // zcode 正文在其自有 sqlite:part id 稳定,upsert 幂等,维持"总是重扫"
        try {
          store.upsertSessionMessages(messagesFromZcodeDb(file.path, row.nativeId, row.id));
        } catch {
          /* 单个 session 的消息抽取失败不拖垮目录 */
        }
        repos = extractSessionRepos(withWork);
      } else if (indexFresh) {
        // 文件级水位新鲜但目录行没命中(典型:codex 同一 session 续写出多个
        // rollout 文件,source_file 只能指一个)。消息已按水位索引过,目录行
        // 照常 upsert,repos 复用已存的,不做全量重扫。
        repos = store.listSessionRepos(row.id);
      } else if (readSize > 0) {
        repos = indexSessionFileMessages(store, withWork, readPath, readMtimeMs, readSize, state);
      } else {
        repos = extractSessionRepos(withWork);
      }
      rows.push(attachRepos(withWork, repos));
    }
    processed += 1;
    if (processed % CATALOG_YIELD_BATCH === 0) await yieldEventLoop();
  }
  store.upsertSessions(rows);
  for (const row of rows) store.replaceSessionRepos(row.id, row.repos ?? []);
  store.upsertSessions(sessionStubsFromUsage(store, since, until, new Set(rows.map((row) => row.id))));
  // 清理:源文件已被删除/轮换的 session,连同消息索引和 repo 归属一起删
  for (const row of store.listSessionRows()) {
    if (!row.sourceFile) continue;
    if (!(CATALOG_PROVIDERS as readonly string[]).includes(row.provider)) continue;
    if (!existsSync(row.sourceFile)) store.deleteSession(row.id);
  }
  applySessionUsage(store, since, until);
  // commit 归因(第二环):有界 git 调用(每 repo 一次 git log + timeout),
  // 失败不拖垮目录扫描
  try {
    await collectSessionCommits(store, { since, until });
  } catch {
    /* commit attribution is best-effort */
  }
  // origin 归因:一次性 backfill(user_version 2→3,重读 codex 文件头 +
  // claude 路径判断)+ 每轮 herdr 升级。单文件读、有界,失败不拖垮目录
  try {
    backfillSessionOrigins(store);
    applyHerdrOrigin(store);
  } catch {
    /* origin attribution is best-effort */
  }
  return scanned;
}

function sessionStubsFromUsage(
  store: Store,
  since: number,
  until: number,
  knownIds: Set<string>,
): SessionRecord[] {
  const stubs = new Map<string, SessionRecord>();
  for (const record of store.getUsageRecords(since, until)) {
    if (record.source !== 'local' || !record.sessionId) continue;
    const provider = catalogProviderOf(record.provider);
    const id = sessionKey(provider, record.sessionId);
    if (knownIds.has(id)) continue;
    const existing = stubs.get(id);
    const updatedAt = Math.max(existing?.updatedAt ?? 0, record.timestamp);
    const startedAt = Math.min(existing?.startedAt ?? record.timestamp, record.timestamp);
    stubs.set(id, attachGit({
      id,
      provider,
      nativeId: record.sessionId,
      cwd: existing?.cwd ?? record.project ?? null,
      title: existing?.title ?? null,
      sourceFile: existing?.sourceFile ?? record.sourceFile ?? null,
      startedAt,
      updatedAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      seenAt: Date.now(),
    }));
  }
  return [...stubs.values()];
}

interface TokenAgg {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

function addAgg(map: Map<string, TokenAgg>, key: string, record: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}): void {
  const cur = map.get(key) ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
  };
  cur.inputTokens += record.inputTokens;
  cur.outputTokens += record.outputTokens;
  cur.totalTokens += record.totalTokens;
  if (record.estimatedCostUsd != null) {
    cur.estimatedCostUsd = (cur.estimatedCostUsd ?? 0) + record.estimatedCostUsd;
  }
  map.set(key, cur);
}

function applySessionUsage(store: Store, since: number, until: number): void {
  const byId = new Map<string, TokenAgg>();
  const byFile = new Map<string, TokenAgg>();
  for (const record of store.getUsageRecords(since, until)) {
    if (record.source !== 'local') continue;
    const provider = catalogProviderOf(record.provider);
    if (record.sessionId) addAgg(byId, sessionKey(provider, record.sessionId), record);
    if (record.sourceFile) addAgg(byFile, record.sourceFile, record);
  }
  const patches: Array<{
    id: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  }> = [];
  for (const session of store.listSessionRows()) {
    const agg = byId.get(session.id)
      ?? (session.sourceFile ? byFile.get(session.sourceFile) : undefined);
    if (!agg) continue;
    patches.push({
      id: session.id,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      estimatedCostUsd: agg.estimatedCostUsd,
    });
  }
  store.updateSessionTokens(patches);
}

export function buildSessionList(
  sessions: SessionRecord[],
  options: {
    since: number;
    until: number;
    generatedAt?: number;
    requirements?: Map<string, string>;
    commits?: SessionCommit[];
    /** true 时图谱包含 subagent 派工 session(默认排除,见其「需求」是派工 prompt)。 */
    includeSubagents?: boolean;
  },
): SessionList {
  const inWindow = sessions.filter((session) => (
    session.updatedAt >= options.since && session.updatedAt < options.until
  ));
  const byProvider = new Map<string, number>();
  const byProject = new Map<string, number>();
  for (const session of inWindow) {
    byProvider.set(session.provider, (byProvider.get(session.provider) ?? 0) + 1);
    for (const project of sessionProjectNames(session)) {
      byProject.set(project, (byProject.get(project) ?? 0) + 1);
    }
  }
  const sorted = inWindow.sort((a, b) => b.updatedAt - a.updatedAt);
  let indexedAt: number | null = null;
  for (const session of sessions) {
    if (indexedAt == null || session.seenAt > indexedAt) indexedAt = session.seenAt;
  }
  return {
    generatedAt: options.generatedAt ?? Date.now(),
    since: options.since,
    until: options.until,
    sessions: sorted,
    byProvider: [...byProvider.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider)),
    byProject: [...byProject.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project)),
    graph: buildWorkGraph(sorted, options.requirements, options.commits, options.includeSubagents ?? false),
    indexedAt,
    indexStatus: 'idle',
  };
}
