const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface BuildInfo {
  commitSha: string;
  shortCommitSha: string;
  buildTimestamp: string;
  bundlePath: string;
  appVersion: string;
}

export function getBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const commitSha = env.PLANOFPPLAN_BUILD_COMMIT?.trim() ?? '';
  const validCommitSha = SHA_PATTERN.test(commitSha) ? commitSha.toLowerCase() : 'dev';
  const configuredShortSha = env.PLANOFPPLAN_BUILD_SHORT?.trim() ?? '';
  const shortCommitSha = validCommitSha === 'dev'
    ? 'dev'
    : (configuredShortSha || validCommitSha.slice(0, 7)).toLowerCase();

  return {
    commitSha: validCommitSha,
    shortCommitSha,
    buildTimestamp: env.PLANOFPPLAN_BUILD_TIMESTAMP?.trim() || 'development',
    bundlePath: env.PLANOFPPLAN_BUNDLE_PATH?.trim() || '/Applications/planofplan.app',
    appVersion: env.PLANOFPPLAN_APP_VERSION?.trim() || '0.1.0',
  };
}
