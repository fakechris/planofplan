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

export function readCredential(id: string): StoredCredential | null {
  return loadAll()[id] ?? null;
}

export function writeCredential(id: string, value: string): void {
  const all = loadAll();
  all[id] = { kind: 'bearer', value };
  const file = credentialsFile();
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
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
