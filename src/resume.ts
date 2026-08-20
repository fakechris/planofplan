/**
 * Native CLI resume for WG-M4.
 * Only advertise Resume when a matching binary is on PATH. Never pretends to
 * deep-link into another agent's UI.
 */
import { spawnSync } from 'node:child_process';
import type { SessionRecord, SessionResume } from './types.ts';

const BINS: Record<string, { names: string[]; args: (id: string) => string[] }> = {
  claude: { names: ['claude'], args: (id) => ['--resume', id] },
  codex: { names: ['codex'], args: (id) => ['resume', id] },
  grok: { names: ['grok'], args: (id) => ['--resume', id] },
  factory: { names: ['droid'], args: (id) => ['--resume', id] },
  dsh: { names: ['dsh'], args: (id) => ['--profile', 'tui', '--resume', id] },
};

function which(names: string[]): string | null {
  for (const name of names) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    const path = result.stdout.trim();
    if (result.status === 0 && path) return path;
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function resumeCommand(session: SessionRecord): { argv: string[]; display: string } | null {
  const spec = BINS[session.provider];
  if (!spec) return null;
  const bin = which(spec.names);
  if (!bin) return null;
  const argv = [bin, ...spec.args(session.nativeId)];
  const display = argv.map(shellQuote).join(' ');
  return { argv, display };
}

export function resumeFor(session: SessionRecord): SessionResume {
  const spec = BINS[session.provider];
  if (!spec) {
    return { available: false, command: null, reason: `${session.provider} 没有已知的 resume CLI` };
  }
  const command = resumeCommand(session);
  if (!command) {
    return { available: false, command: null, reason: `未找到 ${spec.names.join('/')}，装好 CLI 后再 resume` };
  }
  return { available: true, command: command.display };
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function launchResume(session: SessionRecord): { ok: boolean; error?: string; command?: string } {
  const command = resumeCommand(session);
  if (!command) {
    const info = resumeFor(session);
    return { ok: false, error: info.reason ?? 'resume 不可用' };
  }
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Resume 目前只在 macOS Terminal 里启动', command: command.display };
  }
  const pieces: string[] = [];
  if (session.cwd) pieces.push(`cd ${shellQuote(session.cwd)}`);
  pieces.push(command.argv.map(shellQuote).join(' '));
  const script = `tell application "Terminal" to do script ${appleScriptString(pieces.join(' && '))}`;
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() || '无法打开 Terminal', command: command.display };
  }
  return { ok: true, command: command.display };
}
