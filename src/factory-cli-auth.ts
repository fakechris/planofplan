import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';

/**
 * droid CLI（~/.factory/）登录态读取。
 *
 * CLI 的 auth 是 WorkOS 轮换链（refresh token 一次性），不是长效 API key：
 * daemon 兑换会消耗 CLI 的 token，把正在运行的 droid 踢回登录。因此这里
 * 只作为手动恢复入口（planofplan factory-auth），不做自动轮询凭据源。
 *
 * 存储规格（droid 二进制内字符串逆向确认）：
 * - 文件 `<iv>:<tag>:<cipher>` base64，AES-256-GCM，明文 JSON
 *   { access_token, refresh_token, active_organization_id, region }
 * - 变体 auth.v2.loginkeychain：key 在 Keychain service "Factory CLI"、
 *   account auth-encryption-key-security-cli（非生产构建追加 -dev）
 * - 变体 auth.v2.keyring：同上，account auth-encryption-key
 * - 变体 auth.v2.file：key 在 auth.v2.key（base64 32B）
 */

const KEYCHAIN_SERVICE = 'Factory CLI';
const LOGIN_KEYCHAIN_ACCOUNT = 'auth-encryption-key-security-cli';
const KEYRING_ACCOUNT = 'auth-encryption-key';
const DEV_SUFFIX = '-dev';

export interface FactoryCliAuth {
  accessToken: string | null;
  refreshToken: string;
  organizationId: string | null;
  source: string;
}

interface AuthPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  active_organization_id?: unknown;
}

function decryptAuthBlob(blob: string, key: Buffer): AuthPayload | null {
  const parts = blob.trim().split(':');
  if (parts.length !== 3 || key.length !== 32) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0]!, 'base64'));
    decipher.setAuthTag(Buffer.from(parts[1]!, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as AuthPayload;
  } catch {
    return null;
  }
}

async function readKeychainKey(account: string): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const proc = Bun.spawn(
      ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' },
    );
    const timer = setTimeout(() => proc.kill(), 8_000);
    const stdout = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    const raw = stdout.trim();
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function readFileKey(path: string): Buffer | null {
  try {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function parseAuthPayload(payload: AuthPayload | null, source: string): FactoryCliAuth | null {
  const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token.trim() : '';
  if (!refreshToken) return null;
  return {
    accessToken: typeof payload?.access_token === 'string' && payload.access_token.trim()
      ? payload.access_token.trim()
      : null,
    refreshToken,
    organizationId: typeof payload?.active_organization_id === 'string'
      ? payload.active_organization_id.trim()
      : null,
    source,
  };
}

/**
 * 按优先级读取 droid CLI 登录态：loginkeychain（当前默认）→ keyring →
 * keyfile。任一变体解密失败（CLI 未登录 / 格式变化）返回 null。
 */
export async function readFactoryCliAuth(
  baseDir = join(homedir(), '.factory'),
): Promise<FactoryCliAuth | null> {
  const variants: Array<{ file: string; source: string; key: () => Promise<Buffer | null> }> = [
    {
      file: 'auth.v2.loginkeychain',
      source: 'droid CLI keychain',
      key: async () => await readKeychainKey(LOGIN_KEYCHAIN_ACCOUNT)
        ?? await readKeychainKey(LOGIN_KEYCHAIN_ACCOUNT + DEV_SUFFIX),
    },
    {
      file: 'auth.v2.keyring',
      source: 'droid CLI keyring',
      key: async () => await readKeychainKey(KEYRING_ACCOUNT)
        ?? await readKeychainKey(KEYRING_ACCOUNT + DEV_SUFFIX),
    },
    {
      file: 'auth.v2.file',
      source: 'droid CLI keyfile',
      key: async () => readFileKey(join(baseDir, 'auth.v2.key')),
    },
  ];
  for (const variant of variants) {
    const path = join(baseDir, variant.file);
    if (!existsSync(path)) continue;
    const key = await variant.key();
    if (!key) continue;
    const parsed = parseAuthPayload(
      decryptAuthBlob(readFileSync(path, 'utf8'), key),
      variant.source,
    );
    if (parsed) return parsed;
  }
  return null;
}
