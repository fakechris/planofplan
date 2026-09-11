import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHome } from './config.ts';

export interface StoredCredential {
  kind: 'bearer';
  value: string;
}

export function credentialsFile(): string {
  return join(ensureHome(), 'credentials.json');
}

function loadAll(): Record<string, StoredCredential> {
  const file = credentialsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredCredential>;
  } catch {
    return {};
  }
}

export function readCredential(id: string, env: NodeJS.ProcessEnv = process.env): StoredCredential | null {
  // `env:VAR_NAME` 前缀:从环境变量读(launchd EnvironmentVariables 注入,
  // 磁盘零明文;sourcebot {"token":{"env":..}} 同思路)。所有 adapter 与
  // LLM 层都经此漏斗,一处生效。
  if (id.startsWith('env:')) {
    const name = id.slice(4).trim();
    const value = name ? env[name]?.trim() : '';
    return value ? { kind: 'bearer', value } : null;
  }
  return loadAll()[id] ?? null;
}

export function writeCredential(id: string, value: string): void {
  const all = loadAll();
  all[id] = { kind: 'bearer', value };
  const file = credentialsFile();
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 已存凭据的 id 列表(设置页展示用)。 */
export function readAllCredentialIds(): string[] {
  return Object.keys(loadAll()).sort();
}

export function deleteCredential(id: string): void {
  const all = loadAll();
  delete all[id];
  const file = credentialsFile();
  if (Object.keys(all).length === 0) {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
    return;
  }
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
