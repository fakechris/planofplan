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
  /** 注入平台(win32 分支单测用);缺省取 process.platform。 */
  platform?: string;
  /** 注入架构;缺省取 process.arch。 */
  arch?: string;
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
  opencode: { kind: 'cli', names: ['opencode', 'opencode2'], args: (id) => ['-s', id], label: '打开 OpenCode' },
  amp: { kind: 'cli', names: ['amp'], args: (id) => ['threads', 'continue', id], label: '打开 Amp' },
};

const binCache = new Map<string, string | null>();

export function _clearBinCache(): void {
  binCache.clear();
}

function extraBinDirs(home: string, platform: string): string[] {
  const dirs = [
    join(home, '.grok', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.amp', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'bin'),
    join(home, '.codebuddy', 'bin'),
  ];
  if (platform === 'win32') {
    // npm 全局 shim(claude.cmd / codex.cmd 等)的 Windows 落点
    dirs.push(join(home, 'AppData', 'Roaming', 'npm'));
    return dirs;
  }
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
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

function lookupPlatform(lookup: BinLookup): string {
  return lookup.platform ?? process.platform;
}

function candidateDirs(lookup: BinLookup): string[] {
  const home = lookup.home ?? homedir();
  const platform = lookupPlatform(lookup);
  const pathSep = platform === 'win32' ? ';' : ':';
  const pathDirs = (lookup.path ?? process.env.PATH ?? '').split(pathSep).filter(Boolean);
  const extras = lookup.extraDirs ?? extraBinDirs(home, platform);
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

interface CodexPlatformVariant {
  triple: string;
  pkg: string;
  binNames: string[];
}

/** @openai/codex 按平台分发 vendor 二进制的三元组与 npm 包名(实测 npm optionalDependencies)。 */
export function codexPlatformVariant(platform: string, arch: string): CodexPlatformVariant | null {
  if (platform === 'darwin') {
    return arch === 'x64'
      ? { triple: 'x86_64-apple-darwin', pkg: '@openai/codex-darwin-x64', binNames: ['codex'] }
      : { triple: 'aarch64-apple-darwin', pkg: '@openai/codex-darwin-arm64', binNames: ['codex'] };
  }
  if (platform === 'win32') {
    return arch === 'x64'
      ? { triple: 'x86_64-pc-windows-msvc', pkg: '@openai/codex-win32-x64', binNames: ['codex.exe', 'codex'] }
      : { triple: 'aarch64-pc-windows-msvc', pkg: '@openai/codex-win32-arm64', binNames: ['codex.exe', 'codex'] };
  }
  return null;
}

/** Homebrew global @openai/codex often has a wrapper but no vendor binary. Prefer the native. */
export function resolveCodexNative(
  wrapper: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  let script = wrapper;
  try {
    script = realpathSync(wrapper);
  } catch {
    script = wrapper;
  }
  const variant = codexPlatformVariant(platform, arch);
  if (!variant) return null;
  const pkgRoot = join(dirname(script), '..');
  const candidates: string[] = [];
  for (const binName of variant.binNames) {
    candidates.push(
      join(pkgRoot, 'node_modules', variant.pkg, 'vendor', variant.triple, 'bin', binName),
      join(pkgRoot, 'node_modules', variant.pkg, 'vendor', variant.triple, 'codex', binName),
      join(pkgRoot, 'vendor', variant.triple, 'bin', binName),
      join(pkgRoot, 'vendor', variant.triple, 'codex', binName),
    );
  }
  return candidates.find((path) => isExecutable(path)) ?? null;
}

const CODEX_BIN_NAMES = new Set(['codex', 'codex.exe', 'codex.cmd']);

function healthyBin(path: string, name: string, platform: string): string | null {
  if (name === 'codex' || CODEX_BIN_NAMES.has(basename(path))) {
    if (isNodeScript(path)) return resolveCodexNative(path, platform);
    return path;
  }
  return path;
}

/** win32 下补齐 npm shim / PE 后缀;POSIX 原名优先。 */
export function binNameVariants(name: string, platform: string): string[] {
  if (platform !== 'win32' || name.includes('/') || name.includes('\\') || name.startsWith('~')) {
    return [name];
  }
  if (/\.(exe|cmd|bat|ps1)$/i.test(name)) return [name];
  return [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`];
}

export function findExecutable(names: string[], lookup: BinLookup = {}): string | null {
  const platform = lookupPlatform(lookup);
  const cacheKey = lookup.home || lookup.path || lookup.extraDirs || lookup.platform
    ? JSON.stringify([names, lookup.home ?? '', lookup.path ?? '', lookup.extraDirs ?? [], platform])
    : names.join('|');
  if (binCache.has(cacheKey)) return binCache.get(cacheKey) ?? null;
  const home = lookup.home ?? homedir();
  for (const name of names) {
    // Windows 盘符/反斜杠路径同样按直接路径处理,不进目录拼接
    const directPath = name.includes('/') || name.includes('\\') || name.startsWith('~') || /^[A-Za-z]:/.test(name);
    const raw = directPath ? expandHome(name, home) : null;
    if (raw) {
      if (isExecutable(raw)) {
        const healthy = healthyBin(raw, basename(raw), platform);
        if (healthy) {
          binCache.set(cacheKey, healthy);
          return healthy;
        }
      }
      continue;
    }
    for (const dir of candidateDirs(lookup)) {
      for (const variant of binNameVariants(name, platform)) {
        const path = join(dir, variant);
        if (!isExecutable(path)) continue;
        const healthy = healthyBin(path, name, platform);
        if (healthy) {
          binCache.set(cacheKey, healthy);
          return healthy;
        }
      }
    }
  }
  binCache.set(cacheKey, null);
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** cmd.exe 风格引号(展示与 cmd /k 链用):含空格或引号时整体双引号包裹。 */
export function cmdQuote(value: string): string {
  if (value === '') return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
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

/** 打开 URL 的平台启动器。 */
export function urlLaunchArgv(url: string, platform: string): string[] {
  if (platform === 'win32') return ['cmd.exe', '/c', 'start', '', url];
  if (platform === 'darwin') return ['open', url];
  return ['xdg-open', url];
}

export function resumeCommand(
  session: SessionRecord,
  lookup: BinLookup = {},
): { argv: string[]; display: string; kind: ResumeKind; label: string; env?: Record<string, string> } | null {
  const platform = lookupPlatform(lookup);
  const quote = platform === 'win32' ? cmdQuote : shellQuote;
  const spec = specFor(session.provider);
  const over = resumeOverride(session, lookup);
  const kind = over.kind ?? spec?.kind ?? 'cli';
  const label = spec?.label ?? 'Resume';

  if (kind === 'url') {
    const url = interpolate(over.url ?? 'http://127.0.0.1:3080/', session);
    const argv = urlLaunchArgv(url, platform);
    return { argv, display: url, kind, label };
  }

  if (kind === 'app') {
    // ZCode.app 方案是 macOS 专属;其余平台等价 GUI 启动暂不支持
    if (platform !== 'darwin') return null;
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
    display: `${envPrefix}${argv.map(quote).join(' ')}`.trim(),
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

/**
 * Windows 终端启动链:优先 Windows Terminal(wt),退回 cmd start 新窗口。
 * 内层命令经 cmd /k 执行,env 用 set 注入,.cmd shim 也能被 cmd 正确解析。
 */
export function windowsLaunchArgv(
  command: { argv: string[]; env?: Record<string, string> },
  session: { cwd?: string | null },
  hasWindowsTerminal: boolean,
): string[] {
  const parts: string[] = [];
  if (command.env) {
    for (const [key, value] of Object.entries(command.env)) {
      parts.push(`set "${key}=${value}"`);
    }
  }
  parts.push(command.argv.map(cmdQuote).join(' '));
  const chain = parts.join(' && ');
  const cwd = session.cwd ?? '.';
  if (hasWindowsTerminal) {
    return ['wt.exe', '-d', cwd, 'cmd', '/k', chain];
  }
  // start 的 title 必须带引号,否则该词会被当成要执行的程序
  return ['cmd.exe', '/c', 'start', '"planofplan"', '/D', cwd, 'cmd', '/k', chain];
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
  const platform = lookupPlatform(lookup);
  if (platform === 'win32') {
    const wt = findExecutable(['wt.exe'], lookup);
    const argv = windowsLaunchArgv(command, session, wt != null);
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
    if (result.status !== 0) {
      return { ok: false, error: result.stderr?.trim() || '无法打开 Windows Terminal', command: command.display };
    }
    return { ok: true, command: command.display };
  }
  if (platform !== 'darwin') {
    return { ok: false, error: 'Resume 目前支持 macOS Terminal 与 Windows Terminal', command: command.display };
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
