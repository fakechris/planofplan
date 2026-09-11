# Sourcebot (Code Context) 深度调研与借鉴分析

> 调研对象：https://www.sourcebot.dev/code-context 与 https://github.com/sourcebot-dev/sourcebot
> 基准版本：v5.1.12（2026-09-10，clone 至 /tmp/sourcebot-research 深读源码）
> 关联里程碑：M4/INV-183（只读 MCP 9 大工具集）、M7/INV-276-277（消息级 FTS5 检索与上下文交接）、M2/INV-168（水位增量扫描）、M1/INV-167（安全凭据管理）、M6/INV-207-208（单二进制）

---

## 0. 一句话结论

Sourcebot 是 YC 公司 Taqla Inc 出品的**自托管代码搜索引擎**（Zoekt trigram 内核），近两年已演进为"**给 AI 编码 Agent 提供组织级代码上下文的 MCP 服务层**"（Claude Code / Cursor / Codex 一键接入）。它与 planofplan 域不同（它索引 git 仓库，我们索引 Agent 会话），但在**只读 MCP 工具面设计、面向 LLM 的输出裁剪协议、增量索引与墓碑/对账工程、凭据零落盘**四个方面是业界少有的高质量参考实现，对我们 M4 与 M7 有直接落地价值。

---

## 1. 产品定位与演进

三个支柱（docs/docs/overview.mdx）：**Code Search**（人类）→ **Ask Sourcebot**（对代码库提问的内置 Agent）→ **MCP**（"Code context layer for all your agents"）。

演进路径（CHANGELOG.md）：
- v1.0 (2024-10)：GitHub/GitLab 镜像索引的代码搜索；
- v3.0 (2025-04)：结构化重构——Postgres + Redis/BullMQ 任务队列、多租户、认证；
- v4.0 (2025-05)：强制认证、搜索式 code navigation、API Key；
- v4.x (2025-06~2026-05)：MCP 服务器（Streamable HTTP + OAuth 2.1）、Ask 聊天、multi-branch 索引、AI Review Agent；
- v5.0 (2026-06)：**Ask 与 MCP 划入 EE 付费**；移除内嵌 Postgres/Redis，改为外部硬依赖；
- v5.1 (2026-06~)：Skills 工具（create/update/list_skill）、DPoP OAuth、prompt caching。

**战略启示**：一个"人类工具"转型为"Agent 上下文层"后，MCP/Ask 成为付费价值最高的能力——这与 planofplan M7（Agent 自查历史 + 上下文交接）方向互相印证。

---

## 2. 总体架构

yarn monorepo，约 1170 个 TS 文件：

| 包 | 职责 |
|---|---|
| packages/web | Next.js 16 前端 + 服务端 API（搜索、MCP、OpenAPI），端口 3000 |
| packages/backend | BullMQ worker：连接同步、仓库索引、权限同步、清理，内嵌管理 API :3060（Bull Board + Prometheus） |
| vendor/zoekt | git submodule，sourcebot 维护的 Zoekt fork（上游 sourcegraph/zoekt），Go 编译，`zoekt-webserver -index ... -rpc` gRPC :6070 |
| packages/db | Prisma + Postgres 16 |
| packages/queryLanguage | Lezer（CodeMirror 同款 LR 解析器）写的搜索查询语法 |
| packages/schemas | config.json 的 JSON Schema v1/v2/v3（Zod 单一事实源生成） |
| packages/setupWizard | npm 包 `setup-sourcebot`，交互式安装向导 |

部署：单 Docker 容器内 **supervisord 管 3 进程**（zoekt / web / backend），外部 Postgres + Redis（docker-compose 三服务，healthcheck 依赖）。数据缓存目录 `.sourcebot/` = bare 仓库镜像 + zoekt 索引分片。资源模型（sizing-guide）：100 仓库 2C4G → 2000+ 仓库 16C64G，**内存（page cache）对搜索性能影响最大**。

---

## 3. 索引与同步流水线（BullMQ Workload 框架）

数据流：`config.json`（声明式，chokidar 监听热更新）→ **connection-sync**（发现仓库，pLimit(5)，重试尊重 x-ratelimit-reset）→ upsert Repo（复合唯一键）→ 每 repo 一个 `repo-index-v1-<id>` 周期调度器（默认 1h）→ **repo-index**：

1. **bare clone** + 增量 `git fetch --prune`；克隆后立即 `git config --unset remote.origin.url` 防止带 token 的 URL 残留（backend/src/git.ts:156-160）；
2. 凭证经一次性 **git credential-cache 会话**注入：secret 只走 stdin、环境变量零泄漏、日志对 secret 做 REDACT（backend/src/gitCredentialSession.ts）；
3. 写 commit-graph + changed-path Bloom filter 加速 log/blame，存量仓库一次性 `--split=replace` backfill；
4. `zoekt-git-index` 子进程建索引（`-branches`、`-tenant_id`、`-repo_id`、`-shard_prefix_override <orgId>_<repoId>`），execFile + argv 传参防注入；分支上限 64、单文件 2MB、trigram 2 万上限；
5. 索引分片与 zoekt-webserver 共享同一目录，搜索走 gRPC。

**去重与单飞（三层）**：BullMQ deduplication key（`repo:<id>`，keepLastIfActive）+ 调度器天然"最多排队一个"语义 + **Redis redlock 执行锁**（`sourcebot:lock:repo:<id>`，60s 租约自动续期，丢锁即 AbortSignal 协作式取消）。

**可靠性模式**（详见 §8）。

---

## 4. 检索内核

- **Zoekt**：trigram（三元组）倒排索引，支持子串/正则极速检索；Sourcebot 维护 hard fork 并有自动化 submodule 同步流水线（PR 合并 → repository_dispatch → SHA 祖先校验 → 自动开 PR）。
- **符号**：universal-ctags（**钉死 6.1.0**，新版与 zoekt 不兼容）在索引期产出符号表，`sym:` 查询直查符号索引；code navigation **不用 LSIF/SCIP**——定义 = `sym:` 符号查询，引用 = `\b词\b` 词边界正则 + 语言族展开（上限 1000），纯搜索启发式。
- **查询语言**：Lezer grammar 一份语法三处复用——服务端 strict 解析、CodeMirror 搜索栏高亮、以及单独维护的**给 LLM 看的语法描述** `syntaxDescription.ts`（喂给 AI 查询改写）。解析产物 QueryIR 就是 zoekt 的 `Q` proto 消息，零转换。
- **流式搜索**：SSE + gRPC StreamSearch，`pause()/resume()` 背压 + pendingChunks 计数处理 controller 提前关闭竞态；把 zoekt 的 20 个 SearchStats 字段全量透传前端（可回答"这次为什么慢"）。
- **权限下推**：权限同步开启时，把用户可见 repo 集合编译成 `repo_set` **注入 Zoekt 查询**（引擎层过滤，非结果后过滤）；数据层另有 Prisma `$extends` 拦截器对所有 repo 查询（含嵌套 `repos: true`）自动注入行级权限 where。

---

## 5. MCP 与 API 面（对 M4 最有价值的部分）

### 5.1 传输与鉴权
- **Streamable HTTP**（`WebStandardStreamableHTTPServerTransport`）：POST 收 JSON-RPC、DELETE 关会话、GET 返回 405（按规范不支持服务端主动 SSE）；端点稳定在 `/api/mcp`（实际代码在 EE 路由树 `/api/ee/mcp`，用 Next rewrite 映射）。
- 会话 `MCP-Session-Id` + **属主绑定**：复用会话校验 ownerId，不匹配 403。
- 鉴权四通道：NextAuth JWT → OAuth access token（含 DPoP）→ scoped token（`sbst_`，限定 repo）→ API Key（`sbk_` Bearer 或 `X-Sourcebot-Api-Key`）。OAuth 走 RFC 9728 保护资源元数据 + RFC 7591 动态客户端注册；**兼容性实战**：为猜 `/register` 的 Claude Code/Cursor 加 rewrite 补丁。
- 付费墙错误文案面向"会被 agent 渲染给用户"设计，不是裸 403。

### 5.2 工具清单（10 核心 + 条件 5）
`grep / glob / read_file / list_tree / find_symbol_definitions / find_symbol_references / get_diff / list_commits / list_branches / list_repos` + `list_language_models` + `ask_codebase`（阻塞式 Ask Agent，描述里大写警告 "DO NOT USE UNLESS EXPLICITLY ASKED... 60+ seconds"）+ `create/update/list_skill`。

### 5.3 架构模式：一份 ToolDefinition，三个出口
`features/tools/types.ts` 定义中立接口（zod 入参、`isReadOnly/isIdempotent/isDestructive` 注解、execute 返回 `{output, metadata, sources}`）：
- **MCP 适配器**：映射 readOnlyHint/destructiveHint annotations，异常转 `isError: true` 可读文本，埋点带 `source` 归因；
- **Vercel AI 适配器**：同一批工具直接喂给内置 Ask Agent（`needsApproval: !isReadOnly`）；
- **REST API**：`/api/search`、`/api/find_definitions` 等与 MCP 工具共用同一实现层，OpenAPI spec 由 zod-to-openapi 生成。

`metadata`/`sources`（UI 引用卡用）与 `output`（发给模型的唯一内容）严格分离。

### 5.4 面向 LLM 的输出工程（金矿）
1. **搜索零上下文**：grep/glob/symbol 统一 `contextLines: 0`，只回命中行，省 token；要上下文再走 read_file；
2. **单行 2000 字符截断**，带 `... (line truncated)` 后缀；
3. **read_file 三重预算 + 可机械执行的续读协议**：500 行上限 + 5KB 字节预算逐行累加 + 输出尾部 `Use offset=<N> to continue`——模型可以自主分页读完大文件；
4. **穷尽性判定 N+1 技巧**：请求 `total_max_match_count = display_count + 1`，用 `total <= actual` 精确区分"搜完了"与"被截断"，截断时在输出尾部主动告知并给改进建议（换更精确 pattern / 指定 repo / 提高 limit）；
5. **聚合降维**：`groupByRepo` 把千行命中压成每仓库计数摘要（自动提 limit 到 10000 保证计数准确）；
6. **工具描述即提示工程**：每个工具配独立 `.txt` 描述文件（`grep.txt` 等），内容是使用策略清单（何时用 grep vs symbol、并行调用、先 list_repos 发现名字）；
7. **RE2 兼容转义**：工具入参的正则先做 escapeRE2 保证与引擎方言兼容；
8. **list_tree 双上限**：depth≤10、entries≤10000，逐层 BFS 批量取。

### 5.5 客户端接入
文档给出 Claude Code（`claude mcp add --transport http`）、Cursor（mcp.json）、VS Code、Codex（config.toml + `codex mcp login`）、OpenCode、Windsurf 的完整配置；产品内提供 `cursor://` / `vscode:mcp` **一键安装 deeplink**；埋点统一带 `source: 'sourcebot-mcp-server'`。

---

## 6. 数据模型与权限同步

核心表：Repo（复合唯一键 external_id+codeHostUrl+orgId，含 indexedAt/indexedCommitHash/latestIndexingJobId/metadata Json）、Connection（config Json + enforcePermissions）、Account（OAuth 账号 + token 加密 + permissionSyncIssue）、**AccountToRepoPermission**（repoId×accountId，带 `source: ACCOUNT_DRIVEN|REPO_DRIVEN`）。

权限同步双链路：**account-driven**（以用户 OAuth token 视角拉 private repo 列表）与 **repo-driven**（以连接凭证反查协作者）；partial sync（如 Bitbucket 只返回直接授权用户）**只删自己 source 的行**，两链路互补不互踩。**Fail-closed 分类**：只有确定性失败（refresh_token 被拒 / scope 不足）才清空权限并要求重认证；模糊失败（网络/限流）保留上次权限快照，防抖动。

---

## 7. 商业模式与许可

- 开源部分 **FSL-1.1-ALv2**（Functional Source License：禁止竞品使用，2 年后每个版本自动转 Apache 2.0），**不是 AGPL**；
- `ee/` 目录专有许可：MCP server、Ask、权限同步、SSO/SCIM、审计、GitHub App 均为 EE，13 项 entitlement 精确门控（在线 Lighthouse 同步 + 离线签名 key，7 天不同步降级 free）；
- 安装漏斗：`npx setup-sourcebot` 交互向导（选 code host → 配 LLM → 生成 config/.env → 端口冲突双重预检 → compose up → 轮询就绪自动开浏览器），显式隐私声明"代码不出本机"。

**对我们的许可提示**：MCP server 注册逻辑在 `ee/`（专有，不可复制代码）；工具定义在 `features/tools/`（FSL，可用于非竞品场景，但 2 年后才转 Apache）。planofplan 完全自研实现即可，借鉴**设计思想与协议格式**没有障碍。

---

## 8. 可靠性工程模式清单（可直接移植到 planofplan）

1. **latest...JobId 指针 + 条件更新**：job 开始写 `latestIndexingJobId`，完成钩子用 `updateMany({ where: { id, latest...JobId: 本job } })` 条件更新终态——防止锁释放后旧 job 覆盖新 job 状态；
2. **发现不完整保护**：上游 API 部分失败（DISCOVERY_INCOMPLETE）时**不删除**本轮没看到的实体——防止一次抖动扫描误删索引（对 planofplan 的墓碑防复活是直接补强）；
3. **删除墓碑协议**：先原子置 DELETING 标记 → 删字节 → 删行；字节删除失败行保留下轮重试，同一轮失败的 id 排除出后续 batch 防自旋；
4. **启动期三方对账**：DB 期望调度状态 ↔ Redis 实际 scheduler、磁盘文件 ↔ DB 记录，双向清理孤儿；
5. **优先级背压**：INTERACTIVE=1 / INITIAL=5 / SCHEDULED=10——用户触发抢占周期任务；
6. **redlock 执行锁**：资源级单飞、租约自动续期、丢锁信号合并进 AbortSignal 全链路协作式取消（git 子进程、HTTP 分页、索引子进程全部响应 signal）；
7. **job 日志脱敏**：对 `/authorization|cookie|credential|password|private.?key|secret|token/i` 字段值脱敏，深度 6 层；
8. **调度器幂等 upsert**：比较 name/every/data/opts 未变则跳过，保护 next 运行时间不被推后；
9. **优雅停机**：worker close 与 5s 定时器竞速，supervisord autorestart 兜底。

---

## 9. 对 planofplan 的帮助（按里程碑映射）

### 9.1 M4 / INV-183 只读 MCP 9 大工具集（价值最高，直接对标）
- **采纳 ToolDefinition 中立接口**：一份工具定义同时服务 MCP、（将来可能的）内置 Ask、REST API，注解只读/幂等/破坏性，天然符合我们"只读 MCP"底线；
- **移植输出裁剪协议**：我们的正文检索命中 L0 JSONL 后按需流式读取 + 安全截断——正好套用"行级截断 + 字节预算 + `offset` 续读协议"三件套；穷尽性 N+1 判定直接适用于 FTS5 count 查询；
- **groupByRepo → groupByAgent/Session 聚合**：跨 10 家 Agent 会话的宏观统计一页返回；
- **客户端一键接入**：menubar 里做"复制 MCP 配置"（`claude mcp add` 命令、Cursor/Codex 配置片段、deeplink），这是 Sourcebot 验证过的最佳接入体验；
- **埋点 source 归因**：区分工具调用来自 MCP/API/UI；
- **工具描述独立文件**：9 大工具的描述写成使用策略清单（何时 search_sessions vs read_messages vs get_lineage），即提示工程；
- 会话属主校验、匿名降级文案、异常转 `isError` 可读文本等细节照单全收。

### 9.2 M7 / INV-276-277 消息级检索与上下文交接
- **交接载荷引用协议**：Sourcebot 答案强制 `@file:{repo::path:startLine-endLine}` + `repairReferences()` 正则容错修复 LLM 输出——我们的"一键上下文交接"包应定义规范引用格式（如 `@session:{agent::sessionId::seqRange}`）并配同样的修复器；
- **SearchContext → 交接包/上下文组合**：保存的 repo 集合概念可平移为保存的"会话集合 + 项目 + 时间窗"交接模板；
- **Lezer 语法三处复用**：我们若引入 `agent:` `repo:` `since:` 搜索过滤器，用同一 grammar 驱动解析、menubar/UI 高亮、以及**给 Agent 自查历史用的语法说明文档**（喂进 MCP 工具描述）；
- **双层检索印证**：Sourcebot 定义=符号索引、引用=词正则的启发式分层，与我们"`refined_text` 意图精炼索引 + 原话永不覆写、正文回源 L0"的双层设计同构；read_file 不走 Zoekt 走 `git show` 直接回源——**验证了 L0 只读不可变 + L1 可重建 + 正文按需回源哲学在工业界完全可行**。

### 9.3 M2 / INV-168 水位增量扫描与墓碑防复活
- **§8 之 2/3/4 直接移植**：扫描不完整时禁止墓碑化未见 session（补强墓碑防复活三道闸）、latestJobId 条件更新、启动期 index.db ↔ 文件系统对账；
- 优先级队列语义（手动刷新 > 首扫 > 周期扫描）适配我们的单飞子进程调度。

### 9.4 M1 / INV-167 安全凭据管理
- 凭证零落盘三件套：URL 与凭证分离（用完 unset）、一次性 credential-cache 会话经 stdin 注入、日志字段脱敏正则；
- config 的 `environmentOverrides` token 抽象（`{"token":{"env":"X"}}`，禁止明文字面量）值得抄进我们的配置模型；
- `fetchWithRetry` 尊重 `x-ratelimit-reset` 适配各家 Agent 配额 API 轮询。

### 9.5 M6 / INV-207-208 单二进制
- **反面参考**：Sourcebot v5 因内嵌 PG/Redis 的维护负担将其移除、强制外部依赖——印证我们 SQLite 单文件 + Bun 单二进制的选型正确，绝不要引入外部数据库/队列依赖；
- zoekt 的形态（索引器子进程 + 检索服务共享索引目录）与我们"单飞扫描子进程 + 守护 API"互为印证；
- `setup-sourcebot` 向导的冲突预检、隐私声明、就绪自动开浏览器，可参考进首次运行体验。

### 9.6 明确不采纳
- **Zoekt/trigram 引擎**：面向千级仓库、GB 级代码，我们的规模（单机、会话 JSONL）用 SQLite FTS5 trigram tokenizer 足够，引 Go 二进制违背轻量原则；
- **Postgres/Redis/BullMQ**：同上；但其 workload 抽象（dedup key、优先级、执行锁）可以在 SQLite 队列表上实现同等语义；
- **多租户与权限同步**：单用户本地工具无此需求。

---

## 10. 附录：关键文件索引（/tmp/sourcebot-research，clone 已保留）

- MCP 注册：packages/web/src/ee/features/mcp/server.ts（EE 专有）
- 工具定义与 .txt 描述：packages/web/src/features/tools/{grep,readFile,listTree,...}.{ts,txt}、adapters.ts、types.ts
- 输出裁剪/穷尽性判定：packages/web/src/features/search/zoektSearcher.ts:71-110
- 索引流水线：packages/backend/src/{connectionSyncWorkload,repoIndexWorkload,jobManager,reconcileJobSchedulers,gitCredentialSession,git,zoekt}.ts
- 查询语言：packages/queryLanguage/src/{query.grammar,tokens.ts,syntaxDescription.ts}
- 权限：packages/web/src/prisma.ts（$extends 行级过滤）、backend/src/ee/{accountPermissionSyncWorkload,repoPermissionSyncWorkload}.ts
- 安装向导：packages/setupWizard/src/index.ts
- 许可：LICENSE.md（FSL-1.1-ALv2）、ee/LICENSE（专有）
