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

/** Display name: git repo (origin tail / root basename), else cwd basename. */
export function sessionProject(session: {
  gitName?: string | null;
  cwd: string | null;
}): string {
  const gitName = session.gitName?.trim();
  if (gitName) return gitName;
  if (!session.cwd) return '(unknown)';
  const base = basename(session.cwd.replace(/[/\\]+$/, ''));
  return base || session.cwd;
}

/** Stable project id: origin URL, else git root, else cwd, else unknown. */
export function sessionProjectId(session: {
  gitUrl?: string | null;
  gitRoot?: string | null;
  cwd: string | null;
}): string {
  return session.gitUrl || session.gitRoot || session.cwd || '(unknown)';
}
