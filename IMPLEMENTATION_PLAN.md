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

---

## High-Level Roadmap: M7 & M8 (Post M6)

详见研究与对比专论：`docs/four-systems-comparison-and-roadmap.md`

### Milestone M7: 跨 Agent 消息级内容检索与上下文交接引擎 (INV-274)
- **INV-276 (M7-1)**: SQLite FTS5 消息级增量全文索引与信封过滤清洗
  - 扩展 `~/.planofplan/index.db`：新增 `session_messages` 与 `messages_fts` (trigram/fts5)
  - 增量扫描：复用 mtime + 行级游标水位，非阻塞单飞追加
  - 信封降噪：打标 `is_meta=1` 排除命令信封与 Base64 大图
  - API 与检索：`/api/session-search` 支持消息级 snippet 高亮回源
- **INV-277 (M7-2)**: 跨 Agent 需求意图打包与一键上下文交接机制
  - 自动沉淀目标会话的原始意图、修改文件、测试验证与未竟任务
  - 生成标准 Handoff Markdown，通过 `/api/sessions/:id/handoff` 与 MCP 工具输出

### Milestone M8: 研发经验图谱合成与外部伴侣感知消费 (INV-275)
- 基于「Commit 归因 + 文件触碰 + 需求动机」闭环，萃取项目级轻量避坑知识卡片（Policy）
- MCP 新增 `knowledge_query` 与 `project_guidelines` 工具，向外部 Coding Agent 只读投递经验
- 4 槽位 `/api/agent-status` 扩展实时事件流（SSE/WS），打通桌面伴侣与硬件桌宠感知

