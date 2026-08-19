import { describe, expect, test, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { readSafariKimiWebTokens } from '../src/browser-cookies.ts';
import { readKimiWebSession, kimiTokenExpiredHint, refreshKimiWebAccessToken } from '../src/adapters/kimi.ts';

function fixtureRoot(): string {
  return join(tmpdir(), `planofplan-kimi-ls-${process.pid}-${Date.now()}`);
}

function writeFixture(root: string, accessToken: string | null, refreshToken: string | null): void {
  mkdirSync(root, { recursive: true });
  const db = new Database(join(root, 'localstorage.sqlite3'));
  db.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  if (accessToken != null) db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', ['access_token', accessToken]);
  if (refreshToken != null) db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', ['refresh_token', refreshToken]);
  db.close();
}

function fakeJwt(expSec: number, sub = 'user-sub'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSec, sub })}.signature`;
}

const previousDir = process.env.KIMI_SAFARI_LOCALSTORAGE_DIR;
const previousEnvToken = process.env.KIMI_AUTH_TOKEN;
afterAll(() => {
  if (previousDir == null) delete process.env.KIMI_SAFARI_LOCALSTORAGE_DIR;
  else process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = previousDir;
  if (previousEnvToken == null) delete process.env.KIMI_AUTH_TOKEN;
  else process.env.KIMI_AUTH_TOKEN = previousEnvToken;
});

describe('Kimi Safari localStorage', () => {
  test('reads access_token and refresh_token from the Safari origin database', async () => {
    const root = fixtureRoot();
    writeFixture(root, fakeJwt(Math.floor(Date.now() / 1000) + 3600), 'refresh-value');
    process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = root;
    try {
      const tokens = await readSafariKimiWebTokens();
      expect(tokens.refreshToken).toBe('refresh-value');
      expect(tokens.accessToken).toStartWith('eyJ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readKimiWebSession prefers a fresh localStorage access token', async () => {
    const root = fixtureRoot();
    writeFixture(root, fakeJwt(Math.floor(Date.now() / 1000) + 3600), 'refresh-value');
    process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = root;
    delete process.env.KIMI_AUTH_TOKEN;
    try {
      const session = await readKimiWebSession('kimi', false, false);
      expect(session?.source).toBe('safari-localstorage');
      expect(session?.token).toStartWith('eyJ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an expired localStorage access token is skipped instead of used', async () => {
    const root = fixtureRoot();
    writeFixture(root, fakeJwt(Math.floor(Date.now() / 1000) - 3600), 'refresh-value');
    process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = root;
    delete process.env.KIMI_AUTH_TOKEN;
    try {
      const session = await readKimiWebSession('kimi', false, false);
      expect(session).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('kimiTokenExpiredHint reports the approximate expiry age', () => {
    const expired = fakeJwt(Math.floor(Date.now() / 1000) - 2 * 3600);
    expect(kimiTokenExpiredHint(expired)).toContain('2 小时');
    const valid = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    expect(kimiTokenExpiredHint(valid)).toBeNull();
  });
});

describe('Kimi web refresh chain', () => {
  const originalFetch = globalThis.fetch;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = (await Bun.$`mktemp -d`.text()).trim();
    previousHome = process.env.PLANOFPPLAN_HOME;
    process.env.PLANOFPPLAN_HOME = home;
    delete process.env.KIMI_AUTH_TOKEN;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (previousHome == null) delete process.env.PLANOFPPLAN_HOME;
    else process.env.PLANOFPPLAN_HOME = previousHome;
    await Bun.$`rm -rf ${home}`.quiet();
  });

  function mockRefreshEndpoint(status: number, body: unknown): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('AuthService/RefreshToken')) {
        calls.push(String(init?.body));
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return calls;
  }

  test('refreshKimiWebAccessToken posts refresh_token and parses the response', async () => {
    const calls = mockRefreshEndpoint(200, { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 600), refresh_token: 'rotated' });
    const result = await refreshKimiWebAccessToken('candidate-token');
    expect(result?.accessToken).toStartWith('eyJ');
    expect(result?.refreshToken).toBe('rotated');
    expect(calls[0]).toContain('"refresh_token":"candidate-token"');
  });

  test('refreshKimiWebAccessToken returns null on non-200', async () => {
    mockRefreshEndpoint(400, { code: 'invalid_grant' });
    expect(await refreshKimiWebAccessToken('dead-token')).toBeNull();
  });

  test('readKimiWebSession refreshes an expired localStorage access token and persists the chain', async () => {
    const root = fixtureRoot();
    writeFixture(root, fakeJwt(Math.floor(Date.now() / 1000) - 600), 'browser-refresh-token');
    process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = root;
    const freshAccess = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    mockRefreshEndpoint(200, { access_token: freshAccess, refresh_token: 'rotated-refresh' });
    try {
      const session = await readKimiWebSession('kimi', false, false);
      expect(session?.source).toBe('kimi-web-session');
      expect(session?.token).toBe(freshAccess);
      const persisted = JSON.parse(readFileSync(join(home, 'kimi-web-session.json'), 'utf8'));
      expect(persisted.refreshToken).toBe('rotated-refresh');
      expect(persisted.accessToken).toBe(freshAccess);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readKimiWebSession reuses a still-fresh persisted access token without exchanging', async () => {
    const root = fixtureRoot();
    writeFixture(root, fakeJwt(Math.floor(Date.now() / 1000) - 600), 'browser-refresh-token');
    process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = root;
    const persistedAccess = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    const persisted = join(home, 'kimi-web-session.json');
    mkdirSync(home, { recursive: true });
    await Bun.write(persisted, JSON.stringify({ accessToken: persistedAccess, refreshToken: 'chain-refresh', userSub: 'user-sub' }));
    const calls = mockRefreshEndpoint(200, { access_token: 'should-not-happen', refresh_token: 'x' });
    try {
      const session = await readKimiWebSession('kimi', false, false);
      expect(session?.token).toBe(persistedAccess);
      expect(calls.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readKimiWebSession skips the persisted chain when the account anchor differs', async () => {
    const root = fixtureRoot();
    // localStorage 过期 access 的 sub 是 user-sub；持久化链锚定其他账号。
    writeFixture(root, fakeJwt(Math.floor(Date.now() / 1000) - 600, 'user-sub'), 'browser-refresh-token');
    process.env.KIMI_SAFARI_LOCALSTORAGE_DIR = root;
    const persisted = join(home, 'kimi-web-session.json');
    mkdirSync(home, { recursive: true });
    await Bun.write(persisted, JSON.stringify({
      accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 600, 'other-user'),
      refreshToken: 'other-account-chain',
      userSub: 'other-user',
    }));
    const calls = mockRefreshEndpoint(200, { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 600), refresh_token: 'rotated' });
    try {
      const session = await readKimiWebSession('kimi', false, false);
      expect(session?.source).toBe('kimi-web-session');
      // 只允许用浏览器候选兑换，不允许碰其他账号的持久化链。
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain('browser-refresh-token');
      expect(existsSync(join(home, 'kimi-web-session.json'))).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
