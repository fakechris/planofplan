#!/bin/sh
set -eu

# 卸载开机自启：删除 LaunchAgent 注册（plist）并从系统登录项中移除菜单栏 App。
# launchd 已加载的任务保留到注销/重启为止，不会打断当前正在服务的 daemon；下次登录不再自启。
# 与 dashboard「开机自启」开关及菜单栏开关保持同一语义。
LABEL="local.planofplan.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_PATH="/Applications/planofplan.app"

rm -f "$PLIST"
osascript -e "tell application \"System Events\" to delete (every login item whose name is \"planofplan\" or path is \"$APP_PATH\")" 2>/dev/null || true
echo "Removed $PLIST and removed planofplan from Login Items (loaded job keeps running until logout)"
