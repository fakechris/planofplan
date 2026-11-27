/**
 * 仓库 Commit 级多 Agent 与模型归因考古引擎(INV-2195,M3)。
 *
 * 设计守则:
 * 1. L0 原生日志与目标 Git 仓库严格只读,零写入、零篡改;
 * 2. 零 LLM 调用,纯确定性本地计算;
 * 3. 证据分级不升级:hunk-matched / declared / witnessed-author /
 *    hunk-partial / write-touch / bash-write / merged-only / unattributed;
 *    `gh pr merge` 仅记 merged-only,绝不冒充代码作者;
 * 4. 增量缓存:已落 commit_provenance 且 analyzer_version 一致的 SHA 永不重算。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, readSync, readdirSync, statSync, closeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { Database } from 'bun:sqlite';
import type { Store } from './db.ts';
import type {
  CommitProvenanceAuthor,
  CommitProvenanceRecord,
  CommitProvenanceSessionHit,
  CommitProvenanceTier,
  CommitRelayKind,
  RepoHistoryReport,
  RepoHistorySummary,
} from './types.ts';
import { nameOfUrl, repoRefOf } from './repos.ts';
import { wholeMtimeMs } from './mtime.ts';

export const REPO_HISTORY_ANALYZER_VERSION = 1;

const DAY_MS = 86_400_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const SHA_RE = /^[0-9a-f]{40}$/i;
const PR_RE = /\(#(\d+)\)/;
const COMMIT_OUT_RE = /\[[^\s\]]+ (?:(?:\(root-commit\)|\(amend\)) )?([0-9a-f]{7,40})\]/g;
const TRAILER_RE = /^(Co-authored-by|Harness-Session|Amp-Thread|Generated-By|Assisted-by|Entire-Checkpoint):\s*(.+)$/gim;
const GH_PR_URL_RE = /github\.com\/[^/\s]+\/([^/\s]+)\/pull\/(\d+)/gi;
const GH_PR_MERGE_RE = /gh\s+pr\s+merge\s+(\d+)/g;
const BASH_WRITE_HINT_RE = /(?:sed\s+-i|python3|cat\s+<<|git\s+add|tee\s+)/;
const FILE_TOKEN_RE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g;

const STOP_LINES = new Set([
  '{', '}', '});', '];', ');', 'return;', 'break;', 'continue;', 'else {',
  '} else {', 'try {', '} catch {', 'export {', 'import {', '---', '```',
]);

export type RepoHistoryGitRunner = (args: string[]) => string;

export function defaultHistoryGitRunner(timeoutMs = GIT_TIMEOUT_MS): RepoHistoryGitRunner {
  return (args) => {
    const res = spawnSync('git', args, {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0 || res.error) {
      throw new Error(res.error?.message ?? res.stderr?.trim() ?? 'git failed');
    }
    return res.stdout;
  };
}

// ── 纯函数工具层 ────────────────────────────────────────────────────

export function normLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

export function isDistinctiveLine(nline: string): boolean {
  if (nline.length < 16) return false;
  if (STOP_LINES.has(nline)) return false;
  if (/^[-=|: *#/`]+$/.test(nline)) return false;
  return true;
}

/**
 * Edit(old, new) 纯增量行提取:只返回 newText 里出现、oldText 里不存在的特征行。
 * 避免未改动的上下文行被归因到后续碰过同一文件的无关会话。
 */
export function extractDeltaLines(newText: string, oldText = ''): Set<string> {
  const out = new Set<string>();
  if (!newText) return out;
  const oldSet = new Set<string>();
  if (oldText) {
    for (const line of oldText.split(/\r?\n/)) oldSet.add(normLine(line));
  }
  for (const line of newText.split(/\r?\n/)) {
    const nl = normLine(line);
    if (isDistinctiveLine(nl) && !oldSet.has(nl)) out.add(nl);
  }
  return out;
}

export function extractTrailers(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  if (!body) return out;
  TRAILER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TRAILER_RE.exec(body)) !== null) {
    const value = match[2]!.trim();
    if (value) out.push({ key: match[1]!, value });
  }
  return out;
}

export function trailerToAgent(value: string): string | null {
  const low = value.toLowerCase();
  if (low.includes('claude') || low.includes('anthropic')) return 'claude';
  if (low.includes('devin')) return 'devin';
  if (low.includes('factory-droid') || low.includes('droid')) return 'factory';
  if (low.includes('cursor')) return 'cursor';
  if (low.includes('codex') || low.includes('openai')) return 'codex';
  if (low.includes('copilot')) return 'copilot';
  if (low.includes('dependabot')) return 'dependabot';
  return null;
}

export function trailerToModel(value: string): string | null {
  const m = /Claude\s+(Opus|Sonnet|Haiku|Fable)\s+[\d.]+/i.exec(value);
  if (m) return m[0]!.toLowerCase().replace(/\s+/g, '-');
  return null;
}

export function extractPrNumber(subject: string): number | null {
  const m = PR_RE.exec(subject);
  return m ? Number(m[1]) : null;
}

export function topDirOf(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length <= 1) return '(root)';
  if (['src', 'docs', 'evals', 'packages', 'apps', 'tests', 'test', 'web'].includes(parts[0]!) && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0]!;
}

/**
 * Worktree 友好的相对路径后缀匹配:
 * agent 常在兄弟目录或 .claude/worktrees/<name> 下改文件,直接剥主仓 root 前缀会漏判。
 */
export function buildFileSuffixMatcher(relPaths: Iterable<string>): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const rel of relPaths) {
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const base = basename(rel);
    const list = byBase.get(base) ?? [];
    list.push(rel);
    byBase.set(base, list);
  }
  for (const list of byBase.values()) {
    list.sort((a, b) => b.length - a.length);
  }
  return byBase;
}

export function resolveRelPath(rawPath: string | null | undefined, byBase: Map<string, string[]>): string | null {
  if (!rawPath) return null;
  const normalized = rawPath.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  const cands = byBase.get(basename(normalized));
  if (!cands) return null;
  for (const rel of cands) {
    if (normalized === rel || normalized.endsWith(`/${rel}`)) return rel;
  }
  return null;
}

/**
 * 从 Codex `*** Begin Patch` 文本(含嵌在 custom_tool_call:exec JS 字符串内的转义形态)
 * 提取 (rawFilePath, addedDistinctiveLines)。
 */
export function extractApplyPatchWrites(text: string): Array<{ filePath: string; lines: Set<string> }> {
  if (!text || !text.includes('*** Begin Patch')) return [];
  let decoded = text;
  if (decoded.includes('\\n*** ') || decoded.includes('\\n+')) {
    decoded = decoded
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  const results: Array<{ filePath: string; lines: Set<string> }> = [];
  let curFile: string | null = null;
  let curLines = new Set<string>();
  const flush = (): void => {
    if (curFile && curLines.size > 0) results.push({ filePath: curFile, lines: curLines });
    curFile = null;
    curLines = new Set<string>();
  };
  for (const line of decoded.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Update|Add) File:\s*(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      curFile = m[1]!.trim().replace(/^["']|["']$/g, '');
      continue;
    }
    if (line.startsWith('*** End Patch') || line.startsWith('*** Delete File:') || line.startsWith('*** Move to:')) {
      flush();
      continue;
    }
    if (curFile && line.startsWith('+') && !line.startsWith('+++')) {
      const nl = normLine(line.slice(1));
      if (isDistinctiveLine(nl)) curLines.add(nl);
    }
  }
  flush();
  return results;
}

/** 读取 Factory/Droid 会话同目录 `.settings.json` 中的 model 字段。 */
export function readFactorySessionModel(jsonlPath: string): string | null {
  const settingsPath = jsonlPath.replace(/\.jsonl$/i, '.settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;
  } catch {
    return null;
  }
}

// ── Git 日志 + Diff 解析 ────────────────────────────────────────────

export interface RawCommitDiff {
  sha: string;
  authorTs: number;
  commitTs: number;
  authorName: string;
  subject: string;
  body: string;
  trailers: Array<{ key: string; value: string }>;
  prNumber: number | null;
  files: string[];
  addedByFile: Map<string, string[]>;
  totalDistLines: number;
}

const COMMIT_DELIM = '<<<POP_COMMIT>>>';
const BODY_DELIM = '<<<POP_BODYEND>>>';

export function parseGitLogWithDiffs(raw: string): RawCommitDiff[] {
  if (!raw) return [];
  const commits: RawCommitDiff[] = [];
  for (const chunk of raw.split(COMMIT_DELIM)) {
    if (!chunk.trim()) continue;
    const bodyEnd = chunk.indexOf(BODY_DELIM);
    if (bodyEnd < 0) continue;
    const header = chunk.slice(0, bodyEnd);
    const diffPart = chunk.slice(bodyEnd + BODY_DELIM.length);
    const fields = header.split('\x1f');
    if (fields.length < 6) continue;
    const sha = fields[0]!.trim();
    if (!SHA_RE.test(sha)) continue;
    const authorTs = Date.parse(fields[1]!.trim());
    const commitTs = Date.parse(fields[2]!.trim());
    const ts = Number.isFinite(commitTs) ? commitTs : (Number.isFinite(authorTs) ? authorTs : 0);
    if (!ts) continue;
    const authorName = fields[3]!.trim();
    const subject = fields[4]!.trim();
    const body = fields.slice(5).join('\x1f');

    const addedByFile = new Map<string, string[]>();
    const touchedFiles = new Set<string>();
    let curFile: string | null = null;
    let totalDistLines = 0;
    for (const line of diffPart.split('\n')) {
      if (line.startsWith('+++ b/')) {
        curFile = line.slice(6).trim();
        touchedFiles.add(curFile);
      } else if (line.startsWith('--- a/')) {
        const prev = line.slice(6).trim();
        if (prev && prev !== '/dev/null') touchedFiles.add(prev);
      } else if (line.startsWith('+') && !line.startsWith('+++') && curFile) {
        const nl = normLine(line.slice(1));
        if (isDistinctiveLine(nl)) {
          let list = addedByFile.get(curFile);
          if (!list) {
            list = [];
            addedByFile.set(curFile, list);
          }
          list.push(nl);
          totalDistLines += 1;
        }
      }
    }

    commits.push({
      sha,
      authorTs: Number.isFinite(authorTs) ? authorTs : ts,
      commitTs: ts,
      authorName,
      subject,
      body,
      trailers: extractTrailers(body),
      prNumber: extractPrNumber(subject),
      files: [...touchedFiles].sort(),
      addedByFile,
      totalDistLines,
    });
  }
  return commits;
}

/** 轻量头扫描:先只拉 SHA + 时间戳,用于判断是否全量命中缓存。 */
export function listRepoCommitShas(
  repoRoot: string,
  git: RepoHistoryGitRunner,
  options: { sinceMs?: number | null; maxCommits?: number } = {},
): Array<{ sha: string; commitTs: number }> {
  const args = ['-C', repoRoot, 'log', '--no-merges', '--format=%H%x1f%cI'];
  if (options.sinceMs != null) args.push(`--since=${new Date(options.sinceMs).toISOString()}`);
  if (options.maxCommits != null && options.maxCommits > 0) args.push('-n', String(options.maxCommits));
  const raw = git(args);
  const out: Array<{ sha: string; commitTs: number }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [sha, iso] = line.split('\x1f');
    if (!sha || !SHA_RE.test(sha.trim())) continue;
    const ts = Date.parse(iso?.trim() ?? '');
    if (Number.isFinite(ts)) out.push({ sha: sha.trim(), commitTs: ts });
  }
  return out;
}

/** 分批拉取指定 SHA 集合的完整 diff(避开超长历史单次 stdout 爆 maxBuffer)。 */
export function loadCommitDiffsByShas(
  repoRoot: string,
  shas: string[],
  git: RepoHistoryGitRunner,
  batchSize = 150,
): RawCommitDiff[] {
  const out: RawCommitDiff[] = [];
  for (let i = 0; i < shas.length; i += batchSize) {
    const slice = shas.slice(i, i + batchSize);
    if (slice.length === 0) continue;
    const raw = git([
      '-C', repoRoot, 'show', '--no-merges', '--unified=0', '--no-color',
      `--format=${COMMIT_DELIM}%H%x1f%aI%x1f%cI%x1f%an%x1f%s%x1f%b${BODY_DELIM}`,
      ...slice,
    ]);
    out.push(...parseGitLogWithDiffs(raw));
  }
  return out;
}

// ── L0 会话事件采集 ─────────────────────────────────────────────────

export interface WriteEvent {
  provider: string;
  sessionId: string;
  isSubagent: boolean;
  model: string | null;
  ts: number | null;
  lines: Set<string>;
  tool: string;
}

export interface TouchHintEvent {
  provider: string;
  sessionId: string;
  model: string | null;
  ts: number | null;
}

export interface ShaWitnessEvent {
  shaPrefix: string;
  provider: string;
  sessionId: string;
  model: string | null;
  ts: number | null;
}

export interface PrWitnessEvent {
  prNumber: number;
  provider: string;
  sessionId: string;
  model: string | null;
  ts: number | null;
  kind: 'pr-create' | 'pr-merge';
}

export interface SessionMetaInfo {
  provider: string;
  models: Map<string, number>;
  title: string;
  isSubagent: boolean;
}

export interface ScanContext {
  repoNameLower: string;
  byBase: Map<string, string[]>;
  /** 可选目标新增行白名单(按 relPath):提供时只保留命中目标 commit 的行,内存直降 95%+。 */
  targetLinesByFile?: Map<string, Set<string>>;
  writesByFile: Map<string, WriteEvent[]>;
  bashWritesByFile: Map<string, TouchHintEvent[]>;
  readsByFile: Map<string, TouchHintEvent[]>;
  witnessesSha: ShaWitnessEvent[];
  witnessesPr: Map<number, PrWitnessEvent[]>;
  sessionMeta: Map<string, SessionMetaInfo>;
}

export function createScanContext(
  repoName: string,
  byBase: Map<string, string[]>,
  targetLinesByFile?: Map<string, Set<string>>,
): ScanContext {
  return {
    repoNameLower: repoName.toLowerCase(),
    byBase,
    targetLinesByFile,
    writesByFile: new Map(),
    bashWritesByFile: new Map(),
    readsByFile: new Map(),
    witnessesSha: [],
    witnessesPr: new Map(),
    sessionMeta: new Map(),
  };
}

function bumpModel(models: Map<string, number>, model: string | null | undefined): void {
  if (!model || !model.trim()) return;
  const m = model.trim();
  models.set(m, (models.get(m) ?? 0) + 1);
}

function dominantModel(meta: SessionMetaInfo | undefined): string {
  if (!meta || meta.models.size === 0) return 'unknown';
  let best = 'unknown';
  let bestCount = -1;
  for (const [m, c] of meta.models.entries()) {
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  return best;
}

function parseTs(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val > 1e12 ? val : val * 1000;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pushWrite(
  ctx: ScanContext,
  provider: string,
  sessionId: string,
  isSubagent: boolean,
  model: string | null,
  ts: number | null,
  rawPath: string | null | undefined,
  lines: Set<string>,
  tool: string,
): void {
  const rel = resolveRelPath(rawPath, ctx.byBase);
  if (!rel) return;
  let kept = lines;
  if (ctx.targetLinesByFile) {
    const wanted = ctx.targetLinesByFile.get(rel);
    kept = new Set<string>();
    if (wanted && wanted.size > 0) {
      for (const l of lines) {
        if (wanted.has(l)) kept.add(l);
      }
    }
  }
  let list = ctx.writesByFile.get(rel);
  if (!list) {
    list = [];
    ctx.writesByFile.set(rel, list);
  }
  list.push({ provider, sessionId, isSubagent, model, ts, lines: kept, tool });
}

function pushRead(
  ctx: ScanContext,
  provider: string,
  sessionId: string,
  model: string | null,
  ts: number | null,
  rawPath: string | null | undefined,
): void {
  const rel = resolveRelPath(rawPath, ctx.byBase);
  if (!rel) return;
  let list = ctx.readsByFile.get(rel);
  if (!list) {
    list = [];
    ctx.readsByFile.set(rel, list);
  }
  list.push({ provider, sessionId, model, ts });
}

function pushBashWriteHint(
  ctx: ScanContext,
  provider: string,
  sessionId: string,
  model: string | null,
  ts: number | null,
  cmd: string,
): void {
  if (!BASH_WRITE_HINT_RE.test(cmd)) return;
  FILE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN_RE.exec(cmd)) !== null) {
    const rel = resolveRelPath(m[0]!, ctx.byBase);
    if (!rel) continue;
    let list = ctx.bashWritesByFile.get(rel);
    if (!list) {
      list = [];
      ctx.bashWritesByFile.set(rel, list);
    }
    list.push({ provider, sessionId, model, ts });
  }
}

function pushPrWitness(ctx: ScanContext, ev: PrWitnessEvent): void {
  let list = ctx.witnessesPr.get(ev.prNumber);
  if (!list) {
    list = [];
    ctx.witnessesPr.set(ev.prNumber, list);
  }
  list.push(ev);
}

function collectShaWitnessesFromText(
  ctx: ScanContext,
  text: string,
  provider: string,
  sessionId: string,
  model: string | null,
  ts: number | null,
): void {
  COMMIT_OUT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMIT_OUT_RE.exec(text)) !== null) {
    ctx.witnessesSha.push({ shaPrefix: m[1]!, provider, sessionId, model, ts });
  }
}

function collectPrWitnessesFromText(
  ctx: ScanContext,
  text: string,
  provider: string,
  sessionId: string,
  model: string | null,
  ts: number | null,
  kind: 'pr-create' | 'pr-merge',
): void {
  GH_PR_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GH_PR_URL_RE.exec(text)) !== null) {
    const repoSeg = m[1]!.toLowerCase();
    const prNumber = Number(m[2]);
    if (!Number.isFinite(prNumber)) continue;
    if (ctx.repoNameLower && repoSeg !== ctx.repoNameLower && !ctx.repoNameLower.includes(repoSeg) && !repoSeg.includes(ctx.repoNameLower)) {
      continue;
    }
    pushPrWitness(ctx, { prNumber, provider, sessionId, model, ts, kind });
  }
}

function zstdPath(): string {
  return process.env.ZSTD_PATH?.trim()
    || (existsSync('/opt/homebrew/bin/zstd') ? '/opt/homebrew/bin/zstd' : 'zstd');
}

/** 分块流式逐行读取 .jsonl(256 KiB 缓冲,避免单次 readFileSync 打爆大文件堆内存);.zst 走 zstd 解压。 */
function forEachLineInFile(filePath: string, onLine: (line: string, index: number) => void): void {
  if (filePath.endsWith('.zst') || filePath.endsWith('.zstd')) {
    try {
      const out = execFileSync(zstdPath(), ['-dc', filePath], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let start = 0;
      let idx = 0;
      for (;;) {
        const nl = out.indexOf('\n', start);
        if (nl < 0) {
          if (start < out.length) onLine(out.slice(start), idx);
          break;
        }
        onLine(out.slice(start, nl), idx);
        idx += 1;
        start = nl + 1;
      }
    } catch {
      /* ignore unreadable zst */
    }
    return;
  }
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const chunkBuf = Buffer.alloc(256 * 1024);
    const decoder = new StringDecoder('utf8');
    let leftover = '';
    let idx = 0;
    for (;;) {
      const n = readSync(fd, chunkBuf, 0, chunkBuf.length, null);
      if (n <= 0) break;
      const piece = leftover + decoder.write(chunkBuf.subarray(0, n));
      let start = 0;
      for (;;) {
        const nl = piece.indexOf('\n', start);
        if (nl < 0) {
          leftover = piece.slice(start);
          break;
        }
        onLine(piece.slice(start, nl), idx);
        idx += 1;
        start = nl + 1;
      }
    }
    const tail = leftover + decoder.end();
    if (tail) onLine(tail, idx);
  } catch {
    /* ignore unreadable file */
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** 从单个 L0 会话文件提取写增量、读触碰与 commit/PR 目击。 */
export function scanSessionFileIntoContext(
  provider: 'claude' | 'codex' | 'factory' | 'antigravity',
  filePath: string,
  isSubagent: boolean,
  ctx: ScanContext,
): void {
  let sawAnyLine = false;

  if (provider === 'claude') {
    const stem = basename(filePath).replace(/\.jsonl$/i, '');
    const sid = isSubagent
      ? `claude:${basename(dirname(dirname(filePath))).slice(0, 12)}/${stem}`
      : `claude:${stem}`;
    const models = new Map<string, number>();
    let curModel: string | null = null;
    const pendingCommit = new Set<string>();
    const pendingPr = new Map<string, 'pr-create' | 'pr-merge'>();
    let title = '';

    forEachLineInFile(filePath, (line, i) => {
      sawAnyLine = true;
      const hasToolUse = line.includes('"tool_use"');
      const hasToolRes = line.includes('"tool_result"') && (pendingCommit.size > 0 || pendingPr.size > 0);
      const needTitle = !title && line.includes('"user"');
      const hasModel = i < 200 && line.includes('"model"');
      if (!hasToolUse && !hasToolRes && !needTitle && !hasModel) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const ts = parseTs(obj.timestamp);
      const msg = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null;
      if (!msg) return;
      if (typeof msg.model === 'string') {
        curModel = msg.model;
        bumpModel(models, curModel);
      }
      const content = msg.content;
      if (!title && obj.type === 'user') {
        if (typeof content === 'string' && content.trim().length > 6) {
          title = content.trim().split('\n')[0]!.slice(0, 85);
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
              const t = String((b as { text?: unknown }).text ?? '').trim();
              if (t.length > 6) {
                title = t.split('\n')[0]!.slice(0, 85);
                break;
              }
            }
          }
        }
      }
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        const item = b as Record<string, unknown>;
        if (item.type === 'tool_use') {
          const name = typeof item.name === 'string' ? item.name : '';
          const inp = item.input && typeof item.input === 'object' ? item.input as Record<string, unknown> : null;
          const cid = typeof item.id === 'string' ? item.id : '';
          if (!inp) continue;
          if (name === 'Edit') {
            pushWrite(ctx, 'claude', sid, isSubagent, curModel, ts, String(inp.file_path ?? ''), extractDeltaLines(String(inp.new_string ?? ''), String(inp.old_string ?? '')), 'Edit');
          } else if (name === 'Write') {
            pushWrite(ctx, 'claude', sid, isSubagent, curModel, ts, String(inp.file_path ?? ''), extractDeltaLines(String(inp.content ?? '')), 'Write');
          } else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
            const merged = new Set<string>();
            for (const ed of inp.edits) {
              if (ed && typeof ed === 'object') {
                for (const l of extractDeltaLines(String((ed as { new_string?: unknown }).new_string ?? ''), String((ed as { old_string?: unknown }).old_string ?? ''))) {
                  merged.add(l);
                }
              }
            }
            pushWrite(ctx, 'claude', sid, isSubagent, curModel, ts, String(inp.file_path ?? ''), merged, 'MultiEdit');
          } else if (name === 'Read' || name === 'Grep' || name === 'Glob') {
            pushRead(ctx, 'claude', sid, curModel, ts, String(inp.file_path ?? inp.path ?? ''));
          } else if (name === 'Bash' && typeof inp.command === 'string') {
            const cmd = inp.command;
            pushBashWriteHint(ctx, 'claude', sid, curModel, ts, cmd);
            if (cmd.includes('git') && cmd.includes('commit') && cid) pendingCommit.add(cid);
            if (cmd.includes('gh pr create') && cid) pendingPr.set(cid, 'pr-create');
            else if (cmd.includes('gh pr merge')) {
              if (cid) pendingPr.set(cid, 'pr-merge');
              GH_PR_MERGE_RE.lastIndex = 0;
              let mm: RegExpExecArray | null;
              while ((mm = GH_PR_MERGE_RE.exec(cmd)) !== null) {
                pushPrWitness(ctx, { prNumber: Number(mm[1]), provider: 'claude', sessionId: sid, model: curModel, ts, kind: 'pr-merge' });
              }
            }
          }
        } else if (item.type === 'tool_result') {
          const tuid = typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
          if (!tuid || (!pendingCommit.has(tuid) && !pendingPr.has(tuid))) continue;
          let resText = '';
          if (typeof item.content === 'string') resText = item.content;
          else if (Array.isArray(item.content)) {
            resText = item.content.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n');
          }
          if (pendingCommit.has(tuid)) {
            pendingCommit.delete(tuid);
            collectShaWitnessesFromText(ctx, resText, 'claude', sid, curModel, ts);
          }
          const prKind = pendingPr.get(tuid);
          if (prKind) {
            pendingPr.delete(tuid);
            collectPrWitnessesFromText(ctx, resText, 'claude', sid, curModel, ts, prKind);
          }
        }
      }
    });
    if (sawAnyLine) ctx.sessionMeta.set(sid, { provider: 'claude', models, title, isSubagent });
    return;
  }

  if (provider === 'codex') {
    const sid = `codex:${basename(filePath).replace(/\.jsonl(?:\.zstd?)?$/i, '')}`;
    const models = new Map<string, number>();
    let curModel: string | null = null;
    const pendingCommit = new Set<string>();
    const pendingPr = new Map<string, 'pr-create' | 'pr-merge'>();
    let title = '';

    forEachLineInFile(filePath, (line, i) => {
      sawAnyLine = true;
      const need = line.includes('turn_context')
        || line.includes('Begin Patch')
        || (line.includes('git') && line.includes('commit'))
        || line.includes('gh pr ')
        || (line.includes('_output') && (pendingCommit.size > 0 || pendingPr.size > 0))
        || (!title && i < 40 && line.includes('"user"'))
        || (line.includes('exec') && BASH_WRITE_HINT_RE.test(line));
      if (!need) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const ts = parseTs(obj.timestamp);
      const pay = obj.payload && typeof obj.payload === 'object' ? obj.payload as Record<string, unknown> : null;
      if (!pay) return;
      if (obj.type === 'turn_context' && typeof pay.model === 'string') {
        curModel = pay.model;
        bumpModel(models, curModel);
        return;
      }
      if (typeof pay.model === 'string') {
        curModel = pay.model;
        bumpModel(models, curModel);
      }
      if (obj.type !== 'response_item') return;
      if (pay.type === 'message' && pay.role === 'user' && !title && Array.isArray(pay.content)) {
        for (const b of pay.content) {
          if (b && typeof b === 'object' && ((b as { type?: unknown }).type === 'input_text' || (b as { type?: unknown }).type === 'text')) {
            const t = String((b as { text?: unknown }).text ?? '').trim();
            if (t.length > 10 && !t.startsWith('# AGENTS.md')) {
              title = t.split('\n')[0]!.slice(0, 85);
              break;
            }
          }
        }
      } else if (pay.type === 'function_call' || pay.type === 'custom_tool_call') {
        const nm = typeof pay.name === 'string' ? pay.name : '';
        const cid = typeof pay.call_id === 'string' ? pay.call_id : '';
        const rawIn = pay.type === 'custom_tool_call' ? pay.input : pay.arguments;
        const rawStr = typeof rawIn === 'string' ? rawIn : JSON.stringify(rawIn ?? '');
        if (rawStr.includes('*** Begin Patch')) {
          for (const patch of extractApplyPatchWrites(rawStr)) {
            pushWrite(ctx, 'codex', sid, false, curModel, ts, patch.filePath, patch.lines, nm || 'apply_patch');
          }
        }
        pushBashWriteHint(ctx, 'codex', sid, curModel, ts, rawStr);
        if (rawStr.includes('git') && rawStr.includes('commit') && cid) pendingCommit.add(cid);
        if (rawStr.includes('gh pr create') && cid) pendingPr.set(cid, 'pr-create');
        else if (rawStr.includes('gh pr merge')) {
          if (cid) pendingPr.set(cid, 'pr-merge');
          GH_PR_MERGE_RE.lastIndex = 0;
          let mm: RegExpExecArray | null;
          while ((mm = GH_PR_MERGE_RE.exec(rawStr)) !== null) {
            pushPrWitness(ctx, { prNumber: Number(mm[1]), provider: 'codex', sessionId: sid, model: curModel, ts, kind: 'pr-merge' });
          }
        }
      } else if (pay.type === 'function_call_output' || pay.type === 'custom_tool_call_output') {
        const cid = typeof pay.call_id === 'string' ? pay.call_id : '';
        if (!cid || (!pendingCommit.has(cid) && !pendingPr.has(cid))) return;
        const outStr = typeof pay.output === 'string' ? pay.output : JSON.stringify(pay.output ?? '');
        if (pendingCommit.has(cid)) {
          pendingCommit.delete(cid);
          collectShaWitnessesFromText(ctx, outStr, 'codex', sid, curModel, ts);
        }
        const prKind = pendingPr.get(cid);
        if (prKind) {
          pendingPr.delete(cid);
          collectPrWitnessesFromText(ctx, outStr, 'codex', sid, curModel, ts, prKind);
        }
      }
    });
    if (sawAnyLine) ctx.sessionMeta.set(sid, { provider: 'codex', models, title, isSubagent: false });
    return;
  }

  if (provider === 'factory') {
    const sid = `factory:${basename(filePath).replace(/\.jsonl$/i, '')}`;
    const model = readFactorySessionModel(filePath);
    const models = new Map<string, number>();
    bumpModel(models, model);
    let title = '';
    forEachLineInFile(filePath, (line) => {
      sawAnyLine = true;
      if (!line.includes('"tool_use"') && !line.includes('"session_start"')) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (obj.type === 'session_start' && !title && typeof obj.title === 'string') {
        title = obj.title.slice(0, 85);
      }
      const ts = parseTs(obj.timestamp);
      const msg = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null;
      const content = msg?.content ?? obj.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (!b || typeof b !== 'object' || (b as { type?: unknown }).type !== 'tool_use') continue;
        const item = b as Record<string, unknown>;
        const nm = typeof item.name === 'string' ? item.name : '';
        const inp = item.input && typeof item.input === 'object' ? item.input as Record<string, unknown> : null;
        if (!inp) continue;
        if (nm === 'Create' || nm === 'Write') {
          pushWrite(ctx, 'factory', sid, false, model, ts, String(inp.file_path ?? ''), extractDeltaLines(String(inp.content ?? '')), nm);
        } else if (nm === 'Edit') {
          const ns = String(inp.new_str ?? inp.new_string ?? '');
          const os = String(inp.old_str ?? inp.old_string ?? '');
          pushWrite(ctx, 'factory', sid, false, model, ts, String(inp.file_path ?? ''), extractDeltaLines(ns, os), 'Edit');
        } else if (nm === 'ApplyPatch') {
          const raw = String(inp.patch ?? inp.input ?? '');
          for (const patch of extractApplyPatchWrites(raw)) {
            pushWrite(ctx, 'factory', sid, false, model, ts, patch.filePath, patch.lines, 'ApplyPatch');
          }
        } else if (nm === 'Read' || nm === 'Grep' || nm === 'Glob') {
          pushRead(ctx, 'factory', sid, model, ts, String(inp.file_path ?? inp.path ?? ''));
        } else if (nm === 'Execute' || nm === 'Script') {
          const cmd = String(inp.command ?? inp.script ?? '');
          if (cmd) pushBashWriteHint(ctx, 'factory', sid, model, ts, cmd);
        }
      }
    });
    if (sawAnyLine) ctx.sessionMeta.set(sid, { provider: 'factory', models, title, isSubagent: false });
    return;
  }

  if (provider === 'antigravity') {
    const convId = basename(dirname(dirname(dirname(filePath))));
    const sid = `antigravity:${convId}`;
    let pendingCommits = 0;
    forEachLineInFile(filePath, (line) => {
      sawAnyLine = true;
      if (!line.includes('PLANNER_RESPONSE') && !line.includes('GENERIC')) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const ts = parseTs(obj.created_at ?? obj.timestamp);
      if (obj.type === 'PLANNER_RESPONSE' && Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const item = tc as { name?: unknown; args?: unknown };
          const nm = typeof item.name === 'string' ? item.name : '';
          const args = item.args && typeof item.args === 'object' ? item.args as Record<string, unknown> : null;
          if (!args) continue;
          const unq = (v: unknown): string => {
            const s = String(v ?? '');
            if (s.startsWith('"') && s.endsWith('"')) {
              try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
            }
            return s;
          };
          if (nm === 'edit_file' || nm === 'write_file') {
            const p = unq(args.Path);
            const txt = unq(args.Replacement ?? args.Content ?? '');
            const old = unq(args.Target ?? '');
            pushWrite(ctx, 'antigravity', sid, false, null, ts, p, extractDeltaLines(txt, old), nm);
          } else if (nm === 'read_file') {
            pushRead(ctx, 'antigravity', sid, null, ts, unq(args.Path));
          } else if (nm === 'run_command') {
            const cmd = unq(args.CommandLine);
            if (cmd.includes('git') && cmd.includes('commit')) pendingCommits += 1;
          }
        }
      } else if (obj.type === 'GENERIC' && obj.source === 'MODEL' && pendingCommits > 0) {
        pendingCommits -= 1;
        collectShaWitnessesFromText(ctx, String(obj.content ?? ''), 'antigravity', sid, null, ts);
      }
    });
    if (sawAnyLine) ctx.sessionMeta.set(sid, { provider: 'antigravity', models: new Map(), title: '', isSubagent: false });
  }
}

function scanZcodeSqlite(zcodeDbPath: string, sinceMs: number, ctx: ScanContext): void {
  if (!existsSync(zcodeDbPath)) return;
  let db: Database | null = null;
  try {
    db = new Database(zcodeDbPath, { readonly: true });
    const rows = db.query(
      `SELECT p.session_id, p.data AS pdata, m.time_created AS created, m.data AS mdata
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE m.time_created >= ? AND json_extract(p.data, '$.type') = 'tool'`,
    ).all(sinceMs) as Array<{ session_id: string; pdata: string; created: number | null; mdata: string | null }>;
    for (const row of rows) {
      const sid = `zcode:${row.session_id}`;
      const ts = parseTs(row.created);
      let model: string | null = null;
      if (row.mdata) {
        try {
          const mo = JSON.parse(row.mdata) as { modelID?: unknown; model?: { modelID?: unknown } };
          model = typeof mo.modelID === 'string' ? mo.modelID : (typeof mo.model?.modelID === 'string' ? mo.model.modelID : null);
        } catch { /* ignore */ }
      }
      let part: { tool?: unknown; state?: { input?: Record<string, unknown>; output?: unknown } };
      try {
        part = JSON.parse(row.pdata);
      } catch {
        continue;
      }
      const nm = String(part.tool ?? '').toLowerCase();
      const inp = part.state?.input ?? {};
      if (nm === 'edit' || nm === 'edit_file') {
        const fp = String(inp.filePath ?? inp.file_path ?? inp.path ?? '');
        const lns = extractDeltaLines(String(inp.newString ?? inp.new_string ?? ''), String(inp.oldString ?? inp.old_string ?? ''));
        pushWrite(ctx, 'zcode', sid, false, model, ts, fp, lns, nm);
      } else if (nm === 'write' || nm === 'write_file') {
        const fp = String(inp.filePath ?? inp.file_path ?? inp.path ?? '');
        pushWrite(ctx, 'zcode', sid, false, model, ts, fp, extractDeltaLines(String(inp.content ?? '')), nm);
      } else if (nm === 'bash' || nm === 'shell') {
        const cmd = String(inp.command ?? '');
        const out = String(part.state?.output ?? '');
        if (cmd.includes('git') && cmd.includes('commit') && out) {
          collectShaWitnessesFromText(ctx, out, 'zcode', sid, model, ts);
        }
      }
      const meta = ctx.sessionMeta.get(sid) ?? { provider: 'zcode', models: new Map(), title: '', isSubagent: false };
      bumpModel(meta.models, model);
      ctx.sessionMeta.set(sid, meta);
    }
  } catch {
    /* zcode sqlite 不可读:跳过 */
  } finally {
    db?.close();
  }
}

// ── L0 候选文件发现(快速预筛,避免全盘解压无关项目)──────────────────

function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeMsSafe(p: string): number {
  try {
    return wholeMtimeMs(statSync(p));
  } catch {
    return 0;
  }
}

function peekHeadText(filePath: string, bytes = 24_576): string {
  if (filePath.endsWith('.zst') || filePath.endsWith('.zstd')) {
    try {
      // 走管道截断到前 bytes 字节,避免解压大 .zst 触发 spawnSync ENOBUFS
      const res = spawnSync(
        'sh',
        ['-c', '"$1" -dc "$2" 2>/dev/null | head -c "$3"', '_', zstdPath(), filePath, String(bytes)],
        { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return res.stdout ?? '';
    } catch {
      return '';
    }
  }
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function collectCodexFilesRecursive(dir: string, sinceMs: number, out: string[]): void {
  for (const entry of listDirSafe(dir)) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        collectCodexFilesRecursive(full, sinceMs, out);
      } else if ((entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zst')) && wholeMtimeMs(st) >= sinceMs) {
        out.push(full);
      }
    } catch {
      /* ignore */
    }
  }
}

export interface DiscoveredL0Files {
  claude: Array<{ path: string; isSubagent: boolean }>;
  codex: string[];
  factory: string[];
  antigravity: string[];
  zcodeDb: string | null;
}

export function discoverCandidateL0Files(
  store: Store,
  repoUrl: string,
  repoRoot: string | null,
  repoName: string,
  logSinceMs: number,
  home = homedir(),
  extra?: { aliasUrls?: string[]; extraTokens?: string[] },
): DiscoveredL0Files {
  const tokens = new Set<string>();
  const addTok = (s: string | null | undefined): void => {
    if (!s) return;
    const clean = s.trim().toLowerCase();
    if (clean.length >= 3) tokens.add(clean);
  };
  addTok(repoName);
  if (repoRoot) addTok(basename(repoRoot));
  const urlName = nameOfUrl(repoUrl);
  addTok(urlName);
  const aliasUrlSet = new Set<string>([repoUrl, ...(extra?.aliasUrls ?? [])]);
  for (const u of extra?.aliasUrls ?? []) addTok(nameOfUrl(u));
  for (const t of extra?.extraTokens ?? []) addTok(t);
  const matchesRepoText = (text: string): boolean => {
    const low = text.toLowerCase();
    for (const tok of tokens) {
      if (low.includes(tok)) return true;
    }
    return false;
  };

  // 1) 从 planofplan.db 里拿所有已关联到该仓库(及其合并别名)的 session sourceFile
  const dbFilesByProvider = new Map<string, Set<string>>();
  for (const session of store.listSessionRows()) {
    if (!session.sourceFile || session.updatedAt < logSinceMs) continue;
    const hit = (session.repos ?? []).some((r) => (
      aliasUrlSet.has(r.url)
      || (repoRoot != null && r.root === repoRoot)
      || matchesRepoText(r.name)
      || matchesRepoText(r.url)
      || (r.root != null && matchesRepoText(r.root))
    ));
    if (!hit) continue;
    if (!existsSync(session.sourceFile)) continue;
    const set = dbFilesByProvider.get(session.provider) ?? new Set<string>();
    set.add(session.sourceFile);
    dbFilesByProvider.set(session.provider, set);
  }

  // 2) Claude: 匹配项目目录 + DB 命中 + 展开所有 subagents/*.jsonl
  const claudeMap = new Map<string, boolean>();
  const addClaudeMain = (p: string): void => {
    if (mtimeMsSafe(p) < logSinceMs) return;
    const isSub = p.includes('/subagents/');
    claudeMap.set(p, isSub);
    if (!isSub && p.endsWith('.jsonl')) {
      const subDir = join(p.slice(0, -6), 'subagents');
      for (const f of listDirSafe(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sp = join(subDir, f);
        if (mtimeMsSafe(sp) >= logSinceMs) claudeMap.set(sp, true);
      }
    }
  };
  const claudeRoot = join(home, '.claude', 'projects');
  for (const slug of listDirSafe(claudeRoot)) {
    if (!matchesRepoText(slug)) continue;
    const projDir = join(claudeRoot, slug);
    for (const entry of listDirSafe(projDir)) {
      if (entry.endsWith('.jsonl')) addClaudeMain(join(projDir, entry));
    }
  }
  for (const sf of dbFilesByProvider.get('claude') ?? []) addClaudeMain(sf);

  // 3) Codex: DB 命中 + 近期文件头预筛
  const codexSet = new Set<string>();
  for (const sf of dbFilesByProvider.get('codex') ?? []) {
    if (mtimeMsSafe(sf) >= logSinceMs) codexSet.add(sf);
  }
  const allRecentCodex: string[] = [];
  collectCodexFilesRecursive(join(home, '.codex', 'sessions'), logSinceMs, allRecentCodex);
  for (const p of allRecentCodex) {
    if (codexSet.has(p)) continue;
    const head = peekHeadText(p, 16_384);
    if (head && matchesRepoText(head)) codexSet.add(p);
  }

  // 4) Factory / Droid
  const factorySet = new Set<string>();
  for (const sf of dbFilesByProvider.get('factory') ?? []) {
    if (mtimeMsSafe(sf) >= logSinceMs) factorySet.add(sf);
  }
  const factoryRoot = join(home, '.factory', 'sessions');
  for (const slug of listDirSafe(factoryRoot)) {
    if (!matchesRepoText(slug)) continue;
    const dir = join(factoryRoot, slug);
    for (const entry of listDirSafe(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = join(dir, entry);
      if (mtimeMsSafe(fp) >= logSinceMs) factorySet.add(fp);
    }
  }

  // 5) Antigravity
  const agyFiles: string[] = [];
  const agyRoot = join(home, '.gemini', 'antigravity-cli', 'brain');
  for (const cid of listDirSafe(agyRoot)) {
    const tp = join(agyRoot, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (mtimeMsSafe(tp) >= logSinceMs) agyFiles.push(tp);
  }

  // 6) ZCode SQLite
  const zcodePath = join(home, '.zcode', 'cli', 'db', 'db.sqlite');

  return {
    claude: [...claudeMap.entries()].map(([path, isSubagent]) => ({ path, isSubagent })),
    codex: [...codexSet].sort(),
    factory: [...factorySet].sort(),
    antigravity: agyFiles,
    zcodeDb: existsSync(zcodePath) ? zcodePath : null,
  };
}

// ── 四层不升级归因与接力判定 ────────────────────────────────────────

export function attributeCommits(
  repoUrl: string,
  commits: RawCommitDiff[],
  ctx: ScanContext,
  now = Date.now(),
): CommitProvenanceRecord[] {
  // 跨 commit 行频统计:出现在 ≥3 个无关 commit 里的样板行不触发强接力判定
  const lineCommitFreq = new Map<string, number>();
  for (const c of commits) {
    const seen = new Set<string>();
    for (const lines of c.addedByFile.values()) {
      for (const l of lines) seen.add(l);
    }
    for (const l of seen) lineCommitFreq.set(l, (lineCommitFreq.get(l) ?? 0) + 1);
  }

  const out: CommitProvenanceRecord[] = [];
  for (const c of commits) {
    const cts = c.commitTs;
    const ats = c.authorTs;
    // 严格时间因果:写入必须发生在 commit 之前(+60s 时钟偏移容差),最多回溯 7 天(兼容长 PR 分支)
    const winLo = Math.min(ats, cts) - 7 * DAY_MS;
    const winHi = Math.max(ats, cts) + 60_000;

    // Layer 1: Declared trailers + bot git author
    const declared: Array<{ agent: string; label: string }> = [];
    const declaredModels = new Map<string, string>();
    for (const tr of c.trailers) {
      const ag = trailerToAgent(tr.value);
      if (ag) {
        declared.push({ agent: ag, label: `${tr.key}: ${tr.value}` });
        const tm = trailerToModel(tr.value);
        if (tm) declaredModels.set(ag, tm);
      }
    }
    if (declared.length === 0 && c.authorName.toLowerCase().includes('dependabot')) {
      declared.push({ agent: 'dependabot', label: `Author: ${c.authorName}` });
    }

    // Layer 2: Witnessed author vs merge
    const witAuthor: Array<{ provider: string; sessionId: string; model: string | null; kind: string }> = [];
    const witMerge: Array<{ provider: string; sessionId: string; model: string | null; kind: string }> = [];
    for (const w of ctx.witnessesSha) {
      if (w.shaPrefix.length >= 7 && c.sha.startsWith(w.shaPrefix)) {
        witAuthor.push({ provider: w.provider, sessionId: w.sessionId, model: w.model, kind: 'git-commit' });
      }
    }
    if (c.prNumber != null) {
      for (const w of ctx.witnessesPr.get(c.prNumber) ?? []) {
        if (w.kind === 'pr-create') {
          witAuthor.push({ provider: w.provider, sessionId: w.sessionId, model: w.model, kind: 'pr-create' });
        } else {
          witMerge.push({ provider: w.provider, sessionId: w.sessionId, model: w.model, kind: 'pr-merge' });
        }
      }
    }

    // Layer 3: Pure-delta Hunk Line Matching
    const sessionLineHits = new Map<string, { provider: string; sessionId: string; model: string; lines: number; strongLines: number; files: Set<string> }>();
    let matchedDist = 0;
    for (const [rel, distLines] of c.addedByFile.entries()) {
      const evs = (ctx.writesByFile.get(rel) ?? [])
        .filter((ev) => ev.ts == null || (ev.ts >= winLo && ev.ts <= winHi))
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      if (evs.length === 0) continue;
      for (const nl of distLines) {
        let winner: WriteEvent | null = null;
        for (const ev of evs) {
          if (ev.lines.has(nl)) winner = ev;
        }
        if (!winner) continue;
        matchedDist += 1;
        const model = winner.model ?? dominantModel(ctx.sessionMeta.get(winner.sessionId));
        const key = `${winner.provider}|${winner.sessionId}|${model}`;
        let bucket = sessionLineHits.get(key);
        if (!bucket) {
          bucket = { provider: winner.provider, sessionId: winner.sessionId, model, lines: 0, strongLines: 0, files: new Set() };
          sessionLineHits.set(key, bucket);
        }
        bucket.lines += 1;
        bucket.files.add(rel);
        if (nl.length >= 28 && (lineCommitFreq.get(nl) ?? 1) <= 2) {
          bucket.strongLines += 1;
        }
      }
    }

    // Layer 3.5: Write-only & Bash-write touches (24h / 12h before commit)
    const writeTouches = new Map<string, { provider: string; sessionId: string; model: string; count: number }>();
    const bashTouches = new Map<string, { provider: string; sessionId: string; model: string; count: number }>();
    for (const rel of c.files) {
      for (const ev of ctx.writesByFile.get(rel) ?? []) {
        if (ev.ts == null || (ev.ts >= Math.min(ats, cts) - DAY_MS && ev.ts <= winHi)) {
          const model = ev.model ?? dominantModel(ctx.sessionMeta.get(ev.sessionId));
          const key = `${ev.provider}|${ev.sessionId}|${model}`;
          const cur = writeTouches.get(key) ?? { provider: ev.provider, sessionId: ev.sessionId, model, count: 0 };
          cur.count += 1;
          writeTouches.set(key, cur);
        }
      }
      for (const ev of ctx.bashWritesByFile.get(rel) ?? []) {
        if (ev.ts == null || (ev.ts >= Math.min(ats, cts) - 12 * 3_600_000 && ev.ts <= winHi)) {
          const model = ev.model ?? dominantModel(ctx.sessionMeta.get(ev.sessionId));
          const key = `${ev.provider}|${ev.sessionId}|${model}`;
          const cur = bashTouches.get(key) ?? { provider: ev.provider, sessionId: ev.sessionId, model, count: 0 };
          cur.count += 1;
          bashTouches.set(key, cur);
        }
      }
    }

    // Read-only reviewers (strictly exclude writers!)
    const writerSids = new Set<string>();
    for (const v of sessionLineHits.values()) writerSids.add(v.sessionId);
    for (const v of writeTouches.values()) writerSids.add(v.sessionId);
    for (const v of bashTouches.values()) writerSids.add(v.sessionId);
    const reviewers = new Set<string>();
    for (const rel of c.files) {
      for (const ev of ctx.readsByFile.get(rel) ?? []) {
        if (writerSids.has(ev.sessionId)) continue;
        if (ev.ts != null && ev.ts >= cts - 6 * 3_600_000 && ev.ts <= cts + DAY_MS) {
          reviewers.add(ev.provider);
        }
      }
    }

    // Evidence tier (strictly non-escalating)
    const cov = c.totalDistLines > 0 ? matchedDist / c.totalDistLines : 0;
    let tier: CommitProvenanceTier;
    if (matchedDist >= 5 || (matchedDist > 0 && cov >= 0.15)) tier = 'hunk-matched';
    else if (declared.length > 0) tier = 'declared';
    else if (witAuthor.length > 0) tier = 'witnessed-author';
    else if (matchedDist > 0) tier = 'hunk-partial';
    else if (writeTouches.size > 0) tier = 'write-touch';
    else if (bashTouches.size > 0) tier = 'bash-write';
    else if (witMerge.length > 0) tier = 'merged-only';
    else tier = 'unattributed';

    // Aggregate authors
    const provModelLines = new Map<string, { provider: string; model: string; lines: number }>();
    for (const hit of sessionLineHits.values()) {
      const k = `${hit.provider}|${hit.model}`;
      const cur = provModelLines.get(k) ?? { provider: hit.provider, model: hit.model, lines: 0 };
      cur.lines += hit.lines;
      provModelLines.set(k, cur);
    }
    const declProvSet = new Set(declared.map((d) => d.agent));
    const authors: CommitProvenanceAuthor[] = [];
    const seenProv = new Set<string>();
    for (const item of [...provModelLines.values()].sort((a, b) => b.lines - a.lines)) {
      // 有明确 declared trailer 时,屏蔽其他 provider 1-2 行偶发撞车
      if (declProvSet.size > 0 && !declProvSet.has(item.provider) && item.lines < 3) continue;
      authors.push({ provider: item.provider, model: item.model, lines: item.lines, source: 'hunk' });
      seenProv.add(item.provider);
    }
    for (const d of declared) {
      if (!seenProv.has(d.agent)) {
        authors.push({ provider: d.agent, model: declaredModels.get(d.agent) ?? 'unknown', lines: 0, source: 'declared' });
        seenProv.add(d.agent);
      }
    }
    for (const w of witAuthor) {
      if (!seenProv.has(w.provider)) {
        const m = w.model ?? dominantModel(ctx.sessionMeta.get(w.sessionId));
        authors.push({ provider: w.provider, model: m, lines: 0, source: w.kind });
        seenProv.add(w.provider);
      }
    }
    if (authors.length === 0) {
      const fallback = writeTouches.size > 0 ? [...writeTouches.values()] : [...bashTouches.values()];
      fallback.sort((a, b) => b.count - a.count);
      for (const t of fallback.slice(0, 2)) {
        if (!seenProv.has(t.provider)) {
          authors.push({ provider: t.provider, model: t.model, lines: 0, source: writeTouches.size > 0 ? 'write-touch' : 'bash-write' });
          seenProv.add(t.provider);
        }
      }
    }

    // Strict relay classification
    const strongProvs = new Set<string>();
    const strongModels = new Set<string>();
    const strongSessions = new Set<string>();
    for (const hit of sessionLineHits.values()) {
      if (hit.strongLines >= 5) {
        strongProvs.add(hit.provider);
        strongModels.add(`${hit.provider}|${hit.model}`);
        strongSessions.add(hit.sessionId);
      }
    }
    const provUnion = new Set<string>([...strongProvs, ...declProvSet]);
    const mergeProvs = new Set(witMerge.map((w) => w.provider));
    let relayKind: CommitRelayKind = '';
    if (provUnion.size >= 2) relayKind = 'cross-agent-code';
    else if (strongModels.size >= 2) relayKind = 'cross-model-code';
    else if (strongSessions.size >= 2) relayKind = 'multi-session-code';
    else if (provUnion.size > 0 && mergeProvs.size > 0 && [...mergeProvs].some((p) => !provUnion.has(p))) {
      relayKind = 'write-then-merge';
    }

    const sessions: CommitProvenanceSessionHit[] = [...sessionLineHits.values()]
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 6)
      .map((s) => ({
        provider: s.provider,
        sessionId: s.sessionId,
        model: s.model,
        lines: s.lines,
        strongLines: s.strongLines,
        files: [...s.files].sort(),
        title: ctx.sessionMeta.get(s.sessionId)?.title ?? '',
      }));

    out.push({
      repoUrl,
      sha: c.sha,
      prNumber: c.prNumber,
      committedAt: cts,
      authorName: c.authorName,
      subject: c.subject,
      tier,
      primaryProvider: authors[0]?.provider ?? null,
      primaryModel: authors[0]?.model ?? null,
      totalDistLines: c.totalDistLines,
      matchedDistLines: matchedDist,
      relayKind,
      filesCount: c.files.length,
      files: c.files,
      authors,
      declared: declared.map((d) => d.label),
      witnessedAuthor: [...new Set(witAuthor.map((w) => `${w.provider}:${w.kind}`))].sort(),
      mergedBy: [...new Set(witMerge.map((w) => `${w.provider}:${w.kind}`))].sort(),
      reviewers: [...reviewers].sort(),
      sessions,
      analyzerVersion: REPO_HISTORY_ANALYZER_VERSION,
      analyzedAt: now,
    });
  }
  return out;
}

// ── 汇总与报告构造 ──────────────────────────────────────────────────

export function buildRepoHistorySummary(
  records: CommitProvenanceRecord[],
  meta: {
    repoUrl: string;
    repoName: string;
    repoRoot: string | null;
    days: number | null;
    cachedCommits: number;
    newlyAnalyzedCommits: number;
    sessionsScanned: number;
    elapsedMs: number;
  },
): RepoHistorySummary {
  const tierCounts: Record<string, number> = {};
  const providerCommits: Record<string, number> = {};
  const modelLineMap = new Map<string, { provider: string; model: string; lines: number }>();
  const dirMap = new Map<string, { commits: number; providers: Record<string, number> }>();
  const dailyMap = new Map<string, { providers: Record<string, number>; linesByProvider: Record<string, number> }>();
  const relayCounts = { crossAgentCode: 0, crossModelCode: 0, multiSessionCode: 0, writeThenMerge: 0 };

  let totalLines = 0;
  let matchedLines = 0;
  let prCount = 0;
  const daysSet = new Set<string>();

  for (const r of records) {
    tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
    totalLines += r.totalDistLines;
    matchedLines += r.matchedDistLines;
    if (r.prNumber != null) prCount += 1;

    const day = new Date(r.committedAt).toISOString().slice(0, 10);
    daysSet.add(day);
    const dayBucket = dailyMap.get(day) ?? { providers: {}, linesByProvider: {} };
    const prim = r.primaryProvider ?? 'unattributed';
    dayBucket.providers[prim] = (dayBucket.providers[prim] ?? 0) + 1;
    if (r.matchedDistLines > 0) {
      for (const a of r.authors) {
        if (a.lines > 0) dayBucket.linesByProvider[a.provider] = (dayBucket.linesByProvider[a.provider] ?? 0) + a.lines;
      }
    } else {
      dayBucket.linesByProvider[prim] = (dayBucket.linesByProvider[prim] ?? 0) + r.totalDistLines;
    }
    dailyMap.set(day, dayBucket);

    const seenP = new Set<string>();
    for (const a of r.authors) {
      seenP.add(a.provider);
      if (a.lines > 0) {
        const key = `${a.provider}|${a.model}`;
        const cur = modelLineMap.get(key) ?? { provider: a.provider, model: a.model, lines: 0 };
        cur.lines += a.lines;
        modelLineMap.set(key, cur);
      }
    }
    for (const p of seenP) providerCommits[p] = (providerCommits[p] ?? 0) + 1;

    const dirs = new Set(r.files.map(topDirOf));
    for (const dir of dirs) {
      const db = dirMap.get(dir) ?? { commits: 0, providers: {} };
      db.commits += 1;
      db.providers[prim] = (db.providers[prim] ?? 0) + 1;
      dirMap.set(dir, db);
    }

    if (r.relayKind === 'cross-agent-code') relayCounts.crossAgentCode += 1;
    else if (r.relayKind === 'cross-model-code') relayCounts.crossModelCode += 1;
    else if (r.relayKind === 'multi-session-code') relayCounts.multiSessionCode += 1;
    else if (r.relayKind === 'write-then-merge') relayCounts.writeThenMerge += 1;
  }

  const mergedOnly = tierCounts['merged-only'] ?? 0;
  const unattributed = tierCounts['unattributed'] ?? 0;
  const authorAttributed = records.length - mergedOnly - unattributed;
  const daysSorted = [...daysSet].sort();

  const activeProviders = Object.entries(providerCommits)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p]) => p);

  const modelLines = [...modelLineMap.values()]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 15);

  const dirOwnership = [...dirMap.entries()]
    .sort((a, b) => b[1].commits - a[1].commits)
    .slice(0, 14)
    .map(([dir, v]) => ({ dir, commits: v.commits, providers: v.providers }));

  const daily = [...dailyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day, providers: v.providers, linesByProvider: v.linesByProvider }));

  return {
    repoUrl: meta.repoUrl,
    repoName: meta.repoName,
    repoRoot: meta.repoRoot,
    days: meta.days,
    dateRange: daysSorted.length > 0 ? `${daysSorted[0]} .. ${daysSorted[daysSorted.length - 1]}` : '',
    totalCommits: records.length,
    prCount,
    cachedCommits: meta.cachedCommits,
    newlyAnalyzedCommits: meta.newlyAnalyzedCommits,
    sessionsScanned: meta.sessionsScanned,
    elapsedMs: meta.elapsedMs,
    authorAttributed,
    authorPct: records.length > 0 ? Math.round((authorAttributed / records.length) * 1000) / 10 : 0,
    mergedOnly,
    unattributed,
    tierCounts,
    totalLines,
    matchedLines,
    matchedLinesPct: totalLines > 0 ? Math.round((matchedLines / totalLines) * 1000) / 10 : 0,
    activeProviders,
    providerCommits,
    modelLines,
    dirOwnership,
    daily,
    relayCounts,
  };
}

// ── 仓库定位 + 主编排入口(增量缓存 + 单飞) ──────────────────────────

export interface RepoTarget {
  repoUrl: string;
  repoRoot: string | null;
  repoName: string;
}

/** 根据本地路径、项目名或 URL 片段解析目标仓库。 */
export function resolveRepoTarget(store: Store, query: string): RepoTarget | null {
  const q = query.trim();
  if (!q) return null;
  // 1) 直接传本地目录路径
  const resolved = resolve(q);
  if (existsSync(join(resolved, '.git'))) {
    const ref = repoRefOf(resolved);
    if (ref) return { repoUrl: ref.url, repoRoot: ref.root, repoName: ref.name };
    return { repoUrl: resolved, repoRoot: resolved, repoName: basename(resolved) };
  }
  const low = q.toLowerCase();
  // 2) 优先匹配 projects 表
  const projects = store.listProjects();
  const exact = projects.find((p) => p.id === q || p.name.toLowerCase() === low || p.url.toLowerCase() === low);
  if (exact) return { repoUrl: exact.url, repoRoot: exact.root, repoName: exact.name };
  const partial = projects.find((p) => p.name.toLowerCase().includes(low) || p.url.toLowerCase().includes(low) || (p.root?.toLowerCase().includes(low) ?? false));
  if (partial) return { repoUrl: partial.url, repoRoot: partial.root, repoName: partial.name };
  // 3) 兜底从 commit_provenance / session_repos 找
  for (const session of store.listSessionRows()) {
    for (const r of session.repos ?? []) {
      if (r.name.toLowerCase().includes(low) || r.url.toLowerCase().includes(low) || (r.root?.toLowerCase().includes(low) ?? false)) {
        return { repoUrl: r.url, repoRoot: r.root ?? null, repoName: r.name };
      }
    }
  }
  return null;
}

export interface AnalyzeRepoHistoryOptions {
  repoUrl: string;
  repoRoot: string;
  repoName: string;
  /** 合并到同一主项目的其它别名 URL(用于发现父目录/旧工作树上的会话)。 */
  aliasUrls?: string[];
  /** 额外匹配词(如归并的父目录名 grokbot)。 */
  extraTokens?: string[];
  /** null = 全量历史;数字 = 近 N 天。 */
  days?: number | null;
  /** true = 忽略缓存重算范围内所有 commit。 */
  refresh?: boolean;
  /** 可选上限(默认无上限,全量支持)。 */
  maxCommits?: number;
  homeDir?: string;
  git?: RepoHistoryGitRunner;
  now?: number;
}

export interface ReadCachedRepoHistoryOptions {
  aliasUrls?: string[];
  /** 限制返回的 records 长度(null/undefined/<=0 = 全量);summary 始终基于全量计算。 */
  limit?: number | null;
  now?: number;
}

/** 对报告的 records 做前端传输截断,保留完整 summary 与 total/truncated 元信息(INV-2198)。 */
export function sliceHistoryReport(
  report: RepoHistoryReport,
  limit?: number | null,
): RepoHistoryReport {
  const total = report.recordsTotal ?? report.records.length;
  if (limit == null || limit <= 0 || report.records.length <= limit) {
    return {
      ...report,
      recordsTotal: total,
      recordsTruncated: total > report.records.length,
    };
  }
  return {
    ...report,
    records: report.records.slice(0, limit),
    recordsTotal: total,
    recordsTruncated: true,
  };
}

/**
 * 读取已缓存的仓库历史报告(纯读库,零磁盘/git I/O)。
 */
export function readCachedRepoHistory(
  store: Store,
  target: RepoTarget,
  days: number | null,
  nowOrOptions: number | ReadCachedRepoHistoryOptions = Date.now(),
): RepoHistoryReport {
  const opts: ReadCachedRepoHistoryOptions = typeof nowOrOptions === 'number'
    ? { now: nowOrOptions }
    : nowOrOptions;
  const now = opts.now ?? Date.now();
  const sinceMs = days != null && days > 0 ? now - days * DAY_MS : null;
  const urls = opts.aliasUrls && opts.aliasUrls.length > 0
    ? [...new Set([target.repoUrl, ...opts.aliasUrls])]
    : [target.repoUrl];
  const allRecords = store.listCommitProvenanceForUrls(urls, sinceMs);
  const summary = buildRepoHistorySummary(allRecords, {
    repoUrl: target.repoUrl,
    repoName: target.repoName,
    repoRoot: target.repoRoot,
    days,
    cachedCommits: allRecords.length,
    newlyAnalyzedCommits: 0,
    sessionsScanned: 0,
    elapsedMs: 0,
  });
  const base: RepoHistoryReport = {
    cached: allRecords.length > 0,
    summary,
    records: allRecords,
    recordsTotal: allRecords.length,
    recordsTruncated: false,
  };
  return sliceHistoryReport(base, opts.limit);
}

/**
 * 增量分析指定仓库的 Commit 归因历史并落 L1 缓存表 `commit_provenance`。
 * 已分析过的不可变 SHA 直接复用缓存,仅对新增 SHA 跑 diff 与 L0 扫描。
 */
export function analyzeRepoHistory(
  store: Store,
  options: AnalyzeRepoHistoryOptions,
): RepoHistoryReport {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const git = options.git ?? defaultHistoryGitRunner();
  const days = options.days === undefined ? 30 : options.days;
  const sinceMs = days != null && days > 0 ? now - days * DAY_MS : null;

  const commitHeads = listRepoCommitShas(options.repoRoot, git, { sinceMs, maxCommits: options.maxCommits });
  const cachedShas = options.refresh
    ? new Set<string>()
    : store.getCachedProvenanceShas(options.repoUrl, REPO_HISTORY_ANALYZER_VERSION);
  const missingHeads = commitHeads.filter((h) => !cachedShas.has(h.sha));

  let sessionsScanned = 0;
  if (missingHeads.length > 0) {
    const diffs = loadCommitDiffsByShas(options.repoRoot, missingHeads.map((h) => h.sha), git);
    const allRel = new Set<string>();
    const targetLinesByFile = new Map<string, Set<string>>();
    let earliestCommitTs = Infinity;
    for (const d of diffs) {
      for (const f of d.files) allRel.add(f);
      for (const [rel, lines] of d.addedByFile.entries()) {
        let set = targetLinesByFile.get(rel);
        if (!set) {
          set = new Set<string>();
          targetLinesByFile.set(rel, set);
        }
        for (const l of lines) set.add(l);
      }
      if (d.commitTs < earliestCommitTs) earliestCommitTs = d.commitTs;
    }
    const byBase = buildFileSuffixMatcher(allRel);
    const ctx = createScanContext(options.repoName, byBase, targetLinesByFile);

    // 只扫描 mtime >= 最早待分析 commit - 7d 的 L0 文件,大幅缩短增量扫描耗时
    const logSinceMs = Number.isFinite(earliestCommitTs) ? earliestCommitTs - 7 * DAY_MS : (sinceMs ?? 0);
    const discovered = discoverCandidateL0Files(
      store,
      options.repoUrl,
      options.repoRoot,
      options.repoName,
      logSinceMs,
      options.homeDir,
      { aliasUrls: options.aliasUrls, extraTokens: options.extraTokens },
    );
    for (const item of discovered.claude) scanSessionFileIntoContext('claude', item.path, item.isSubagent, ctx);
    for (const path of discovered.codex) scanSessionFileIntoContext('codex', path, false, ctx);
    for (const path of discovered.factory) scanSessionFileIntoContext('factory', path, false, ctx);
    for (const path of discovered.antigravity) scanSessionFileIntoContext('antigravity', path, false, ctx);
    if (discovered.zcodeDb) scanZcodeSqlite(discovered.zcodeDb, logSinceMs, ctx);

    sessionsScanned = ctx.sessionMeta.size;
    const computed = attributeCommits(options.repoUrl, diffs, ctx, now);
    store.upsertCommitProvenance(computed);
  }

  const allRecords = store.listCommitProvenance(options.repoUrl, sinceMs);
  const wantShas = new Set(commitHeads.map((h) => h.sha));
  const records = wantShas.size > 0
    ? allRecords.filter((r) => wantShas.has(r.sha))
    : allRecords;

  const summary = buildRepoHistorySummary(records, {
    repoUrl: options.repoUrl,
    repoName: options.repoName,
    repoRoot: options.repoRoot,
    days,
    cachedCommits: commitHeads.length - missingHeads.length,
    newlyAnalyzedCommits: missingHeads.length,
    sessionsScanned,
    elapsedMs: Date.now() - startedAt,
  });

  return { cached: true, summary, records };
}
