import { describe, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cursorSafeStorageKey,
  decryptCursorSafeStorage,
  isCursorSafeStorageValue,
  resetCursorKeyCacheForTests,
  setCursorKeyCacheForTests,
} from '../src/cursor-safestorage.ts';
import { cursorAdapter } from '../src/adapters/cursor.ts';
import type { AdapterContext, PlanConfig } from '../src/types.ts';

const PREFIX = 'cursor-safe-storage:v1:';

/** 按实测格式合成密文：PREFIX + base64("v10" + AES-128-CBC(明文))，
 * IV 固定 16 空格（Chromium Linux os_crypt 方案，INV-2016 破译）。 */
function encryptForTest(plaintext: string, key: Buffer): string {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const data = Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + data.toString('base64');
}

const KEY = randomBytes(16);

describe('cursor safeStorage 解密（INV-2016）', () => {
  test('识别前缀；往返解密恢复明文 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJnaXRodWJ8ODQ1MiIsImV4cjo9OTk5OTk5OTk5OX0.sig';
    expect(isCursorSafeStorageValue(jwt)).toBe(false);
    const sealed = encryptForTest(jwt, KEY);
    expect(isCursorSafeStorageValue(sealed)).toBe(true);
    expect(decryptCursorSafeStorage(sealed, KEY)).toBe(jwt);
  });

  test('错误密钥 / 损坏载荷 / 非 v10 头 / key=null 全部 fail-soft 返回 null', () => {
    const sealed = encryptForTest('eyJ.x.y', KEY);
    expect(decryptCursorSafeStorage(sealed, randomBytes(16))).toBeNull(); // padding 错
    expect(decryptCursorSafeStorage(PREFIX + Buffer.from('short').toString('base64'), KEY)).toBeNull();
    expect(decryptCursorSafeStorage(PREFIX + Buffer.concat([Buffer.from('v11'), randomBytes(48)]).toString('base64'), KEY)).toBeNull();
    expect(decryptCursorSafeStorage(sealed, null)).toBeNull();
    expect(decryptCursorSafeStorage('not-prefixed', KEY)).toBeNull();
  });
});

describe('cursorSafeStorageKey（Keychain 读取，注入式）', () => {
  test('任意密码经 PBKDF2(saltysalt,1003) 派生 16 字节密钥；拒绝 → null；进程内缓存', () => {
    resetCursorKeyCacheForTests();
    const pwd = 'abcdefghijklmnop';
    const derived = cursorSafeStorageKey(() => pwd);
    expect(derived?.length).toBe(16);
    // 派生确定性：同密码同密钥
    resetCursorKeyCacheForTests();
    expect(cursorSafeStorageKey(() => pwd)).toEqual(derived);
    // 缓存生效：换注入也不变
    expect(cursorSafeStorageKey(() => 'zzzz')).toEqual(derived);
    resetCursorKeyCacheForTests();
    expect(cursorSafeStorageKey(() => null)).toBeNull();
    // 失败也缓存（避免每轮弹授权窗）
    expect(cursorSafeStorageKey(() => 'should-not-be-read')).toBeNull();
    resetCursorKeyCacheForTests();
  });
});

describe('cursor adapter 集成：state.vscdb 密文值 → 解密 → cookie 链路', () => {
  function makeCtx(): AdapterContext {
    const plan: PlanConfig = {
      slug: 'cursor', name: 'Cursor legacy', adapter: 'cursor',
      enabled: true, pollIntervalSec: 300, credRef: null, extra: {},
    };
    return { plan, now: () => Date.now(), log: () => {} };
  }

  test('库里存 safeStorage 密文时解出 JWT 并拼出 WorkosCursorSessionToken cookie', async () => {
    const sub = 'github|8452';
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payloadExp = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payloadExp || payload}.sig`;
    const sealed = encryptForTest(jwt, KEY);

    const root = mkdtempSync(join(tmpdir(), 'cursor-ss-'));
    try {
      const gs = join(root, 'User', 'globalStorage');
      mkdirSync(gs, { recursive: true });
      const db = new Database(join(gs, 'state.vscdb'));
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      db.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', sealed);
      db.close();
      process.env.CURSOR_DB_PATH_FOR_TEST = join(gs, 'state.vscdb');
      setCursorKeyCacheForTests(KEY);
      const cred = await cursorAdapter.detectCredentials(makeCtx());
      expect(cred).not.toBeNull();
      expect(cred!.source).toBe('auto');
      expect(cred!.accountId).toBe('8452');
      expect(cred!.cookie).toContain('WorkosCursorSessionToken=8452%3A%3AeyJ');
    } finally {
      delete process.env.CURSOR_DB_PATH_FOR_TEST;
      resetCursorKeyCacheForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Keychain 不可用时返回 null（fail-soft，不抛）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-ss2-'));
    try {
      const gs = join(root, 'User', 'globalStorage');
      mkdirSync(gs, { recursive: true });
      const db = new Database(join(gs, 'state.vscdb'));
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      db.query('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'cursorAuth/accessToken', encryptForTest('eyJ.a.b', KEY));
      db.close();
      process.env.CURSOR_DB_PATH_FOR_TEST = join(gs, 'state.vscdb');
      setCursorKeyCacheForTests(null); // Keychain 被拒
      expect(await cursorAdapter.detectCredentials(makeCtx())).toBeNull();
    } finally {
      delete process.env.CURSOR_DB_PATH_FOR_TEST;
      resetCursorKeyCacheForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
