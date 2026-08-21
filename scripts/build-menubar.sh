#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PACKAGE="$ROOT/macos/PlanofplanMenuBar"
INSTALL_APP="/Applications/planofplan.app"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Lumen Local Codesign}"
IDENTIFIER="local.planofplan.menubar"
COMMIT_SHA=$(git -C "$ROOT" rev-parse HEAD)
SHORT_COMMIT_SHA=$(git -C "$ROOT" rev-parse --short=7 HEAD)
BUILD_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
APP_VERSION=$(awk '
  /<key>CFBundleShortVersionString<\/key>/ {
    getline
    gsub(/^[[:space:]]*<string>|<\/string>[[:space:]]*$/, "")
    print
    exit
  }
' "$PACKAGE/Info.plist")
APP_VERSION=${APP_VERSION:-0.1.0}
STAGING_ROOT=""
STAGED_APP=""
BACKUP_ROOT=""

cleanup() {
  if [ -n "$BACKUP_ROOT" ] && [ -d "$BACKUP_ROOT/planofplan.app" ] && [ ! -e "$INSTALL_APP" ]; then
    mv "$BACKUP_ROOT/planofplan.app" "$INSTALL_APP" || true
  fi
  if [ -n "$STAGING_ROOT" ]; then rm -rf "$STAGING_ROOT"; fi
  if [ -n "$BACKUP_ROOT" ]; then rm -rf "$BACKUP_ROOT"; fi
}
trap cleanup EXIT

DIRTY_FILES=$(git -C "$ROOT" status --porcelain --untracked-files=all -- \
  . \
  ':(exclude)dist/**' \
  ':(exclude)macos/PlanofplanMenuBar/.build/**' \
  ':(exclude)macos/SweetCookieKit/.build/**')
if [ -n "$DIRTY_FILES" ]; then
  echo "Refusing to build with uncommitted source changes." >&2
  echo "Commit the changes first, then run bun run menubar:build." >&2
  printf '%s\n' "$DIRTY_FILES" >&2
  exit 1
fi

if [ "$IDENTITY" = "-" ]; then
  echo "Refusing ad-hoc signing: Full Disk Access would not survive rebuilds." >&2
  echo "Create/trust a certificate-backed identity such as 'Lumen Local Codesign'." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$IDENTITY\"" >/dev/null; then
  echo "Code-signing identity not found or not trusted: $IDENTITY" >&2
  echo "Use the stable self-signed identity from Lumen Navi, or set APPLE_SIGNING_IDENTITY." >&2
  exit 1
fi

STAGING_ROOT=$(mktemp -d "/Applications/.planofplan-build.XXXXXX")
STAGED_APP="$STAGING_ROOT/planofplan.app"

swift build --package-path "$PACKAGE" -c release

mkdir -p "$STAGED_APP/Contents/MacOS" "$STAGED_APP/Contents/Resources"
cp "$PACKAGE/.build/arm64-apple-macosx/release/PlanofplanMenuBar" "$STAGED_APP/Contents/MacOS/PlanofplanMenuBar"
cp "$PACKAGE/Info.plist" "$STAGED_APP/Contents/Info.plist"
if [ -f "$PACKAGE/Resources/planofplan.icns" ]; then
  cp "$PACKAGE/Resources/planofplan.icns" "$STAGED_APP/Contents/Resources/planofplan.icns"
fi
/usr/libexec/PlistBuddy -c "Set :PlanofplanCommitSHA $COMMIT_SHA" "$STAGED_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :PlanofplanCommitShortSHA $SHORT_COMMIT_SHA" "$STAGED_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :PlanofplanBuildTimestamp $BUILD_TIMESTAMP" "$STAGED_APP/Contents/Info.plist"
printf '%s\n' "$ROOT" > "$STAGED_APP/Contents/Resources/project-root"
printf '%s\n' "${PLANOFPPLAN_MENUBAR_PORT:-9291}" > "$STAGED_APP/Contents/Resources/port"

if ! codesign --force --sign "$IDENTITY" --identifier "$IDENTIFIER" --timestamp=none "$STAGED_APP"; then
  echo "Failed to sign $STAGED_APP with $IDENTITY" >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=1 "$STAGED_APP"

if [ -e "$INSTALL_APP" ]; then
  BACKUP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/planofplan-previous.XXXXXX")
  mv "$INSTALL_APP" "$BACKUP_ROOT/planofplan.app"
fi
mv "$STAGED_APP" "$INSTALL_APP"
codesign --verify --deep --strict --verbose=1 "$INSTALL_APP"
rm -rf "$BACKUP_ROOT"
BACKUP_ROOT=""

echo "Installed $INSTALL_APP"
echo "Commit $COMMIT_SHA"
codesign -dv --verbose=2 "$INSTALL_APP" 2>&1 |
  grep -iE "Authority|Identifier|Signature|TeamIdentifier|Format|flags=" || true
codesign -d -r- "$INSTALL_APP" 2>&1 | grep "designated =>" || true
