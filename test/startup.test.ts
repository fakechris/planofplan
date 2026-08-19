import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchAgentPlistPath,
  isLaunchOnStartupSupported,
  getStartupSettings,
  setLaunchOnStartup,
} from '../src/startup.ts';
import { createServer } from '../src/server.ts';
import { openMemoryDb } from '../src/db.ts';
import { DEFAULT_PLANS } from '../src/config.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planofplan-agents-'));
  process.env.PLANOFPPLAN_LAUNCH_AGENTS_DIR = dir;
});

afterEach(() => {
  delete process.env.PLANOFPPLAN_LAUNCH_AGENTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('launch on startup setting', () => {
  test('defaults to disabled when no LaunchAgent plist is registered', () => {
    expect(getStartupSettings()).toEqual({
      launchOnStartup: { available: isLaunchOnStartupSupported(), enabled: false },
    });
  });

  test('enabled reflects the plist registration file', () => {
    writeFileSync(launchAgentPlistPath(), '<plist/>');
    expect(getStartupSettings().launchOnStartup.enabled).toBe(isLaunchOnStartupSupported());
  });

  test('turning off deletes the registration without touching anything else', () => {
    writeFileSync(launchAgentPlistPath(), '<plist/>');
    const result = setLaunchOnStartup(false);
    expect(result.enabled).toBe(false);
    expect(result.restarting).toBe(false);
    expect(existsSync(launchAgentPlistPath())).toBe(false);
    // 再次关闭应幂等
    setLaunchOnStartup(false);
  });

  test('settings API reports state and PUT off removes the registration', async () => {
    const store = openMemoryDb();
    for (const plan of DEFAULT_PLANS) store.syncPlan(plan);
    const server = createServer(store, { refreshPlan: async () => ({ ok: true }) } as never, {
      port: 9291,
      plans: DEFAULT_PLANS,
    });

    writeFileSync(launchAgentPlistPath(), '<plist/>');
    const initial = await server.request('http://localhost/api/settings');
    expect(((await initial.json()) as { launchOnStartup: { enabled: boolean } }).launchOnStartup.enabled)
      .toBe(isLaunchOnStartupSupported());

    const response = await server.request('http://localhost/api/settings/launch-on-startup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, enabled: false });
    expect(existsSync(launchAgentPlistPath())).toBe(false);

    const badBody = await server.request('http://localhost/api/settings/launch-on-startup', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(badBody.status).toBe(400);
  });
});
