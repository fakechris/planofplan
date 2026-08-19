# planofplan

本地 dashboard，管理多个 AI Coding Plan 订阅的用量/限额。
展示形态参考 **CodexBar**（逐 plan 用量条 + 总览 dashboard），架构参考 **onWatch**（守护进程 + SQLite + localhost Web）。

当前状态：**M2**（8 个 adapter 接入：MiniMax、GLM legacy/current、Codex、Kimi、Grok、Cursor、Claude、Factory Droid；其中 MiniMax/Codex/Cursor/Claude 已本机真机验证）。

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
planofplan usage [--json] [--provider sl] 全 plan 用量输出（CodexBar usage 风格）
planofplan status                        各 plan 调度/凭据/最近抓取状态
planofplan refresh [slug]                手动刷新一个/全部 plan
planofplan browser-auth --browser name   读取指定浏览器 kimi-auth（仅该浏览器，按需触发 Keychain）
planofplan auth set <slug> --key <v>     存手动 key（credentials.json, 0600）
planofplan auth set <slug> --auto        改回自动检测（env / CLI 凭据）
planofplan auth clear <slug>             清掉手动 key
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

## 配置

运行时状态全部在 `~/.planofplan/`（可用 `PLANOFPPLAN_HOME` 改）：

- `config.json` — 每 plan 配置（slug/name/adapter/enabled/poll_interval_sec/extra）
- `credentials.json` — 手动 API Key（0600）
- `planofplan.db` — 用量快照与历史（SQLite）

默认配置注册 `minimax`（region=cn）。新增 plan = 在 `config.json` 加一条 + `src/adapters/` 加一个 adapter。

## 架构

```
src/cli.ts        入口：serve / usage / status / refresh / auth
src/core.ts       Scheduler（轮询/退避/stale）+ overview 组装
src/db.ts         SQLite：plans / snapshots / plan_state
src/auth.ts       manual key 存取（0600）+ env 读取
src/adapters/     每 plan 一个 adapter：detectCredentials -> fetchUsage -> QuotaWindow[]
web/              静态前端（无构建，vanilla JS + CSS）
```

adapter 接口见 `src/types.ts`。MiniMax 的端点/解析规格出处：CodexBar `docs/minimax.md` + `MiniMaxUsageFetcher.swift`、JinHanAI/coding-plan-monitor（实测实现）。

## 覆盖矩阵与验证状态（2026-08-18）

| plan | adapter | 真机验证 | 备注 |
|---|---|---|---|
| MiniMax legacy | minimax | ✅ | 5h 多车道（general/video）+ weekly 车道 |
| GLM Coding Plan | glm | ⏳ | 自动尝试 z.ai / BigModel quota host，支持 5h/week/MCP；只需在 Dashboard 的 GLM 设置弹窗填写 API key，不需要选择区域 |
| Claude Code | claude | ✅ | 读 Keychain OAuth；5H 7% / Week 18%（实测） |
| OpenAI Codex | codex | ✅ | 读 `~/.codex/auth.json`；5H 90%（实测） |
| Kimi Code | kimi | ✅ | 读 `~/.kimi-code/credentials/kimi-code.json`；按 onWatch 规则自动刷新并写回轮换 token；月限额需 kimi.com 网页登录态 |
| Grok | grok | ✅ | 读 `~/.grok/auth.json`；Credits 95%（实测，8/18 重登后；SuperGrok） |
| Cursor legacy | cursor | ✅ | 读 `state.vscdb`；legacy 0/500（实测，本月已重置） |
| Factory Droid | factory | ⏳ | 对齐 CodexBar：API key 走 `/api/billing/limits`，网页会话走 Factory cookie；Standard 5H/Week/Month + legacy Standard/Premium |

## 已知限制（M2）

- GLM 待 API key：在 Dashboard 的 GLM 设置弹窗填写，或运行 `planofplan auth set glm --key <key>`；也可设置 `Z_AI_API_KEY` / `ZAI_API_KEY` / `BIGMODEL_API_KEY`
- Factory 可设置 `FACTORY_API_KEY`、`~/.factory/.env` 或运行 `planofplan auth set factory --key <key>`；也可在 `app.factory.ai` 登录后通过 menubar 读取 Safari/Chromium/Firefox 的 Factory session cookie。接口与窗口语义对齐 CodexBar `docs/factory.md`，onWatch 当前没有 Factory adapter
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
