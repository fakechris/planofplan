# planofplan

本机的多 coding agent 洞察中枢：从 Claude Code / Codex / Kimi / GLM 等 agent 的本地 session 里做**内容抽取 → 用户动机洞察 → agent 行为跟踪 → commit 到动机的归因**。

归因链：`用户消息（动机） → session（意图载体） → tool calls（行为） → file touches（触及面） → commit（结果）`。

两条产品线：**额度与消耗**（多 plan 配额 dashboard + macOS menubar，形态参考 CodexBar，架构参考 onWatch）是入口和钩子；**工作谱系**（session → 需求 → commit 的归因链）是主线。session 索引层设计参照 Obelisk 研究（[`docs/obelisk-session-research.md`](docs/obelisk-session-research.md)）。

当前状态：**M2 额度轨** + **WG-M3 session 目录**（扫描本地 Claude / Codex / Grok / DSH 等日志，只读文件头，不复制原文。见 [`docs/work-graph-design.md`](docs/work-graph-design.md)）。

界面按 **Lumen Design System** 实现：Vault 深色默认、Atelier 浅色切换（`data-theme`），IBM Plex Sans/Mono 字体栈，4px 网格，额度阈值 75%/90% 染色。

## 快速开始

```bash
bun install

# 方式一：环境变量提供 MiniMax Coding Plan Key
export MINIMAX_CODING_API_KEY=sk-cp-xxxx
bun run serve        # http://localhost:9288

# 方式二：存到本地凭据文件（~/.planofplan/credentials.json，0600）
bun run planofplan auth set minimax --key sk-cp-xxxx
bun run serve

# 不配 key 也能预览界面（内置示例数据，内存库不落盘）
bun run demo
```

## CLI
```
planofplan serve [--demo] [--port N]    启动守护进程 + Web dashboard
planofplan usage [--json] [--provider sl] 全 plan 配额输出
planofplan tokens [--json] [--days N] [--provider sl] token usage & spend 报表
planofplan sessions [--json] [--days N] [--provider sl] 本地 session 目录（Claude/Codex/Grok/DSH…）
planofplan status                        各 plan 调度/凭据/最近抓取状态
planofplan refresh [slug]                手动刷新一个/全部 plan
planofplan browser-auth                  只读取 Safari kimi-auth 并刷新 Kimi
planofplan auth set <slug> --key <v>     存手动 key（credentials.json, 0600）
planofplan auth set <slug> --auto        改回自动检测（env / CLI 凭据）
planofplan auth clear <slug>             清掉手动 key
```

`tokens` / `/api/usage` 是独立于 quota 百分比的 Usage & Spend 报表：

- 默认只读本地 provider 日志：Codex `~/.codex/sessions`、Claude
  `~/.claude/projects`、ZCode `~/.zcode/cli/rollout`、Kimi CLI
  `~/.kimi-code/sessions`、Grok CLI `~/.grok/logs/unified.jsonl`、DSH
  `~/.dsh/sessions`。Codex 使用累计 token 的非负增量，Claude 使用
  `message.id + requestId` 去重，DSH 只取最终 `assistant/message` 事件避免
  streaming chunk 重复。
- Droid/Factory 的 `~/.factory/sessions` 当前只有 session/message 元数据，没有可靠的
  per-turn token ledger，因此不会把 `summaryTokens` 或消息数伪装成 token usage；Droid
  的真实组织 token consumption 仍使用 Factory Analytics。
- 统计 input、cache read、cache creation、output、reasoning、total，并按日期、provider、
  model、source 聚合。
- 本地成本是价格表估算，不是账单；未知模型不显示虚构价格。
- 设置 `ANTHROPIC_ADMIN_API_KEY` 可加入 Claude Code Analytics，设置
  `FACTORY_API_KEY` 可加入 Factory organization Analytics。二者要求各自的组织级权限，
  并作为 `official` 来源单独标记。
- 设置 `CODEX_APP_SERVER_USAGE=1` 可尝试调用本机 Codex app-server 的
  `account/usage/read` 官方日汇总。官方数据与本地日志可能存在范围差异，报表不会把它们
  伪装成同一份账单。
- Dashboard 普通打开和 `GET /api/usage` 默认只读已保存数据，不会同步扫描大日志目录。
  使用 Dashboard 的“扫描本地日志”按钮，或调用 `GET /api/usage?days=30&refresh=1`
  显式启动后台扫描；扫描期间 API 会返回上次已保存的数据和 `scanStatus`。
- Session catalog（`planofplan sessions` / `/api/sessions`）在 daemon 启动时增量索引，
  之后由文件监听（`src/watcher.ts`）实时驱动：session 目录有写入就自动触发增量扫描
  并通过 SSE（`/api/events`）推送 dashboard 刷新，无需打开页面或手动扫描；
  未变文件按行级水位跳过，扫描过程分片让出事件循环。

JSON API：

```text
GET /api/usage?days=30
GET /api/usage?days=7&provider=codex
GET /api/usage?days=30&refresh=1
```

## MCP（agent 查 planofplan）

daemon 在 `POST http://localhost:<port>/mcp` 提供只读 MCP（streamable HTTP，
无会话状态；Host 头校验同样生效）。被监控的 agent 可以反过来查配额与谱系——
这是三家里没人做的错位面：agentsview/obelisk 的 agent 面是通用历史检索，
这里只有配额 + 谱系。五个工具：

- `plan_quota_status` 各订阅的配额窗口与重置倒计时
- `usage_summary` 本地日志的 token 用量/成本估算（按天/provider/模型）
- `session_search` 跨全部 agent 会话的元数据 ∪ 消息正文 FTS 搜索
- `repo_lineage` 一个仓库最近的会话→需求→commit 谱系
- `requirement_status` 最近抽取的需求及其 commit 落地状态

接入 Claude Code：

```bash
claude mcp add --transport http planofplan http://localhost:9288/mcp
```

接入 Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.planofplan]
url = "http://localhost:9288/mcp"
```

## macOS menubar app

构建并安装到唯一运行位置 `/Applications/planofplan.app`：

```bash
bun run menubar:build
open /Applications/planofplan.app
```

`menubar:build` 只允许在 Git 工作区干净且所有源代码已经 commit 后运行。构建会把当前
commit 的完整 SHA、短 SHA、构建时间和版本写入 app，并原子替换
`/Applications/planofplan.app`。不要从 `dist` 启动旧副本。

menubar app 会启动本地 Bun daemon，并提供查看用量、刷新全部 plan、打开 Dashboard，以及**选择一个浏览器**读取 Kimi/Factory 网页会话。

浏览器读取不会自动遍历所有浏览器。每个浏览器的 Keychain 结果和 Kimi token 只在当前进程内存缓存，后台轮询不会再次弹出密码：

```bash
bun src/cli.ts browser-auth --browser firefox
bun src/cli.ts browser-auth --browser chrome
bun src/cli.ts browser-auth --browser comet
bun src/cli.ts browser-auth --browser dia
bun src/cli.ts browser-auth --browser safari
```

`menubar:build` 使用证书身份 `Lumen Local Codesign` 对 app 签名，并拒绝
ad-hoc 签名。这样 Full Disk Access 的 TCC 授权绑定稳定的 Bundle ID /
designated requirement，而不是每次构建都会变化的 cdhash。

首次使用时，确认本机存在这个证书身份：

```bash
security find-identity -v -p codesigning | grep 'Lumen Local Codesign'
```

如果不存在，在“钥匙串访问 → 证书助理 → 创建证书”中创建一个
“Code Signing”自签名证书，名称使用 `Lumen Local Codesign`，并设为始终信任。
然后只需把首次稳定签名生成的 `/Applications/planofplan.app` 加入 Full Disk Access；
以后用同一身份重建不会重复要求授权。

Chrome、Comet、Dia 等 Chromium 浏览器首次读取可能弹出对应的 macOS Safe Storage
Keychain 授权；Safari Cookie 由原生 app 读取。首次检测到 Safari cookie 文件被系统保护时，
app 会自动打开“完全磁盘访问权限”设置页并持续检测授权结果，授权后自动重试 Kimi，
无需用户在 planofplan 内手动选择浏览器。macOS 仍要求用户在系统设置中确认开关。
Cookie token 不写入数据库或凭据文件。

`planofplan usage --json` 输出示例：

```json
{
  "generatedAt": 1755440000000,
  "plans": [
    {
      "slug": "minimax",
      "name": "MiniMax legacy",
      "adapter": "minimax",
      "enabled": true,
      "status": "ok",
      "authStatus": "auto",
      "windows": [
        {
          "id": "rolling_5h",
          "label": "5H",
          "used": 380,
          "total": 1000,
          "unit": "prompts",
          "percentage": 38,
          "resetAt": 1755448400000,
          "note": null
        }
      ],
      "lastFetchedAt": 1755447200000,
      "lastAttemptAt": 1755447200000,
      "lastError": null
    }
  ]
}
```

## 常驻 daemon（launchd 自愈，默认关闭）

menubar app 只在自身启动时探测并拉起一次 daemon，daemon 之后死掉它不会重试
（2026-08-19 的事故原因）。**开机自启默认不开启**，也不会替用户安装任何
LaunchAgent；在 Dashboard header 的「开机自启」开关里显式选择：

- **从关到开**：安装 `local.planofplan.daemon` LaunchAgent（KeepAlive 崩溃/被杀
  约 10s 自动重启，RunAtLoad 登录自启），daemon 会切换到 launchd 守护下重启接管，
  页面短暂重连。端口与 menubar bundle 一致（默认 9291），menubar 探测到端口健康
  就不会重复 spawn。
- **从开到关**：删除 LaunchAgent 注册；注销/重启后不再自动启动。当前会话里已在
  运行的 daemon 不受影响，继续服务到注销为止。

CLI 等价命令与检查方式：

```bash
bun run daemon:install                                    # 安装并立即启动（同开关开启）
bun run daemon:uninstall                                   # 删除自启注册（同开关关闭）
launchctl print gui/$(id -u)/local.planofplan.daemon      # 查看守护状态
```

- 日志在 `~/.planofplan/serve.log`（kimi Safari 授权警告每分钟追加约两行，注意定期
  `: > ~/.planofplan/serve.log` 清空）。
- plist 记录的是仓库绝对路径，仓库移动/改名后需重新 `bun run daemon:install`。
- 开启守护后不要再手动 `bun run serve`：默认端口不同（9288 vs 9291），会出现两个
  daemon 同时轮询并写同一个 SQLite 库。

## 配置

运行时状态全部在 `~/.planofplan/`（可用 `PLANOFPPLAN_HOME` 改）：

- `config.json` — 每 plan 配置（slug/name/adapter/enabled/poll_interval_sec/extra）
- `credentials.json` — 手动 API Key（0600）
- `planofplan.db` — 用量快照与历史（SQLite）

默认配置注册 `minimax`（region=cn）。新增 plan = 在 `config.json` 加一条 + `src/adapters/` 加一个 adapter。

## 架构

```
src/cli.ts        入口：serve / usage / status / refresh / auth / pricing
src/core.ts       Scheduler（轮询/退避/stale，入口吞错）+ overview 组装
src/db.ts         SQLite：plans / snapshots / usage_records / sessions / session_user_meta
src/auth.ts       manual key 存取（0600）+ env 读取
src/adapters/     每 plan 一个 adapter：detectCredentials -> fetchUsage -> QuotaWindow[]
src/usage.ts      本地 JSONL scanner、token 去重、日期/model/provider 聚合
src/pricing.ts    模型价格快照（LiteLLM 拉取 + 家族表兜底）
src/sessions.ts   session 目录（catalog + 消息级索引 + 行级水位 + 墓碑过滤）
src/watcher.ts    文件监听：根目录 recursive watch + 静默窗/maxWait 防抖
src/mcp.ts        只读 MCP server（/mcp，五个配额/谱系工具）
src/official-usage.ts  Anthropic / Factory Analytics + 可选 Codex app-server usage
web/              静态前端（无构建，vanilla JS + CSS；SSE 实时刷新）
```

adapter 接口见 `src/types.ts`。MiniMax 的端点/解析规格出处：CodexBar `docs/minimax.md` + `MiniMaxUsageFetcher.swift`、JinHanAI/coding-plan-monitor（实测实现）。

各 agent 本地 session 格式的证据与坑（动 parser 前必读、动 parser 时必更）：[`docs/session-format-sources.md`](docs/session-format-sources.md)。

## 覆盖矩阵与验证状态（2026-08-21）

| plan | adapter | 真机验证 | 备注 |
|---|---|---|---|
| MiniMax legacy | minimax | ✅ | 5h 多车道（general/video）+ weekly 车道 |
| GLM Coding Plan | glm | ⏳ | 自动尝试 z.ai / BigModel quota host，支持 5h/week/MCP；只需在 Dashboard 的 GLM 设置弹窗填写 API key，不需要选择区域 |
| Claude Code | claude | ✅ | 读 Keychain OAuth；5H / Week / Fable Week（`limits[].weekly_scoped` 解析）；5H 7% / Week 18%（实测） |
| OpenAI Codex | codex | ✅ | 读 `~/.codex/auth.json`；5H 90%（实测） |
| Kimi Code | kimi | ✅ | 读 `~/.kimi-code/credentials/kimi-code.json`；按 onWatch 规则自动刷新并写回轮换 token；月限额需 kimi.com 网页登录态 |
| Grok | grok | ✅ | 读 `~/.grok/auth.json`；Credits 95%（实测，8/18 重登后；SuperGrok） |
| Cursor legacy | cursor | ✅ | 读 `state.vscdb`；legacy 0/500（实测，本月已重置） |
| Factory Droid | factory | ⏳ | 对齐 CodexBar：API key 走 `/api/billing/limits`，网页会话走 Factory cookie；Standard 5H/Week/Month + legacy Standard/Premium |

## 已知限制（M2）

- GLM 待 API key：在 Dashboard 的 GLM 设置弹窗填写，或运行 `planofplan auth set glm --key <key>`；也可设置 `Z_AI_API_KEY` / `ZAI_API_KEY` / `BIGMODEL_API_KEY`
- Factory 可设置 `FACTORY_API_KEY`、`~/.factory/.env` 或运行 `planofplan auth set factory --key <key>`；也可在 `app.factory.ai` 登录后通过 menubar 读取 Safari/Chromium/Firefox 的 Factory session cookie。接口与窗口语义对齐 CodexBar `docs/factory.md`，onWatch 当前没有 Factory adapter
- Factory WorkOS refresh token 一次性轮换：daemon 维护自己的轮换链并写入 `~/.planofplan/factory-session.json`（跨重启存活），浏览器/CLI 各持独立链互不影响；只有 menubar 重读或 `planofplan factory-auth` 导入 droid CLI 登录态（`~/.factory/auth.v2.*`，AES-256-GCM，key 在 Keychain `Factory CLI`）才会切换/消耗对应来源的 token——导入 droid CLI 的链会让 CLI 下次要求重新登录，因此只作手动恢复入口，不做自动凭据源
- Bun fetch 不读取 HTTP(S)_PROXY；Grok 等需要代理的端点建议用系统级 TUN/全局代理（M3 可加 CONNECT 隧道）
- Kimi 月限额仅网页会话可取：menubar 会按 provider 自动读取所选浏览器；遵循 CodexBar 的 `desktopAuthToken()`/`importSession().authToken` 会话导入，不以 JWT `exp` 单独判断网页是否登出。Keychain 结果与 token 只在内存缓存，不遍历、不重复授权
- Kimi CLI access_token 只有 15 分钟有效期：按 onWatch 规则在过期时自动调用 `auth.kimi.com/api/oauth/token`，并把轮换后的 access/refresh token 安全写回原 `kimi-code.json`；设 `KIMI_USE_REFRESH=0` 可关闭
- Kimi 周额度接口按 100 计（97/100 = 剩余 3%）；5h 窗口接口无 used 字段，用 remaining 反推
- 无 session 鉴权（仅监听 localhost；如部署到其他机器需自行加反向代理/密码）
- UI 的启停/授权开关写 db，重启后以 config.json 为准（文档见设计 §8）

## 测试

```bash
bun test           # minimax 解析 + store 快照逻辑
bun run typecheck  # tsc --noEmit
```
