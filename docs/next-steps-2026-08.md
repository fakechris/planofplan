# 下一步工作：三项目对照后的排序（2026-08-29）

> 输入：agentsview（kenn-io，MIT，Go+Svelte，PR ~#1550）、obelisk（tommy0103，
> **AGPL-3.0**，Electron+TS，2026-08-29 main）、Wake（iAmCorey，MIT，Rust+GPUI）。
> 结论对齐 `obelisk-session-research.md`（P0 消息表 + 行级水位已于 08-22 落地）、
> `work-graph-design.md` 的抄/不抄框架。obelisk 为 AGPL：**只抄思想，代码/schema/ADR
> 文本一律不搬**。

## 0. 决策框架

三家各占一条赛道：agentsview = 规模化用量/成本（50 家 parser、价格快照、语义搜索）；
obelisk = agent 记忆检索（CodeAct 查询面，已以插件进 DSH）；Wake = 人类浏览体验
（trigram 搜索、resume、墓碑）。planofplan 不在他们的赛道补课，只做两件事：

1. 关掉阻碍主线（额度轨 + 谱系轨）的基建短板；
2. 建三家里没有的那个面：**配额 + 谱系的 agent 查询（MCP）**。

## 1. 差距清单（他们有 → 我们弱）

| # | 能力 | 证据出处 | 我们现状 |
| --- | --- | --- | --- |
| A | 文件监听 + 实时推送 | agentsview SSE；obelisk ADR-0009（@parcel/watcher + 热文件轮询 + 断流恢复 + 有界批调度）；Wake live watching | 只在打开页面 / `refresh=1` 时 spawn 扫描子进程，无监听无 SSE |
| B | 用户数据层（星标/隐藏/删除）独立于可重建索引 | Wake `wake-core/src/db.rs:199-220,445-460`：tombstones 表 file_path+key 双键，重建幸存；agentsview 有 star/rename 端点 | 无。L1 可重建 ⇒ 用户操作在重建后必然复活 |
| C | 标题来源多元化 | obelisk：Claude `ai-title` 记录 + `history.jsonl`；Codex `session_index.jsonl` 只当轻量标题/更新元数据 | 首条用户消息启发式截取；「隐藏无标题」开关证明痛点 |
| D | agent 查询面 | obelisk CodeAct + skill（已进 DSH 插件）；agentsview MCP server（`internal/mcp`） | 无。且没一家能查配额/谱系 |
| E | 安全默认 | agentsview：loopback + Host 头校验（防 DNS rebinding）+ `--require-auth` | localhost 绑定，但无 Host 校验 |
| F | 价格数据机制 | agentsview：LiteLLM/OpenRouter 快照 + 离线 fallback + 整数微美元 | `usage.ts` 硬编码 `MODEL_PRICE_FAMILIES` 正则，新模型出现即失明 |
| G | provider 覆盖 | Wake 15 家（含 SQLite 型存储读法：copilot/opencode/kiro）；agentsview ~50 | 7 家，但含 zcode/dsh/factory 独家 |
| H | 格式溯源制度 | agentsview `docs/internal/session-format-sources.md`：每 provider 一条格式证据 | 研究文档有，但无 per-provider 证据条目 |
| I | 语义/结构化检索 | agentsview 向量/混合；obelisk CodeAct 结构化查询 | FTS5 trigram（已落地，够用） |

## 2. 批次排序

### 第一批 —— 基建收尾（✅ 已全部落地，2026-08-29）

1. **watcher + 单飞索引触发 + SSE**（差距 A）。参考 obelisk ADR-0009 的形态：根目录
   recursive watch + 静默窗防抖 + maxWait 有界批（吵闹的活跃 session 不饿死 flush）。
   搭现有车：flush 不重造扫描，只 spawn 同一个 `sessions --refresh` 子进程
   （`session_index_state` 行级水位保证未变文件近零成本），加 trailing 重触发。
   服务端 `/api/events` SSE 广播 `index` / `sessions-indexed`；前端 EventSource 收到
   后节流触发 `render()`。
   验收：活跃 session 写入后，dashboard 无人工操作 ≤5s 内出现新消息；footer 显示
   索引状态与最近索引时间。（隔离 E2E 冒烟已验证全链路）
   后续优化（先测量再决定）：changedPaths 定向发现（省 walk 成本；需处理
   kimi wire.jsonl / grok chat_history.jsonl → 目录文件的反向映射）。
2. **session_user_meta + 墓碑**（差距 B，Wake 模式）：`session_user_meta` 表
   （session_id 主键 + file_path 副键）独立于可重建索引；star/hidden 走部分更新，
   删除 = 墓碑 + 级联清 L1 行（L0 源文件永远不动）；catalog 扫描三道闸
   （发现层拦 file_path、行层拦 id、stub 层拦 usage 回填）+ 存量清理；
   `/api/sessions` 默认排除 hidden（`?hidden=1` 显式包含，FTS 命中路径同闸）；
   端点：star/hide/DELETE/restore + `/api/sessions/deleted` 恢复入口。
   验收：hidden/star 在 rebuild 后幸存（测试覆盖）；删除走墓碑不复活（测试覆盖）。
3. **Host 头校验 + 可选鉴权**（差距 E）：仅放行 localhost/127.0.0.1/[::1] 的 Host
   （`PLANOFPLAN_ALLOWED_HOSTS` 可扩），403 其余。鉴权开关暂缓（无对外暴露场景）。

### 第二批 —— 元数据质量（✅ 已落地，2026-08-29，喂当前主战场：计划发现）

4. **标题来源多元化**（差距 C）：官方优先于启发式——claude `ai-title` 记录
   （头部解析 + 消息索引流式读双路捕获,记录可深至数千行）→
   `history.jsonl` 首条真实用户输入兜底;codex `session_index.jsonl` 的
   `thread_name` 覆盖启发式。`MESSAGE_PARSER_VERSION` 升 3,一次性全量
   重扫顺带刷新全部标题。本机实测:782 session / 687 有标题(88%),
   18 个 codex 官方线程名生效。
5. **is_meta 过滤**（research 文档 P1 #6）：claude `isMeta` 注入
   （structured-output-enforce 等）与 codex 系统信封（11 种标签,本机普查
   清单,显式列举不误杀用户粘贴的 HTML）不进标题提取、消息索引与
   transcript 视图。新信封出现时往 `CODEX_META_ENVELOPES` 追加并升
   parser 版本。

### 第三批 —— 差异化新面（✅ 已落地，2026-08-29）

6. **只读 MCP server**（差距 D 的错位打法）：`POST /mcp`（streamable HTTP
   子集,手写 JSON-RPC 最小协议面,无 SDK 依赖）暴露
   `plan_quota_status` / `usage_summary` / `session_search` /
   `repo_lineage` / `requirement_status`。Host 头校验覆盖;README 补了
   Claude Code / Codex 接入命令。不做通用历史检索（obelisk 已占位）。
   落地时顺带修掉一个被 watcher 放大的潜伏崩溃:调度器/启动扫描/扫描
   子进程三方并发写 SQLite,WAL 下无 busy_timeout 时第二个写者
   SQLITE_BUSY 直接带崩 daemon——补 `PRAGMA busy_timeout=5000` +
   调度器入口吞错（`safeRefresh`）。

### 第四批 —— 机制与制度（见缝插针）

7. 价格表快照化（差距 F；注意成本只是估算层，不过度投入）。
8. 格式溯源文件（差距 H）：动某家 parser 时补该家证据条目。

## 3. 明确不做（本轮）

- 语义/向量搜索（差距 I）：等 FTS 不够用的真实信号。
- parser 数量竞赛（差距 G）：按实际在用的 agent 加。
- Recap 周报卡片 / 虚拟滚动 / 桌面壳 / PG·DuckDB 镜像：全是别家产品面。谱系轨跑出
  数据后可评估「谱系周报」（哪些需求落了 commit、每个需求烧了多少额度）。
