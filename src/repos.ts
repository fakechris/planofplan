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
