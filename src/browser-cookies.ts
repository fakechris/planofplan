import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCookies } from '@steipete/sweet-cookie';

export interface BrowserCookieResult {
  token: string | null;
  source: string | null;
  warnings: string[];
}

export type KimiBrowser = 'chrome' | 'brave' | 'arc' | 'chromium' | 'comet' | 'dia' | 'firefox' | 'safari';
export const KIMI_BROWSER: KimiBrowser = 'safari';
export const KIMI_BROWSERS: readonly KimiBrowser[] = [
  'chrome',
  'brave',
  'arc',
  'chromium',
  'comet',
  'dia',
  'firefox',
  'safari',
];
const BROWSER_RESULT_CACHE_TTL_MS = 5 * 60_000;
const browserResultCache = new Map<KimiBrowser, { at: number; result: BrowserCookieResult }>();
const keychainPasswordCache = new Map<string, { at: number; password: string | null }>();

interface ChromiumApp {
  name: string;
  root: string;
  account: string;
  service: string;
}

const CUSTOM_CHROMIUM_APPS: ChromiumApp[] = [
  {
    name: 'Comet',
    root: join('Comet'),
    account: 'Comet',
    service: 'Comet Safe Storage',
  },
  {
    name: 'Dia',
    root: join('Dia', 'User Data'),
    account: 'Dia',
    service: 'Dia Safe Storage',
  },
];

function decodeCookieValue(bytes: Uint8Array, stripHashPrefix: boolean): string | null {
  const body = stripHashPrefix && bytes.length >= 32 ? bytes.slice(32) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^[\u0000-\u001f]+/, '');
  } catch {
    return null;
  }
}

function decryptV10(value: Uint8Array, password: string): string | null {
  if (value.length < 3) return null;
  const prefix = Buffer.from(value.slice(0, 3)).toString('utf8');
  if (!/^v\d\d$/.test(prefix)) return null;
  if (prefix === 'v20') return null; // Chrome app-bound encryption needs a browser-provided key.
  try {
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(Buffer.from(value.slice(3))), decipher.final()]);
    const padding = padded.at(-1) ?? 0;
    const plaintext = padding > 0 && padding <= 16 ? padded.subarray(0, -padding) : padded;
    return decodeCookieValue(plaintext, true);
  } catch {
    return null;
  }
}

function readKeychainPassword(app: ChromiumApp): string | null {
  const cacheKey = `${app.service}\n${app.account}`;
  const cached = keychainPasswordCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BROWSER_RESULT_CACHE_TTL_MS) return cached.password;

  const result = Bun.spawnSync([
    '/usr/bin/security',
    'find-generic-password',
    '-w',
    '-a',
    app.account,
    '-s',
    app.service,
  ]);
  if (result.exitCode !== 0) {
    keychainPasswordCache.set(cacheKey, { at: Date.now(), password: null });
    return null;
  }
  const password = result.stdout.toString().trim() || null;
  keychainPasswordCache.set(cacheKey, { at: Date.now(), password });
  return password;
}

function profileDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name) || /^user-\d+$/.test(name));
  return [...new Set(['Default', ...names])].map((name) => join(root, name));
}

function copyCookieDb(dbPath: string): { directory: string; dbPath: string } | null {
  if (!existsSync(dbPath)) return null;
  const directory = mkdtempSync(join(tmpdir(), 'planofplan-cookies-'));
  const copiedDb = join(directory, 'Cookies');
  try {
    copyFileSync(dbPath, copiedDb);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${copiedDb}${suffix}`);
    }
    return { directory, dbPath: copiedDb };
  } catch {
    rmSync(directory, { recursive: true, force: true });
    return null;
  }
}

async function readCometOrDiaCookie(app: ChromiumApp): Promise<BrowserCookieResult> {
  const warnings: string[] = [];
  const password = readKeychainPassword(app);
  if (!password) {
    return {
      token: null,
      source: null,
      warnings: [`${app.name} Safe Storage Keychain 读取失败或未授权`],
    };
  }

  const root = join(homedir(), 'Library', 'Application Support', app.root);
  for (const profile of profileDirectories(root)) {
    for (const relative of ['Cookies', join('Network', 'Cookies')]) {
      const copied = copyCookieDb(join(profile, relative));
      if (!copied) continue;
      try {
        const { Database } = await import('bun:sqlite');
        const db = new Database(copied.dbPath, { readonly: true });
        const rows = db
          .query('SELECT value, encrypted_value FROM cookies WHERE name = ? AND host_key LIKE ?')
          .all('kimi-auth', '%kimi.com%') as Array<{
          value: unknown;
          encrypted_value: unknown;
        }>;
        db.close();
        for (const row of rows) {
          const plain =
            typeof row.value === 'string'
              ? row.value
              : row.value instanceof Uint8Array
                ? new TextDecoder().decode(row.value)
                : '';
          const encrypted =
            row.encrypted_value instanceof Uint8Array
              ? row.encrypted_value
              : typeof row.encrypted_value === 'string'
                ? new TextEncoder().encode(row.encrypted_value)
                : null;
          const token = plain || (encrypted ? decryptV10(encrypted, password) : null);
          if (token) {
            return {
              token,
              source: `${app.name} (${profile.split('/').at(-1) ?? 'profile'})`,
              warnings,
            };
          }
          if (encrypted?.length && Buffer.from(encrypted.slice(0, 3)).toString('utf8') === 'v20') {
            warnings.push(`${app.name} 使用 v20 app-bound Cookie，当前需浏览器导出的 session`);
          }
        }
      } catch {
        warnings.push(`${app.name} Cookie 数据库读取失败`);
      } finally {
        rmSync(copied.directory, { recursive: true, force: true });
      }
    }
  }
  return { token: null, source: null, warnings };
}

export async function readBrowserKimiAuth(browser: KimiBrowser = 'safari'): Promise<BrowserCookieResult> {
  const cached = browserResultCache.get(browser);
  if (cached && Date.now() - cached.at < BROWSER_RESULT_CACHE_TTL_MS) return cached.result;

  const save = (result: BrowserCookieResult): BrowserCookieResult => {
    browserResultCache.set(browser, { at: Date.now(), result });
    return result;
  };
  const warnings: string[] = [];

  if (browser === 'comet' || browser === 'dia') {
    const app = CUSTOM_CHROMIUM_APPS.find((candidate) => candidate.name.toLowerCase() === browser);
    if (app) return save(await readCometOrDiaCookie(app));
  }

  // Sweet Cookie handles exactly one selected Chromium Safe Storage, Firefox moz_cookies,
  // or Safari binary cookies. Never probe all browsers in one call: each Chromium
  // target can cause a separate macOS Keychain authorization prompt.
  if (browser === 'firefox' || browser === 'safari') {
    try {
      const result = await getCookies({
        url: 'https://www.kimi.com/',
        browsers: [browser],
        names: ['kimi-auth'],
        mode: 'merge',
        includeExpired: false,
        debug: true,
      });
      warnings.push(...result.warnings);
      const cookie = result.cookies.find((item) => item.name === 'kimi-auth' && item.value.trim());
      if (cookie) {
        return save({ token: cookie.value, source: cookie.source?.browser ?? browser, warnings });
      }
    } catch (error) {
      warnings.push(`${browser} Cookie 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return save({ token: null, source: null, warnings });
  }

  try {
    const result = await getCookies({
      url: 'https://www.kimi.com/',
      browsers: ['chrome'],
      chromiumBrowser: browser as 'chrome' | 'brave' | 'arc' | 'chromium',
      // Default profile avoids repeating a Safe Storage lookup for every profile.
      // Users with a non-default profile can override it with KIMI_BROWSER_PROFILE.
      profile: process.env.KIMI_BROWSER_PROFILE ?? 'Default',
      names: ['kimi-auth'],
      mode: 'first',
      includeExpired: false,
      debug: true,
    });
    warnings.push(...result.warnings);
    const cookie = result.cookies.find((item) => item.name === 'kimi-auth' && item.value.trim());
    if (cookie) {
      return save({ token: cookie.value, source: cookie.source?.browser ?? browser, warnings });
    }
  } catch (error) {
    warnings.push(`${browser} Cookie 读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return save({ token: null, source: null, warnings });
}
