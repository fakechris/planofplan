import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── commit trailer 声明通道 ─────────────────────────────────────────
// commit-attribution 的 declared 分级早已解析 `Harness-Session: <id>` trailer,
// 但没有任何 harness 会写它(本机几十个 repo 实测为零)——声明通道形同虚设。
// 这里把通道建起来:prepare-commit-msg 钩子在提交时问 daemon「当前 repo 的
// 最新活跃 session 是谁」,盖章 trailer。agent 走 git commit 即自动声明,
// 归因侧零改动;daemon 不在/无活跃 session 时静默跳过,绝不阻塞提交。

const HOOK_MARKER = '# planofplan:commit-trailer v1';

export function prepareCommitMsgPath(repo: string): string {
  return join(repo, '.git', 'hooks', 'prepare-commit-msg');
}

function hookScript(port: number): string {
  return `#!/bin/sh
${HOOK_MARKER}
# 提交时向本机 planofplan daemon 查询当前 repo 的活跃 session,盖章
# Harness-Session trailer(declared 归因通道)。已盖/查不到/daemon 不在
# 都静默跳过,绝不阻塞提交。卸载:planofplan hook uninstall。
case "$2" in message|commit|"") ;; *) exit 0 ;; esac
grep -qi '^Harness-Session:' "$1" 2>/dev/null && exit 0
CWD=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
[ -n "$CWD" ] || exit 0
SESSION=$(curl -sf -m 2 -G -H 'Host: localhost:${port}' \\
  --data-urlencode "cwd=$CWD" "http://127.0.0.1:${port}/api/sessions/current" 2>/dev/null \\
  | sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' | head -1)
[ -n "$SESSION" ] || exit 0
printf '\\nHarness-Session: %s\\n' "$SESSION" >> "$1"
exit 0
`;
}

export interface HookResult {
  ok: boolean;
  status: 'installed' | 'already' | 'uninstalled' | 'refused' | 'not-found' | 'no-repo';
  path?: string;
  reason?: string;
}

export function installCommitHook(repo: string, port: number): HookResult {
  if (!existsSync(join(repo, '.git'))) {
    return { ok: false, status: 'no-repo', reason: `${repo} 不是 git 仓库(找不到 .git)` };
  }
  const hookPath = prepareCommitMsgPath(repo);
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (!existing.includes(HOOK_MARKER)) {
      // 已有别人的 prepare-commit-msg(比如模板/husky):不覆盖,提示手工合并
      return { ok: false, status: 'refused', path: hookPath, reason: '已存在非 planofplan 的 prepare-commit-msg 钩子,拒绝覆盖;可手工把盖章逻辑合并进去' };
    }
    return { ok: true, status: 'already', path: hookPath };
  }
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(hookPath, hookScript(port));
  chmodSync(hookPath, 0o755);
  return { ok: true, status: 'installed', path: hookPath };
}

export function uninstallCommitHook(repo: string): HookResult {
  const hookPath = prepareCommitMsgPath(repo);
  if (!existsSync(hookPath)) return { ok: true, status: 'not-found', path: hookPath };
  const existing = readFileSync(hookPath, 'utf8');
  if (!existing.includes(HOOK_MARKER)) {
    return { ok: false, status: 'refused', path: hookPath, reason: '该钩子不属于 planofplan,不动' };
  }
  rmSync(hookPath);
  return { ok: true, status: 'uninstalled', path: hookPath };
}
