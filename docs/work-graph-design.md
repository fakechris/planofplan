# planofplan 工作谱系（Work Graph）

> 状态：已确认落点（2026-08-20）。额度轨继续走 `planofplan-design.md`；本文件是**第二条产品轨**。
> 下文 **M3–M6 即本轨里程碑**（WG-M3…），与额度轨原 M3（授权与运维）并行，不互相覆盖。
> 来源：dsh-track 的分层/证据纪律 + 本机多 agent session 盘点；明确不做成 Wake / Entire / SpecStory / OVP 的克隆。

---

## 0. 产品句

planofplan 是本机 coding agent 的指挥台：

- **额度轨（已有）**：订阅怎么烧（quota windows + token spend）。
- **谱系轨（本文件）**：烧出来的工作是什么、落在哪个 repo。

两轨共用同一守护进程、同一 SQLite（`~/.planofplan/planofplan.db`）、同一 localhost dashboard。不是两个产品。

**dsh-track 继续留在 DSH 里**：live 捕获、决策点、3080 会话深链。planofplan 只读磁盘上已经落下的日志（含 DSH 的 `session.jsonl.zstd`），不替代 DSH 插件，也不把外源 session 深链进 DSH UI。

**OVP 不吃这条语料。** 原始 jsonl 含密钥与工具输出，不能进可发布 vault，也不能走 reader trunk / Crystal。

---

## 1. 对照：抄什么、不抄什么

| 来源 | 抄 | 不抄 |
|---|---|---|
| **dsh-track** | L0/L1 分层；执行图与日历纱线的数据模型；证据 guard（trailer/user 才能 declared）；项目 = 实际碰到的 git repo | cordis 插件身份；`track.json`；Linear 任务墙当第一屏；DSH `sessions.open` 深链；live observer |
| **Wake** | 只读别家目录；索引可重建；应用内阅读 transcript；Resume 调原生 CLI | 纯找对话当北极星；GPUI 重写；把本产品收成 session 资料库 |
| **Entire** | 以后可选的 commit trailer 作为 declared 通道 | git hook / checkpoint 分支；必须包装 agent 才有历史；单仓库范围 |
| **SpecStory** | 无 | `specstory run` 包装；往每个仓库倒 markdown；Cloud；跨 agent 续跑当第一跳转 |
| **OVP** | append-only ledger 心态、投影可重建 | Source→Unit→Crystal 管道；把 session 当文章 |

---

## 2. 分层与存储

| 层 | 位置 | 谁写 | 规则 |
|---|---|---|---|
| **L0 事实** | 各家原目录（`~/.claude/projects`、`~/.codex/sessions`、`~/.grok/sessions`、`~/.dsh/sessions`、…） | 各 harness | **只读，不搬、不改、不进 git** |
| **L1 目录/图** | `~/.planofplan/planofplan.db` 的 `sessions`（及后续 `session_graphs` / `work_links`） | planofplan 扫描器 | 可整体重建；删表再扫不丢 L0 |
| **展示** | dashboard 新区块 + CLI | 本仓库 `web/` | 与额度页同壳 |

身份：`{source}:{nativeId}`，例如 `codex:01a01cbe-…`、`dsh:session-76764e4b-…`。各家 UUID 可能撞车，前缀不可省。

扫描器与现有 `src/usage.ts` **共用文件发现**（同一趟 `collectUsageReport` 附带 catalog）。禁止第二套全盘 walk 再扫 1GB Codex rollout。大文件只读文件头（默认 256 KiB）抽 cwd / 标题，token 汇总从已有 `usage_records` 聚合。

Grok 例外：token 日志在 `~/.grok/logs/unified.jsonl`，**session 目录**在 `~/.grok/sessions/<urlencoded-cwd>/<id>/summary.json`。Catalog 走 summary.json，token 用 `sid` 回填，不把 unified.jsonl 伪装成一个 session。

---

## 3. 跳转（三档，诚实标注）

1. **应用内阅读**（M4）：永远能做。自己的 GUI 渲染 user/assistant/tool。
2. **原生 Resume**（M4）：探测到入口才显示按钮。launchd PATH 极小，必须搜家目录候选；**跳过坏掉的 Homebrew Codex node wrapper**（缺 vendor 原生二进制就换 nvm/native）。DSH 打开 `http://127.0.0.1:3080/`（web，不是 TUI）。ZCode 打开 GUI（`zcode://workspace/open?path=`）。Claude 优先 `~/.local/bin/claude.sh`。覆盖写在 `~/.planofplan/config.json`：

```json
{
  "resume": {
    "claude": { "bin": "~/.local/bin/claude.sh" },
    "dsh": { "kind": "url", "url": "http://127.0.0.1:3080/" }
  }
}
```

`args` 里 `{id}` 会替换成 native session id；`env` 会在 Terminal 里 `export`（密钥更适合放 wrapper，不要写进 config）。
3. **Handoff**（M4 以后，可选）：把摘要喂给当前 agent。不是跳转。

M3 只做到：列出 session、展示元数据、给出 `source_file` 路径（可「在 Finder 中显示」）。不假装打开 Claude/Team/Z/Qwen 的 UI。

---

## 4. 证据纪律（从 M6 生效，M3 不写边）

与 dsh-track / Better Harness 对齐，提前立规矩：

- 只有显式声明能带强证据：commit trailer、用户在 UI 里点的关联 → `declared` / `observed`。
- 时间窗、标题相似、LLM 聚类 → 最多 `candidate`。语义层永不升级证据。
- 缺证据保持显式（candidate / unmapped），不拼一条「看起来完整」的交付链。
- 跨 agent「同一需求」（Grok 接手 Codex 等）默认 candidate。

M3–M5 只建立 session 节点与纱线位置，不写 `implements` / `landed-in` 边。

---

## 5. 数据模型（M3）

```sql
sessions (
  id            TEXT PRIMARY KEY,   -- 'codex:<uuid>'
  provider      TEXT NOT NULL,      -- claude | codex | grok | dsh | kimi | zcode | factory
  native_id     TEXT NOT NULL,
  cwd           TEXT,               -- 工作目录；未知为 NULL
  title         TEXT,               -- 首条非 ack 用户请求，截断单行；未知为 NULL
  source_file   TEXT,               -- L0 路径，供打开/Finder
  started_at    INTEGER,            -- epoch ms
  updated_at    INTEGER NOT NULL,   -- 文件 mtime 或 summary.updated_at
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  seen_at       INTEGER NOT NULL    -- 本次扫描时间
);
CREATE UNIQUE INDEX idx_sessions_native ON sessions(provider, native_id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_cwd ON sessions(cwd);
```

### 5.1 多维 git（纱线 / 需求抽取的主键）

cwd walk-up 只回答「人坐在哪」。纱线图和需求归属必须用**实际碰到的仓**，而且一个 session 可以碰到多个。三层分开存，互不顶替：

| 维度 | 来源 | 回答 | 证据 | 用途 |
|---|---|---|---|---|
| **工作 git** | session `cwd` 向上找到 `.git` / origin | 人在哪个仓库目录里开的 session | observed | session 元数据、Resume cwd |
| **触碰 git** | 日志里 tool 的 `file_path` / `workdir` / `git -C` | 实际读/写/操作了哪些仓 | observed | **纱线泳道**、**需求.project** |
| **提交 git** | 工作∪触碰仓的 `git log`（committer time，session 窗 ±10min） | 这段工作落到了哪些仓 | trailer `Harness-Session:` → declared；仅时间重叠 → candidate | 交付落点；不升级证据；当前实现默认关闭（大量 `git log` 会阻塞 daemon，且 Bun 1.3.5 在长扫描中曾段错误），需要时显式传入 git runner |

规则（对齐 dsh-track `header.repos` / `attributeIssuesBySpan`）：

- 需求归到其 span 里**第一个触碰仓**。没有触碰就保持 `(unmapped)`，**不准**用工作 git 冒充。
- `~/source/dsh/explorer` 不是项目；从那里改 `dsh-track` / `dsh-harness-ops` 时，纱线要画出那些仓。
- 时间接近不是 provenance。缺证据保持 candidate / unmapped。

表：`session_repos (session_id, role, url, root, name, evidence_kind, first_seq)`。`sessions.git_*` 仍是工作 git 的投影，方便列表。

标题规则（对齐 dsh-track `titleify` / `isShortAck`）：跳过过短确认（「可以」「ok」）；压空白；上限 80 字。全文不进 M3 表。

Token 列是 **usage_records 的聚合投影**，不是第二份消费账本。session 没有 usage 行时 token 为 0（Factory 当前就是这样）。

---

## 6. 各家 L0 → M3 catalog

验收四家（必须列出）：**Claude、Codex、Grok、DSH**。其余有文件则附带，没有不装假数据。

| provider | 发现 | native id | cwd | title |
|---|---|---|---|---|
| claude | `~/.claude/projects/<slug>/*.jsonl` | 文件 stem（UUID） | 记录字段，否则 slug 启发式 | 文件头里第一条 `type=user` 文本 |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` | `session_meta.payload.id` 或文件名 UUID | `session_meta.payload.cwd` | 文件头里第一条 user `response_item` |
| grok | `~/.grok/sessions/<enc-cwd>/<id>/summary.json` | `info.id` | `info.cwd` | `generated_title` / `session_summary` |
| dsh | `~/.dsh/sessions/<ws>/<id>/session.jsonl.zstd` | header `id` 或父目录名 | header `cwd` | 头事件里首条 `user/message` 且 `source.kind=user` |
| kimi | `~/.kimi-code/sessions/**/state.json` | `id` | `cwd` | `title` / `lastPrompt` |
| zcode | usage 已扫的 jsonl，按 `sessionId` 归并 | `sessionId` | 未知则空 | 未知则空 |
| factory | `~/.factory/sessions/**/*.jsonl` | `session_start.id` | `session_start.cwd` | `session_start.title` |

大文件（Codex 单条 rollout 可达 ~1GB）：**只读文件头**，禁止 `readFile` 全文。压缩 DSH 日志用 `zstd -dc` 但截断输出；单文件解压缓冲上限 8 MiB。

---

## 7. API / CLI / UI（M3）

```
GET  /api/sessions?days=30&provider=&project=
GET  /api/sessions/:id
GET  /api/sessions/:id/transcript → turns + resume 是否可用（M4）
POST /api/sessions/:id/reveal     → macOS `open -R <source_file>`；其它平台 501
POST /api/sessions/:id/resume     → 有 CLI 则在 Terminal 里 cd + resume（M4）
```

`GET` 默认只读库，不触发扫描（与 `/api/usage` 相同）。「扫描本地日志」走现有 `tokens` 子进程；`collectUsageReport` 成功后调用 `collectSessionCatalog`。

```
planofplan sessions [--json] [--days N] [--provider sl]
```

读库列出；不单独全盘重扫。需要刷新时先 `planofplan tokens`（或 dashboard 按钮）。

Dashboard：对话 tab。搜索（标题 / 需求 / git 项目 / 来源）；筛 provider / **git 项目**（不是 cwd basename）。列表或项目聚合视图。行：provider、需求标题、git 项目。点开读正文 + Resume。chat 搜索后置。

---

## 8. 里程碑

| 阶段 | 内容 | 验收 | 明确不做 |
|---|---|---|---|
| **M3 Session 目录** | `sessions` 表 + 头扫描 + 与 usage 同趟 + 列表页/CLI | Claude / Codex / Grok / DSH 能列出；条数与 usage 能对上（同文件/同 sid）；大文件不全文读 | 正文渲染、Resume、图、issue |
| **M4 阅读 + Resume** | 应用内 transcript；有 CLI 才显示 Resume | 点开一条 Claude 和一条 Codex 能读对话；无 CLI 的源只有阅读 | 假深链；跨 agent 续跑当默认 |
| **M5 日历纱线** | 多维 git 抽取 + 需求 + 关系图。纱线泳道 = **触碰 git**（工具路径实际碰到的仓），不是 cwd。工作 git 只作 session 元数据。提交 git 先记仓身份（时间窗 candidate / trailer declared）。日历纱线可视化随后 | 同一 session 可落在多个触碰仓；需求不因 cwd 而全部塌到工作 git；explorer cwd 里改 dsh-track 的需求归 dsh-track | 把时间窗 commit 升级成 observed；chat 搜索；skill 蒸馏 |
| **M6 谱系（可选）** | 需求候选、commit sha 对齐、证据 guard | 默认 dry-run；时间窗链接标 candidate | skill 蒸馏；Entire hook；写入 OVP Crystal |

M3 完成后再开 M4。M5 可复用 dsh-involute `export/track-calendar-view.html` 的数据形状，不必复用 DSH 面板代码。

---

## 9. 模块切分

```
src/sessions.ts     catalog：发现、文件头解析、titleify、与 usage 聚合
src/repos.ts        cwd / 路径 → git root / origin URL；触碰路径抽取
src/session-repos.ts 工作 git / 触碰 git / 提交 git 抽取
src/graph.ts        session / requirement / project 关系图（worked-in / touched / landed-in）
src/transcript.ts   只读 JSONL 流式正文（有上限）
src/resume.ts       家目录候选路径探测 CLI，macOS Terminal 启动
src/db.ts           sessions 表 CRUD（现有 Store，不加第二个库）
src/usage.ts        collectUsageReport 末尾调用 collectSessionCatalog；不复制 walk
src/server.ts       /api/sessions*
src/cli.ts          sessions 子命令
web/                Session 目录区块（vanilla JS，无构建）
```

新增 adapter 文件不是必须：catalog 按磁盘布局识别 provider，不走 quota 的 `PlanAdapter`。额度 adapter 与 session 发现可以 provider 名对齐，但失败互不影响（没有 Codex 额度凭据仍能列出 rollout）。

---

## 10. 非目标（再写一遍以免膨胀）

- 不把 L0 拷进 db 或任何 vault。
- 不写回 `~/.dsh/storages/track.json`。
- 不在 M3 做 Linear 式任务墙。
- 不包装 agent 启动（`specstory run` / `entire enable`）。
- 不从单条 session 蒸馏 SKILL.md。
- 不把「看起来像同一需求」的跨 agent session 自动合成一条 declared 链。
