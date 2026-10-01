import { describe, expect, test } from 'bun:test';
import { getBuildInfo } from '../src/build-info.ts';

describe('build info', () => {
  test('uses the commit metadata embedded by the menubar build', () => {
    expect(getBuildInfo({
      PLANOFPPLAN_BUILD_COMMIT: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      PLANOFPPLAN_BUILD_SHORT: 'abcdef0',
      PLANOFPPLAN_BUILD_TIMESTAMP: '2025-01-02T03:04:05Z',
      PLANOFPPLAN_BUNDLE_PATH: '/Applications/planofplan.app',
      PLANOFPPLAN_APP_VERSION: '0.1.0',
    })).toEqual({
      commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      shortCommitSha: 'abcdef0',
      buildTimestamp: '2025-01-02T03:04:05Z',
      bundlePath: '/Applications/planofplan.app',
      appVersion: '0.1.0',
    });
  });

  test('falls back to an explicit development identity', () => {
    expect(getBuildInfo({})).toMatchObject({
      commitSha: 'dev',
      shortCommitSha: 'dev',
      buildTimestamp: 'development',
      bundlePath: '/Applications/planofplan.app',
    });
  });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>0.2.0</string>
	<key>PlanofplanBuildTimestamp</key>
	<string>2026-10-01T13:08:20Z</string>
	<key>PlanofplanCommitSHA</key>
	<string>e9598cbaf55d4f140bb04f9c094ce156f7b4a45c</string>
	<key>PlanofplanCommitShortSHA</key>
	<string>e9598cb</string>
</dict>
</plist>`;
  const daemon = '/Applications/planofplan.app/Contents/MacOS/planofplan-daemon';

  test('a daemon started by launchd (no env) reads its bundle Info.plist', () => {
    const read = (path: string): string => {
      expect(path).toBe('/Applications/planofplan.app/Contents/Info.plist');
      return plist;
    };
    expect(getBuildInfo({}, daemon, read)).toEqual({
      commitSha: 'e9598cbaf55d4f140bb04f9c094ce156f7b4a45c',
      shortCommitSha: 'e9598cb',
      buildTimestamp: '2026-10-01T13:08:20Z',
      bundlePath: '/Applications/planofplan.app',
      appVersion: '0.2.0',
    });
  });

  test('env set by the menubar app still wins over the plist', () => {
    expect(getBuildInfo({ PLANOFPPLAN_BUILD_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01' }, daemon, () => plist))
      .toMatchObject({ commitSha: 'abcdef0123456789abcdef0123456789abcdef01', shortCommitSha: 'abcdef0' });
  });

  test('outside an app bundle, or with an unreadable plist, it stays dev', () => {
    expect(getBuildInfo({}, '/Users/me/.bun/bin/bun', () => plist).commitSha).toBe('dev');
    expect(getBuildInfo({}, daemon, () => { throw new Error('ENOENT'); }).commitSha).toBe('dev');
    expect(getBuildInfo({}, daemon, () => '<plist><dict></dict></plist>').commitSha).toBe('dev');
  });
});

