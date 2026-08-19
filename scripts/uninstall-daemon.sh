#!/bin/sh
set -eu

# 卸载开机自启：只删除 LaunchAgent 注册（plist）。launchd 已加载的任务
# 保留到注销/重启为止，不会打断当前正在服务的 daemon；下次登录不再自启。
# 与 dashboard「开机自启」开关的关闭路径保持同一语义。
LABEL="local.planofplan.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

rm -f "$PLIST"
echo "Removed $PLIST (loaded job keeps running until logout)"
