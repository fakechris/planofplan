/**
 * Multi-dimension git extraction for a session.
 *
 *   work   — cwd walk-up (where the session sat)
 *   touch  — tool-call / file_path / git -C targets in the log
 *   commit — git log of work∪touch roots in the session window
 *
 * Yarn lanes and requirement.project use touch. Work is session metadata.
 * Time-window commit matches are candidate; trailers are declared.
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import {
  nameOfUrl,
  repoRefOf,
  reposOfRecords,
  type RepoRef,
} from './repos.ts';
import type { SessionRecord, SessionRepo } from './types.ts';

export const TOUCH_BYTES = 2 * 1024 * 1024;
export const ZSTD_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_GRACE_MS = 10 * 60 * 1000;
export const TRAILER_SESSION = 'Harness-Session';

export type GitRunner = (args: string[]) => string;

export const defaultGitRunner: GitRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

export function sourcePathFor(session: SessionRecord): string | null {
  if (!session.sourceFile) return null;
  if (session.provider === 'grok' && session.sourceFile.endsWith('summary.json')) {
    const chat = join(dirname(session.sourceFile), 'chat_history.jsonl');
    if (existsSync(chat)) return chat;
  }
  if (session.provider === 'kimi' && session.sourceFile.endsWith('state.json')) {
    const wire = join(dirname(session.sourceFile), 'agents', 'main', 'wire.jsonl');
    if (existsSync(wire)) return wire;
  }
  return session.sourceFile;
}

/** 垃圾 cwd 不立项目(家目录/临时区):会出现在各种闲聊会话里,立了全是噪声。 */
function isJunkCwd(cwd: string | null | undefined, home: string): boolean {
  if (!cwd || !cwd.startsWith('/')) return true;
  if (cwd === home || cwd === '/' || cwd === '/tmp' || cwd === '/private/tmp') return true;
  if (cwd.startsWith('/var/folders/') || cwd.startsWith('/private/var/folders/')) return true;
  return false;
}

export function workRepoOf(session: SessionRecord, home = homedir()): SessionRepo | null {
  const fromCwd = session.cwd ? repoRefOf(session.cwd) : undefined;
  const root = session.gitRoot || fromCwd?.root;
  if (root || session.gitUrl || fromCwd) {
    const url = session.gitUrl || fromCwd?.url || root || session.cwd || '(unknown)';
    const name = session.gitName || fromCwd?.name || nameOfUrl(url);
    return {
      sessionId: session.id,
      role: 'work',
      url,
      root: root || url,
      name,
      evidenceKind: 'observed',
    };
  }
  // 无 git 的 cwd(纯研究目录等):目录本身即工作身份——url/root 用路径,
  // 与「无 remote 的 repo 退化为 root path」同一套身份纪律。没有这层,
  // 非 git 目录的会话/需求在所有项目视图里都找不到(线上实测:research/*
  // 四个目录整体缺失)。
  if (isJunkCwd(session.cwd, home)) return null;
  const cwd = session.cwd!;
  return {
    sessionId: session.id,
    role: 'work',
    url: cwd,
    root: cwd,
    name: nameOfUrl(cwd),
    evidenceKind: 'observed',
  };
}

function parseJsonl(raw: string): unknown[] {
  const records: unknown[] = [];
  const lines = raw.split(/\r?\n/);
  if (!raw.endsWith('\n') && lines.length > 0) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* truncated */
    }
  }
  return records;
}

function readLogText(path: string, maxBytes = TOUCH_BYTES): string {
  if (path.endsWith('.jsonl.zstd') || path.endsWith('.jsonl.zst')) {
    try {
      const zstd = process.env.ZSTD_PATH?.trim()
        || (existsSync('/opt/homebrew/bin/zstd') ? '/opt/homebrew/bin/zstd' : 'zstd');
      const output = execFileSync(zstd, ['-dc', path], {
        encoding: 'utf8',
        maxBuffer: ZSTD_MAX_BYTES,
      });
      return output.slice(0, maxBytes);
    } catch {
      return '';
    }
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function recordsFromZcodeDb(path: string, nativeId: string): unknown[] {
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query(
      `SELECT p.data AS part FROM part p WHERE p.session_id = ?`,
    ).all(nativeId) as Array<{ part: string }>;
    return rows.map((row) => {
      try {
        return JSON.parse(row.part);
      } catch {
        return row.part;
      }
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function touchReposFromRecords(
  sessionId: string,
  records: readonly unknown[],
): SessionRepo[] {
  return reposOfRecords(records).map((ref, index) => ({
    sessionId,
    role: 'touch' as const,
    url: ref.url,
    root: ref.root,
    name: ref.name,
    evidenceKind: 'observed' as const,
    firstSeq: index,
  }));
}

export function parseTrailers(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  if (!body) return out;
  const re = /^(Harness-Session):\s*(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = match[2]!.trim();
    if (value) out.push({ key: match[1]!, value });
  }
  return out;
}

export function sessionMatchesTrailer(session: SessionRecord, value: string): boolean {
  const needle = value.trim();
  if (!needle) return false;
  return needle === session.id
    || needle === session.nativeId
    || session.id.endsWith(`:${needle}`);
}

export function parseCommitWindow(raw: string): Array<{
  sha: string;
  committedAt: number;
  subject: string;
  body: string;
}> {
  if (!raw) return [];
  const fields = raw.split('\0');
  if (fields.length % 4 === 1) fields.pop();
  const commits: Array<{ sha: string; committedAt: number; subject: string; body: string }> = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [sha, committerIso, subject, body] = fields.slice(i, i + 4) as [string, string, string, string];
    const committedAt = Date.parse(committerIso ?? '');
    if (!sha || !Number.isFinite(committedAt)) continue;
    commits.push({ sha, committedAt, subject: subject ?? '', body: body ?? '' });
  }
  return commits;
}

export function commitReposForSession(
  session: SessionRecord,
  roots: RepoRef[],
  git: GitRunner,
): SessionRepo[] {
  const started = session.startedAt ?? session.updatedAt;
  const since = started - SESSION_GRACE_MS;
  const until = session.updatedAt + SESSION_GRACE_MS;
  const out: SessionRepo[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root.root || seen.has(root.url)) continue;
    seen.add(root.url);
    let raw = '';
    try {
      raw = git([
        '-C', root.root,
        'log', '--all',
        `--since=${new Date(since).toISOString()}`,
        `--until=${new Date(until).toISOString()}`,
        '-z', '--format=%H%x00%cI%x00%s%x00%b',
      ]);
    } catch {
      continue;
    }
    const commits = parseCommitWindow(raw).filter((commit) => (
      commit.committedAt >= since && commit.committedAt <= until
    ));
    if (commits.length === 0) continue;
    const declared = commits.some((commit) => (
      parseTrailers(commit.body).some((trailer) => sessionMatchesTrailer(session, trailer.value))
    ));
    out.push({
      sessionId: session.id,
      role: 'commit',
      url: root.url,
      root: root.root,
      name: root.name,
      evidenceKind: declared ? 'declared' : 'candidate',
    });
  }
  return out;
}

export interface ExtractRepoOptions {
  records?: unknown[];
  git?: GitRunner | null;
}

export function extractSessionRepos(
  session: SessionRecord,
  options: ExtractRepoOptions = {},
): SessionRepo[] {
  const repos: SessionRepo[] = [];
  const work = workRepoOf(session);
  if (work) repos.push(work);

  let records = options.records;
  if (!records) {
    const path = sourcePathFor(session);
    if (path && session.provider === 'zcode' && path.endsWith('.sqlite')) {
      records = recordsFromZcodeDb(path, session.nativeId);
    } else if (path && existsSync(path)) {
      records = parseJsonl(readLogText(path));
    } else {
      records = [];
    }
  }
  const touch = touchReposFromRecords(session.id, records);
  repos.push(...touch);

  // Commit-role derivation shells out to `git log` per repo. It is expensive
  // and has been observed to crash Bun 1.3.5 under a large local catalog
  // (thousands of sessions, hundreds of git invocations). Disable by default;
  // callers that need declared/candidate commit evidence can pass a runner.
  const git = options.git === undefined ? null : options.git;
  if (git) {
    const roots: RepoRef[] = [];
    const seen = new Set<string>();
    for (const repo of [...(work ? [work] : []), ...touch]) {
      if (seen.has(repo.url)) continue;
      seen.add(repo.url);
      roots.push({ url: repo.url, root: repo.root, name: repo.name });
    }
    repos.push(...commitReposForSession(session, roots, git));
  }
  return repos;
}

export function attachRepos(session: SessionRecord, repos: SessionRepo[]): SessionRecord {
  const work = repos.find((repo) => repo.role === 'work');
  return {
    ...session,
    repos,
    gitRoot: work?.root ?? session.gitRoot ?? null,
    gitUrl: work?.url ?? session.gitUrl ?? null,
    gitName: work?.name ?? session.gitName ?? null,
  };
}

export { basename };
