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
});
