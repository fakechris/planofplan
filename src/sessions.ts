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
import type { Store } from './db.ts';
import type { SessionList, SessionRecord } from './types.ts';

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

function projectName(cwd: string | null): string {
  if (!cwd) return '(unknown)';
  const base = basename(cwd.replace(/[/\\]+$/, ''));
  return base || cwd;
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
  if (!UUID_RE.test(nativeId)) return null;
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
  for (const record of records) {
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, unknown>
      : null;
    if (record.type === 'session_meta' && payload) {
      const id = payload.id ?? payload.session_id;
      if (typeof id === 'string') nativeId = id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      startedAt = parseTimestamp(payload.timestamp ?? record.timestamp, mtimeMs);
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
      files: walkFiles(root, since, (name) => name.endsWith('.jsonl') && UUID_RE.test(name.replace(/\.jsonl$/i, ''))),
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
  ];
  return groups.flatMap(({ provider, files }) => files.flatMap((path) => {
    try {
      return [{ provider, path, mtimeMs: statSync(path).mtimeMs }];
    } catch {
      return [];
    }
  }));
}

export function collectSessionCatalog(store: Store, options: SessionCollectOptions = {}): number {
  const since = options.since ?? Date.now() - 30 * DAY_MS;
  const until = options.until ?? Date.now();
  const discovered = discoverSessionFiles(options, since);
  const rows: SessionRecord[] = [];
  for (const file of discovered) {
    const row = extractSessionFile(file.provider, file.path, file.mtimeMs);
    if (row) rows.push(row);
  }
  store.upsertSessions(rows);
  store.upsertSessions(sessionStubsFromUsage(store, since, until, new Set(rows.map((row) => row.id))));
  applySessionUsage(store, since, until);
  return rows.length;
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
    stubs.set(id, {
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
    });
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
  options: { since: number; until: number; generatedAt?: number },
): SessionList {
  const inWindow = sessions.filter((session) => (
    session.updatedAt >= options.since && session.updatedAt < options.until
  ));
  const byProvider = new Map<string, number>();
  const byProject = new Map<string, number>();
  for (const session of inWindow) {
    byProvider.set(session.provider, (byProvider.get(session.provider) ?? 0) + 1);
    const project = projectName(session.cwd);
    byProject.set(project, (byProject.get(project) ?? 0) + 1);
  }
  let indexedAt: number | null = null;
  for (const session of sessions) {
    if (indexedAt == null || session.seenAt > indexedAt) indexedAt = session.seenAt;
  }
  return {
    generatedAt: options.generatedAt ?? Date.now(),
    since: options.since,
    until: options.until,
    sessions: inWindow.sort((a, b) => b.updatedAt - a.updatedAt),
    byProvider: [...byProvider.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider)),
    byProject: [...byProject.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project)),
    indexedAt,
    indexStatus: 'idle',
  };
}
