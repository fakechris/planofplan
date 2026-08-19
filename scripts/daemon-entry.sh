#!/bin/sh
set -eu

# launchd 运行环境的 PATH 非常小，不能依赖 which bun；与 menubar app 的
# findExecutable 使用同一组候选路径，避免 Homebrew 升级/迁移后找不到 bun。
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

find_bun() {
  for candidate in \
    "${PLANOFPLAN_BUN_PATH:-}" \
    "${BUN_INSTALL:-}/bin/bun" \
    "$HOME/.bun/bin/bun" \
    /opt/homebrew/bin/bun \
    /usr/local/bin/bun
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

BUN=$(find_bun) || {
  echo "planofplan daemon: bun not found; set PLANOFPLAN_BUN_PATH" >&2
  exit 1
}

cd "$ROOT"
exec "$BUN" src/cli.ts serve --port "${PLANOFPPLAN_DAEMON_PORT:-9291}"
