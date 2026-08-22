# planofplan 设计方案

> 状态：待评审（架构方向已按用户确认收敛，技术栈默认值可一票否决）
> 参考蓝本：**onWatch**（架构/数据模型/轮询调度）＋ **CodexBar**（provider 文档规格/用量条显示语义/CLI 输出）＋ ccusage / kimi-code-usage / Tendo33（窗口算法与专项实现）
> 上游调研与数据源细节见 [`docs/coding-plan-usage-trackers.md`](./coding-plan-usage-trackers.md)

---

## 0. 产品定位（2026-08-22 用户确认）

planofplan 不是配额监控器，而是**本机的 coding agent 洞察层**：

- **内容抽取**：消息级索引多家 agent 的本地 transcript——用户说了什么、agent 做了什么；
- **用户动机洞察**：从用户消息抽取需求/意图，聚成可追踪的「动机单元」（work graph 的 requirement 是其载体）。已有地基：`src/graph.ts` 的 requirement 节点（title 启发式）+ dsh-track 的 capture/motivation-context 实践——其教训是模型主动捕获率极低（实测 1/148），且「最近一条用户请求」的 context 粒度太粗；离线从 L0 日志抽取 + 消息级全文是正路，不走 agent 自报；
- **agent 行为跟踪**：tool call 序列、文件触及面、失败重试，刻划 agent 怎么干活；
- **commit → 动机归因**：session-repos 的三维归属（work/touch/commit）+ `Harness-Session` trailer，把每个 commit 归因回当初那句需求。

归因链：`用户消息（动机） → session（意图载体） → tool calls（行为） → file touches（触及面） → commit（结果）`。

额度/配额（下文 §0.1 起）是第一条产品线与获客钩子，不是终态。session 索引层的工程参照见 [`obelisk-session-research.md`](./obelisk-session-research.md)：消息表 + FTS、行级增量 cursor、changedPaths 定向索引；中文搜索用 trigram 分词（unicode61 对中文子串半残，实测）。

## 0.1 产品形态（用户已确认）

- **展示方式照 CodexBar**：
  - 每个 plan 一条**用量条**（`used/total`、百分比、重置倒计时）；多窗口的 plan 一条 bar 内分多段（5h / 周 / 月 / 请求数），支持「合并总条 vs 分条」视图切换；
  - 阈值染色：`>50%` 正常、`10–50%` 黄、`<10%` 红（CodexBar 语义），`stale` 数据灰显并标注抓取时间。
- **一个 total dashboard**：单页聚合 8 个 plan 的同屏总览（卡片网格 + 顶部汇总：可用 plan 数、最紧俏排序、即将重置列表），每卡片可展开历史/预测。
- **授权方式（已确认）**：主路线 = API Key / 本地 CLI 凭据自动检测（onWatch 式，绕开浏览器）；浏览器 cookie 读取仅作兜底层，不做主体（不采用浏览器扩展）。
- 平台：macOS 优先，Web dashboard 形态天然跨平台；不做菜单栏 app（那是 CodexBar 的壳，不是数据能力）。

## 1. 总体架构

```
┌─────────────────────────────  planofplan daemon（单进程，常驻）  ─────────────────────────────┐
│                                                                                              │
│  ┌──────────────┐   ┌──────────────────────┐   ┌───────────────────┐   ┌─────────────────┐   │
│  │ Provider     │   │ Scheduler            │   │ Snapshot Store    │   │ Web Server      │   │
│  │ Adapters     │   │ 每 plan 独立轮询      │   │ SQLite 快照/历史   │   │ /api + 静态前端  │   │
│  │ (8 个)       │   │ 指数退避/限流/stale  │   │ 保留期/pruning    │   │ localhost:PORT  │   │
│  └──────┬───────┘   └──────────┬───────────┘   └────────┬──────────┘   └────────┬────────┘   │
│         │ 凭据检测/读取         │ 触发                  │ 读写                  │ 查询/刷新     │
│  ┌──────┴───────┐              │                        │                        │             │
│  │ Auth 层       │◄─────────────┴────────────────────────┴────────────────────────┘             │
│  │ 自动检测 +    │   (手动 refresh / auth set 从 CLI 或 UI 进来)                                  │
│  │ 手动 key 存储 │                                                                              │
│  └──────────────┘                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **单进程**：轮询调度、SQLite、HTTP server、静态资源全在一个进程（onWatch 同思路，`<50MB` 内存）。
- **适配器是纯函数化插件**：`detectCredentials → fetchRaw → normalize(→ QuotaSnapshot[])`，每个 plan 一个文件，新增 plan = 新增文件 + 注册一行。
- **数据流**：Scheduler 按每 plan 间隔触发 → Adapter 拉取 → normalize 成多窗口快照 → 落 SQLite → Web 端读 SQLite 渲染。失败时**保留最后成功快照标 stale**（CodexBar 语义），auth 失败则暂停该 plan 并等待恢复（onWatch 语义）。

## 2. 技术选型（默认值，可一票否决）

| 层 | 默认选择 | 理由 |
|---|---|---|
| 运行时 | **Bun + TypeScript** | 单进程内完成 daemon+server+db；内置 `bun:sqlite`；适配器逻辑与 CodexBar provider 文档同构，对照移植成本最低；用户环境已有 bun |
| HTTP | Hono | 轻量、Bun 一等支持，路由/中间件够用 |
| 存储 | SQLite（`bun:sqlite`） | onWatch 同款，零运维 |
| 前端 | **静态 HTML/CSS/JS + Chart.js**，无构建步骤 | onWatch 同思路（模板渲染 + fetch /api）；避免前端工程化；风格 MD3 |
| 凭据存储 | `~/.planofplan/credentials.json`（chmod 600），密钥按 id 引用；后续可换系统 keychain | 个人本地工具，先最小可用 |
| 备选 | Go（完全照 onWatch） | 若偏好单一二进制/更低内存；代价是适配器层重写，本方案默认不走 |

> 技术栈与架构解耦：本设计的接口、数据模型、适配器规格与语言无关，栈切换只影响实现层。

## 3. 数据模型（借鉴 onWatch 的 quota values + reset cycles）

```sql
-- 每个 plan 的静态配置
plans(
  id            TEXT PRIMARY KEY,      -- 'minimax_legacy' | 'glm_legacy' | 'claude' | ...
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,         -- 显示名，如 "MiniMax legacy"
  enabled       INTEGER DEFAULT 1,
  adapter       TEXT NOT NULL,         -- 对应 adapters/minimax.ts 等
  cred_ref      TEXT,                  -- credentials.json 里的 key id（manual 时）
  poll_interval_sec INTEGER,           -- 默认 60；Claude 等可按需降频
  extra         TEXT,                  -- JSON：区域、profile、region 等 adapter 参数
  created_at / updated_at
)

-- 每窗格一次抓取的结果（当前值 = 每种 (plan_id, window) 的最新一条）
snapshots(
  id           INTEGER PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  window       TEXT NOT NULL,          -- rolling_5h | weekly | monthly | requests | credits_period
  label        TEXT,                   -- 展示名，如 "5H" / "Week" / "Month" / "Requests"
  used         REAL NOT NULL,
  total        REAL,                   -- NULL = 只有余额（如 Grok credits、MiniMax 剩余 prompts）
  unit         TEXT DEFAULT 'percent', -- percent | requests | credits | prompts
  percentage   REAL,                   -- 归一化 0-100，用于染色
  reset_at     INTEGER,                -- epoch ms；NULL = 未知
  fetched_at   INTEGER NOT NULL,
  stale        INTEGER DEFAULT 0,      -- 上次失败仍展示最后快照
  UNIQUE(plan_id, window, fetched_at)
)
CREATE INDEX idx_snapshots_plan_window ON snapshots(plan_id, window, fetched_at);

-- 当前状态直接由最新快照派生（无需单独 current 表），history/预测查同一张表
```

**窗口语义统一建模**（8 个 plan 的 4 种模型全部落进 `window` 字段）：

| 模型 | window | 命中的 plan |
|---|---|---|
| 滚动 5h 单窗口 | `rolling_5h` | MiniMax legacy、GLM legacy（只有 5h，无次级窗口） |
| 周 + 5h（+月） | `rolling_5h` + `weekly`（+ `monthly`） | Claude、Codex、Kimi、GLM current |
| 纯周期余额 | `credits_period`（周期起止由 provider 返回） | Grok（creditUsagePercent + currentPeriod.end） |
| 请求数 / 月 | `requests`（`monthly` 周期） | Cursor legacy（500 req/月） |

> 一条 API 响应可产生多条快照（如 GLM current 的 TOKENS_LIMIT 5h + TOKENS_LIMIT weekly + TIME_LIMIT）。「仅单窗口」的 legacy plan 在 UI 上自然只渲染一条 bar。

**适配器接口**：

```ts
interface PlanAdapter {
  slug: string;
  detectCredentials(): Promise<CredentialRef | null>;   // 自动检测，null = 需手动
  fetch(ctx: AdapterContext): Promise<ProviderRaw>;      // ctx 带凭据与 extra 参数
  normalize(raw: ProviderRaw, at: number): QuotaSnapshot[]; // → 多窗口快照
}
```

## 4. 8 个 adapter 规格（需求规格直接抄 CodexBar 的 provider docs）

> 每行给出：凭据 → 端点 → 解析要点 → 坑。完整请求头/字段见上游报告 §6。

| # | Plan | 凭据（自动检测顺序） | 端点 | 解析要点 | 坑 |
|---|---|---|---|---|---|
| 1 | MiniMax legacy | `MINIMAX_CODING_API_KEY`（`sk-cp-*`）优先于 `MINIMAX_API_KEY`；区域 `MINIMAX_REGION` | `GET {host}/v1/api/openplatform/coding_plan/remains`（host: platform.minimaxi.com 或 CN 变体） | 剩余（prompts）+ 5h 滚动重置时间 | legacy 端点可用性需本人账号实测（新旧账号可能差异，报告 §8） |
| 2 | GLM legacy | `BIGMODEL_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY` / relay 文件 | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（Bearer + `accept: application/json`） | `data.limits[]` 取 TOKENS_LIMIT（5h）为主窗口；无周/月窗口 | **勿走 cookie/爬虫**（反爬，JinHanAI 实录）；legacy 是否只返回单条需实测 |
| 3 | Claude Code | 自动：Claude Code keychain / `~/.claude/.credentials.json`（OAuth） | `GET https://api.anthropic.com/api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`） | `five_hour`（5h）+ `seven_day`（周）+ `extra_usage`（月度花费/上限） | **限流 ~5 req/token**：429 时刷新 OAuth token 换限流窗口（onWatch 方案）；token 需 `user:profile` scope |
| 4 | Codex | `~/.codex/auth.json` → `tokens.access_token`（多 profile 支持） | OAuth 用量 API | 5h / weekly / monthly 窗口 | 周窗口需「开窗」才计（可选 auto-starter，默认关） |
| 5 | Kimi | 手动：Kimi Code 控制台 `sk-kimi-*`（**非**开放平台 key）；备选自动：`~/.kimi-code/credentials/kimi-code.json` | `https://api.kimi.com/coding/v1` | weekly + 5h 双窗口 | **月度额度只有网页端**（需 WebBridge/浏览器，本方案**不实现**，UI 标注「网页端可见」或留扩展点） |
| 6 | GLM current | `Z_AI_API_KEY`（global）或 BigModel CN 同上；`ZAI_REGION` | 与 #2 同端点家族（`api.z.ai` 或 `open.bigmodel.cn`） | TOKENS_LIMIT 最短=5h 主窗口、较长=周（可 `unit=6` 校验）、TIME_LIMIT=MCP 月度 | 周窗口识别逻辑直接抄 glm-plan-usage |
| 7 | Grok | `~/.grok/auth.json`（`grok login` 产物，`GROK_HOME` 可覆写） | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（Bearer + `x-xai-token-auth: xai-grok-cli`） | `creditUsagePercent` + `currentPeriod.end` → credits_period 单窗口 | token ~7 天过期；stdio ACP / gRPC-web 作回退；**非官方契约，随 grok CLI 演进**（报告 §8） |
| 8 | Cursor legacy | 自动：Cursor.app `state.vscdb`（+ WAL/shm **只读**）取 `cursorAuth/accessToken`（JWT 过期 <60s 不采用） | `GET https://cursor.com/api/usage?user={userId}`（sentry/*.json 取 userId）→ `maxRequestUsage`；或 `usage-summary`（plan %）+ billing cycle end | 自动识别 legacy request-count（500/2000 req/月）vs USD credit 双轨（抄 Tendo33） | 内部端点易漂移：401 重试 + partial-data 降级；应用 token 优先于 cookie |
| — | 兜底层（可选，M4） | 读浏览器 cookie 存储（Chromium 系 AppSupport 动态扫描 + Keychain 解密 / Gecko cookies.sqlite / WebKit binarycookies） | 仅用于「网页端才有」的数据（Claude Web extra usage/credits、Codex web cookie 增值、Cursor cookie） | — | 三层实现 + 过期重登；本方案默认不做 |

## 5. 同步与调度

- **每 plan 独立轮询间隔**：默认 60s（onWatch 默认），`planofplan.json`/UI 可调；**Claude 最低 5–10min**（规避 /api/oauth/usage 限流），429 时自动刷新 OAuth token 再重试有限次。
- **失败策略**：指数退避（1min 起步，封顶 30min）；连续失败保留最后成功快照并标 `stale`（UI 灰显 + 抓取时间）；auth 失败暂停该 plan，恢复（新 key/重新登录 CLI）后自动继续。
- **保留策略**：snapshots 默认保留 30 天，启动时 pruning；每 plan 每日保留至多多窗口时间线。
- **手动触发**：`planofplan refresh [slug]`、UI 每卡片刷新按钮；启动时全量拉一次。
- **凭据生命周期**：自动检测优先（本地 CLI/OAuth 文件），手动 key 存 credentials.json；检测不到时 UI 引导去对应 CLI 登录或填 key（每 plan 独立，互不影响）。

## 6. API 与 UI

### 6.1 HTTP API（全部 localhost，session 鉴权可选）

```
GET  /api/overview                 → 8 个 plan 当前快照（每 plan 各窗口最新一条 + stale 标记 + 聚合汇总）
GET  /api/plans/:slug              → 单 plan 当前状态 + 窗口明细
GET  /api/plans/:slug/history?window=weekly&days=7  → 历史序列（Chart.js 用）
GET  /api/plans/:slug/creds/status → 凭据状态（auto_detected | manual_ok | missing | failed）
POST /api/plans/:slug/refresh      → 手动刷新
PUT  /api/plans/:slug/auth         → 设置凭据（{mode:'auto'}|{mode:'manual',value,ref}）| 启停
GET  /api/plans/:slug/history...   （略）
```

### 6.2 CLI（CodexBar `usage --json` 风格，供 statusline/脚本消费）

```
planofplan serve                 # 启动 daemon（含 web）
planofplan refresh [slug]        # 手动刷新一个/全部
planofplan usage [--json]        # 全 plan 用量输出（JSON schema 对齐代码示例）
planofplan usage --provider claude --source auto --verbose   # 单 plan 调试（抄 CodexBar 的排障体验）
planofplan status                # 各 plan 调度/凭据/最后抓取时间
planofplan auth set <slug> [--auto | --key <v>]
```

### 6.3 页面结构

```
/dashboard（total dashboard）
  ├─ 顶部汇总行：可用 plan 数 · 最紧俏（剩余 % 升序 top3）· 即将重置（<1h 倒计时列表）· 聚合总条（合并模式）
  ├─ 卡片网格（每 plan 一张）：
  │    plan 名 + 凭据状态徽标 + 主窗口用量条（used/total/percent/倒计时）
  │    · 多窗口 plan：条内分段（5h | Week | Month | Requests），分条视图可切换
  │    · 点击 → 展开：全部窗口明细 + 历史折线（Chart.js）+ burn-rate 预测 + 重置时间
  │    · 失败：灰显 + "X 分钟前" 
/dashboard/settings
  ├─ 每 plan：启停开关 · 授权方式（自动检测 / 手动 key）· 轮询间隔 · 单独刷新 · 清空凭据
  └─ 全局：端口 · session 密码 · 保留期 · 兜底 cookie 层开关（M4）
```

## 7. 目录结构

```
planofplan/
├─ src/
│  ├─ core/            # scheduler, snapshot store, backoff, pruning
│  ├─ adapters/        # minimax.ts glm.ts claude.ts codex.ts kimi.ts grok.ts cursor.ts + index.ts 注册表
│  │                    # 每个 adapter 头部注释引用 CodexBar 对应 doc 作为规格出处
│  ├─ db/              # schema.ts, migrations, queries（bun:sqlite）
│  ├─ auth/            # credential 自动检测 + credentials.json 读写（0600）
│  ├─ server/          # Hono app：routes/api.ts, static mount
│  └─ cli/             # index.ts：serve/refresh/usage/status/auth 子命令
├─ web/                # 静态前端：index.html, app.js, styles.css, chart.js（vendored, 无构建）
├─ docs/               # 调研报告 + 本设计 + 每 adapter 备注
├─ data/               # planofplan.db（0600，可被 .gitignore）
├─ planofplan.json     # 每 plan 配置（enabled/interval/extra），密钥不在此文件
└─ README.md
```

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 闭环** | 骨架（Bun+TS+Hono+SQLite+静态前端）+ 数据模型 + **MiniMax legacy** 一个 adapter + 总览页渲染一条 bar | dashboard 能看到 MiniMax 5h 窗口剩余/倒计时；`planofplan usage --json` 有输出 |
| **M2 全量接入** | 其余 7 个 adapter + 多窗口归一 + stale/backoff + 历史图表/预测 | 8 个 plan 同屏，各窗口正确染色与倒计时 |
| **M3 授权与运维** | per-plan 授权 UI、凭据状态机、Claude 限流换 token、CLI 全子命令、pruning | 单 plan 失效不影响其他；凭据丢失有明确引导 |
| **M4 可选** | 浏览器 cookie 兜底层（Chromium/Gecko/WebKit）、多账号、statusline 插件 | 网页端独有数据可见 |

> 建议 M1 先打通 MiniMax legacy（或 GLM legacy）：都是「单 5h 窗口」最简单模型，先验证窗口语义与 UI 闭环，再铺多窗口。

### 8.1 工作谱系轨（产品主线，2026-08-20 立项 / 2026-08-22 升级为主线）

额度轨（上表）继续维护。按 §0 的定位，谱系轨是产品主线：额度怎么烧只是表象，烧出来的工作落在哪、归因回哪句需求才是核心价值。完整分层、证据纪律、跳转三档与里程碑见 [`work-graph-design.md`](./work-graph-design.md)。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **WG-M3 Session 目录** | `sessions` 表 + 文件头 catalog + 与 `usage.ts` 同趟扫描 + dashboard 列表 | Claude / Codex / Grok / DSH 能列出 |
| **WG-M4 阅读 + Resume** | 应用内 transcript；有 CLI 才显示 Resume | 见谱系文档 |
| **WG-M5 日历纱线** | 跨项目需求节点 | 见谱系文档 |
| **WG-M6 谱系（可选）** | 需求候选 / commit 对齐，默认 dry-run | 见谱系文档 |

WG-M3 与额度 M3 并行；实现时不要把授权/cookie 工作堵在 session 目录后面。

## 9. 开放问题

1. **技术栈默认值（TS+Bun）需用户默认认可**，想走 Go（onWatch 照搬）说一声即可。
2. MiniMax legacy / GLM legacy 端点需**用本人账号实测**：确认响应字段、是否单窗口、重置时间语义（报告 §8 未验证项）。
3. Grok `cli-chat-proxy` billing 契约非官方、随 grok CLI 演进——adapter 需带版本容错和回退链。
4. Cursor 内部端点漂移——抄 Tendo33 的 401 重试与 partial-data 降级。
5. Claude 限流实测：降频参数与 429 换 token 策略需按真实账号调整。
6. Kimi 月度额度只在网页端——确认是跳过还是 M3 后加 cookie 兜底。
7. 是否把 CLI `usage --json` 输出做成一等功能（顺带支持 statusline/waybar 等社区面板），影响 M1 验收面。

## 10. 从参考项目抄什么、不抄什么

| 来源 | 抄 | 不抄 |
|---|---|---|
| onWatch | 架构（daemon+SQLite+Web）、轮询/backoff/stale、quota+reset-cycle 数据模型、MD3 视觉、burn-rate 预测、OAuth 429 换 token | GPL 代码本体、Go 栈、菜单栏/GNOME 扩展、多账号广度 |
| CodexBar | provider 文档规格（凭据→端点→解析）、用量条显示语义（多窗口/染色/倒计时/stale）、`usage --json` CLI 风格、阈值配色 | macOS 菜单栏壳、受支持浏览器名单那套登录流程 |
| ccusage | 5-Hour blocks 窗口算法、本地燃烧速率补充视图 | 本地聚合为主要形态 |
| kimi-code-usage / glm-plan-usage / Tendo33 | Kimi 双窗口显示、GLM 周窗口 unit=6、Cursor request-count 双轨识别 | 各自单体形态 |
| JinHanAI | GLM 反爬避坑记录、真实响应示例 | cookie/爬虫路线 |
