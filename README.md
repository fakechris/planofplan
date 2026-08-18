# planofplan

本地 dashboard，管理多个 AI Coding Plan 订阅的用量/限额。
展示形态参考 **CodexBar**（逐 plan 用量条 + 总览 dashboard），架构参考 **onWatch**（守护进程 + SQLite + localhost Web）。

当前状态：**M1**（骨架 + MiniMax legacy adapter 闭环）。

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
planofplan auth set <slug> --key <v>     存手动 key（credentials.json, 0600）
planofplan auth set <slug> --auto        改回自动检测（env / CLI 凭据）
planofplan auth clear <slug>             清掉手动 key
```

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

## 已知限制（M1）

- 仅 MiniMax adapter；其余 7 个 plan（GLM legacy/current、Claude、Codex、Kimi、Grok、Cursor）在 M2 接入，规格已定稿在 `docs/planofplan-design.md`
- 无 session 鉴权（仅监听 localhost；如部署到其他机器需自行加反向代理/密码）
- UI 的启停/授权开关写 db，重启后以 config.json 为准（文档见设计 §8）

## 测试

```bash
bun test           # minimax 解析 + store 快照逻辑
bun run typecheck  # tsc --noEmit
```
