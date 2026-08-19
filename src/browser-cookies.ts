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

export interface KimiWebTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

/**
 * 读取 Safari 里 www.kimi.com 的 localStorage 凭据（access_token / refresh_token）。
 *
 * 2026-08 实测：kimi.com 前端的 apiv2 请求使用 localStorage 的 access_token 做
 * Bearer（token 由页面经 auth.kimi.com account.gateway.v1.AuthService/RefreshToken
 * 自行刷新）；kimi-auth cookie 已不参与 API 鉴权，过期后网页仍正常。
 *
 * 这里只读不写、也不主动刷新：refresh_token 与网页共享且会轮换，daemon 兑换会把
 * 页面踢下线。页面打开时自己刷新 token，本函数下个轮询周期自然读到新值。
 */
export async function readSafariKimiWebTokens(): Promise<KimiWebTokens> {
  // 测试/高级覆盖：直接指向一个含 localstorage.sqlite3 的目录。
  const override = process.env.KIMI_SAFARI_LOCALSTORAGE_DIR?.trim();
  if (override) {
    const tokens = await readKimiTokensFromDb(join(override, 'localstorage.sqlite3'));
    if (tokens.accessToken || tokens.refreshToken) return tokens;
    return tokens;
  }
  const container = join(homedir(), 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library');
  const websiteData = join(container, 'WebKit', 'WebsiteData');
  // 旧布局：WebsiteData/LocalStorage/https_www.kimi.com.localstorage
  const legacyRoot = join(websiteData, 'LocalStorage');
  if (existsSync(legacyRoot)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(legacyRoot);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!/^https_www\.kimi\.com(_\d+)?\.localstorage$/.test(name)) continue;
      const tokens = await readKimiTokensFromDb(join(legacyRoot, name));
      if (tokens.accessToken || tokens.refreshToken) return tokens;
    }
  }
  // 新布局（Safari 17+）：WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3。
  // hash 预映像含设备相关盐，无法离线推导；遍历时只读键名，仅取键匹配且值形如 JWT 的库。
  const defaultRoot = join(websiteData, 'Default');
  let hashDirs: string[] = [];
  try {
    hashDirs = readdirSync(defaultRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    hashDirs = [];
  }
  for (const hash of hashDirs) {
    let innerDirs: string[] = [];
    try {
      innerDirs = readdirSync(join(defaultRoot, hash), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const inner of innerDirs) {
      const dbPath = join(defaultRoot, hash, inner, 'LocalStorage', 'localstorage.sqlite3');
      if (!existsSync(dbPath)) continue;
      const tokens = await readKimiTokensFromDb(dbPath);
      if (tokens.accessToken || tokens.refreshToken) return tokens;
    }
  }
  return { accessToken: null, refreshToken: null };
}

async function readKimiTokensFromDb(dbPath: string): Promise<KimiWebTokens> {
  const empty: KimiWebTokens = { accessToken: null, refreshToken: null };
  const copied = copyCookieDb(dbPath);
  if (!copied) return empty;
  try {
    const { Database } = await import('bun:sqlite');
    const db = new Database(copied.dbPath, { readonly: true });
    const rows = db
      .query('SELECT key, value FROM ItemTable WHERE key IN (?, ?)')
      .all('access_token', 'refresh_token') as Array<{ key?: unknown; value?: unknown }>;
    db.close();
    const tokens: KimiWebTokens = { accessToken: null, refreshToken: null };
    for (const row of rows) {
      const value =
        row.value instanceof Uint8Array
          ? decodeItemValue(row.value)
          : typeof row.value === 'string'
            ? row.value
            : null;
      if (!value) continue;
      if (row.key === 'access_token' && value.split('.').length === 3) tokens.accessToken = value.trim() || null;
      if (row.key === 'refresh_token') tokens.refreshToken = value.trim() || null;
    }
    // 只认同时形如 kimi web 凭据的库：access_token 必须是 JWT，避免误读其他站点。
    if (!tokens.accessToken) return { accessToken: null, refreshToken: null };
    return tokens;
  } catch {
    return empty;
  } finally {
    rmSync(copied.directory, { recursive: true, force: true });
  }
}

/** WebKit 的 ItemTable value 可能是 UTF-16LE BLOB（token 本身不含 NUL，用 NUL 嗅探编码）。 */
function decodeItemValue(value: Uint8Array): string | null {
  try {
    if (value.includes(0)) {
      let out = '';
      for (let i = 0; i + 1 < value.length; i += 2) {
        out += String.fromCharCode(value[i]! | (value[i + 1]! << 8));
      }
      return out.replace(/\u0000+/g, '') || null;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

export async function readBrowserKimiAuth(browser: KimiBrowser = 'safari'): Promise<BrowserCookieResult> {  const cached = browserResultCache.get(browser);
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
