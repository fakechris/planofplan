/**
 * Git project identity from a session cwd.
 *
 * The project is the enclosing git repository (origin URL / root), not the
 * cwd basename. ~/source/dsh/explorer is not a project; dsh-track is.
 * Filesystem-observed only — never claimed as declared evidence.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface RepoRef {
  url: string;
  root: string;
  name: string;
}

const rootCache = new Map<string, string | undefined>();
const urlCache = new Map<string, string>();

export function _clearRepoCache(): void {
  rootCache.clear();
  urlCache.clear();
}

function hasGitMarker(dir: string): boolean {
  try {
    const st = statSync(`${dir}/.git`);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

export function repoRootOf(path: string): string | undefined {
  const cached = rootCache.get(path);
  if (cached !== undefined || rootCache.has(path)) return cached;
  let dir = path;
  for (let i = 0; i < 16 && dir.length > 1; i++) {
    if (hasGitMarker(dir)) {
      const marker = `${dir}/.git`;
      let root = dir;
      try {
        if (statSync(marker).isFile()) {
          const match = readFileSync(marker, 'utf8').match(/gitdir:\s*(.+)/);
          if (match) {
            let gitDir = match[1]!.trim();
            if (gitDir.includes('$GIT_DIR')) gitDir = gitDir.replace(/\$GIT_DIR/g, dir);
            const stripped = gitDir.replace(/\/worktrees\/[^/]+$/, '');
            const parent = dirname(stripped);
            if (parent && parent !== '.' && existsSync(parent)) root = parent;
          }
        }
      } catch {
        /* keep dir as root */
      }
      rootCache.set(path, root);
      return root;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  rootCache.set(path, undefined);
  return undefined;
}

export function repoUrlOf(root: string): string | undefined {
  const cached = urlCache.get(root);
  if (cached !== undefined) return cached || undefined;
  try {
    const config = readFileSync(`${root}/.git/config`, 'utf8');
    const origin = config.match(/\[remote\s+"?origin"?\][^\[]*?url\s*=\s*(\S+)/);
    const url = origin?.[1];
    urlCache.set(root, url ?? '');
    return url;
  } catch {
    urlCache.set(root, '');
    return undefined;
  }
}

export function nameOfUrl(url: string): string {
  const tail = (url.split('/').pop() ?? url).replace(/\.git$/, '');
  return tail || url;
}

/** 计划页「项目」= 仓库短名;非 git 目录没有 repo,全部归入这一个桶(下拉框的选项值也是它)。 */
export const PLAN_NO_REPO_NAME = '(非 git 目录)';

export function planRepoNameOf(repo: string | null | undefined): string {
  return repo ? nameOfUrl(repo) : PLAN_NO_REPO_NAME;
}

/**
 * 归一化仓库身份 URL(INV-2198):
 * - https://github.com/org/repo.git ↔ https://github.com/org/repo ↔ git@github.com:org/repo.git
 *   统一归一为小写的 `host/org/repo`
 * - file:///path/to/repo → `/path/to/repo`
 * - 本地路径去尾斜杠
 */
export function canonicalRepoUrl(url: string): string {
  let s = url.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (s.startsWith('file://')) {
    return s.slice('file://'.length).replace(/\/+$/, '') || '/';
  }
  const scp = /^(?:[^@\s]+@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(s);
  if (scp && !s.startsWith('/') && !/^[a-zA-Z]+:\/\//.test(s)) {
    const host = scp[1]!.toLowerCase();
    const path = scp[2]!.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
    return `${host}/${path}`;
  }
  const proto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/.exec(s);
  if (proto) {
    const host = proto[1]!.toLowerCase();
    const path = proto[2]!.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
    return `${host}/${path}`;
  }
  return s;
}

export function isRemoteRepoUrl(url: string): boolean {
  const s = url.trim();
  if (!s || s.startsWith('/') || s.startsWith('file://')) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) || /^(?:[^@\s]+@)?[A-Za-z0-9.-]+:[^/]/.test(s);
}

/** 只读外部工具/Skill/依赖缓存/SDK/Agent 内部目录判定(供项目页默认折叠噪音,不删数据)。 */
const TOOL_OR_NOISE_PATH_RE = /(?:^\/opt\/homebrew(?:\/|$)|^\/usr\/local\/(?:Homebrew|Cellar)(?:\/|$)|\/\.skills\/|\/\.agents\/skills\/|\/\.claude\/|\/\.codex\/|\/\.gemini\/|\/\.cargo\/|\/\.rustup\/|\/\.cache\/|\/\.npm\/|\/\.local\/share\/|\/Library\/Caches\/|\/node_modules\/|\/esp\/esp-idf|\/research\/20\d\d-|\/analysis\/sources\/|\/github\/repos\/|^\/(?:private\/)?tmp\/)/i;

export function isToolOrNoiseRoot(root: string | null | undefined): boolean {
  if (!root) return false;
  return TOOL_OR_NOISE_PATH_RE.test(root);
}

export interface CanonicalProjectGroup<T extends { id: string; url: string; name: string; root: string | null; lastSeenAt: number }> {
  primary: T;
  aliases: T[];
  aliasUrls: string[];
  aliasNames: string[];
  hasGit: boolean;
  isToolRepo: boolean;
}

/**
 * 将裂变的同源项目非破坏性地归并为逻辑主项目(INV-2198):
 * 1) 共享 canonicalRepoUrl(如 lumenbox.git 与 lumenbox)
 * 2) 退化本地路径与远程主仓共享相同 root(如 /Users/.../agentbox → fakechris/lumenbox.git)
 * 3) 兄弟 worktree 退化路径(<primaryRoot>-<suffix>,如 agentbox-r30 / agentbox-wt-review)
 * 4) 非 git 父包装目录且其直接下级恰好只有唯一一个主 git 仓库(如 .../grokbot → .../grokbot/agentbox)
 */
export function groupCanonicalProjects<T extends { id: string; url: string; name: string; root: string | null; lastSeenAt: number }>(
  projects: T[],
  options: { hasGitDir?: (root: string) => boolean } = {},
): Array<CanonicalProjectGroup<T>> {
  const rawHasGitDir = options.hasGitDir ?? ((r: string) => hasGitMarker(r));
  const gitDirMemo = new Map<string, boolean>();
  const hasGitDir = (r: string): boolean => {
    const cached = gitDirMemo.get(r);
    if (cached !== undefined) return cached;
    const hit = rawHasGitDir(r);
    gitDirMemo.set(r, hit);
    return hit;
  };
  const checkHasGit = (p: T): boolean => {
    if (isRemoteRepoUrl(p.url)) return true;
    return Boolean(p.root && hasGitDir(p.root));
  };
  const scorePrimary = (p: T): number => {
    let sc = 0;
    if (isRemoteRepoUrl(p.url)) sc += 100;
    if (p.url.endsWith('.git')) sc += 10;
    if (p.root && hasGitDir(p.root)) sc += 50;
    if (p.root && !isToolOrNoiseRoot(p.root)) sc += 20;
    if (p.name && !p.name.startsWith('/')) sc += 5;
    if (!p.url.endsWith('/')) sc += 2;
    return sc;
  };
  const pickPrimary = (items: T[]): T => (
    [...items].sort((a, b) => scorePrimary(b) - scorePrimary(a) || b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id))[0]!
  );

  // Step 1: 按 canonicalRepoUrl 归组
  const byCanon = new Map<string, T[]>();
  for (const p of projects) {
    const key = canonicalRepoUrl(p.url) || p.url;
    const arr = byCanon.get(key) ?? [];
    arr.push(p);
    byCanon.set(key, arr);
  }
  let groups: Array<{ primary: T; members: T[] }> = [...byCanon.values()].map((members) => ({
    primary: pickPrimary(members),
    members,
  }));

  // 选出「远程/真 git 主仓」索引:按 root 建图
  const primaryByRoot = new Map<string, { primary: T; members: T[] }>();
  for (const g of groups) {
    if (g.primary.root && (isRemoteRepoUrl(g.primary.url) || hasGitDir(g.primary.root))) {
      const r = g.primary.root.replace(/\/+$/, '');
      const existing = primaryByRoot.get(r);
      if (!existing || scorePrimary(g.primary) > scorePrimary(existing.primary)) {
        primaryByRoot.set(r, g);
      }
    }
  }

  // 统计每个父目录直接包含的「非工具主 git 仓」数量(用于单仓父目录如 grokbot → agentbox)
  const childrenByParent = new Map<string, Array<{ primary: T; members: T[] }>>();
  for (const [r, g] of primaryByRoot.entries()) {
    if (isToolOrNoiseRoot(r)) continue;
    const parent = dirname(r);
    if (!parent || parent === '/' || parent === r) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(g);
    childrenByParent.set(parent, list);
  }

  // Step 2/3/4: 将退化路径项目归并到对应的主仓
  const mergedInto = new Map<object, { primary: T; members: T[] }>();
  const sortedPrimaryRoots = [...primaryByRoot.keys()].sort((a, b) => b.length - a.length);
  for (const g of groups) {
    if (isRemoteRepoUrl(g.primary.url)) continue;
    const rawPath = (g.primary.root ?? g.primary.url).replace(/\/+$/, '');
    if (!rawPath.startsWith('/')) continue;

    // 2) 同 root 退化路径(e.g. /Users/.../grokbot/agentbox → lumenbox.git)
    const sameRoot = primaryByRoot.get(rawPath);
    if (sameRoot && sameRoot !== g) {
      mergedInto.set(g, sameRoot);
      continue;
    }

    // 3) 兄弟 worktree 退化路径(e.g. /Users/.../grokbot/agentbox-r30 → agentbox)
    if (!hasGitDir(rawPath)) {
      let wtTarget: { primary: T; members: T[] } | null = null;
      for (const pr of sortedPrimaryRoots) {
        if (rawPath.startsWith(`${pr}-`) && !rawPath.slice(pr.length + 1).includes('/')) {
          wtTarget = primaryByRoot.get(pr) ?? null;
          break;
        }
      }
      if (wtTarget && wtTarget !== g) {
        mergedInto.set(g, wtTarget);
        continue;
      }

      // 4) 非 git 父目录且直接下级恰好只有唯一主 git 仓(e.g. .../grokbot → .../grokbot/agentbox)
      const directKids = childrenByParent.get(rawPath);
      if (directKids && directKids.length === 1 && directKids[0] !== g) {
        mergedInto.set(g, directKids[0]!);
        continue;
      }
    }
  }

  for (const [child, target] of mergedInto.entries()) {
    const src = child as { primary: T; members: T[] };
    target.members.push(...src.members);
  }
  groups = groups.filter((g) => !mergedInto.has(g));

  return groups.map((g) => {
    const primary = pickPrimary(g.members);
    const aliases = g.members.filter((m) => m.id !== primary.id);
    const aliasUrls = [...new Set(g.members.map((m) => m.url))];
    const aliasNames = [...new Set(g.members.map((m) => m.name).filter((n) => n && n !== primary.name))];
    return {
      primary,
      aliases,
      aliasUrls,
      aliasNames,
      hasGit: checkHasGit(primary),
      isToolRepo: isToolOrNoiseRoot(primary.root),
    };
  });
}

export function repoRefOf(path: string): RepoRef | undefined {
  const root = repoRootOf(path);
  if (!root) return undefined;
  const url = repoUrlOf(root);
  return { url: url ?? root, root, name: nameOfUrl(url ?? root) };
}

export const UNMAPPED_PROJECT = '(unmapped)';

function uniqueNames(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = value?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function reposOf(session: { repos?: Array<{ role: string; name: string; url?: string }> | null }, role: string) {
  return (session.repos ?? []).filter((repo) => repo.role === role);
}

/** Work git: cwd walk-up. Where the session sat, not what it touched. */
export function sessionWorkProject(session: {
  gitName?: string | null;
  cwd: string | null;
  repos?: Array<{ role: string; name: string; url?: string }> | null;
}): string {
  const fromRepos = uniqueNames(reposOf(session, 'work').map((repo) => repo.name));
  if (fromRepos.length > 0) return fromRepos[0]!;
  const gitName = session.gitName?.trim();
  if (gitName) return gitName;
  if (!session.cwd) return '(unknown)';
  const base = basename(session.cwd.replace(/[/\\]+$/, ''));
  return base || session.cwd;
}

/** Touch git names in first-seen order. Empty when the log touched no repo. */
export function sessionTouchProjects(session: {
  repos?: Array<{ role: string; name: string; url?: string }> | null;
}): string[] {
  return uniqueNames(reposOf(session, 'touch').map((repo) => repo.name));
}

/**
 * Yarn / requirement project names: actual touched repos.
 * Work git is not a fallback — unmapped stays explicit.
 */
export function sessionYarnProjects(session: {
  repos?: Array<{ role: string; name: string; url?: string }> | null;
}): string[] {
  return sessionTouchProjects(session);
}

/**
 * Display / filter names: touch git if present, else work git.
 * Used so sessions without a log scan still appear under the cwd repo.
 */
export function sessionProjectNames(session: {
  gitName?: string | null;
  gitUrl?: string | null;
  gitRoot?: string | null;
  cwd: string | null;
  repos?: Array<{ role: string; name: string; url: string }> | null;
}): string[] {
  const touch = sessionTouchProjects(session);
  if (touch.length > 0) return touch;
  const work = sessionWorkProject(session);
  return work ? [work] : ['(unknown)'];
}

/** Display name: first touch git, else work git, else unknown. */
export function sessionProject(session: {
  gitName?: string | null;
  cwd: string | null;
  repos?: Array<{ role: string; name: string }> | null;
}): string {
  return sessionTouchProjects(session)[0] ?? sessionWorkProject(session);
}

/** Stable project id: origin URL, else git root, else cwd, else unknown. */
export function sessionProjectId(session: {
  gitUrl?: string | null;
  gitRoot?: string | null;
  cwd: string | null;
}): string {
  return session.gitUrl || session.gitRoot || session.cwd || '(unknown)';
}

export function projectIdOfRepo(repo: { url: string; root?: string | null }): string {
  return repo.url || repo.root || '(unknown)';
}

/** Absolute paths mentioned in a log record (file_path / workdir / git -C / bare paths). */
export function pathsOfRecord(record: unknown): string[] {
  if (record == null) return [];
  if (typeof record === 'string') return pathsIn(record);
  try {
    return [...new Set(pathsIn(JSON.stringify(record).slice(0, 32_000)))];
  } catch {
    return [];
  }
}

function pathsIn(text: string): string[] {
  const out: string[] = [];
  const re = /(?:file_path|workdir|path|cwd)\s*[:=]\s*"?([/][^\s"'\\,]+)|git\s+-C\s+([/][^\s"'\\,]+)|([/][^\s"'\\,)]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const path = (match[1] ?? match[2] ?? match[3])!;
    out.push(path.replace(/[`'"\\]+$/, ''));
  }
  return out;
}

/** Repos a set of log records actually touched, in first-seen order. */
export function reposOfRecords(records: readonly unknown[]): RepoRef[] {
  const seen = new Set<string>();
  const out: RepoRef[] = [];
  for (const record of records) {
    for (const path of pathsOfRecord(record)) {
      const ref = repoRefOf(path);
      if (!ref || seen.has(ref.url)) continue;
      seen.add(ref.url);
      out.push(ref);
    }
  }
  return out;
}
