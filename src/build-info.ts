import { readFileSync } from 'node:fs';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface BuildInfo {
  commitSha: string;
  shortCommitSha: string;
  buildTimestamp: string;
  bundlePath: string;
  appVersion: string;
}

/**
 * 运行中二进制所在 .app 的 Info.plist(build-menubar.sh 写入 commit/时间)。
 * launchd 直接执行 bundle 内 daemon,不经菜单栏注入 env,只能从这里读(INV-933)。
 */
function bundlePlist(
  execPath: string,
  readText: (path: string) => string,
): { bundlePath: string; values: Map<string, string> } | null {
  const bundle = execPath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1];
  if (!bundle) return null;
  let xml: string;
  try {
    xml = readText(`${bundle}/Contents/Info.plist`);
  } catch {
    return null;
  }
  const values = new Map<string, string>();
  for (const [, key, value] of xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    values.set(key!, value!.trim());
  }
  return { bundlePath: bundle, values };
}

export function getBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): BuildInfo {
  const plist = env.PLANOFPPLAN_BUILD_COMMIT?.trim() ? null : bundlePlist(execPath, readText);
  const commitSha = env.PLANOFPPLAN_BUILD_COMMIT?.trim() || plist?.values.get('PlanofplanCommitSHA') || '';
  const validCommitSha = SHA_PATTERN.test(commitSha) ? commitSha.toLowerCase() : 'dev';
  const configuredShortSha = env.PLANOFPPLAN_BUILD_SHORT?.trim() || plist?.values.get('PlanofplanCommitShortSHA') || '';
  const shortCommitSha = validCommitSha === 'dev'
    ? 'dev'
    : (configuredShortSha || validCommitSha.slice(0, 7)).toLowerCase();

  return {
    commitSha: validCommitSha,
    shortCommitSha,
    buildTimestamp: env.PLANOFPPLAN_BUILD_TIMESTAMP?.trim()
      || (validCommitSha === 'dev' ? '' : plist?.values.get('PlanofplanBuildTimestamp'))
      || 'development',
    bundlePath: env.PLANOFPPLAN_BUNDLE_PATH?.trim() || plist?.bundlePath || '/Applications/planofplan.app',
    appVersion: env.PLANOFPPLAN_APP_VERSION?.trim() || plist?.values.get('CFBundleShortVersionString') || '0.1.0',
  };
}
