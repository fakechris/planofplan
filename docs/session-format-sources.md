# Session 格式溯源（format provenance）

> 制度（参照 agentsview 的 `docs/internal/session-format-sources.md`）：
> **动某家 provider 的 parser（发现/抽取/标题/消息索引）时，必须在同一次变更里
> 更新对应条目并更新「已验证」日期。** 没有证据的格式推断不允许进代码。
> harness 的本地格式没有公开规范，唯一的事实来源是真实落盘文件——条目里的
> 证据都标注了来源和验证日期。格式漂移是 parser 层最大的隐性维护成本。

| Provider | 源目录（L0，只读） | 已验证 |
| --- | --- | --- |
| claude | `~/.claude/projects/<urlencoded-cwd>/<uuid>.jsonl`（+ `subagents/agent-*.jsonl`） | 2026-08-29 |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`（+ `~/.codex/session_index.jsonl`） | 2026-08-29 |
| grok | `~/.grok/sessions/<urlencoded-cwd>/<uuid>/summary.json`（正文在 `chat_history.jsonl`） | 2026-08-29 |
| dsh | `~/.dsh/sessions/**/session.jsonl.zstd`（zstd 压缩，透明解压） | 2026-08-29 |
| kimi | `~/.kimi-code/sessions/<dir>/state.json`（正文在 `agents/main/wire.jsonl`） | 2026-08-29 |
| zcode | `~/.zcode/cli/db/db.sqlite`（或 `db/db.sqlite`） | 2026-08-29 |
| factory | `~/.factory/sessions/*.jsonl`（排除 `*.settings.*`） | 2026-08-29 |

## claude

- **行格式**：`{type, uuid, timestamp, cwd?, message:{role, content}}`；
  content 是字符串或块数组（`text` / `tool_use` / `tool_result`）。
- **官方标题**：`{type:"ai-title", aiTitle:"<kebab-slug>", sessionId}`。
  **位置不固定**——本机实测出现在第 102 / 1446 / 2658 行，头部 256KB 解析常漏，
  主路径靠消息索引的流式全量读捕获（`sessions.ts` 的 `indexSessionFileMessages`）。
- **注入与信封**：`isMeta:true` 记录（如 `[structured-output-envelope]`
  structured-output 强制注入）不是用户输入；`<command-…` / `<local-command-…`
  / `[` 开头的用户消息是命令信封。标题与消息索引都要跳过。
- **compact 续跑摘要**（2026-08 本机实证，18 个文件）：不是独立 type，而是
  `isCompactSummary:true` 的用户消息，content 以 "This session is being
  continued…" 开头内嵌摘要。处理：重分类 `kind='summary'/role='system'`——
  FTS 可搜（压缩后的会话仍能搜到早期意图），但不进需求抽取与标题。
- **history.jsonl**（`~/.claude/history.jsonl`，projects 的兄弟文件）：
  `{display, sessionId, timestamp, project, pastedContents}` 每条用户输入一行；
  用于无标题 session 的兜底（首条非信封 display）。
- **去重口径**（usage 侧）：`message.id + requestId` 去重。
- 证据：本机 `~/.claude/projects/-Users-chris-workspace-planofplan/*.jsonl`、
  `-Users-chris-Downloads-staffg-installer/dfa2e527-*.jsonl`（ai-title），
  `~/.claude/history.jsonl`（2.1MB 实测）。

## codex

- **文件名**：`rollout-YYYY-MM-DDTHH-MM-SS-<36位uuid>.jsonl`（可 `.zst`）。
- **行格式**：`{timestamp, type:"session_meta", payload:{id, cwd, timestamp, originator}}`
  + `{type:"response_item", payload:{role, content:[{type:"input_text"|"output_text", text}]}}`
  + function_call / custom_tool_call 及其 output。
- **无消息 id**：append-only，行号即稳定身份（`codexLineUuid` 方案）。
- **系统信封**（本机 2026-08 普查，用户 input_text 里的非用户原话，共 11 种）：
  `environment_context`(2055) `codex_internal_context`(451) `recommended_plugins`(406)
  `turn_aborted`(403) `user_action`(238) `goal_context`(227) `subagent_notification`(192)
  `image`(多形态) `task`(56) `skill`(23) `user_shell_command`(12)。
  显式清单维护在 `transcript.ts` 的 `CODEX_META_ENVELOPES`——新信封出现时追加并
  升 `MESSAGE_PARSER_VERSION`；不要改成「`<` 开头即信封」（用户粘贴 HTML 是真实输入）。
- **session_index.jsonl**（`~/.codex/session_index.jsonl`，sessions 的兄弟文件）：
  `{id, thread_name, updated_at}` 每线程一行（本机 145 行），只当轻量标题/更新
  元数据，不当 transcript 源。
- **多 rollout 同 session**：同一 session 续写会产生多个 rollout 文件（本机实测
  86 个文件共享一个 session id）；catalog 的 source_file 只指一个，其余靠
  「文件级水位新鲜但目录行未命中」分支复用。
- 证据：本机 `~/.codex/sessions/2026/*/*/rollout-*.jsonl`（信封普查全量扫描）、
  `~/.codex/session_index.jsonl`。

## grok

- **目录布局**：session 目录 `sessions/<urlencoded-cwd>/<uuid>/`，目录级元数据在
  `summary.json`，消息正文在兄弟文件 `chat_history.jsonl`——catalog 走 summary.json，
  消息索引重定向到 chat_history.jsonl（`sessions.ts` 的 `messageReadPath`）。
- **token 日志分离**：用量在 `~/.grok/logs/unified.jsonl`（不在 session 目录），
  按 `sid` 回填；不把 unified.jsonl 伪装成一个 session。

## dsh（DeepSeek Harness）

- **存储**：`~/.dsh/sessions/**/session.jsonl.zstd`，zstd 压缩；解压经外部 zstd
  （`ZSTD_PATH` / homebrew 路径），有 `ZSTD_MAX_BYTES` 上限。压缩文件无字节水位
  语义，mtime 变即整量重解。
- **行格式**：`{time, type:"user/message"|"assistant/message"|"tool/call", data:{...}}`；
  `user/message` 的 `data.source.kind !== 'user'` 跳过；token 只取最终
  `assistant/message` 事件（streaming chunk 会重复计数）。

## kimi（Kimi Code）

- **目录布局**：`sessions/<dir>/state.json` 是目录级元数据，消息正文在
  `agents/main/wire.jsonl`——同 grok 的重定向模式。
- **undo/clear 语义**：wire 流可能被撤销（obelisk 公开文档记录 Kimi undo/clear
  触发全量重放）；我们的水位是「mtime/size 变即按文件处理」，目录文件小，
  全量重解成本可接受。

## zcode

- **存储**：自有 SQLite（`db/db.sqlite` 或 `db.sqlite`），`part` 表自带稳定 id。
- **WAL 坑**：主文件 mtime 在 WAL 模式下不可信——**总是重扫**，幂等 upsert 保全
  正确性（part id 稳定）。消息直接读其 SQLite 而非 jsonl。

## factory（Droid）

- **存储**：`~/.factory/sessions/*.jsonl`（`*.settings.*` 排除）。
- **已知限制**：只有 session/message 元数据，**没有可靠的 per-turn token
  ledger**——不得把 `summaryTokens` 或消息数伪装成 token usage；真实组织用量
  走 Factory Analytics（`FACTORY_API_KEY`，official 来源单独标记）。

---

## commit witness 证据（2026-08-30 新增）

- `git commit` 的 tool_result 首行格式 `[<branch> <sha>] <subject>`（root-commit
  为 `[<branch> (root-commit) <sha>]`）——目击提取按 tool_use↔tool_result
  配对制（claude 按 id、codex 按 call_id），只认 commit 命令的输出，`git log`
  浏览输出的 sha 一概不算（防假阳性）。命令识别按 shell 分段 + 剥包装词
  （`bash -lc` 等）后要求首子命令为 `commit`。dsh/factory 不落盘工具输出，
  是 witness 的盲区（由 trailer 钩子兜底）。

## antigravity（2026-08-31 新版实证，usage 已接入）

- 新版 IDE 布局：`~/.gemini/antigravity/conversations/<uuid>.db`（SQLite：
  trajectory_meta/steps/gen_metadata/executor_metadata/…）+ `brain/<uuid>/
  .system_generated/logs/transcript.jsonl`（明文）。旧版只有加密 `.pb`
  （Keychain Chromium AES），按无 ledger 跳过。
- **usage**：`gen_metadata.data` 是 protobuf blob——`field 1 chat_model{
  field 4 usage{1=model 枚举[1000,5000), 2=input(未缓存), 3=output(含思考),
  4=cache_write(弃用), 5=cache_read(可选)} 19=response_model 21=display_name}`。
  字段号与校验（量级上限防 decoy）参照 agentsview（其对 sidecar 交叉验证
  550/550）。本机实测：18 行/会话，gemini-3.7-flash，cache 主导。
- **时间戳近似**：gen_metadata 无逐条时间戳，记录时间用 `.db` mtime
  （会话粒度日分桶够用；要精确需 join steps/消息时间线，后续再说）。
- **session catalog（2026-08-31 已接入）**：发现 = conversations/*.db；
  git 身份从 trajectory_metadata_blob 的字节串直取（file:// URI = cwd、
  https://*.git = remote——proto 字段序不保证，手读字段号会错位）；
  正文 = brain/<uuid>/.system_generated/logs/transcript.jsonl（明文事件流：
  USER_INPUT 剥 <USER_REQUEST> 信封、PLANNER_RESPONSE 的 content +
  tool_calls、CHECKPOINT/SYSTEM_MESSAGE 跳过；无消息 uuid，step_index 做
  稳定身份）。tool_calls 的 args 是结构化参数（含 CommandLine 字段）——
  witness 通道后续可从 CommandLine 挖，v1 未接（钩子兜底）。

## 维护规则（重申）

1. 改某家 parser → 同一次变更更新本文件对应条目 + 「已验证」日期。
2. 新发现的格式坑（去重/截断/压缩/身份）先落证据到这里，再动代码。
3. 消息抽取规则变更 → 升 `MESSAGE_PARSER_VERSION`（`sessions.ts`）触发全量重扫。
4. 第三方格式知识（obelisk/agentsview 的公开文档）可以引用为证据，但
   **代码不抄**（obelisk AGPL-3.0；agentsview MIT 但语言不通用）。
