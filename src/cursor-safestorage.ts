/**
 * Cursor safeStorage 凭据解密（INV-2016）。
 *
 * Cursor 新版把 state.vscdb `cursorAuth/accessToken` 从明文 JWT 改为 Electron
 * safeStorage 密文：`cursor-safe-storage:v1:` + base64("v10" + AES-128-CBC 密文)。
 * 本机破译（2026-11-22，密钥矩阵实测）：**Linux 风格 os_crypt**——
 *   key = PBKDF2(Keychain 密码, "saltysalt", 1003, SHA1, 16 字节)
 *   IV  = 16 个空格（固定，不内嵌在载荷里）
 *   密文 = "v10" 之后的全部字节（macOS 原生 Chromium 的「内嵌 IV」方案
 *   与原始密码直用方案均已实测排除——BAD_DECRYPT）。
 * Keychain 条目：service `Cursor Safe Storage`（account "Cursor Key"）。
 *
 * Fail-soft 原则：Keychain 被拒/解密失败一律返回 null（交由 adapter 的
 * credentialHint 路径），绝不抛错带崩轮询。首次读 Keychain 会弹一次系统
 * 授权窗，用户点「始终允许」后一劳永逸；结果（含失败）进程内缓存，
 * 避免每轮轮询都弹窗。密钥与解密结果只在内存使用，不落日志。
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PREFIX = 'cursor-safe-storage:v1:';
const KEYCHAIN_SERVICE = 'Cursor Safe Storage';
/** Chromium Linux os_crypt 的固定参数（Cursor safeStorage 实测沿用）。 */
const PBKDF2_SALT = 'saltysalt';
const PBKDF2_ITERATIONS = 1003;
const FIXED_IV = Buffer.alloc(16, 0x20);

export function isCursorSafeStorageValue(value: string): boolean {
  return value.startsWith(PREFIX);
}

function readKeychainDefault(service: string): string | null {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    /* 用户拒绝授权 / 条目不存在 / security 不可用 */
    return null;
  }
}

let cachedKey: Buffer | null | undefined;

/** Keychain 密码 → PBKDF2 派生的 16 字节 AES 密钥（Chromium saltysalt 方案）。 */
function keyFromPassword(password: string): Buffer {
  return pbkdf2Sync(password, PBKDF2_SALT, PBKDF2_ITERATIONS, 16, 'sha1');
}

/** 读 Keychain "Cursor Safe Storage" 并派生密钥（进程内缓存）。readKeychain 供测试注入。 */
export function cursorSafeStorageKey(
  readKeychain: (service: string) => string | null = readKeychainDefault,
): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const password = readKeychain(KEYCHAIN_SERVICE);
  cachedKey = password == null ? null : keyFromPassword(password);
  return cachedKey;
}

/** 解密 `cursor-safe-storage:v1:` 值 → 明文（JWT）。任何失败返回 null。 */
export function decryptCursorSafeStorage(value: string, key: Buffer | null): string | null {
  if (!value.startsWith(PREFIX) || key == null) return null;
  try {
    const data = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (data.length < 20 || data.subarray(0, 3).toString('latin1') !== 'v10') return null;
    const ciphertext = data.subarray(3);
    const decipher = createDecipheriv('aes-128-cbc', key, FIXED_IV);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const text = plain.toString('utf8');
    return text === '' ? null : text;
  } catch {
    /* 错误密钥的 padding 错误 / base64 损坏等 */
    return null;
  }
}

/** 测试专用：重置密钥缓存。 */
export function resetCursorKeyCacheForTests(): void {
  cachedKey = undefined;
}

/** 测试专用：注入密钥（跳过 Keychain）。 */
export function setCursorKeyCacheForTests(key: Buffer | null): void {
  cachedKey = key;
}
