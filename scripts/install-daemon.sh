#!/bin/sh
set -eu

# 安装/更新 launchd 守护：daemon 崩溃或被杀后由 launchd 自动重启，
# 登录时自启。端口必须与 menubar bundle 的 Resources/port 一致
# （build-menubar.sh 默认 9291），否则 menubar 会再 spawn 第二个 daemon。
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="local.planofplan.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${PLANOFPPLAN_HOME:-$HOME/.planofplan}"
PORT="${PLANOFPPLAN_DAEMON_PORT:-9291}"
UID_=$(id -u)

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/scripts/daemon-entry.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/serve.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/serve.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true

# bootout 异步生效，立即 bootstrap 可能报 5: I/O error，小退避重试。
BOOTSTRAPPED=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$UID_" "$PLIST" 2>/dev/null; then
    BOOTSTRAPPED=1
    break
  fi
  sleep 1
done
if [ "$BOOTSTRAPPED" -ne 1 ]; then
  echo "launchctl bootstrap failed for $LABEL" >&2
  exit 1
fi

echo "Installed $LABEL (port $PORT, log $LOG_DIR/serve.log)"
launchctl print "gui/$UID_/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid)' || true
