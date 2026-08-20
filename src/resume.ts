/**
 * Native resume for WG-M4.
 * CLI: pick a working binary (skip broken Homebrew Codex wrappers).
 * DSH: open the web GUI URL. ZCode: open the GUI app.
 * Claude: prefer ~/.local/bin/claude.sh when present; override in config.json.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_RESUME, loadConfig } from './config.ts';
import type { ResumeConfig, ResumeKind, ResumeOverride, SessionRecord, SessionResume } from './types.ts';

export interface BinLookup {
  home?: string;
  path?: string;
  extraDirs?: string[];
  resume?: ResumeConfig;
}

interface ResumeSpec {
  kind: ResumeKind;
  names: string[];
  args: (id: string) => string[];
  missingReason?: string;
  label: string;
}

const BINS: Record<string, ResumeSpec> = {
  claude: { kind: 'cli', names: ['claude.sh', 'claude'], args: (id) => ['--resume', id], label: 'Resume' },
  codex: { kind: 'cli', names: ['codex'], args: (id) => ['resume', id], label: 'Resume' },
  grok: { kind: 'cli', names: ['grok'], args: (id) => ['--resume', id], label: 'Resume' },
  factory: { kind: 'cli', names: ['droid'], args: (id) => ['--resume', id], label: 'Resume' },
  kimi: { kind: 'cli', names: ['kimi', 'kimi-cli'], args: (id) => ['--session', id], label: 'Resume' },
  dsh: { kind: 'url', names: [], args: () => [], label: '打开 DSH' },
  zcode: { kind: 'app', names: [], args: () => [], missingReason: '未找到 ZCode.app', label: '打开 ZCode' },
};

const binCache = new Map<string, string | null>();

export function _clearBinCache(): void {
  binCache.clear();
}

function extraBinDirs(home: string): string[] {
  const dirs = [
    join(home, '.grok', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'bin'),
    join(home, '.codebuddy', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const nvm = join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvm)) {
    try {
      for (const version of readdirSync(nvm)) {
        dirs.push(join(nvm, version, 'bin'));
      }
    } catch {
      /* ignore */
    }
  }
  return dirs;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function candidateDirs(lookup: BinLookup): string[] {
  const home = lookup.home ?? homedir();
  const pathDirs = (lookup.path ?? process.env.PATH ?? '').split(':').filter(Boolean);
  const extras = lookup.extraDirs ?? extraBinDirs(home);
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [...pathDirs, ...extras]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function readHead(path: string, bytes = 80): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function isNodeScript(path: string): boolean {
  const head = readHead(path);
  return head.startsWith('#!') && head.includes('node');
}

function darwinTriple(): string {
  return process.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
}

/** Homebrew global @openai/codex often has a wrapper but no vendor binary. Prefer the native. */
export function resolveCodexNative(wrapper: string): string | null {
  let script = wrapper;
  try {
    script = realpathSync(wrapper);
  } catch {
    script = wrapper;
  }
  const pkgRoot = join(dirname(script), '..');
  const triple = darwinTriple();
  const pkg = process.arch === 'x64' ? '@openai/codex-darwin-x64' : '@openai/codex-darwin-arm64';
  const candidates = [
    join(pkgRoot, 'node_modules', pkg, 'vendor', triple, 'bin', 'codex'),
    join(pkgRoot, 'node_modules', pkg, 'vendor', triple, 'codex', 'codex'),
    join(pkgRoot, 'vendor', triple, 'bin', 'codex'),
    join(pkgRoot, 'vendor', triple, 'codex', 'codex'),
  ];
  return candidates.find((path) => isExecutable(path)) ?? null;
}

function healthyBin(path: string, name: string): string | null {
  if (name === 'codex' || path.endsWith('/codex')) {
    if (isNodeScript(path)) return resolveCodexNative(path);
    return path;
  }
  return path;
}

export function findExecutable(names: string[], lookup: BinLookup = {}): string | null {
  const cacheKey = lookup.home || lookup.path || lookup.extraDirs
    ? JSON.stringify([names, lookup.home ?? '', lookup.path ?? '', lookup.extraDirs ?? []])
    : names.join('|');
  if (binCache.has(cacheKey)) return binCache.get(cacheKey) ?? null;
  const home = lookup.home ?? homedir();
  for (const name of names) {
    const raw = name.includes('/') || name.startsWith('~') ? expandHome(name, home) : null;
    if (raw) {
      if (isExecutable(raw)) {
        const healthy = healthyBin(raw, basename(raw));
        if (healthy) {
          binCache.set(cacheKey, healthy);
          return healthy;
        }
      }
      continue;
    }
    for (const dir of candidateDirs(lookup)) {
      const path = join(dir, name);
      if (!isExecutable(path)) continue;
      const healthy = healthyBin(path, name);
      if (healthy) {
        binCache.set(cacheKey, healthy);
        return healthy;
      }
    }
  }
  binCache.set(cacheKey, null);
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function effectiveResume(lookup: BinLookup): ResumeConfig {
  if (lookup.resume) return lookup.resume;
  try {
    return loadConfig().resume ?? DEFAULT_RESUME;
  } catch {
    return DEFAULT_RESUME;
  }
}

function interpolate(template: string, session: SessionRecord): string {
  return template
    .replaceAll('{id}', session.nativeId)
    .replaceAll('{cwd}', session.cwd ?? '');
}

function appBundle(name: string): string {
  return name.endsWith('.app') ? `/Applications/${name}` : `/Applications/${name}.app`;
}

function resumeOverride(session: SessionRecord, lookup: BinLookup): ResumeOverride {
  return effectiveResume(lookup)[session.provider] ?? {};
}

function specFor(provider: string): ResumeSpec | undefined {
  return BINS[provider];
}

export function resumeCommand(
  session: SessionRecord,
  lookup: BinLookup = {},
): { argv: string[]; display: string; kind: ResumeKind; label: string; env?: Record<string, string> } | null {
  const spec = specFor(session.provider);
  const over = resumeOverride(session, lookup);
  const kind = over.kind ?? spec?.kind ?? 'cli';
  const label = spec?.label ?? 'Resume';

  if (kind === 'url') {
    const url = interpolate(over.url ?? 'http://127.0.0.1:3080/', session);
    return { argv: ['open', url], display: url, kind, label };
  }

  if (kind === 'app') {
    const app = over.app ?? 'ZCode';
    if (!existsSync(appBundle(app))) return null;
    if (session.cwd) {
      const url = interpolate(over.url ?? 'zcode://workspace/open?path={cwd}', session);
      return { argv: ['open', url], display: url, kind, label };
    }
    return { argv: ['open', '-a', app], display: `open -a ${app}`, kind, label };
  }

  const names = over.bin ? [over.bin] : spec?.names ?? [];
  if (names.length === 0) return null;
  const bin = findExecutable(names, lookup);
  if (!bin) return null;
  const extra = over.args?.map((arg) => interpolate(arg, session))
    ?? spec?.args(session.nativeId)
    ?? ['--resume', session.nativeId];
  const argv = [bin, ...extra];
  const envPrefix = over.env
    ? Object.keys(over.env).map((key) => `${key}=…`).join(' ') + ' '
    : '';
  return {
    argv,
    display: `${envPrefix}${argv.map(shellQuote).join(' ')}`.trim(),
    kind,
    label,
    env: over.env,
  };
}

export function resumeFor(session: SessionRecord, lookup: BinLookup = {}): SessionResume {
  const spec = specFor(session.provider);
  const over = resumeOverride(session, lookup);
  if (!spec && !over.kind && !over.bin && !over.url && !over.app) {
    return { available: false, command: null, reason: `${session.provider} 没有已知的 resume CLI` };
  }
  const command = resumeCommand(session, lookup);
  if (!command) {
    return {
      available: false,
      command: null,
      reason: spec?.missingReason ?? `未找到 ${spec?.names.join('/') ?? session.provider}，装好 CLI 后再 resume`,
    };
  }
  return {
    available: true,
    command: command.display,
    kind: command.kind,
    label: command.label,
  };
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function launchResume(
  session: SessionRecord,
  lookup: BinLookup = {},
): { ok: boolean; error?: string; command?: string } {
  const command = resumeCommand(session, lookup);
  if (!command) {
    const info = resumeFor(session, lookup);
    return { ok: false, error: info.reason ?? 'resume 不可用' };
  }
  if (command.kind === 'url' || command.kind === 'app') {
    const result = spawnSync(command.argv[0]!, command.argv.slice(1), { encoding: 'utf8' });
    if (result.status !== 0) {
      return { ok: false, error: result.stderr.trim() || '无法打开', command: command.display };
    }
    return { ok: true, command: command.display };
  }
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Resume 目前只在 macOS Terminal 里启动', command: command.display };
  }
  const pieces: string[] = [];
  if (command.env) {
    for (const [key, value] of Object.entries(command.env)) {
      pieces.push(`export ${key}=${shellQuote(value)}`);
    }
  }
  if (session.cwd) pieces.push(`cd ${shellQuote(session.cwd)}`);
  pieces.push(command.argv.map(shellQuote).join(' '));
  const script = `tell application "Terminal" to do script ${appleScriptString(pieces.join(' && '))}`;
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() || '无法打开 Terminal', command: command.display };
  }
  return { ok: true, command: command.display };
}
