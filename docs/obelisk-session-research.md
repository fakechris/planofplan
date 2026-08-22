# Obelisk vs planofplan：session 功能对比研究

> 研究对象：[`tommy0103/obelisk`](https://github.com/tommy0103/obelisk)(clone 到 `/tmp/obelisk` 深读源码，main 分支，AGPL-3.0)
> 对比对象：本 repo `/Users/chris/workspace/planofplan` 的 session 功能
> 方法：一手源码为准，关键结论标注文件路径

## 0. 先纠正两个前提

**Obelisk 没有名不副实——它就是做 session 管理的。** 而且和 planofplan 的 session 功能高度同构：把 Claude Code / Codex / Kimi Code / Pi 的本地 transcript 索引进**单个 SQLite + FTS5**(`~/.obelisk/obelisk.sqlite`)，然后提供两个消费面（README.md)：

- **Agent 侧**:`obelisk --search / --query / --attune` CLI + agent skill(`skill-doc/SKILL.md`)，让 coding agent 用 JS 沙箱查询自己的历史（"上次 auth bug 改了哪些文件"这类问题）;
- **人类侧**:Electron + Vue 桌面 app(`app/`)，浏览 sessions、记忆、Activity 热力图、周报卡片。

**planofplan 的现状比描述中好一些。** 读源码确认，planofplan 已有按需的 transcript 查看（`src/transcript.ts`，流式读、2MB/160 turn 截断）、resume(`src/resume.ts`，六家 CLI 的 resume 命令 + Terminal/URL/App 三种启动方式）、Finder reveal(`src/server.ts:194-218`)。真正缺的是：**消息级索引和内容级搜索**——transcript 是每次请求现读现解析、不落库，所以无法跨 session 搜对话内容；session 表只存元数据。索引慢的根源也在这：`extractSessionRepos` 要为每个变动的 session 文件读 2MB 正文做路径正则（`src/session-repos.ts:28` 的 `TOUCH_BYTES`)，且活跃文件每次全量重扫，没有行级续扫。

## 1. 数据

| | Obelisk | planofplan |
|---|---|---|
| 数据源 | 4 家：Claude(`~/.claude/projects`)、Codex(`sessions` + `archived_sessions`)、Kimi Code(session 目录 + wire.jsonl)、Pi（递归 `*.jsonl`)。另读 Claude 的 `subagents/*.jsonl`、`workflows/*.json`、`history.jsonl` 标题 | 7 家：claude / codex / grok / dsh / kimi / zcode(SQLite)/ factory(`src/sessions.ts:53` 的 `CATALOG_PROVIDERS`) |
| 粒度 | **消息级**:user/assistant 每条消息一行，含 parent_uuid 因果链、model、input/output tokens(含 cache 折入）、cwd、skill、turn_duration_ms;tool call / tool result 各一行（含 input_json、file_path、is_error);subagent / workflow / workflow_agent / summary 也各成表 | **session 目录级**：一行 = 一个 session（标题、cwd、时间、token 聚合、git 归属）。token 不从 transcript 算，而是从 `usage_records` 回填（`src/sessions.ts:690` `applySessionUsage`)。transcript 不落库 |
| Schema | `packages/core/src/schema.sql`:sessions / messages / tool_calls / tool_results / subagents / workflows / workflow_agents / summaries / index_state + **FTS5 虚表**(messages_fts、memories_fts，触发器自动同步）+ 覆盖面很全的二级索引（file_path、session+name、agent_id、时间……) | `src/db.ts:85-117`:sessions（平铺元数据）+ session_repos(session↔repo 三维角色）。无 FTS、无消息表 |
| 截断策略 | 入库即截断：`trunc()`(TEXT_LIMIT)+ `truncJson()` 递归截 JSON 里的长字符串（`packages/core/src/parsing.ts:50-67`)，索引体积可控；`raw()` 可按需回源取完整原文（`providers/claude.ts:398` `rawClaude`) | 不入库，读取时截断（2000 字符/turn、160 turn、2MB 字节帽） |

**Obelisk 独有的数据层**：记忆（memories 表 + FTS,agent 检索出结论后注册用户批准的 markdown 文件，`query.ts` 的 `remember`/`forget`)；summaries 表（Claude away_summary、Pi compaction summary)。**planofplan 独有的数据层**:git repo 归属三维角色（work/touch/commit,`src/session-repos.ts`，含 `Harness-Session` commit trailer 声明式证据）和 work graph(`src/graph.ts`)——Obelisk 有 fileHistory（文件→session）但没有 commit 归属。

## 2. 模型

**Obelisk 的核心抽象是「规范 TranscriptRecord 流」**(`packages/core/src/providers/types.ts`,ADR 0001/0007):

- provider adapter 是**纯函数**:`discover(ctx) → IndexUnit[]`、`parse(unit, cursor) → Generator<TranscriptRecord, Cursor>`，永不碰数据库；`IndexUnit` 刻意不是文件抽象（Kimi 一单元 = 一个目录，zcode 类似）;
- 11 种 record kind(message / tool_call / tool_result / summary / subagent / workflow / workflow_agent / session / message-turn-duration 定点更新 / delete-session 撤回）;
- **写入语义集中在唯一的 persist 层**(`packages/core/src/persist.ts`)：消息 `ON CONFLICT` upsert;session 合并（started_at 取 MIN、ended_at 取 MAX、其余 fill-if-null COALESCE);`countMode: 'delta' | 'total'` 区分行级增量 adapter 和全量重放 adapter 的 message_count 语义；
- **visibility 三态**(visible / inactive / hidden）由 provider 显式 attestation，不由文本推断——Pi 的分支/compaction、Kimi 的 undo 可以让被取代的历史变 `inactive`，默认查询不可见但不删（ADR 0007);
- session 身份可以比 wire ID 更丰富：Pi 的自定义 session-id 是项目局部的，Obelisk 用 header id + 规范化 cwd 的哈希做确定性命名空间（README "Multi-provider support" 节）。

**planofplan 的模型是「session 目录 + repo 归属」**:`SessionRecord` 平铺 + `SessionRepo{role: work|touch|commit, evidenceKind: observed|declared|candidate}`。这个 repo 维度（尤其是 commit trailer 声明）比 Obelisk 的 `sessions.project`（仅 dash 编码目录名 + 从消息 cwd 推 project_path,`indexer.ts:59` `refreshSessionProjectPaths`）更准，是 planofplan 的差异化资产。但消息/turn/tool 层完全缺失，`searchSessions`(`src/sessions.ts:91`）只能在标题/路径/repo 名字符串里做子串匹配。

## 3. 架构

**Obelisk 的索引管线**(`packages/core/src/indexer.ts` + `provider-indexing.ts`):

- **行级增量 cursor**:`index_state` 表 per-unit 存 `"<mtimeMs>:<linesProcessed>"`,Claude adapter 用行号续扫，`parse` 只产出新增行（`providers/claude.ts:31-38, 264`);mtime 变了才重扫，重扫只从第 skip+1 行开始；
- **changedPaths 定向发现**:daemon watcher(chokidar,`app/src/main/indexer-service.ts`,debounce 2s + 稳定性 500ms + 30s 心跳）把变更路径传给 `discover(ctx.changedPaths)`，各 adapter 按路径白名单过滤，全盘 readdir 只在无变更集时发生；
- **跨进程单写者仲裁**:writer-lease（独立 SQLite lock db,`writer-lease.ts`)+ write-coordinator 有界重试（`write-coordinator.ts`)+ `__app_heartbeat__` 标记（app daemon 活着时 CLI 跳过构建，`indexer.ts:108-125`);CLI 每次 query 前自动做一次增量 build(30s debounce)，保证 agent 查到自己正在进行的 session;
- **每 unit 一个事务**，失败 unit 跳过并记录，finalize 单事务做全局修补（project_path 重推、workflow 父子链接 heal、FTS rebuild);force 重建是原子发布（全删全写或不动）;
- **indexVersionMarker**(`providers/types.ts:302`):adapter 声明索引语义版本，marker 缺失时对已索引 source 做一次 provider 自有 replay——升级解析逻辑不需要用户手动清库；
- **进程结构**:app 主进程把索引放 worker(`app/src/main/indexer-worker.ts`);CLI 与 app 共享同一份 precompiled core(ADR 0003/0005)。

**planofplan 的索引管线**(`src/sessions.ts:586` `collectSessionCatalog` + `src/server.ts:148-164`):

- 发现：每次全量 walk 7 个根目录，按 mtime ≥ since-2d 过滤，30 天窗口；
- 增量粒度 = **整个 session 文件**:mtime ≤ seenAt 则复用旧行整体跳过；一旦变动就 head 解析 + 2MB 正文 repo 提取全量重做。活跃的大 session（一天几十 MB 的 Codex rollout）每次扫描都全价重读——这是"索引慢"的主因；
- zcode 特例：WAL 导致 mtime 不可信，总是重扫；
- 触发：dashboard 打开或 `refresh=1` 时 server spawn 一个 CLI 子进程跑 `sessions --refresh`(`src/server.ts:152`),**无文件监听**，索引状态只有 running/idle 两值；
- 写并发：靠"server 单进程 + 子进程串行"隐式保证，无显式锁。

## 4. UI/UX

**Obelisk app**(Electron + Vue,`app/src/renderer/src/`):

- **Sessions**:SessionList 支持项目/source 过滤、排序、无标题噪音折叠，每行有"年龄石条"(obelisk 隐喻，越老越高越灰）；点击进入 **SessionDetail**(`views/SessionDetail.vue`)：**虚拟滚动 timeline**(`session-timeline-*.mjs` 一整套，含滚动策略/视口管理）、first/prev/next/last 消息导航、tool call 富渲染（diff、终端输出、文件 viewer,`tool-renderer.js`)、subagent 详情页、原始 JSONL 行查看（`raw()` 回源）、session 内跳转；
- **Activity**(`views/Activity.vue`):GitHub 风格热力图 + 周/累计 token 曲线；
- **Recap**：周报/月报卡片，可导出分享，还有 recap 专用检索模式（`skill-doc/references/recap/`);
- **Memory / Settings**：记忆列表与详情；数据源目录、自动刷新、重建索引；
- 键盘快捷键（`keyboard-shortcuts.mjs`)。

**planofplan web dashboard**(`web/app.js`,vanilla JS + Hono):

- sessions tab 是 Wake 风格库：列表/项目分组两种视图、provider/project/搜索/隐藏无标题过滤、右栏 detail（需求标题 + 元数据 + 同项目相关 session)+ 截断 transcript + Resume/Reveal 按钮；
- 信息密度低：turn 只留 2000 字符纯文本、tool 只显示 `tool · 名字`、无模型/token/时间逐消息维度、无虚拟滚动（40 条分页"显示更多")、无 session 内搜索、无内容高亮；
- 索引进度只有 footer 一行"正在索引…"。

## 5. 可借鉴清单（按价值/成本排序）

### P0 — 直接解决"内容级能力缺失"

1. **消息级 messages 表 + FTS5 全文搜索**。
   出处：`packages/core/src/schema.sql:9-56`(messages 表 + messages_fts + 三个自动同步触发器）。
   落点：`src/db.ts` 加 `session_messages` 表 + FTS5 虚表（bun:sqlite 支持 FTS5，已实测可用；中文分词选型见第 8.3 节），触发器照搬即可;`src/sessions.ts` 扫描时顺手 yield 消息行（head 解析已 JSON.parse 了前 256KB，扩到全文件即可）;`web/app.js` 搜索框从子串匹配换成 `?q=` 走 FTS，命中消息级结果并高亮（Obelisk `search()` 返回 message+session+rank+时序邻居，`query.ts:167`)。只索引 user/assistant 可见文本，tool 内容不入 FTS，体积可控。
   成本：中。这是"搜对话内容"的唯一正解，也是后续一切内容级功能的地基。

2. **行级增量 cursor 取代整文件重扫**。
   出处：`packages/core/src/providers/claude.ts:31-38`(cursor = `"mtime:lines"`,parse 从 skip 行恢复）、`packages/core/src/schema.sql:35`(index_state 表）、`packages/core/src/persist.ts:160-164`(cursor 透传落库）。
   落点：`src/db.ts` 加 `session_index_state(path, mtime_ms, lines_processed)`;`src/sessions.ts` 的 `collectSessionCatalog` 把"整条复用 / 全量重解析"二态改为三态：未变跳过 / 从第 N 行续扫只解析新增 / 全量。活跃大文件（Codex rollout、Claude 长会话）每次扫描从"读 2MB+全量正则"降为"读新增几 KB"。直接解决"索引慢"。
   成本：中低。续扫产出可直接喂给第 1 条的消息表和第 4 条的 touch 增量。

3. **tool_calls 表 + fileHistory / failures 两个查询**。
   出处：`packages/core/src/schema.sql:17-22` + `idx_tc_file` 索引；`query.ts:332` `fileHistory()`（文件→哪些 session 碰过它）、`query.ts:357` `failures()`(is_error=1 或 `Exit code %` 的 tool result + 后续 3 条消息做上下文）。
   落点：`src/session-repos.ts` 已经在为 touch 角色解析 tool_use 的 file_path(`reposOfRecords`)——把这些 file_path 顺手落 `session_file_touches` 表，就同时得到 (a) 更准的 touch 归属（不用每次重算）、(b) "这个文件最近在哪些 session 被反复修改"查询、配合 `src/graph.ts` 强化 work graph。和 planofplan 的 git/repo 主线高度协同。
   成本：低（解析已经做了，只差落表）。

### P1 — 明显的体验/正确性收益

4. **fs 监听 + changedPaths 定向索引**。
   出处：`app/src/main/indexer-service.ts`(chokidar、debounce 2000ms、stability 500ms、心跳）、`packages/core/src/providers/types.ts:64`(`DiscoverContext.changedPaths`)、`providers/claude.ts:84-103`（按变更路径白名单过滤发现结果）。
   落点：planofplan 已有常驻 daemon(`scripts/daemon-entry.sh`)，加 `fs.watch` 监听各 provider 根目录，变更即触发 `collectSessionCatalog({changedPaths})`，发现阶段直接缩到变更文件，不用每次 walk 全目录。dashboard 的 `indexStatus` 可从二态升级为"上次索引时间 + 本轮扫描 N 文件"(Obelisk 在 index_state 里放 `__last_build__` / `__app_heartbeat__` 哨兵行的做法可直接借用，`indexer.ts:119-122`)。
   成本：中。

5. **标题来源多元化：优先读 Claude `ai-title` 记录和 `history.jsonl`**。
   出处：`providers/claude.ts:299`(`obj.type === 'ai-title'`)、`claude.ts:70-79`(discover 先读 `history.jsonl` 建 sessionId→title 映射，再随 unit.meta 传入）。
   落点：`src/sessions.ts` 的 `claudeTitle` 目前从首条非短回复用户消息启发式截取；Claude 现在会写 AI 生成标题，直接读更准，还能减少"无标题"噪音（dashboard 已有"隐藏无标题"开关，说明这是真实痛点）。
   成本：低。

6. **is_meta / visibility 过滤框架**。
   出处：`providers/types.ts:86`、ADR 0007(visible/inactive/hidden 三态，is_meta 与 visibility 分离）、`providers/claude.ts:318-319`(skill instructions 单独 content_type)。
   落点：`src/sessions.ts` 现有 `isShortAck` + `<command-` 前缀过滤（`:64-67, :226`)，是同一思想的弱实现。做了第 1 条后，给消息打 `content_type`/`is_meta`，搜索和标题提取默认排除 meta，避免把命令信封、skill 注入当成用户需求。
   成本：低（依附于第 1 条）。

7. **session 合并语义：started_at MIN / ended_at MAX / fill-if-null**。
   出处：`packages/core/src/persist.ts:129-147`（与既有行合并而非覆盖，countMode delta/total 区分）。
   落点：`src/db.ts` `upsertSessions` 已是 COALESCE 风格，但 `updatedAt` 直接用 mtime、token 用全量重算回填（`src/sessions.ts:690`)；配合行级增量后可改为 delta 累加，避免每次全表扫 usage_records。
   成本：低。

### P2 — 架构性参考（值得抄思想，不必抄实现）

8. **canonical record 流 + 唯一 persist 层**（adapter 纯函数化）。
   出处：ADR 0001、ADR 0007、`providers/types.ts:254-262`、`persist.ts`（唯一碰 DB 的层）。Obelisk 曾有两个各自为政的 indexer 静默漂移，靠这个分层根治。
   落点：`src/transcript.ts` 的 `turnsFromClaude/Codex/Dsh/...` 是六份平行实现，输出单一 `TranscriptTurn`。若做消息表，把"解析 → 统一 record 流 → 落库/渲染两个消费者"分开，UI 展示和索引共享同一份 provider 知识，不会再漂移。
   成本：中高。建议在做第 1 条时顺势做，不单独立项。

9. **写并发仲裁（writer-lease + 心跳）**。
   出处：`packages/core/src/writer-lease.ts`、`write-coordinator.ts`、`indexer.ts:108-125`。
   落点：planofplan 目前靠 server 单进程隐式串行。若 macOS 菜单栏 app(`macos/PlanofplanMenuBar`）或 CLI 也要写同一个 SQLite，需要显式单写者 lease——现在不用做，但设计消息表写入路径时把"谁可以写"收口到一个模块，给将来留门。
   成本：中（需要时才做）。

10. **indexVersionMarker：解析逻辑升级触发自动重放**。
    出处：`providers/types.ts:302`、`provider-indexing.ts:121-130`(marker 缺失→对已索引 source 安排 replay，按 unit 补扫）。
    落点：做了消息表后，解析规则一定会迭代（比如标题策略、meta 判定）。在 `session_index_state` 里存一个 `parser_version`，版本变了自动重扫受影响 provider，避免"老索引永远是旧格式"。
    成本：低（依附于第 2 条）。

### P3 — 方向性参考（大投入，先看价值）

11. **虚拟滚动 timeline + 消息级导航 + tool 富渲染**。
    出处：`app/src/renderer/src/views/SessionDetail.vue`、`session-timeline-viewport.mjs`、`tool-renderer.js`(diff/终端/文件 viewer 分类型渲染）。
    落点：`web/app.js` 的 transcript 面板。依赖第 1 条（消息落库后才有分页/定位的游标）。先做"消息列表 + 时间戳 + model + token"的密度升级即可拿到大半收益，虚拟滚动在 turn 数上千时才必要。
    成本：中高。

12. **Activity 热力图 + Recap 周报卡片**。
    出处：`app/src/renderer/src/views/Activity.vue`、`views/Recap*.vue`、`tests/recap-*.test.mjs`。
    落点：planofplan 的 usage tab 已有 token 曲线；session 维度（哪天在哪些项目上开了多少需求）的热力图和"本周 recap"和本产品的"多 plan 聚合"定位很搭。属于新产品功能而非补课，单独立项评估。
    成本：中高。

13. **Agent 可查询的检索 API(CodeAct 模式）**。
    出处：`packages/core/src/core.ts`(vm 沙箱执行 JS)、`query.ts` 的 16 个 helper、`skill-doc/SKILL.md` + `references/`（渐进式披露的 api-reference / query-patterns / pitfalls)、ADR 0002（契约双冻结：CLI envelope golden test + helper 形状对齐文档）。
    落点：planofplan 若想让 agent 查"我这个 plan 还剩多少额度""上次哪个 session 烧了多少 token"，可以暴露 `planofplan query` 只读 SQL + 少量 helper。注意 Obelisk 的 invocation nonce 机制（`--nonce` 标记"查询者自己的 session",`skill-doc/references/api-reference.md` 的 Invocation Identity 节）解决了一个真实而隐蔽的问题：agent 查历史时会查到自己正在进行的 session 并误当证据。
    成本：高。且与第 1/3 条耦合，建议排在其后验证需求。

## 6. planofplan 不必借鉴、反而是自身优势的部分

- **git 归属三维角色（work/touch/commit)+ `Harness-Session` trailer 声明式证据**(`src/session-repos.ts`):Obelisk 只有目录级 project 推断，没有 commit 级归属；
- **归因链主线**（2026-08-22 定位更新：内容抽取 → 动机洞察 → 行为跟踪 → commit→动机归因）：Obelisk 的 Activity 只是 token 报表，没有动机/commit 维度——配额/用量聚合在 planofplan 是入口产品线而非终态；
- **provider 覆盖**(7 家含 zcode/grok/dsh/factory）多于 Obelisk(4 家）；zcode 直接读其 SQLite 的处理（`src/sessions.ts:441`）与 Obelisk"adapter 不必是文件"的 IndexUnit 抽象同思路。

## 7. 一句话结论

Obelisk 证明了"本地 agent session 索引"的完整形态：**消息级入库 + FTS5 + 行级增量 cursor + 监听触发 + 统一 persist 层**。planofplan 的短板不在思路（repo 归属、resume、增量 mtime 都已具备）而在粒度——止步于 session 目录级。最小路径是先做清单第 1+2 条（消息表 + 行级续扫），两者共享同一次解析管线，一次施工同时解决"索引慢"和"没有内容级能力"两个痛点。


---

## 8. 追问深挖（2026-08-22 补充，全部基于实测）

### 8.1 问题 1:Obelisk 的存储空间到底多大

**截断策略**(`packages/core/src/parsing.ts:18, 50-67`):`TEXT_LIMIT = 10000` 字符。`trunc()` 截单字符串；`truncJson()` 递归 walk tool input 的 JSON，把每个字符串值截到 10000。也就是说入库文本的硬上限是**每字段 10K 字符**——一条 2MB 的 shell 输出最多留 10K。

**FTS 配置**(`packages/core/src/schema.sql:41-46, 77-80`):`messages_fts` 只索引 `text` 一列（uuid/session_id 标 UNINDEXED),**默认 unicode61 分词，没有 trigram/porter**;external-content 模式（`content=messages`),text 只在 messages 表存一份，FTS 只存倒排索引。注意：**FTS 不覆盖 tool_calls/tool_results 的内容**——工具输出能按 file_path/is_error 查，但不能全文搜。

**实测倍率**（本机真实数据，采样 = 最大的 8-12 个文件 + 中位 + 小文件，按 obelisk 的截断规则模拟入库）:

| 源 | 原始量（本机 `du -sh`) | 采样原始 | 消息可见文本占比 | 含 tool I/O（截断后）占比 |
|---|---|---|---|---|
| Claude(462 文件） | 454 MB | 162.9 MB | ~1.2% | ~12.6%(33072 消息行） |
| Codex(1388 文件） | 7.2 GB | 2882 MB | **~0.25%**(39132 消息行） | ~14.1%（几乎全是 tool payload) |

结论很清楚：**原始体量 95%+ 是工具输出/思考/reasoning 等噪音；真正的对话文本只有 0.25%-1.2%**。入库后多大取决于存不存 tool 内容：

- 只存消息文本（obelisk 的 FTS 覆盖面）：本机 claude+codex ≈ 5.5MB + 18MB ≈ **24MB 文本**，加 FTS 索引（实测 bun/SQLite FTS5 索引开销 ≈ 文本的 1.0x，见 8.3 冒烟）→ **DB 增长约 50MB**;
- 连 tool_calls/tool_results 截断内容也存（obelisk 实际做法）:claude+codex ≈ 57MB + ~1GB ≈ **1.1GB**，加索引 → **1.5-2GB 量级**。瓶颈几乎全在 codex 的 tool payload(7.2GB 原始里采出 ~14%)。

⚠️ 采样偏向大文件（top-heavy)，全量语料的比率会略低；数字按区间理解。

**清理策略：没有。** 通读 `indexer.ts`/`db.ts`/`persist.ts`，无 VACUUM、无 TTL、无保留窗口；`delete-session` 只用于源端显式撤回（codex guardian 替换 `codex.ts:152`、kimi undo `kimi.ts:721`、pi supersession `pi.ts:1377`)。源文件被用户删掉后，已索引的行**会留在库里**，唯一的回收手段是 `obelisk --build`(force 重建：事务内删光全表再重放，`indexer.ts:227-247`)。对 7GB 级语料这是个真实缺陷，planofplan 应吸取教训（见 8.3 的过期清理设计）。

### 8.2 问题 2：一次性扫描之后，增量到底怎么扫

**Obelisk 有两条增量路径**:

- **CLI 侧（被动）**：每次 `--query`/`--search` 先跑 `buildIndex()`(`packages/core/src/core.ts`)。两道防抖（`indexer.ts:108-125`)：若 `index_state` 里 `__app_heartbeat__` 在 60s 内（app daemon 活着）直接跳过；`__last_build__` 在 30s 内跳过。否则走增量：全目录 discover(readdir + statSync 每个文件），mtime > cursor 记录的文件才进入 parse。
- **App 侧（主动）**:chokidar 监听所有 provider 的 `watchRoots()`(`app/src/main/indexer-service.ts`),**debounce 2000ms + 文件稳定性 500ms**（等写入停顿）,30s 写一次心跳，watch 失败 5s 重试。变更路径通过 `DiscoverContext.changedPaths` 传给 adapter,discover 只返回变更文件（`providers/claude.ts:84-122`)——这是关键的 IO 优化：**有 watcher 时不需要全目录 stat**。

**行级 cursor 的恢复方式（重要细节）**:cursor = `"<mtimeMs>:<linesProcessed>"`。恢复时 `readLines` **从字节 0 重读整个文件**(64KB 缓冲流式读，`parsing.ts:116-135`)，逐行 `JSON.parse`,**第 skip 行之后才产出 record**——但注意 `claude.ts:283-297` 里 `JSON.parse(line)` 在 `if (lineNum <= skip) return` **之前**,JSON 解析是一行都不省的。也就是说 claude 的"行级增量"只省了 DB 写入和 record 构建，**没省读也没省 parse**。Codex 更贵：full-reparse 语义，整个 session 重解析 + 全部消息重新 upsert(`countMode: 'total'`)。

**planofplan 现状**:
- session 目录：仅在 dashboard 打开/`refresh=1` 时由 server spawn 子进程 `cli sessions --refresh`(`src/server.ts:148-164`)。无 watcher、无定时。增量粒度 = 整个文件：mtime ≤ seenAt 则整条复用；一旦变动，读 256KB head + **2MB 正文**(repo touch 提取，`src/session-repos.ts:28`)+ 全量路径正则。IO 有 2.25MB 上限所以单个文件不算贵，但 N 个活跃文件 × 每次打开页面 = 重复劳动。
- usage 侧已有更优范式：codex 的 `parsedBytes` **字节级 cursor**(`src/usage.ts:618-680`)。追加扫描时 `scanCodexFile` 从 `parsedBytes` 偏移开始只 parse 新增字节（CPU 增量）——但注意它仍是 `readFileSync` 整文件读入内存再切片（**IO 没省，只省了 parse**),cursor 里还存了 `previous`（上轮累计 usage）用于差分、cursor 有版本号、解析失败自动回退全量（`usage.ts:541-549, 577-593`)。**session 索引可以直接复用这一套 cursor_json 模式**——`usage_scan_files` 表已经有 path/size/mtime/parsedBytes/cursor_json 的全套 schema(`src/db.ts:74-83`)。

**同一个「活跃 session 追加 5KB」事件的对比**:

| | Obelisk(claude, app watcher) | Obelisk(codex) | planofplan session 现状 | planofplan usage codex cursor |
|---|---|---|---|---|
| 触发延迟 | 事件后 ~2.5s 自动 | 同左 | 下次打开 dashboard | 下次 usage 刷新 |
| 发现成本 | 0(changedPaths 直达） | 0 | 全目录 walk + stat(7 个根） | 全目录 walk + stat |
| 读 IO | **整文件**(50MB 文件 = 50MB) | 整文件 | ≤2.25MB（有截断帽） | 整文件读入，只切新增 |
| 解析 CPU | **全量 JSON.parse 每行** | 全量 + 全量 re-upsert | ≤2MB 解析 + 正则 | **只 parse 5KB** |
| 写 DB | 新增行 upsert + FTS | 全部消息 re-upsert | 1 行 session + repos | 新增 usage 行 |

结论：**两边的"增量"都只做到一半**。Obelisk 赢在发现（changedPaths）和写入（行级 cursor 只写增量）,planofplan usage 侧赢在 parse（字节偏移），但 IO 都没省（obelisk 主动全读，planofplan 用 2MB 帽子兜底）。真正完整的形态 = changedPaths 发现 + 字节偏移 `pread` 读 + 增量 parse + 增量 upsert，四者拼起来，而零件在两边都已经存在。

### 8.3 问题 3:planofplan 做消息表的落地设计

**冒烟验证（已实测，bun 环境）**:

```
CREATE VIRTUAL TABLE x USING fts5(content)                      -- ✅ bun:sqlite 可用
unicode61 分词:'修复登录' 可整词命中,'修复' 子串不命中            -- ❌ 中文子串搜索不可用
tokenize='trigram':'复登录'/'auth'/'AUTH' 命中,'修复'(2 字)不命中 -- ✅ 可用，但最少 3 字符
性能:23.6MB 文本 / 2 万行,单事务插入 696ms,DB 文件 47.1MB(= 文本 2.0x,FTS ≈ 1x)
```

结论：bun:sqlite 的 FTS5 可用；**中文场景必须 trigram**(unicode61 把连续中文当一个词，子串搜不到——obelisk 用默认 unicode61，意味着它对中文对话的搜索其实是半残的，这是 planofplan 可以反超的点）。trigram 的坑：查询少于 3 个字符不命中（中日韩 2 字词很常见），查询侧要对 <3 字符的查询回退 `LIKE '%..%'`。trigram 索引比 unicode61 大约 1.5-2x，按 8.1 的消息文本体量（几十 MB）无所谓。

**表结构**（贴着 `src/db.ts` 现有风格，整数 ms 时间戳，与 `sessions.id` 外键对齐）:

```sql
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,               -- 去重键，见下
  session_id TEXT NOT NULL,          -- sessions.id('claude:<uuid>' 等)
  seq INTEGER NOT NULL,              -- 源文件行号 / part 序号,排序用
  role TEXT NOT NULL,                -- user | assistant | tool
  kind TEXT NOT NULL DEFAULT 'text', -- text | tool_use | tool_result
  tool_name TEXT,
  text TEXT,                         -- 截断到 10K 字符(照 obelisk TEXT_LIMIT)
  timestamp INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX idx_session_messages_session ON session_messages(session_id, seq);
CREATE VIRTUAL TABLE session_messages_fts USING fts5(
  text, content=session_messages, content_rowid=rowid, tokenize='trigram');
-- + ai/ad/au 三个同步触发器(照 obelisk schema.sql:43-56 照搬)
```

对照现有 `TranscriptTurn`(`src/types.ts:213-217`:role/text/toolName)：只多了 id/seq/kind/时间/token/model——正好是 `transcript.ts` 解析时手里有但扔掉的信息。

**存多少（体积控制）**：照 8.1 的实测，v1 只入库 **user/assistant 文本 + tool_use 的 input（截 2K)**;tool_result 的输出正文**不入库**(detail 视图继续走 `transcript.ts` 按需现读）。这样本机 11.4GB 原始语料 → 消息文本 ~40-60MB + trigram FTS ~1-1.5x → **DB 增长约 100-150MB，可控**。如果连 tool_result 也存，codex 一家就 +1GB，不值。`text` 截断到 10K 保留 obelisk 的防爆帽。另外加 obelisk 没有的**过期清理**：扫描时发现 source_file 已不存在 → 删 session 连带消息（`ON DELETE` 手动级联）,30 天窗口外的老消息可定期 prune——这是对 8.1 发现的 obelisk 缺陷的针对性改进。

**消息 id 去重策略**（逐 provider):

- claude:transcript 行自带 `obj.uuid`，直接用（`src/sessions.ts:45` 已验证文件名即 UUID);
- codex:**没有消息 id**——照 obelisk 的方案合成 `codex:<threadId>:<行号,左补零>`(`packages/core/src/parsing.ts:245` `codexLineUuid`)，因为 codex 是 append-only，行号即稳定身份；
- kimi/grok/factory/dsh:wire/chat JSONL 行号合成 `${nativeId}:${seq}`;
- zcode：源是 SQLite,`part` 表自带 id(`src/session-repos.ts:109` 已在查 part)，直接用。

写入用 `INSERT ... ON CONFLICT(id) DO UPDATE`（照 obelisk persist.ts 的 messages upsert)，增量重放幂等。

**解析管线（最小侵入）**：不动 `sessions.ts` 的 head 解析（目录提取保持 256KB 便宜）。改动集中在**变动文件的全量分支**——那里 `extractSessionRepos` 本来就要读 2MB 正文，把这一次读取的产物从"只给 reposOfRecords"扩成"record 流"，同时喂两个消费者：repo 提取（现有）和消息行提取（新）。具体：把 `transcript.ts` 的六个 `turnsFromX(records)` 各加一个 companion `messagesFromX(records) → MessageRow[]`（共享同一份已 parse 的 records，纯函数，可直接放进 `transcript.ts` 同文件）;`TranscriptTurn` 保持不动，UI 的按需 transcript 路径完全不受影响。这比 obelisk 的 canonical TranscriptRecord 全套抽象轻得多，但拿到了"一次 parse 多方消费"的核心收益。

**增量配合**:`usage_scan_files` 表的 `parsedBytes + cursor_json` 模式原样复用到一张 `session_index_state(path, mtime_ms, parsed_bytes, lines)`。文件变大且 parsedBytes ≤ size → 从字节偏移续读（用 `readSync` 指定 position，把 usage 侧"整读再切"的 IO 浪费也省掉），新行解析出消息 upsert，同时更新 touch repos；文件 size 缩小或 parsedBytes > size（截断/轮换）→ 删该 session 消息全量重扫。zcode 走"db mtime 不可信总是重扫 + 消息 upsert 幂等"的现有特例即可。

**写入时机**：搭现有车——`src/server.ts:152` 的 `startSessionIndex` 已经 spawn `cli sessions --refresh` 子进程做 session 索引，消息索引放**同一个子进程的同一趟扫描**里（每个文件一个事务）。`src/db.ts:1131` 已开 WAL，子进程写、server 读互不阻塞，不用引入新进程模型。后续要"打开页面时数据就是新的"再上 P1 第 4 条的 fs.watch + changedPaths。

**查询面**:`/api/sessions?q=` 里 `searchSessions` 之外并一路 FTS:`SELECT session_id, snippet(...) FROM session_messages_fts WHERE text MATCH ?` 按 session 聚合 top N,web 端在 session 条目下展示命中片段。`snippet()` 是 FTS5 内置函数，高亮不用自己写。

### 8.4 问题 4:Obelisk 的产品方向判断（简要）

从 README + SKILL.md + ADR 读出来三条明确的赌注：

1. **Agent 是第一用户，人类界面是第二屏**。tagline 就是 "queryable by your agent, browsable by you"。检索不走 RAG/embedding，而是 **CodeAct**:agent 自己写 JS/SQL 查结构化索引（`skill-doc/SKILL.md` "Obelisk is a CodeAct memory layer")。赌的是：对结构化 transcript 数据，agent 写定向查询比向量检索更准、更省、零基础设施。ADR 0002 把 helper 返回形状用契约测试冻死、文档升格为权威——因为真正的 API 消费者是 agent，形状漂移 = agent 静默坏掉。invocation nonce 机制（识别"正在查询的那个 session 自己"）更说明他们在认真优化"agent 边写历史边查历史"的自指回路。
2. **Memory 是"人审的合成缓存"，不是自动记忆**。`--attune` 与只读 `--query` 完全分离（不同沙箱、不同 helper 集）,agent 只能提议写记忆、必须用户批准（SKILL.md "Mutation approvals");memory 行带 `anchors`/`message_start/end` 回链到源 session 证据，README 明确定位 "a synthesis cache, not a replacement for raw evidence"。这是对"agent 自动记 memory 会腐烂"的清醒回应。
3. **人类侧做情感价值而非效率工具**:Activity 热力图、Recap 周报卡片（可分享、archetype 主题）是留存/传播层；skill 里 `recap` 走独立 intent 路由和专用检索参考，说明"周期性回顾"被他们视为人侧的核心场景，而不是顺手的报表。

对 planofplan 的启示：planofplan 的基本盘（配额/用量聚合）天然是"人看"的仪表盘，obelisk 证明了同一份本地数据再加一个"agent 可查"的面就能长出第二种产品；但 obelisk 也示范了代价——一旦把 agent 当用户，helper 形状、token 口径、身份边界（is_invoking）都得当公共 API 管理。

### 8.5 实施回填(2026-08-22,v1 已落地)

8.3 的方案已实现并冒烟,实测数字与发现的坑:

- **首扫**:30 天窗口、7 家 provider、真实本机数据,75s;消息 66,080 行;DB 从 164MB → 481MB(**+317MB**,高于 8.3 预估的 100-150MB,主因是 codex 巨型 rollout(单文件 100-170MB)的 tool_use 入参(2K 截断)+ trigram 索引比 unicode61 大约 1.5-2x)。体积可接受但贴上限,后续若要压缩可考虑 tool_use 入参截到 500 字符或不入 FTS。
- **增量稳态**:3.3s(对比 HEAD 基线 5.8s 还更快)。期间抓到两个真 bug:
  1. mtime 毫秒精度撞车(测试里 writeFileSync 同毫秒重写被误判新鲜)→ 新鲜度改为 mtime + size 双等,session_index_state 加 size 列;
  2. **codex 同一 session 续写产生多个 rollout 文件**(实测 86 个文件共享 session id),catalog 的 sourceFile 只能指一个,其余文件每轮全量重扫(含 169MB 大文件,单此一项 22s)→ 加"文件级水位新鲜但目录行未命中"分支,直接复用索引。
- **写入事务**:WAL 下每次 COMMIT 一次 fsync,按批提交把续扫拖慢一个数量级(16s/965 批)→ 改为整文件一个事务(Store.withTransaction,支持嵌套)。
- **FTS 实测**:trigram 中文 ≥3 字符命中 1-7ms;2 字查询回退 LIKE,66k 行全表扫 639ms 可接受。snippet 用 char(1)/char(2) 做命中标记,前端转义后换成 <b>。
- **冒烟**:`bun src/cli.ts sessions --refresh` 真实库两轮 + HTTP `/api/sessions?q=` 实测(FTS 并集、LIKE 回退、snippet 均正常)。
