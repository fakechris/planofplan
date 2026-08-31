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
import { messagesFromRecord, messagesFromZcodeDb, isClaudeMetaRecord, isClaudeCompactSummary, isCodexMetaUserText } from './transcript.ts';
import { touchesFromRecord } from './file-touches.ts';
import { commitWitnessesFromRecord, commitWitnessesFromZcodeDb, type WitnessPairing } from './commit-witness.ts';
import { collectSessionCommits } from './commit-attribution.ts';
import {
  applyHerdrOrigin,
  backfillDshFactoryOrigins,
  backfillSessionOrigins,
  classifyCodexMeta,
  classifyDshHeader,
  classifyFactoryStart,
  classifySessionPath,
} from './session-origin.ts';
import { claudeParentOfPath, materializeSessionLinks } from './session-links.ts';
import { materializeRequirements } from './requirements.ts';
import { refineRequirements } from './requirement-llm.ts';
import { loadConfig } from './config.ts';
import { materializePlanFiles, materializeProgressNotes, materializeTodoSnapshots } from './plans.ts';
import type { SessionCommit, SessionIndexState, SessionList, SessionRecord, SessionRepo } from './types.ts';
import { extractAntigravitySession, antigravityTranscriptPath } from './antigravity-session.ts';

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
  antigravityRoot?: string;
  /** 消息/touch/水位保留天数(目录行永久保留);0 = 关闭清理。默认取 PLANOFPLAN_MESSAGE_RETENTION_DAYS 或 60。 */
  messageRetentionDays?: number;
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

export const CATALOG_PROVIDERS = ['claude', 'codex', 'grok', 'dsh', 'kimi', 'zcode', 'factory', 'antigravity'] as const;
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
  // 官方 AI 标题最优先:claude 自己起的 slug,比首条用户消息启发式准
  for (const record of records) {
    if (record.type !== 'ai-title') continue;
    const aiTitle = typeof record.aiTitle === 'string' ? record.aiTitle.trim() : '';
    if (aiTitle) return titleify(aiTitle);
  }
  for (const record of records) {
    if (record.type !== 'user') continue;
    if (isClaudeMetaRecord(record)) continue;
    // compact 续跑摘要当标题 = 截断的英文摘要,比无标题更糟
    if (isClaudeCompactSummary(record)) continue;
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
    // Launch 边:父 session id 也在路径上(顶层 subagents/ 形态返回 null)
    parentId: claudeParentOfPath(path),
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
        if (text && !isShortAck(text) && !isCodexMetaUserText(textOf(payload.content))) title = text;
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
    // 头部自带 declared 级标记:origin:'subagent' + parentSession
    ...(classifyDshHeader(header) ?? {}),
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
    // Worker 子会话:callingSessionId = 发起它的 droid session
    ...(classifyFactoryStart(start) ?? {}),
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
  if (provider === 'antigravity') {
    const transcript = antigravityTranscriptPath(path, dirname(path));
    const row = extractAntigravitySession(path, transcript, mtimeMs);
    return row ? [row] : [];
  }
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
    {
      provider: 'antigravity',
      files: walkFiles(
        options.antigravityRoot ?? process.env.ANTIGRAVITY_HOME ?? join(home, '.gemini', 'antigravity', 'conversations'),
        since,
        (name) => UUID_RE.test(name.replace(/\.db$/i, '')),
      ),
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

/** watcher 用:catalog 扫描涉及的全部根目录(去重)。根的推导必须与 discoverSessionFiles 保持同源。 */
export function sessionWatchRoots(): string[] {
  const home = homedir();
  const claudeRoots = [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ].filter(Boolean);
  const grokHome = process.env.GROK_HOME ?? join(home, '.grok');
  return [...new Set([
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(home, '.codex', 'sessions'),
    ...claudeRoots,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(home, '.dsh', 'sessions'),
    join(grokHome, 'sessions'),
    process.env.KIMI_CODE_HOME ? join(process.env.KIMI_CODE_HOME, 'sessions') : join(home, '.kimi-code', 'sessions'),
    join(home, '.factory', 'sessions'),
    process.env.ZCODE_HOME ?? join(home, '.zcode', 'cli'),
  ])];
}

// ── 标题补充源(官方优先于启发式) ────────────────────────────────────
// codex 的 session_index.jsonl 与 claude 的 history.jsonl 都是 harness 自己
// 落盘的轻量元数据:不读 rollout 正文就能拿到官方线程名/首条用户输入。

/** codex 官方线程名(<codex home>/session_index.jsonl):id → thread_name。百行量级,整读。 */
function readCodexIndexTitles(options: SessionCollectOptions): Map<string, string> {
  const sessionsRoot = options.codexRoot ?? process.env.CODEX_HOME ?? join(homedir(), '.codex', 'sessions');
  const map = new Map<string, string>();
  try {
    const raw = readFileSync(join(dirname(sessionsRoot), 'session_index.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof entry.id !== 'string' || typeof entry.thread_name !== 'string') continue;
        const title = titleify(entry.thread_name);
        if (title) map.set(entry.id, title);
      } catch {
        /* 脏行跳过 */
      }
    }
  } catch {
    /* 无索引文件:标题走启发式 */
  }
  return map;
}

/**
 * claude history.jsonl(<config>/history.jsonl):sessionId → 首条真实用户输入。
 * 只兜底无标题 session;信封/斜杠命令/短确认与 claudeTitle 同规则过滤。
 * 2MB 量级整读,每轮 catalog 一次,几十毫秒内。
 */
function readClaudeHistoryTitles(options: SessionCollectOptions): Map<string, string> {
  const claudeRoots = options.claudeRoots ?? [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(homedir(), '.config', 'claude', 'projects'),
    join(homedir(), '.claude', 'projects'),
  ].filter(Boolean);
  const map = new Map<string, string>();
  for (const root of claudeRoots) {
    try {
      const raw = readFileSync(join(dirname(root), 'history.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { sessionId?: unknown; display?: unknown };
          if (typeof entry.sessionId !== 'string' || map.has(entry.sessionId)) continue;
          const text = typeof entry.display === 'string' ? entry.display.trim() : '';
          if (!text || isShortAck(text) || text.startsWith('/')) continue;
          if (text.startsWith('<command-') || text.startsWith('<local-command') || text.startsWith('[')) continue;
          const title = titleify(text);
          if (title) map.set(entry.sessionId, title);
        } catch {
          /* 脏行跳过 */
        }
      }
    } catch {
      /* 无 history 文件:跳过该根 */
    }
  }
  return map;
}

const CATALOG_YIELD_BATCH = 8;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── 消息级索引:行级续扫 ─────────────────────────────────────────
// 水位存 session_index_state(path → mtime/parsedBytes/lines/parserVersion)。
// 文件只在尾部增长时从字节偏移续读;压缩文件(zstd)无法按字节续扫,整量重解。

/** 消息抽取规则版本:改 messagesFromX / 加 touch 行为层时 +1,老水位自动失效触发全量重扫。 */
// v3:claude isMeta 记录与 codex 系统信封不再进消息索引;标题来源多元化
// (ai-title / history.jsonl / session_index.jsonl),全量重扫顺带刷新全部标题。
// v4:claude isCompactSummary 续跑摘要重分类为 kind='summary'/role='system'
// (可搜、不进需求抽取与标题),需求物化在下一轮 collect 自动自愈。
// v5:commit witness 提取(git commit 的 tool_result sha 目击)——全量重扫
// 把历史存量的目击证据一次性挖出来(回溯红利是这层的核心价值)。
// v6:witness 命令识别修多行 -m 与包装词,重扫补齐 v5 漏掉的目击。
// v7:witness 覆盖 codex custom_tool_call(exec)形态;zcode 走独立路径随扫随提。
export const MESSAGE_PARSER_VERSION = 7;
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
  if (provider === 'antigravity' && path.endsWith('.db')) {
    const transcript = antigravityTranscriptPath(path, dirname(path));
    if (existsSync(transcript)) return transcript;
  }
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
): { repos: SessionRepo[]; aiTitle: string | null } {
  const canAppend = state != null
    && state.parserVersion === MESSAGE_PARSER_VERSION
    && !isCompressedLog(readPath)
    && state.parsedBytes > 0
    && readSize >= state.size
    && readSize > state.parsedBytes;
  const baseLines = canAppend && state ? state.lines : 0;
  const repoRecords: unknown[] = [];
  // claude 的 ai-title 记录位置不固定(可深至数千行),头部解析常漏;
  // 消息索引的全量/续扫流式读必然路过它,顺手捕获最后一条
  let aiTitle: string | null = null;
  // commit witness 的配对状态(文件级):tool_use 与 tool_result 可能跨批次
  const witnessPairing: WitnessPairing = new Map();
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
      // 同趟顺手产出 commit 目击:git commit 的 tool_result 里印着 sha
      const witnesses = lines.flatMap(({ record }) => (
        commitWitnessesFromRecord(session.provider, session.id, record, witnessPairing)
      ));
      try {
        store.upsertSessionMessages(messages);
        store.upsertSessionTouches(touches);
        store.upsertSessionCommitWitnesses(witnesses);
      } catch {
        /* 单批写入失败不拖垮整趟目录扫描 */
      }
      for (const { record, end } of lines) {
        if (session.provider === 'claude'
          && record.type === 'ai-title'
          && typeof record.aiTitle === 'string'
          && record.aiTitle.trim()) {
          aiTitle = record.aiTitle.trim();
        }
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
  const repos = canAppend
    ? mergeSessionRepos(store.listSessionRepos(session.id), fresh)
    : fresh;
  return { repos, aiTitle };
}

export async function collectSessionCatalog(store: Store, options: SessionCollectOptions = {}): Promise<number> {
  const since = options.since ?? Date.now() - 30 * DAY_MS;
  const until = options.until ?? Date.now();
  // 墓碑过滤(参照 Wake 的双键设计):用户删除的 session 不能在重建后复活。
  // 三道闸:发现层拦 file_path、行层拦 session id、stub 层拦 usage 回填;
  // 收尾再把墓碑期间漏进库的存量行清掉。
  const tombstones = store.tombstonedSessionInfo();
  const discovered = discoverSessionFiles(options, since)
    .filter((file) => !tombstones.paths.has(file.path));

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
      if (tombstones.ids.has(row.id)) continue;
      const withWork = attachGit(row);
      let repos: SessionRepo[];
      if (file.provider === 'zcode') {
        // zcode 正文在其自有 sqlite:part id 稳定,upsert 幂等,维持"总是重扫"
        try {
          store.upsertSessionMessages(messagesFromZcodeDb(file.path, row.nativeId, row.id));
          store.upsertSessionCommitWitnesses(commitWitnessesFromZcodeDb(file.path, row.nativeId, row.id));
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
        const indexed = indexSessionFileMessages(store, withWork, readPath, readMtimeMs, readSize, state);
        repos = indexed.repos;
        if (indexed.aiTitle) withWork.title = titleify(indexed.aiTitle);
      } else {
        repos = extractSessionRepos(withWork);
      }
      rows.push(attachRepos(withWork, repos));
    }
    processed += 1;
    if (processed % CATALOG_YIELD_BATCH === 0) await yieldEventLoop();
  }
  // 标题补充源,对复用行同样生效:codex 官方线程名覆盖启发式,claude history
  // 兜底无标题 session(信封开头的会话头部解析抽不出标题)
  const codexIndexTitles = readCodexIndexTitles(options);
  const claudeHistoryTitles = readClaudeHistoryTitles(options);
  for (const row of rows) {
    if (row.provider === 'codex') {
      const official = codexIndexTitles.get(row.nativeId);
      if (official) row.title = official;
    } else if (row.provider === 'claude' && !row.title) {
      const fallback = claudeHistoryTitles.get(row.nativeId);
      if (fallback) row.title = fallback;
    }
  }
  store.upsertSessions(rows);
  for (const row of rows) store.replaceSessionRepos(row.id, row.repos ?? []);
  store.upsertSessions(
    sessionStubsFromUsage(store, since, until, new Set(rows.map((row) => row.id)))
      .filter((stub) => !tombstones.ids.has(stub.id)),
  );
  // 清理:墓碑期间漏进库的行先删;源文件已被删除/轮换的 session,
  // 连同消息索引和 repo 归属一起删
  for (const row of store.listSessionRows()) {
    if (tombstones.ids.has(row.id)) {
      store.deleteSession(row.id);
      continue;
    }
    if (!row.sourceFile) continue;
    if (!(CATALOG_PROVIDERS as readonly string[]).includes(row.provider)) continue;
    if (!existsSync(row.sourceFile)) store.deleteSession(row.id);
  }
  // 库维护(有界,失败不拖垮扫描):磁盘上已不存在的孤儿水位(实测积累过
  // 359/1920 行)按存在性清理;消息按保留期裁剪,目录行永久保留。
  try {
    const statePaths = store.listSessionIndexStatePaths();
    const deadStates = statePaths.filter((path) => !existsSync(path));
    if (deadStates.length > 0) store.deleteSessionIndexStates(deadStates);
    const scanPaths = store.listUsageScanFilePaths();
    const deadScans = scanPaths.filter((path) => !existsSync(path));
    if (deadScans.length > 0) store.deleteUsageScanFiles(deadScans);
    const retentionDays = options.messageRetentionDays
      ?? Number(process.env.PLANOFPLAN_MESSAGE_RETENTION_DAYS ?? 60);
    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      store.pruneSessionDataBefore(Date.now() - retentionDays * DAY_MS);
    }
  } catch {
    /* maintenance is best-effort */
  }
  applySessionUsage(store, since, until);
  // commit 归因(第二环):有界 git 调用(每 repo 一次 git log + timeout),
  // 失败不拖垮目录扫描
  try {
    await collectSessionCommits(store, { since, until });
  } catch {
    /* commit attribution is best-effort */
  }
  // origin 归因:一次性 backfill(user_version <4 时跑,重读 codex 文件头 +
  // claude 路径判断;dsh/factory 是独立哨兵的二次 pass)+ 每轮 herdr 升级。
  // 单文件读、有界,失败不拖垮目录扫描
  try {
    backfillSessionOrigins(store);
    backfillDshFactoryOrigins(store);
    applyHerdrOrigin(store);
  } catch {
    /* origin attribution is best-effort */
  }
  // 无 git cwd 的存量会话补目录身份(新扫描由 workRepoOf 兜底;这里覆盖
  // 修复前的老行)。必须在 projects/requirements 物化之前跑。
  try {
    const home = homedir();
    const withWork = store.sessionIdsWithWorkRepo();
    const patches: Array<{ sessionId: string; role: 'work'; url: string; root: string; name: string; evidenceKind: 'observed' }> = [];
    for (const row of store.listSessionRows()) {
      if (withWork.has(row.id)) continue;
      if (!row.cwd || !row.cwd.startsWith('/') || row.cwd === home || row.cwd === '/' || row.cwd === '/tmp' || row.cwd === '/private/tmp' || row.cwd.startsWith('/var/folders/') || row.cwd.startsWith('/private/var/folders/')) continue;
      patches.push({ sessionId: row.id, role: 'work', url: row.cwd, root: row.cwd, name: basename(row.cwd), evidenceKind: 'observed' });
    }
    for (const patch of patches) store.appendSessionRepo(patch);
  } catch {
    /* cwd backfill is best-effort */
  }
  // projects 实体物化(IA 第一步):从 session_repos 增量 upsert,幂等
  try {
    store.materializeProjects();
  } catch {
    /* project materialization is best-effort */
  }
  // Launch 边物化(IA 第二步):claude parent 补链 + parent_id → 边 +
  // plugin:claude 回链,幂等
  try {
    materializeSessionLinks(store);
  } catch {
    /* launch link materialization is best-effort */
  }
  // 需求实体物化(IA 第三步):user 消息流规则抽取 + span 级项目归因,
  // 全量重导,确定性 id,幂等
  try {
    materializeRequirements(store);
    // 需求 LLM 精炼(显式 opt-in + 已配置 LLM 才生效;每轮限量,best-effort)
    try {
      const llmCfg = loadConfig().llm ?? { provider: null as never, model: null as never };
      await refineRequirements(store, llmCfg);
    } catch {
      /* refinement is best-effort */
    }
  } catch {
    /* requirement materialization is best-effort */
  }
  // 计划态物化(计划研究 §5.3):TodoWrite 消息快照(纯库内)+ plan 文件
  // 扫盘(mtime 门控,增量快照)
  try {
    materializeTodoSnapshots(store);
    materializeProgressNotes(store);
  } catch {
    /* todo snapshot materialization is best-effort */
  }
  try {
    materializePlanFiles(store);
  } catch {
    /* plan file materialization is best-effort */
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
    /** requirement 的 §1.5 origin 分级(图谱节点着色)。 */
    requirementLevels?: Map<string, string>;
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
    graph: buildWorkGraph(
      sorted,
      options.requirements,
      options.commits,
      options.includeSubagents ?? false,
      options.requirementLevels,
    ),
    indexedAt,
    indexStatus: 'idle',
  };
}
