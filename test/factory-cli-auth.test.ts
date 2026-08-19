import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFactoryCliAuth } from '../src/factory-cli-auth.ts';

let dir: string;

function encryptAuthFile(path: string, key: Buffer, payload: object): void {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload))),
    cipher.final(),
  ]);
  writeFileSync(path, [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-cli-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('droid CLI auth', () => {
  test('reads the keyfile variant (auth.v2.key + auth.v2.file)', async () => {
    const key = randomBytes(32);
    writeFileSync(join(dir, 'auth.v2.key'), key.toString('base64'));
    encryptAuthFile(join(dir, 'auth.v2.file'), key, {
      access_token: 'cli-access-token',
      refresh_token: 'cli-refresh-token',
      active_organization_id: 'org_123',
      region: null,
    });
    await expect(readFactoryCliAuth(dir)).resolves.toEqual({
      accessToken: 'cli-access-token',
      refreshToken: 'cli-refresh-token',
      organizationId: 'org_123',
      source: 'droid CLI keyfile',
    });
  });

  test('returns null when no auth files exist', async () => {
    await expect(readFactoryCliAuth(dir)).resolves.toBeNull();
  });

  test('returns null when the key cannot decrypt the blob', async () => {
    writeFileSync(join(dir, 'auth.v2.key'), randomBytes(32).toString('base64'));
    encryptAuthFile(join(dir, 'auth.v2.file'), randomBytes(32), {
      refresh_token: 'cli-refresh-token',
    });
    await expect(readFactoryCliAuth(dir)).resolves.toBeNull();
  });
});
