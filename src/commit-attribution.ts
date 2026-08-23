/**
 * Commit 归因(WG 归因链第二环):session ↔ git commit。
 *
 * 证据分级:
 *   declared  — commit message 带 `Harness-Session: <session-id>` trailer
 *               (本机实测 2026-08:几十个 repo 的 git log 里没有任何 harness
 *               写过 trailer,declared 是面向未来的约定;candidate 是现实路径)
 *   candidate — commit 落在 session 活跃窗(started-grace ~ updated+grace)、
 *               repo 是该 session 的 work/touch repo;有 touch 数据的 session
 *               必须文件交集才落表,无 touch 数据的按 session 封顶
 *               CANDIDATE_PER_SESSION_MAX 条(ts 近者优先);merge 在 git 层
 *               --no-merges 挡掉,stash 类 subject 不进 candidate
 *
 * 历史教训(为什么这个模块的有界性是硬约束):早期实现 per-session per-repo
 * 全量 git log,在几千 session 的目录上打爆 Bun 主线程(段错误 + 事件循环
 * 阻塞,daemon 被 launchd 反复重启)。所以这里:
 *   - 只对 session_repos 已关联的 repo 跑 git,每个 repo 一次 git log
 *   - git log 带 --since/--until(session 并集窗口)+ -n 上限,并排除
 *     refs/stash(--exclude 必须在 --all 之前;实测 stash 的 "On main:" /
 *     "index on main:" 提交会混进候选)
 *   - spawnSync timeout(默认 5s),超时/失败跳过该 repo
 *   - repo 之间 yieldEventLoop;单个 repo 最坏阻塞 = timeout(5s),典型 <20ms
 */
import { spawnSync } from 'node:child_process';
import type { Store } from './db.ts';
import {
  SESSION_GRACE_MS,
  parseTrailers,
  sessionMatchesTrailer,
  type GitRunner,
} from './session-repos.ts';
import type { SessionCommit, SessionRecord, SessionRepo } from './types.ts';

const COMMIT_LOG_MAX = 300;
const CANDIDATE_PER_COMMIT_MAX = 5;
/** 无 touch 数据的 session:candidate 封顶条数(ts 近者优先)。 */
export const CANDIDATE_PER_SESSION_MAX = 100;
const GIT_TIMEOUT_MS = 5_000;
const SHA_RE = /^[0-9a-f]{40}$/i;
/** stash 类提交的 subject 模式(merge 在 git log 层用 --no-merges 挡,这里只挡 stash)。 */
const STASH_SUBJECT_RE = /^(?:On|index on|untracked files on|WIP on) \S[^:]*:/;

/** 有界 git runner:timeout + maxBuffer,任何失败抛给调用方跳过。 */
export function boundedGitRunner(timeoutMs = GIT_TIMEOUT_MS): GitRunner {
  return (args) => {
    const result = spawnSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(result.error?.message ?? result.stderr?.trim() ?? 'git failed');
    }
    return result.stdout;
  };
}

export interface RepoCommitRaw {
  sha: string;
  committedAt: number;
  subject: string;
  body: string;
  /** repo 相对路径 */
  files: string[];
}

/**
 * 解析 `git log -z --format='%H%x00%cI%x00%s%x00%b%x00' --name-only` 的输出。
 * 实测格式:每条 commit = sha/iso/subject/body 四个 NUL 分隔字段,随后一个
 * 空字段,再是「\n+文件名」开头的若干 NUL 分隔文件字段,直接接下一条的 sha。
 */
export function parseGitLogFiles(raw: string): RepoCommitRaw[] {
  if (!raw) return [];
  const fields = raw.split('\0');
  const commits: RepoCommitRaw[] = [];
  const isCommitStart = (i: number): boolean => (
    i + 1 < fields.length
    && SHA_RE.test(fields[i]!)
    && Number.isFinite(Date.parse(fields[i + 1]!))
  );
  let i = 0;
  while (i < fields.length) {
    if (!isCommitStart(i)) {
      i += 1;
      continue;
    }
    const [sha, iso, subject, body] = fields.slice(i, i + 4) as [string, string, string, string];
    const committedAt = Date.parse(iso);
    let j = i + 4;
    const files: string[] = [];
    while (j < fields.length && !isCommitStart(j)) {
      const file = fields[j]!.replace(/^\n+/, '');
      if (file) files.push(file);
      j += 1;
    }
    commits.push({ sha, committedAt, subject: subject ?? '', body: body ?? '', files });
    i = j;
  }
  return commits;
}

/** session 活跃窗:[started(无则 updated) - grace, updated + grace] */
function windowOf(session: SessionRecord, grace: number): [number, number] {
  return [(session.startedAt ?? session.updatedAt) - grace, session.updatedAt + grace];
}

function relPathOf(filePath: string, root: string): string | null {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!filePath.startsWith(prefix)) return null;
  return filePath.slice(prefix.length);
}

export interface AttributeRepoOptions {
  repo: { url: string; root: string; name: string };
  sessions: SessionRecord[];
  /** sessionId → 该 session 在此 repo 里碰过的 repo 相对路径集合 */
  touchesBySession: Map<string, Set<string>>;
  /**
   * 有任何 touch 数据的 session 集合。在列的 session:candidate 必须有文件
   * 交集才落表;不在列的(如 codex/grok,工具入参里少有结构化路径)保留
   * 时间窗 candidate,由调用方按 session 封顶。declared(trailer)不受此限。
   */
  touchedSessionIds?: Set<string>;
  /**
   * 远端已有(remote-tracking)的 sha 集合,用于标 pushed。null = 远端查询
   * 失败,pushed 置 undefined(调用方按已推送存,维持旧行为)。
   */
  remoteShas?: Set<string> | null;
  git: GitRunner;
  graceMs?: number;
  maxCommits?: number;
}

/** 单 repo 的 commit 归因:一次 git log,trailer 优先,否则时间窗 candidate。 */
export function attributeRepoCommits(options: AttributeRepoOptions): SessionCommit[] {
  const { repo, sessions, touchesBySession, git } = options;
  const grace = options.graceMs ?? SESSION_GRACE_MS;
  const maxCommits = options.maxCommits ?? COMMIT_LOG_MAX;
  if (sessions.length === 0) return [];
  const since = Math.min(...sessions.map((s) => windowOf(s, grace)[0]));
  const until = Math.max(...sessions.map((s) => windowOf(s, grace)[1]));
  let raw = '';
  try {
    raw = git([
      '-C', repo.root,
      // --exclude 必须在 --all 之前(stash);--no-merges 在 git 层挡 merge commit
      'log', '--exclude=refs/stash', '--all', '--no-merges',
      `--since=${new Date(since).toISOString()}`,
      `--until=${new Date(until).toISOString()}`,
      '-n', String(maxCommits),
      '-z', '--format=%H%x00%cI%x00%s%x00%b%x00',
      '--name-only',
    ]);
  } catch {
    return []; // git 失败/超时:跳过该 repo,不拖垮整趟扫描
  }
  const out: SessionCommit[] = [];
  const remoteShas = options.remoteShas ?? null;
  const pushedOf = (sha: string): boolean | undefined => (
    remoteShas == null ? undefined : remoteShas.has(sha)
  );
  for (const commit of parseGitLogFiles(raw)) {
    if (commit.committedAt < since || commit.committedAt > until) continue;
    const overlapOf = (session: SessionRecord): boolean => {
      const touched = touchesBySession.get(session.id);
      if (!touched || touched.size === 0) return false;
      return commit.files.some((file) => touched.has(file));
    };
    const declared = sessions.filter((session) => (
      parseTrailers(commit.body).some((trailer) => sessionMatchesTrailer(session, trailer.value))
    ));
    if (declared.length > 0) {
      for (const session of declared) {
        out.push({
          sessionId: session.id,
          repo: repo.url,
          sha: commit.sha,
          kind: 'declared',
          ts: commit.committedAt,
          summary: commit.subject,
          fileOverlap: overlapOf(session),
          pushed: pushedOf(commit.sha),
        });
      }
      continue;
    }
    // candidate:时间窗重叠;stash 类提交不进 candidate;有 touch 数据的
    // session 必须有文件交集;文件交集提高置信度,排序优先并截断上限
    if (STASH_SUBJECT_RE.test(commit.subject)) continue;
    const touched = options.touchedSessionIds ?? new Set<string>();
    const candidates = sessions
      .filter((session) => {
        const [from, to] = windowOf(session, grace);
        return commit.committedAt >= from && commit.committedAt <= to;
      })
      .map((session) => ({ session, overlap: overlapOf(session) }))
      .filter(({ session, overlap }) => !touched.has(session.id) || overlap)
      .sort((a, b) => Number(b.overlap) - Number(a.overlap) || b.session.updatedAt - a.session.updatedAt)
      .slice(0, CANDIDATE_PER_COMMIT_MAX);
    for (const { session, overlap } of candidates) {
      out.push({
        sessionId: session.id,
        repo: repo.url,
        sha: commit.sha,
        kind: 'candidate',
        ts: commit.committedAt,
        summary: commit.subject,
        fileOverlap: overlap,
        pushed: pushedOf(commit.sha),
      });
    }
  }
  return out;
}

const REPO_YIELD_BATCH = 5;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 归因 pass:挂在 collectSessionCatalog 末尾。只在 scan 窗口内、有
 * work/touch repo 的 session 上跑;先清后算,幂等可重放。
 */
export async function collectSessionCommits(
  store: Store,
  options: { since?: number; until?: number; git?: GitRunner | null } = {},
): Promise<number> {
  const git = options.git === undefined ? boundedGitRunner() : options.git;
  if (!git) return 0;
  const since = options.since ?? Date.now() - 30 * 86_400_000;
  const until = options.until ?? Date.now();

  const sessions = store.listSessionRows().filter((session) => (
    session.updatedAt >= since && session.updatedAt < until
  ));
  const byRepo = new Map<string, { repo: SessionRepo; sessions: SessionRecord[] }>();
  for (const session of sessions) {
    for (const repo of session.repos ?? []) {
      if (repo.role === 'commit' || !repo.root) continue;
      const group = byRepo.get(repo.url) ?? { repo, sessions: [] };
      if (!group.sessions.some((s) => s.id === session.id)) group.sessions.push(session);
      byRepo.set(repo.url, group);
    }
  }
  if (byRepo.size === 0) return 0;

  // 重算前先清掉本次覆盖的 session 的旧归因;滚出窗口的 session 的行也一并清掉
  //(它们不会再被重算,留着只会带着旧口径腐烂)
  store.deleteSessionCommitsFor(sessions.map((s) => s.id));
  store.deleteSessionCommitsBefore(since);

  const touchedSessionIds = store.listTouchedSessionIds();
  const all: SessionCommit[] = [];
  let processed = 0;
  for (const { repo, sessions: repoSessions } of byRepo.values()) {
    const touchesBySession = new Map<string, Set<string>>();
    for (const row of store.listTouchesUnderRoot(repo.root!)) {
      const rel = relPathOf(row.filePath, repo.root!);
      if (!rel) continue;
      const set = touchesBySession.get(row.sessionId) ?? new Set<string>();
      set.add(rel);
      touchesBySession.set(row.sessionId, set);
    }
    // pushed 标记:每 repo 一次有界调用拿 remote-tracking 已有的 sha 集合
    //(以本地 fetch 状态为准,近似「GitHub 上是否存在」);失败 → null →
    // pushed 全部按未知处理,不拖垮归因
    let remoteShas: Set<string> | null = null;
    try {
      const raw = git([
        '-C', repo.root!,
        'log', '--remotes', '--format=%H',
        `--since=${new Date(since).toISOString()}`,
        '-n', '1000',
      ]);
      remoteShas = new Set(raw.split('\n').map((line) => line.trim()).filter(Boolean));
    } catch {
      remoteShas = null;
    }
    try {
      all.push(...attributeRepoCommits({ repo, sessions: repoSessions, touchesBySession, touchedSessionIds, remoteShas, git }));
    } catch {
      /* 单 repo 归因失败不拖垮整趟扫描 */
    }
    processed += 1;
    if (processed % REPO_YIELD_BATCH === 0) await yieldEventLoop();
  }

  // 无 touch 数据的 session:candidate 每 session 封顶(跨 repo 全局,ts 近者优先);
  // declared 和有文件交集的 candidate 不受限
  const uncapped = all.filter((row) => row.kind === 'declared' || touchedSessionIds.has(row.sessionId));
  const cappedBySession = new Map<string, SessionCommit[]>();
  for (const row of all) {
    if (row.kind === 'declared' || touchedSessionIds.has(row.sessionId)) continue;
    const list = cappedBySession.get(row.sessionId) ?? [];
    list.push(row);
    cappedBySession.set(row.sessionId, list);
  }
  const capped: SessionCommit[] = [];
  for (const rows of cappedBySession.values()) {
    rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    capped.push(...rows.slice(0, CANDIDATE_PER_SESSION_MAX));
  }
  const rows = [...uncapped, ...capped];
  store.upsertSessionCommits(rows);
  return rows.length;
}
