# Plan: Self-contained menubar bundle + auto-launchd

**Goal**: `/Applications/planofplan.app` becomes portable. New machine flow = drag → double-click → 9291 alive. No `bun`, no `~/workspace/planofplan`, no Dashboard click.

**Status**: Not Started

## Stages

### B1. Compile daemon into bundle
- Add to `scripts/build-menubar.sh`:
  ```sh
  bun build --compile src/cli.ts \
    --outfile "$STAGED_APP/Contents/MacOS/planofplan-daemon"
  ```
- Verify standalone: `./planofplan-daemon --help` from arbitrary cwd works without bun in PATH.

### B2. Swift spawns bundle binary
- `main.swift startDaemon()`:
  - `executableURL` = `Bundle.main.url.../MacOS/planofplan-daemon`
  - args: `["serve", "--port", String(port)]`
  - Drop `process.currentDirectoryURL`
  - Drop `projectRoot()` and its callers (kept `configuredPort()` — uses `Bundle.main.url(forResource: "port")`).

### B3. launchd plist points at bundle binary
- `scripts/install-daemon.sh` plist template:
  - `ProgramArguments[0]` = `/Applications/planofplan.app/Contents/MacOS/planofplan-daemon`
  - Drop `WorkingDirectory` key
- `scripts/daemon-entry.sh` becomes dev-only fallback (kept; `bun run serve` still uses it). Document in header comment.

### B4. Remove project-root resource
- `build-menubar.sh:72` `printf '%s\n' "$ROOT" > .../project-root` → delete.
- `main.swift` `projectRoot()` function → delete.

### B5. Auto-register LaunchAgent on first launch
- `main.swift applicationDidFinishLaunching`:
  - After `ensureDaemon()`, check `FileManager.fileExists(atPath: plistPath)`.
  - If missing: NSAlert "登录时自动启动？"; on yes, `Process().launchPath = "/bin/sh"`, args = `[installPath]`, run detached.
- Dashboard `PUT /api/settings/launch-on-startup` stays as the off-switch.

## Verification (V1)

- `bun run typecheck` → 0 errors
- `bun run menubar:build` → produces `planofplan.app/Contents/MacOS/planofplan-daemon`
- `./Contents/MacOS/planofplan-daemon --help` from `/tmp` → works (no bun, no cwd)
- Open app → 9291 alive, Dashboard loads
- `sudo reboot` (or just `launchctl kickstart -k`) → 9291 still alive
- Simulate new user: `mv ~/workspace/planofplan /tmp/__hide__ && open /Applications/planofplan.app && curl 9291` → 200

## Out of scope (later)

- Real .dmg / .pkg installer
- Apple Developer ID signing (currently relies on per-machine `Lumen Local Codesign` self-signed cert)
- Codesign hardening for cross-machine cert portability
- FDA auto-grant (impossible — macOS requires user in System Settings)
