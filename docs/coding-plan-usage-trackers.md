# 各 AI Coding Plan 用量追踪项目调研报告

> 调研日期：2026-08-18
> 目的：为个人「coding plan 用量监控 dashboard」（项目 `planofplan`）做前期调研，找出成熟的开源项目作为参考/复用对象。本报告基于 GitHub 仓库 README/源码/issue 与官方文档（WebSearch + FetchUrl），未登录任何账号、未运行被调研项目代码。
> 标注：无法从公开来源验证的内容以「未验证」标出。

---

## 0. 结论速览（TL;DR）

- **没有单一项目完整覆盖用户全部 8 个 plan**，但 **onWatch（Go 守护进程 + Web dashboard）** 与 **CodexBar（macOS 菜单栏 app，69 个 provider）** 两家可以覆盖 7~8 个（差异在 Cursor legacy 与 Kimi 的实现形态）。它们各自的 provider adapter（数据源、端点、鉴权）文档化程度是全行业最高的，是自研 dashboard 的**最佳参照物**。
- **用户担心的三个「难搞」plan 其实都有现成实现可抄**：
  - **MiniMax legacy（5 小时滚动窗口）**：官方 API（coding plan API key）即可查；onWatch、CodexBar、JinHanAI 均有现成实现。
  - **GLM legacy（5 小时窗口、无周限额）**：`open.bigmodel.cn/api/monitor/usage/quota/limit` + API Key 即可查（CodexBar/onWatch 均已实现）；**不要走 cookie/爬虫路线**（JinHanAI 实测被反爬拦截）。
  - **Cursor legacy（500 次/月请求数模型）**：有专门项目 Tendo33/cursor-usage-tracker 显式支持 request-count 模型，读本地 `state.vscdb` + 内部端点 `cursor.com/api/usage`。
- **「5 小时滚动窗口」模型**已被多个成熟项目处理（Claude 的 5-Hour 窗口、GLM 的 TOKENS_LIMIT、MiniMax 的 5h rolling reset、Kimi 的 5Ho）；**Cursor 请求数模型**也被显式支持。见[第 5 节](#5-专项核查5-小时滚动窗口与-cursor-请求数模型)。
- **推荐策略**：直接部署 onWatch（若接受 GPL-3.0 与 Go）或参考 CodexBar 的 provider 文档自建轻量 dashboard（MIT，可整体借鉴架构）；8 个 plan 的数据源全部有成熟 adapter 可移植，**没有需要从零逆向的 provider**。

---

## 1. 概览表：候选项目 × 覆盖 plan × 形态 × 授权 × 同步

| 项目 | Stars | License | 语言 | 覆盖的本报告相关 plan | Dashboard 形态 | 授权方式 | 数据同步机制 |
|---|---|---|---|---|---|---|---|
| **[onWatch](https://github.com/onllm-dev/onWatch)** | 712 | GPL-3.0 | Go | MiniMax✓ GLM-legacy✓(cn) GLM-current✓ Claude✓ Codex✓ Kimi✓ Grok✓ Cursor✓ | Web dashboard（localhost:9211，MD3）+ macOS 菜单栏 + GNOME 扩展 + Prometheus /metrics | `.env` 里放 API Key/OAuth token；Claude/Codex/Grok 从本地 CLI 凭据自动检测 | 后台守护进程，每 ~60s 轮询各 provider 用量 API，SQLite 落库 |
| **[CodexBar](https://github.com/steipete/CodexBar)** | 20.2k | MIT | Swift(88%)+C | Claude✓ Codex✓ z.ai/GLM✓ MiniMax✓ Grok✓ Cursor✓ Kimi(未验证) | macOS 菜单栏 app（每 provider 一个状态项/合并图标）+ 跨平台 CLI（`codexbar usage --json`）+ 大量社区插件（waybar/KDE/GNOME） | 复用已有会话：OAuth/device flow、API Key、浏览器 cookie、本地文件；不存密码 | app 内定时刷新（status polling），CLI 手动/脚本调用 |
| **[ccusage](https://github.com/ccusage/ccusage)** | 18k | MIT | Rust(88%)+TS | Claude✓ Codex✓ Kimi✓ Grok-Build✓（API/用量聚合，非 plan） | CLI（daily/weekly/monthly/session 报表、5-hour blocks 报表、statusline beta、JSON 输出） | 无需授权，只读本地日志文件 | 手动运行（`bunx ccusage`）；statusline 每次渲染时读取 |
| **[opencode-quota](https://github.com/slkiser/opencode-quota)** | 889 | MIT | TypeScript | MiniMax✓ MiniMax-CN✓ GLM-legacy(Zhipu)✓ GLM-current(Z.ai)✓ Kimi✓ Cursor✓(预算/支出) Grok(SuperGrok)✓ Claude✓ | OpenCode 插件：侧边栏 Quota 面板 + TUI toast + 状态行 + `/quota` `/tokens_*` 命令；终端 CLI | 自动复用本地 CLI/OAuth/API Key；支持自定义 provider | 命令触发 / 自动 toast；token 统计读 OpenCode 本地库 |
| **[oh-my-pi](https://github.com/can1357/oh-my-pi)** | 25.4k | MIT | TS+Bun+Rust | 目录含 Cursor、Kimi Code、MiniMax(+CN)、Z.AI/GLM、Zhipu Coding Plan、Alibaba 等 coding plan provider | 终端 AI 编码 agent；`@oh-my-pi/omp-stats` 本地用量观测 dashboard；Auth 账户/用量缓存 | OAuth 或 plan API Key（`/login` 各 provider 命令） | 随 agent 使用拉取并缓存用量（`AuthStorage.#fetchUsageCached`） |
| **[kimi-code-usage](https://github.com/Golden0Voyager/kimi-code-usage)** | 12 | 未验证(疑 MIT) | Python+TS | Kimi✓（周 + 5 小时 + 月，月度需 WebBridge） | Rich CLI + MCP Server + VS Code 状态栏（`Wee:96% 5Ho:99%`） | Kimi Code 控制台 API Key（`sk-kimi-*`），Env `KIMI_CODING_API_KEY` | 手动/定时（VS Code 刷新间隔可配，默认 5 分钟） |
| **[glm-plan-usage](https://github.com/jukanntenn/glm-plan-usage)** | 13 | MIT | Rust | GLM-current✓（Token 5h + 周限额 + MCP 月度） | Claude Code statusline 插件（状态栏显示用量+倒计时） | 复用 Claude Code 的 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` | 每次状态栏渲染查一次（带 5 分钟缓存） |
| **[coding-plan-monitor](https://github.com/JinHanAI/coding-plan-monitor)** | 1 | MIT | TypeScript | MiniMax✓ GLM-legacy⏸（被反爬，文档记录调查过程） | CLI（进度条 + 90% 桌面通知，10 分钟 watch 模式） | MiniMax API Key；GLM 计划用 cookie（被反爬后弃用） | `ai-usage check` / `ai-usage watch` |
| **[caut](https://github.com/Dicklesworthstone/coding_agent_usage_tracker)** | 79 | MIT(with rider) | Rust(96%) | Claude✓ Codex✓ Cursor✓（Web/CLI/OAuth 多源） | CLI（`usage/cost/status/config`，人类可读 + `caut.v1` JSON schema）+ 守护进程/历史 SQLite | 复用各 provider CLI/OAuth/浏览器 cookie（web 源仅 macOS） | CLI 手动调用；daemon 模式轮询并落 SQLite |
| **[aiusage](https://github.com/juliantanx/aiusage)** | 113 | MIT | TS+Svelte | Claude✓ Codex✓ Cursor✓ Kimi✓ Grok-Build✓（20+ 工具，本地日志解析） | 本地 Web dashboard（localhost:3847，tokens/cost/sessions）+ CLI + 桌面 tray widget | 无授权需求（只读本地日志）；可选同步需 GitHub/S3 等凭据 | `aiusage parse` / `aiusage serve`（启动时解析一次） |

> 注：「GLM-legacy」指用户第 2 项（智谱/BigModel 早期套餐，每 5 小时重置、无周限额）；「GLM-current」指第 6 项（周 + 5h + 月）。两者在数据源上同为 `*/api/monitor/usage/quota/limit` 端点家族，区别见 §2.2 / §3.8。

---

## 2. 核心项目详情（按推荐优先级）

### 2.1 onWatch —— 最接近「一站式中控台」的项目

仓库：<https://github.com/onllm-dev/onWatch>（原 SynTrack）
指标：712 stars / 56 forks / 440 commits / v2.13.3（2026-07-27）/ GPL-3.0 / Go 77%+JS 22%。

**覆盖**：Synthetic、Z.ai（GLM）、Anthropic（Claude Code）、Codex、GitHub Copilot、MiniMax、Gemini CLI、Cursor、Grok、Antigravity、OpenCode Go、Kimi Code（+ Moonshot/DeepSeek 余额）——对应用户 8 个 plan 中的 **7~8 个**（除 GLM-legacy 需用 `ZAI_REGION=cn` 走同一 Z.ai provider，见下）。

**形态**：轻量后台守护进程（<50MB RAM，实测 ~34-43MB），SQLite 存储（`~/.onwatch/data/onwatch.db`），Material Design 3 Web dashboard（`localhost:9211`），macOS 菜单栏、GNOME 扩展、Docker（distroless 镜像）、Prometheus `/metrics` 端点（beta，带 bearer token 鉴权）。dashboard 含 provider 卡片（环形用量表 + 重置倒计时）、历史图表、burn-rate/pace 预测、邮件/SMTP 通知、多账号管理。（来源：仓库 README 及 v2.13.x release notes）

**授权方式**（逐 provider 的凭据来源全部文档化在 `.env.example`）：
- Anthropic/Claude：自动从 Claude Code 系统 keychain/凭据文件检测 OAuth token（也可手动 `ANTHROPIC_TOKEN`）。
- Codex：`CODEX_TOKEN`，从 `~/.codex/auth.json`（`tokens.access_token`）读取，支持多 profile。
- MiniMax：`MINIMAX_API_KEY` + `MINIMAX_REGION`（global/cn），支持多账号（Settings → MiniMax → Add Account，各账号独立轮询）。
- Z.ai：`ZAI_API_KEY` + `ZAI_REGION`（global/cn），轮询 Z.ai `/monitor/usage/quota/limit`，跟踪 token 限额、时间限额、工具调用配额。
- Grok：`GROK_TOKEN`（`grok login` 的 bearer）或自动检测 `~/.grok/auth.json`（`GROK_HOME` 可覆写）。
- Kimi：优先本地 OAuth 凭据（`~/.kimi-code/credentials/kimi-code.json`，`KIMI_CODE_CREDENTIALS` 可覆写），可选 `KIMI_TOKEN`/`MOONSHOT_API_KEY`。
- Cursor：`CURSOR_TOKEN`（自动从 Cursor Desktop 检测）。
- 所有 Key 放 `.env`、日志脱敏、零遥测。

**数据同步**：守护进程轮询各用量 API（Anthropic 示例为每 60s），SQLite 记录快照/重置周期；Anthropic `/api/oauth/usage` 端点有强速率限制（~每 token 5 次请求），onWatch 通过刷新 OAuth token 自动规避（引用了 anthropics/claude-code#31021）。还带一个 beta 的 **Codex 自动开窗器**（检测 5h/周窗口未启动时发一条 ~62 token 的 ping 把窗口跑起来，默认关闭）。

**数据源**：
- Z.ai：`/monitor/usage/quota/limit`（token/time/tool-call 限额）——与 CodexBar 同一端点家族。
- Anthropic：OAuth 用量端点（5-Hour / 7-Day / Monthly 动态配额以百分比呈现）。
- MiniMax：**明确支持「5 小时滚动窗口」重置周期**，跨 M2/M2.1/M2.5 共享配额池。
- Grok：6 月新增 provider，走 `~/.grok/auth.json`。

**取舍**：GPL-3.0（若派生自研项目会传染）；Go 技术栈；仪表盘功能远多于用户的「个人 dashboard」需求。但它把「每 5h 重置」这类窗口语义做成了通用数据模型（quota values + reset cycles），对自研非常有参考价值。

### 2.2 CodexBar —— provider 覆盖面最大、数据源文档最全

仓库：<https://github.com/steipete/CodexBar>｜官网 <https://codexbar.app/>
指标：20.2k stars / 1.7k forks / 5381 commits / v0.52.0（2026-08-17，活跃）/ MIT / Swift 88% + C 10%。灵感来源注明是 ccusage（README Credits）。

**覆盖**：官方标语「Every AI coding limit in your menu bar. **69 providers**.」——含 Codex、OpenAI、Claude、Cursor、Gemini、Copilot、Grok、GroqCloud、ElevenLabs、Deepgram、z.ai、MiniMax、Kiro、Zed、Vertex AI、Augment、OpenRouter、LiteLLM、LLM Proxy、Codebuff、Command Code、ClinePass、AWS Bedrock 等。对应用户 8 plan：Claude✓ Codex✓ GLM(z.ai + BigModel CN)✓ MiniMax✓ Grok✓ Cursor✓；Kimi 在 69 家列表内但 README 未逐条列文档页（未验证）。

**形态**：macOS 14+ 菜单栏 app（每 provider 一个状态项，或 Merge Icons 模式）+ 跨平台 CLI（macOS/Linux tarball，Homebrew/AUR，`codexbar usage --json`）+ 十多个社区面板插件（Waybar、KDE Plasma xN、GNOME、Cinnamon、tmux/Zellij 等，均基于 `codexbar` CLI 输出）。显示 used/total 用量条、**每窗口（session/5h、weekly、monthly）重置倒计时**、credit 余额、状态徽章。

**授权方式**：「Privacy-first. Reuses existing provider sessions — OAuth, device flow, API keys, browser cookies, local files — so no passwords are stored.」Settings → Providers 里给每 provider 选数据源；API Key 存 `~/.config/codexbar/config.json`（权限受限）；cookie 走系统 Keychain 缓存。

**数据源（每 provider 有独立 doc，这是全行业最值得抄的文档层）**：
- **Claude**（docs/claude.md）：OAuth API / 浏览器 cookie / CLI PTY 回退；session + weekly 用量。
- **Codex**（docs/codex.md）：OAuth API 或本地 Codex CLI；可选 OpenAI web cookie 补充 dashboard 数据。
- **Cursor**（docs/cursor.md）：浏览器会话 cookie 获取 plan + usage + billing resets。
- **z.ai / GLM**（docs/zai.md，2026-08-03 更新）：API-token 型，**两个区域**：Global `api.z.ai` 与 BigModel CN `open.bigmodel.cn`。端点 `GET {host}/api/monitor/usage/quota/limit`（`Authorization: Bearer <token>` + `accept: application/json`）；token 来源依次为 config → `Z_AI_API_KEY` → CN 区 `BIGMODEL_API_KEY`/`ZHIPU_API_KEY`/`ZHIPUAI_API_KEY`/`GLM_API_KEY` → relay 文件（`~/.coding-relay/glm-api-key`、`~/.config/bigmodel/api_key`）。team 用量需 `Bigmodel-Organization`/`Bigmodel-Project` 头 + `type=2`（quota）/`type=3`（hourly）。响应解析：`data.limits[]` 中**最短 TOKENS_LIMIT（通常 5 小时）→ 主窗口，较长 TOKENS_LIMIT（通常周）→ 次级窗口，TIME_LIMIT → MCP 通道**；`nextResetTime`（epoch ms）→ 重置时间；`data.planName/plan/level` → 套餐名。dashboard 地址：`bigmodel.cn/coding-plan/personal/usage`。
- **Grok**（docs/grok.md，2026-08-17 更新）：数据源按序为 ①`~/.grok/auth.json`（`grok login` 产物，OIDC token，~7 天过期）②`grok agent stdio` ACP JSON-RPC `x.ai/billing`（grok 0.1.210 起在 agent-stdio 面上返回 Method not found，TUI 里才生效）③Grok CLI-proxy billing REST `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（Bearer + `x-xai-token-auth: xai-grok-cli`，读 `config.creditUsagePercent`，重置时间取 `config.currentPeriod.end`）④grok.com billing gRPC-web `GetGrokCreditsConfig`（需 Web Key Exchange，仅 cookie 会被拒）⑤本地 `~/.grok/sessions/**/signals.json` 聚合 token 用量。主窗口 = 订阅内 credit usage（weekly/monthly 标签随重置周期变化）。
- **MiniMax**（docs/minimax.md）：Coding Plan API token（`sk-cp-*`，区别于普通 `sk-api-*`；Env `MINIMAX_CODING_API_KEY` 优先于 `MINIMAX_API_KEY`）或浏览器 cookie；请求 `/v1/api/openplatform/coding_plan/remains`（global host `platform.minimaxi.com` 或 CN host，`MINIMAX_HOST`/`MINIMAX_CODING_PLAN_URL`/`MINIMAX_REMAINS_URL` 可覆写）；web 路径还可贴 cookie/cURL。

**取舍**：macOS-only GUI（Linux 只有 CLI），不提供 web dashboard 形态；但 provider 文档+CLI JSON 输出+MIT 许可使其成为**自研 adapter 层的第一参考资料**。

### 2.3 ccusage —— 本地文件聚合的行业标准（Claude 侧重）

仓库：<https://github.com/ccusage/ccusage>｜官网 <https://ccusage.com/>
指标：18k stars / 793 forks / 94 贡献者 / v20.0.20（2026-08-15）/ MIT / Rust 88% + Nix/TS。由 ryoppippi 维护。

**覆盖**：Claude Code、Codex、OpenCode、Amp、Droid、Codebuff、Hermes Agent、pi-agent、Goose、OpenClaw、Kilo、Kimi、Qwen、GitHub Copilot CLI、Gemini CLI、Grok Build CLI（统一 CLI 报表）。

**形态**：CLI 报表（daily/weekly/monthly/session/project、`--json`、`--no-cost`、`--timezone`）+ **⏰ 5-Hour Blocks 报表**（按 Claude 计费窗口追踪用量、活跃窗口监控）+ 状态栏集成（Statusline，Beta）+ 成本估算（LiteLLM pricing，支持 `--offline`）。

**数据源**：**只读本地 CLI 日志**（"Analyze coding (agent) CLI token usage and costs from local data"），无需任何注册/登录。Claude 侧扫描 JSONL 用量文件并直接提取 `usageLimitResetTime`（当 API 错误消息标记 `isApiErrorMessage` 时，用于 blocks 窗口重置时间）。适配器以 crate 形式组织（`rust/adapters/<agent>`，每 adapter README 注明数据源与路径）。**Claude 用量文件是 Claude Code 本地记录的 usage JSONL**（`~/.claude/projects/**/usage.jsonl` 路径细节以官方文档为准——其 JSONL 记录含 token 与 `usageLimitResetTime` 字段，见仓库 rust loader 提取逻辑；具体路径「未验证到官方文档级」）。

**授权**：无。这是它与 onWatch/CodexBar 的关键差异——**不查各平台用量 API，只做本地聚合**，因此拿不到「plan 剩余额度/重置时间」这类账户级数据（除 Claude usageLimitResetTime 等日志内信息）。

**取舍**：是 Claude Code/Codex 本地 token/成本分析的标杆；对「显示 8 个 plan 当前额度」这个目标主要是**补充件**（本地燃烧速率）+ blocks 窗口算法参考。

### 2.4 opencode-quota —— 覆盖中国区套餐最全的插件

仓库：<https://github.com/slkiser/opencode-quota>
指标：889 stars / 90 forks / 682 commits / v4.8.2（2026-08-16，活跃）/ MIT / TypeScript 97%。

**覆盖**（厂商官方表）：
- 美国区：Anthropic(Claude，本地 CLI/OAuth)、OpenAI、xAI SuperGrok、Cursor（本地估算，预算/支出）、GitHub Copilot、Google AGY/Antigravity、OpenCode Go/Zen、OpenRouter、Synthetic、Chutes、NanoGPT、Kilo Gateway、Ollama Cloud。
- **中国区（对本报告最相关）**：Kimi Code（Remote API）、MiniMax Coding Plan（Remote API）、**MiniMax Coding Plan (CN)**（Remote API）、**Z.ai Coding Plan**（Remote API）、**Zhipu Coding Plan**（Remote API）——即同时覆盖用户第 1/2/5/6 项；另含 Alibaba Coding Plan（本地估算）、Qwen Code（本地估算）、Xiaomi MiMo（dashboard API）、DeepSeek（余额）。

**形态**：OpenCode 插件，侧边栏 Quota 面板、TUI toast、紧凑状态行、`/quota`、`/quota_status`、`/tokens_today|daily|weekly|monthly|session|all`、CLI `opencode-quota show --json`、OpenTelemetry 指标。标签风格「Day quota / 5h quota / Day budget / Balance」。

**授权/同步**：自动复用 OpenCode 本地的 provider 凭据（OAuth/API Key）；token 统计读 OpenCode 本地 `opencode.db`。支持自定义 provider（`provider add` 引导）。

**取舍**：强绑定 OpenCode 生态；「Remote API」具体端点未在 README 细列（要抄端点需翻源码，未展开）。作为**中国区套餐覆盖面最广**的 OPEN 实现（尤其同时含 Zhipu/Z.ai 与 MiniMax/MiniMax-CN），值得作为 GLM/MiniMax/Kimi 三家的第二参考资料。

### 2.5 oh-my-pi —— 巨型的 coding-plan 客户端兼用量统计

仓库：<https://github.com/can1357/oh-my-pi>（omp.sh）
指标：25.4k stars / 2.5k forks / 18,384 commits / v17.3.6（2026-08-17）/ MIT / TypeScript 85% + Rust 9%（Bun 运行时）。

**相关面**：它本身是终端 AI 编码 agent，但其模型/Provider 目录（`@oh-my-pi/pi-catalog`）内置了海量 **Coding Plan 类型 provider**（README 明确分两栏）：
- 常规：Anthropic `oauth`、OpenAI Codex `oauth`、Gemini/Antigravity `oauth`、xAI、SuperGrok `oauth`、Synthetic 等；
- **Coding plans**：Cursor `oauth`、GitHub Copilot `oauth`、GitLab Duo、Devin `oauth`、**Kimi Code `plan`**、Moonshot、**MiniMax Coding Plan `plan`**、**MiniMax Coding Plan CN `plan`**、Alibaba Coding Plan `plan`、Qwen Portal `oauth`、**Z.AI / GLM Coding Plan `plan`**、**Zhipu Coding Plan `plan`**、Xiaomi MiMo、Qianfan、Umans `plan`、NanoGPT、Novita、Venice、Kilo、ZenMux、OpenCode Go、OpenCode Zen。

配套 `@oh-my-pi/omp-stats`（"Local observability dashboard for AI usage statistics"）与 Auth 账户/用量缓存（`AuthStorage.#fetchUsageCached`、broker usage accounts，2026-08-14 仍在迭代）。若干 GitHub issue 记录了 zhipu-coding-plan / GLM coding plan 模型目录维护（如 #8540 把 GLM-5.3 加入 zhipu-coding-plan 目录）。

**取舍**：作为 agent 其用量统计面向「自己的用量」，不是给 8 家订阅开一个独立 dashboard 的产品；但 **coding-plan provider 目录 + `plan` 类型 + omp-stats** 证明了：截止 2026-08，市面上主流 plan（含 Zhipu CN、MiniMax CN 这种中国区细分）都有可编程访问途径。其 catalog 可作为「哪些 plan 有账号/凭据体系」的权威清单。具体 quota 轮询端点未逐条展开（未验证到源码级）。

### 2.6 kimi-code-usage —— Kimi 专属全家桶

仓库：<https://github.com/Golden0Voyager/kimi-code-usage>｜PyPI: `kimi-code-usage`，VS Code Marketplace: `HainingYu.kimi-code-usage`
指标：12 stars / 247 commits / v0.1.1（2026-04-24，仓库 7 月底仍有提交）/ 语言 Python 59% + TS 40%；License 页未标注（未验证，疑 MIT）。

**覆盖**：Kimi（Moonshot）Coding Plan：**weekly + 5 小时**额度；**月度**额度需另启 Kimi WebBridge 守护 + 浏览器扩展（Kimi 需保持登录，关掉只影响月度）。额外功能：读本地 Codex auth 文件显示 ChatGPT Plus 用量（401 后自动刷新 token）。

**形态**：①Rich 风格 CLI（`kimi-usage`，`--json`/`--plain`）②MCP Server（`kimi-mcp`，暴露 `get_kimi_usage`，兼容 Claude Code/Cursor/Windsurf/Hermes）③VS Code 状态栏扩展（`🌕 [===] Wee:96% 5Ho:99%`，低额度阈值告警，刷新间隔可配，默认 5 分钟）。

**授权**：Kimi Code **控制台**创建的 API Key（`sk-kimi-xxx`，**不是**开放平台 platform.kimi.com 的 `sk-xxx`，README 特别警告两者不互通），base URL `https://api.kimi.com/coding/v1`。

**取舍**：单 provider 但三端形态齐全 + 现成的 weekly/5h 双窗口显示语义，**是所有项目中把「5 小时窗口」显示做地最细的**；可直接作为自研 Kimi adapter 的对照实现。

### 2.7 glm-plan-usage —— GLM 随 Claude Code 状态栏展示

仓库：<https://github.com/jukanntenn/glm-plan-usage>｜npm `@jukanntenn/glm-plan-usage`
指标：13 stars / 46 commits / v0.3.1（2026-06-16）/ MIT / Rust 84%。

**覆盖**：GLM（智谱 ZAI/智谱平台）算力套餐：Token 使用百分比（**5 小时窗口**）、**周限额**（`unit=6` 检测，新版套餐）、MCP 月度用量、重置时间（时钟/倒计时）、premium 模型消耗倍率（高峰/低谷）。

**形态**：Claude Code `settings.json` 的 statusLine command 插件（也支持与 CCometixLine 组合）；GLM 模型消耗倍率按模型+时段动态计算。

**授权**：**复用 Claude Code 的鉴权通道**——`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`（即智谱提供的 Anthropic 兼容端点）。5 分钟缓存减少 API 调用，自动平台检测（ZAI vs 智谱）。

**取舍**：单平台单 provider，但它是「GLM 用量 API 的可用性」的又一实证，且周限额窗口解析逻辑（unit=6）可直接抄。

### 2.8 coding-plan-monitor —— MiniMax + GLM 的踩坑记录（必读避坑参考）

仓库：<https://github.com/JinHanAI/coding-plan-monitor>
指标：1 star / 6 commits / 最后提交 2026-03-17 / MIT / TypeScript。

**覆盖**：
- **MiniMax ✅ 可用**：通过**官方 API**（MiniMax Coding Plan API Key）查询，展示剩余 prompts（如 `1,500 / 1,500 prompts`）与重置时间（如「约 15 分钟后」）。
- **智谱 GLM ⏸ 被反爬拦截**：`https://open.bigmodel.cn/api/monitor/usage/quota/limit` + Bearer 直接调用**返回空 body**；Puppeteer/Playwright headless 均被风控识别；Chrome CDP 连已登录浏览器可行但维护成本高，作者弃用并记录。

**形态**：CLI（`ai-usage check`，`ai-usage watch` 每 10 分钟刷新 + 用量 >90% 桌面通知）；Key/cookie 存在 `~/.ai-usage-tracker/config.json`（chmod 600）。

**文档价值**：README 里贴出了 GLM usage API 的真实响应结构：
```json
{ "code": 200, "msg": "操作成功",
  "data": { "limits": [
    { "type": "TIME_LIMIT",  "percentage": 33, "nextResetTime": 1774663282997 },
    { "type": "TOKENS_LIMIT", "percentage": 32, "nextResetTime": 1773734366338 }
  ], "level": "pro" } }
```
并给出官方网页用量页 `https://open.bigmodel.cn/usercenter/glm-coding/usage`（显示每 5 小时 Token 窗口、MCP 每月额度、重置时间）。

> ⚠️ 注意辨析：JinHanAI 走的是**cookie/浏览器路径**被风控；而 **CodexBar/onWatch 用 API Key + `accept: application/json` 等标准头**对同一组 `/monitor/usage/quota/limit` 端点查询是工作的（多项目实证）。因此结论是：**GLM legacy 用量查询用 API Key 走 open.bigmodel.cn 即可，别碰 cookie/爬虫**。

---

## 3. 次要/纵深项目简表

| 项目 | 一句话定位 | 相关 plan |
|---|---|---|
| [caut](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) | CodexBar 核心逻辑的跨平台 Rust CLI 移植（含 daemon + SQLite + `caut.v1` JSON schema），Claude OAuth token 三级解析（keyring/credentials.json/keychain） | Claude、Codex、Cursor |
| [aiusage](https://github.com/juliantanx/aiusage) | 本地优先聚合 dashboard（localhost:3847），解析 20+ 工具的本地日志（tokens/cost/sessions「quota pressure」），可选 GitHub/S3 同步与排行榜 | Claude/Codex/Cursor/Kimi/Grok-Build 等 |
| [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | 实时 Claude 用量监控 + 预测/告警 | Claude |
| [phuryn/claude-usage](https://github.com/phuryn/claude-usage) | Claude 本地 dashboard，Pro/Max 订阅显示进度条 | Claude |
| [codeinaire/claude-code-usage-tracker](https://github.com/codeinaire/claude-code-usage-tracker) | 解析 JSONL 会话入库 SQLite 的 Web 应用 | Claude |
| [ccseva](https://github.com/Iamshankhadeep/ccseva) | macOS 菜单栏实时 Claude 用量 | Claude |
| [douglasmonsky/codex-usage-tracker](https://github.com/douglasmonsky/codex-usage-tracker) | 本地优先 MCP 工具 + dashboard，分析 Codex token/credits/线程模式（读本地数据） | Codex |
| [Dwtexe/cursor-stats](https://github.com/Dwtexe/cursor-stats)、[OsmanByrm/Cursor-Requests-Limit-Tracker](https://github.com/OsmanByrm/Cursor-Requests-Limit-Tracker)、[lixwen/cursor-usage-monitor](https://github.com/lixwen/cursor-usage-monitor) | Cursor 订阅用量状态栏/告警（request-count 追踪） | Cursor |
| [ofershap/cursor-usage](https://github.com/ofershap/cursor-usage) | Cursor Enterprise 官方 API 的 MCP/插件封装（团队视角） | Cursor（企业） |
| [deviffyy/OpenQuota](https://github.com/deviffyy/OpenQuota) | 跨平台 AI coding 用量/限额/重置时间追踪 | 多平台（覆盖度未验证） |
| [getagentseal/codeburn](https://github.com/getagentseal/codeburn) | 37 个工具/agent 的本地 token 成本统计（`npx codeburn`） | 不面向 plan 额度 |
| [PhilippPolterauer/opencode-quotas](https://github.com/PhilippPolterauer/opencode-quotas) | OpenCode 插件聚合 Antigravity + Codex 用量 | Codex/Antigravity |
| [farion1231/cc-switch #1038](https://github.com/farion1231/cc-switch/discussions/1038) | cc-switch 讨论帖：智谱 GLM coding plan 用量查询脚本 | GLM |
| [mahonzhan/awesome-coding-plan](https://github.com/mahonzhan/awesome-coding-plan) | 各厂家 Coding Plan 价值对比清单（非 tracker，但适合选型背景） | 全部 |
| [xai-org/grok-build](https://github.com/xai-org/grok-build) | xAI 官方开源 coding agent（`grok` CLI）；本地 `~/.grok/` 产物是各 tracker 的凭据/数据来源 | Grok |
| [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | Kimi Code 官方 CLI | Kimi |

---

## 4. 8 个 plan 的覆盖矩阵与结论

图例：✅=有成熟项目实现；⏸=存在但受限/需条件；❌=无（本轮未找到）。

| # | Plan（用户口径） | 限额模型 | 是否有项目读取 | 最佳参考项目/方案 | 若无成熟参考，需自建的数据源 |
|---|---|---|---|---|---|
| 1 | **MiniMax coding plan（早期/legacy）** | 每 5 小时重置，无周限额（滚动 5h 窗口） | ✅ | **onWatch** MiniMax provider（明确支持 5h 滚动重置、多账号、global/cn 区域）；端点细节见 **CodexBar** docs/minimax.md（`/v1/api/openplatform/coding_plan/remains` + `sk-cp-*`） | 无需逆向：官方 Coding Plan API（API Key）可查用量与重置时间 |
| 2 | **GLM 早期 legacy（智谱/BigModel）** | 每 5 小时重置，无周限额 | ✅ | **CodexBar** z.ai provider 的 BigModel CN 路由（`open.bigmodel.cn/api/monitor/usage/quota/limit` + `BIGMODEL_API_KEY` 等，TOKENS_LIMIT 5h 为主窗口）；**onWatch** `ZAI_REGION=cn`；**opencode-quota** Zhipu Coding Plan | 无需逆向：API Key 查询可用。**避坑**：cookie/爬虫路径有反爬（JinHanAI 实录） |
| 3 | **Claude Code（Anthropic）** | 周 + 5h + 月 | ✅ | **onWatch**（OAuth `/api/oauth/usage`，处理了 429 限流）；**ccusage**（本地 JSONL 聚合 + blocks 窗口；无凭据、最省事）；**CodexBar**（OAuth/cookie/CLI PTY 三源回退） | 无 |
| 4 | **OpenAI Codex** | 周 + 月（5h 窗口在 app 内） | ✅ | **onWatch** Codex（`~/.codex/auth.json` → OAuth；5h+周窗口；auto quota-starter beta）；或本地解析（ccusage/aiusage/douglasmonsky） | 无 |
| 5 | **Moonshot Kimi** | 周 + 5h + 月 | ✅ | **kimi-code-usage**（`sk-kimi-*` API Key 三端工具）；**onWatch**（本地 OAuth 自动检测）；**opencode-quota** | 无 |
| 6 | **智谱 GLM coding plan（现行）** | 周 + 5h + 月 | ✅ | **CodexBar** z.ai 或 **onWatch** Z.ai（同端点；5h/weekly TOKENS_LIMIT + TIME_LIMIT=MCP）；**glm-plan-usage**（statusline，周限额 `unit=6`） | 无 |
| 7 | **xAI Grok** | 仅周限额 | ✅ | **CodexBar** grok（`~/.grok/auth.json` → cli-chat-proxy `/v1/billing?format=credits` 最稳；gRPC-web 兜底）；**onWatch** Grok | 无需逆向：grok CLI 凭据 + 代理 billing 端点（该端点是否为「官方公开契约」未验证，随 grok CLI 演进） |
| 8 | **Cursor（legacy）** | 500 次/月（request-count 模型） | ✅ | **Tendo33/cursor-usage-tracker**（**显式支持 legacy request-count 模型**：读 `state.vscdb` + `cursor.com/api/usage` + stripe 元数据）；**CodexBar** Cursor（浏览器 cookie） | 无需逆向：本地 SQLite 凭据 + 内部端点（非公开文档、易变动，需兼容性处理） |

**核心发现**：8 个 plan 中 **8/8 都有可参考的成熟实现**。真正需要「自研适配器」的不是数据源本身（都有现成代码/端点），而是：

1. **统一窗口语义模型**——把「滚动 5h」「周」「月」「请求数」统一建模（onWatch 的 quota/reset-cycle 数据模型可直接借鉴）；
2. **鉴权与凭据的生命周期管理**——OAuth 刷新（Claude/Codex/Kimi/Grok）、cookie 过期（Cursor）、`sk-*` Key 轮换；
3. **每 plan 独立授权**——用户的刚需「per-plan authorization」，上述项目均为「每 provider 一组凭据」，符合此模型。

---

## 5. 专项核查：5 小时滚动窗口 与 Cursor 请求数模型

### 5.1 「5 小时窗口」模型（用户第 1/2 项 + Claude/Codex/Kimi 的相关窗口）

明确已有项目支持：

| 计划 | 验证项目 | 证据 |
|---|---|---|
| Claude Code 5-Hour | ccusage「5-Hour Blocks Report」；onWatch「Anthropic quotas are dynamic (5-Hour, 7-Day, Monthly)」 | ccusage README Features；onWatch README FAQ |
| GLM（legacy 与现行）5h TOKENS_LIMIT | CodexBar docs/zai.md「Shortest TOKENS_LIMIT (normally 5 hours) → primary Coding Plan window」；JinHanAI 输出示例「Token 5h Window … Reset: 03/06 02:17」；glm-plan-usage Token 重置倒计时 | 各 README/doc（§2.2/§2.7/§2.8） |
| MiniMax legacy 5h 滚动 | onWatch「tracks the shared quota pool … with 5-hour rolling window reset cycles」；JinHanAI「Reset: in ~15 minutes」 | onWatch README FAQ / JinHanAI 输出示例 |
| Codex 5h 窗口 | onWatch「Codex 5h and weekly windows …」+ auto quota-starter | onWatch README FAQ |
| Kimi 5h | kimi-code-usage VS Code 状态栏 `5Ho:99%`（5-hour 阈值项、`fiveHourLowThresholdPercent`） | kimi-code-usage README |
| Antigravity weekly+5h | onWatch antigravity provider（weekly + 5h buckets） | onWatch commit 记录 |

结论：**「每 5 小时滚动重置」已是各家 tracker 的常见窗口语义**，可直接参考 onWatch 的 `quota values + reset cycles` 建模，不存在需要从零发明的算法。用户的 MiniMax/GLM legacy 是「只有 5h 窗口」的特例（无周/月窗口），对应端点只返回单条 TOKENS_LIMIT（legacy）或再加 TIME_LIMIT。

### 5.2 Cursor request-count 模型（用户第 8 项）

- **Tendo33/cursor-usage-tracker**（MIT，TS）**显式支持双轨**：自动识别账号属 legacy「Request Count Model (legacy, 500/2000 req/month)」（状态栏 `🟢 0/500`、`🟡 1200/2000`）还是新「USD Credit Model」（`$42.30/$400`）。数据源：本地 `sentry/*.json` 找 userId + `state.vscdb` SQLite 读 `cursorAuth/accessToken` → 调 `GET https://cursor.com/api/usage?user={userId}`（cookie `WorkosCursorSessionToken`）、`POST https://api2.cursor.sh/.../GetCurrentPeriodUsage`、`GET https://cursor.com/api/auth/stripe`。README 明示这些是**与 Cursor 官网 dashboard 相同的非官方端内端点**。
- **CodexBar** Cursor provider 同走浏览器 cookie（plan + usage + billing resets）。
- 其他：Dwtexe/cursor-stats、OsmanByrm/Cursor-Requests-Limit-Tracker（Python 通知）、aiusage 的 Cursor 本地日志解析。

结论：**request-count 模型有专门实现可抄**；注意端点为非公开内部接口，实现需做容错/降级（Tendo33 有完整的 401 重试与 partial-data 处理，值得照搬）。

---

## 6. 数据源一图流（每个 provider → adapter 应读什么）

> 「①」= 首选路径，「②③」= 回退。凭据来源与端点均标注出处项目（详见 §2、§3）。

```
MiniMax legacy 〔1〕
  Auth: MiniMax Coding Plan API Key (sk-cp-*)   [CodexBar docs/minimax.md]
  Endpoint①: {MINIMAX_HOST}/v1/api/openplatform/coding_plan/remains   (global: platform.minimaxi.com / CN 变体)
  兜底②: 浏览器 cookie（同端点）
  返回: 剩余额度/用量/重置时间（5h 滚动）  [onWatch: 5-hour rolling reset cycles]

GLM legacy / GLM current 〔2, 6〕（同一端点家族，区域不同）
  Auth: API Key（global: Z_AI_API_KEY；CN: BIGMODEL_API_KEY/ZHIPU_API_KEY/GLM_API_KEY 或 relay 文件） [CodexBar docs/zai.md]
  Endpoint①: GET {api.z.ai | open.bigmodel.cn}/api/monitor/usage/quota/limit   Header: Bearer + accept: application/json
  解析: data.limits[] → TOKENS_LIMIT(5h) / TOKENS_LIMIT(weekly) / TIME_LIMIT(MCP) + nextResetTime(epoch ms) + level/planName [CodexBar/onWatch/JinHanAI]
  注意: 勿走 cookie/headless 爬虫（反爬） [JinHanAI coding-plan-monitor]

Claude Code 〔3〕
  Auth①: 本地 Claude Code OAuth token（macOS keychain / ~/.claude credentials） [onWatch/caut]
  Endpoint①: Anthropic /api/oauth/usage（5-Hour/7-Day/Monthly 百分比；有限流，需 OAuth 刷新规避） [onWatch FAQ, anthropics/claude-code#31021]
  路径②: 本地 JSONL 用量文件（ccusage 解析 token + usageLimitResetTime，blocks 窗口用） [ccusage]
  路径③: CLI PTY / 浏览器 cookie（CodexBar）

OpenAI Codex 〔4〕
  Auth: ~/.codex/auth.json → tokens.access_token（或 CODEX_TOKEN） [onWatch docs/CODEX_SETUP]
  Endpoint①: OAuth 用量 API（5h/weekly/monthly 窗口；Codex 周窗口需「开窗」才计） [onWatch FAQ + auto quota-starter]
  路径②: 本地 ~/.codex 数据（history.jsonl / 会话库；ccusage/aiusage/douglasmonsky 解析 token/credits）

Moonshot Kimi 〔5〕
  Auth①: Kimi Code 控制台 API Key sk-kimi-*（非开放平台 key） [kimi-code-usage README]
  Endpoint①: https://api.kimi.com/coding/v1（weekly + 5h；月度需 WebBridge + 浏览器扩展） [kimi-code-usage]
  路径②: 本地 OAuth 凭据 ~/.kimi-code/credentials/kimi-code.json（自动检测） [onWatch .env.example]

xAI Grok 〔7〕
  Auth: ~/.grok/auth.json（grok login；GROK_HOME 可覆写） [CodexBar docs/grok.md, onWatch]
  Endpoint①: CLI-proxy GET https://cli-chat-proxy.grok.com/v1/billing?format=credits（Bearer + x-xai-token-auth: xai-grok-cli）→ creditUsagePercent
  端点②: grok agent stdio ACP JSON-RPC x.ai/billing（0.1.210 起 agent-stdio 不可用）
  端点③: grok.com gRPC-web GetGrokCreditsConfig（需 WKE）
  本地④: ~/.grok/sessions/**/signals.json（token 估算，信息性）

Cursor legacy 〔8〕
  Auth: 本地 Cursor 数据：sentry/*.json 取 userId + state.vscdb SQLite 取 cursorAuth/accessToken [Tendo33 README]
  Endpoint①: GET https://cursor.com/api/usage?user={userId}（Cookie: WorkosCursorSessionToken=...）→ maxRequestUsage（legacy 500/2000）
  端点②: POST https://api2.cursor.sh/.../GetCurrentPeriodUsage（USD 双轨模型）
  端点③: GET https://cursor.com/api/auth/stripe（套餐元数据）
  注意: 非官方内部端点，需 401 重试与降级 [Tendo33]
```

---

## 7. 结论与推荐

### 7.1 直接可用的选项

1. **onWatch**（GPL-3.0，Go）——最接近「8 个 plan 一站式」：已覆盖 MiniMax（5h）、Z.ai/GLM（含 cn 区域）、Claude、Codex、Kimi、Grok、Cursor，附 Web dashboard/SQLite/告警。若接受 GPL 与 Go，**先试它**。局限：Cursor 走 API token（非 request-count 专线）、GLM-legacy 用 cn 区域映射、无浏览器抓取型 Cursor legacy 语义。
2. **CodexBar**（MIT，macOS 菜单栏 + CLI）——覆盖 69 家、每 provider 数据源文档化最全；作为「零成本看板」直接装，也能 `codexbar usage --json` 供脚本/自研 dashboard 消费。局限：无 Web dashboard 形态、GUI 仅 macOS。
3. **ccusage**（MIT，CLI）——Claude Code/Codex 本地用量监控事实标准，配合上述两者互补（本地燃烧速度 vs 账户额度）。

### 7.2 参考/移植清单（自建 dashboard 的建议顺序）

- **架构**：onWatch（daemon + SQLite 快照 + reset-cycle 数据模型 + burn-rate 预测）或 aiusage（轻量本地 Web + 解析器架构）。
- **adapter 文档蓝本**：CodexBar 各 provider doc（claude/codex/cursor/zai/grok/minimax/kimi）——作者把每个 provider 的凭据、端点、解析规则都写成了 md，是最佳「需求规格书」。
- **窗口/额度显示**：ccusage blocks（5h 窗口算法）、kimi-code-usage（5h+weekly 双栏状态栏）、Tendo33（request-count + USD 双轨自动识别）。
- **鉴权管理**：onWatch .env.example + 本地凭据自动检测；caut 的 Claude OAuth 三级解析（keyring→credentials.json→keychain）。
- **8 个 plan 对应抄哪个实现**：
  - MiniMax → onWatch MiniMax / CodexBar minimax.md（API Key 即可）
  - GLM legacy → CodexBar zai.md BigModel CN 路由（API Key，勿爬 cookie）
  - Claude Code → onWatch (OAuth) + ccusage (本地)
  - Codex → onWatch Codex（含 5h/周窗口、pace）
  - Kimi → kimi-code-usage / onWatch
  - GLM current → CodexBar zai.md / glm-plan-usage（周限额 unit=6）
  - Grok → CodexBar grok.md（credits proxy）
  - Cursor legacy → Tendo33（request-count 模型 + 本地 SQLite 凭据）

### 7.3 需要自研的部分（真实缺口）

1. **统一的「多窗口」数据模型与 UI**：现有项目要么偏 web（onWatch/aiusage）、要么偏菜单栏/CLI（CodexBar/ccusage），**没有一个是「几台机器/浏览器都能看的个人 Web dashboard + 8 个 plan 同屏」**。这是 planofplan 的核心差异化。
2. **Legacy 套餐的持续兼容**：MiniMax 2026-03 起对新用户转向「token 制 + 周配额」（reddit r/vibecoding 讨论可见迁移公告），用户 legacy 5h 套餐与新套餐走同一批端点还是已冻结的旧端点，需用自己账号实测确认（未验证）。
3. **Cursor 内部端点漂移**：非官方端点随时变化，需容错与降级（Tendo33 的 partial-data 处理是范本）。
4. **GLM legacy 的周/月缺失语义**：legacy 只返回 5h 窗口，dashboard 需能表达「仅单窗口」的 plan（onWatch 对无第二窗口的 provider 已有类似处理）。
5. **每 plan 独立授权 + 凭据安全存储**：现有项目用 `.env`/config 文件平铺；用户要求「per-plan authorization」，建议做加密存储（系统 keychain）与按 plan 的开关/授权粒度——这是自研层主要工作量。

---

## 8. 附：未验证/待实测事项

- CodexBar 是否覆盖 Kimi provider（README 69 家列表含 Kimi 字样但无独立 doc 页确认）——**未验证**。
- MiniMax legacy 端点在新旧账号上的可用性差异——**未验证**。
- Claude Code usage JSONL 的官方路径文档（`~/.claude/projects/**/usage.jsonl`）——ccusage 源码确证读取 usage JSONL 与 `usageLimitResetTime`，但官方路径文档未逐字核对——**未验证到官方文档级**。
- kimi-code-usage 的正式 License——**未验证**（README/仓库页未标）。
- opencode-quota 各中国区 provider 实际调用的端点 URL（README 只标「Remote API」）——**未验证到源码级**。
- oh-my-pi omp-stats 对每个 coding-plan 的实际轮询端点——**未验证到源码级**。

---

## 9. 需求迭代：授权必须支持「任意浏览器」（2026-08-17 补充）

**新约束**：用户试用 CodexBar 后确认其不满足「打开任意浏览器 → 读取该浏览器会话数据」的授权体验。经核对源码文档（docs/claude.md、docs/cursor.md），问题实锤：

- **cookie 读取写死三套路径**：Safari（`~/Library/Cookies/Cookies.binarycookies`）→ Chrome/Chromium fork（写死 `~/Library/Application Support/Google/Chrome/*/Cookies`）→ Firefox（cookies.sqlite）。同是 Chromium 但路径不同的浏览器（Arc、Edge、Brave、Vivaldi、国产 Chromium 等）默认读不到；Linux 无浏览器 cookie 导入，只能手动粘贴。
- **登录跳转只认「受支持浏览器」名单**：Cursor 的 Add/Switch Account 流程（`CursorLoginBrowserRouter.swift`）要么用系统 HTTPS 默认处理器（前提是它属于受支持名单），要么在名单内选一个，选中后**钉死在该浏览器**轮询 cookie，名单外一律中止；且整套仅在 macOS。

**影响评估**：8 个 plan 全部存在「不碰浏览器」的授权路径（MiniMax/GLM=API Key；Claude/Codex/Grok/Kimi=本地 CLI OAuth 凭据或 key；Cursor=应用内 token，见 §6）。浏览器捕获在技术上只兜：① Claude Web-only 增值数据（extra usage、credits）② Cursor cookie 兜底 ③ Codex web cookie 增值。因此「任意浏览器」更接近 UX 偏好（登录即授权、不想管 key），而非功能必需。

**据此重排参考优先级**：
- **onWatch** 完全不依赖浏览器（.env API key + 本地 CLI 凭据自动检测），在该约束下反而最贴合「无浏览器也能全量覆盖」。
- 若坚持浏览器捕获，市面没有「任意浏览器」通用方案，属自研项，两条路线：
  - **浏览器扩展**（参照 kimi-code-usage 的 WebBridge 守护 + 浏览器扩展模式）：任何支持扩展的浏览器可装，登录页捕获会话回传本地 dashboard，Chromium/Gecko 通用；
  - **全量 cookie 存储扫描**（CodexBar 思路做全）：Chromium 系动态扫描 `~/Library/Application Support/*/*/Cookies` + Keychain 解密（v10/v11），Gecko cookies.sqlite，WebKit binarycookies——三层实现 + 过期重登。
- CodexBar 降级为「数据源文档参考」，不再是授权体验参考。

**已确认（2026-08-17）**：授权主路线 = **纯 API Key / 本地 CLI 凭据**（onWatch 式，绕开浏览器，8 个 plan 全覆盖）；浏览器捕获不做为主体，仅当某数据只能从网页端获取时兜底使用，形态偏好**直接读浏览器 cookie 存储**（Chromium/Gecko/WebKit 三层，不采用浏览器扩展）。
