# 四大多 Agent 会话/状态/记忆系统全景对比与演进路线图

> 调研对象：**Wake**、**Obelisk**、**Memmy Agent**、**planofplan**  
> 基准日期：2026-09-09  
> 目的：全面审视四套系统的架构拓扑、数据抽象、检索能力、演化机制与消费形态，确立 `planofplan` 的核心护城河与后续高阶演进里程碑。

---

## 0. 执行摘要与四系统定位速览

| 系统 | 一句话定位 | 核心技术栈 | 存储与底座 | 主要消费形态 | 核心护城河 |
|---|---|---|---|---|---|
| **Wake** | 极致轻量、零侵入的本地会话检索与终端唤醒器 | Rust + GPUI 0.2 | SQLite + FTS5 (Trigram) | macOS 原生桌面 (Rust 原生渲染) | 毫秒级冷启动、极致排版与平滑手感、14 家 Agent 零侵入只读解析、高亮直达定位 |
| **Obelisk** | 跨 Agent 消息级历史归档与 Agent 自查沙箱 | TypeScript + Electron + Vue 3 | SQLite + FTS5 + JSONL 原文回源 | 桌面 GUI + `obelisk` CLI / Agent 专属查询 Skill | 结构化消息/Tool/Subagent 关系表、信封噪音过滤（`is_meta`/`visibility`）、Agent 运行期自查历史沙箱 |
| **Memmy Agent** | 本地优先的四层仿生认知记忆与桌宠智能伴侣 | TypeScript + Fastify + Electron + React | SQLite + sqlite-vec (向量+FTS5) | Electron 完整工作台 + 置顶透明桌宠 (Pet) 挂件 + 6 大 IM 渠道 | L1 轨迹到 L2 策略/L3 世界模型/Skill 结晶、强化学习信用分配（$\gamma,\lambda,\delta$）、6 通道检索融合、桌宠微交互 |
| **planofplan** | 跨 Plan 额度监控、日志成本穿透与 Commit 动机归因中枢 | TypeScript/Bun + Swift | SQLite (L1 索引 + 元数据隔离) | macOS 原生菜单栏 (Swift) + launchd 守护 + 只读 Streamable HTTP MCP | 业内最全 10 种 Plan 配额与 LiteLLM 价格表对齐、会话文件触及到 Git Commit 三级可信度归因、只读 MCP 9 大工具集暴露、4 槽 Agent 状态监控 API |

---

## 1. 深度对比矩阵

### 1.1 架构拓扑与运行时对比

| 维度 | Wake | Obelisk | Memmy Agent | planofplan |
|---|---|---|---|---|
| **进程结构** | 单进程桌面应用，后台线程扫描与索引，无常驻网络守护 | Electron 主进程 + 独立 Worker 线程执行索引 + 跨进程写锁仲裁 | Fastify 本地 API (动态端口) + Memory 服务 (:18960) + Gateway (:18970) + WebUI/WS (:18980) + Serve (:18990) + Electron | Bun 轻量后台守护进程 (监听 :9291) + Swift 原生常驻 Menubar 应用 + launchd 自愈托管 |
| **内存与资源** | ~30-60 MB，纯原生无 Web 引擎开销 | ~200-400 MB (Electron 多进程) | ~400-800 MB (Electron + Node 多个常驻微服务) | ~35-50 MB (Bun 守护进程) + ~25 MB (Swift 原生菜单栏) |
| **Agent 接入方式** | 严格只读外部文件，零侵入，绝不写任何 Agent 目录 | 只读外部文件，提供供 Agent 读取的 CLI 和 MCP Skill | 混合模式：历史可只读扫描，但实时依赖向各 Agent 写入 Hook/Plugin/Skill | 纯只读扫描外部会话日志，提供统一只读 Streamable HTTP MCP 服务供外部 Agent 消费，提供可选 Git Hook 写入 commit trailer |
| **多 Agent 覆盖度** | 14 家 (含 Cursor, Claude, Codex, OpenCode, Qoder, Gemini, DeepSeek Harness 等) | 4 家 (Claude, Codex, Kimi, Pi) | 9 家 (Cursor, Claude, Codex, OpenCode, OpenClaw, Hermes, WorkBuddy, Pi, qwenwork) + 自发现 | 10 家 (Claude, Codex, OpenCode, Amp, Cursor, Grok, Kimi, ZCode, Factory, DeepSeek) |

### 1.2 数据模型与抽象分层对比

| 维度 | Wake | Obelisk | Memmy Agent | planofplan |
|---|---|---|---|---|
| **核心数据实体** | `Session`（平铺元数据，按 cwd 目录推断） | `Session` -> `Message` -> `ToolCall` -> `Subagent` -> `Workflow` -> `Memory` | `L1 Trace` -> `L2 Policy` -> `L3 World Model` -> `Skill` | `SessionRecord` + `SessionRepo` (三维角色: work/touch/commit) + `Requirement` + `Usage` |
| **消息正文存储** | 不落库，渲染时按需从原 JSONL 读取解析并做 Tree-sitter 高亮 | 落库进入 `messages` 表，入库即做递归长度截断，带 FTS5 虚表 | 落库进入 `L1 Trace`，入库截断（4000/2000字，回合≤2MiB），向量化与反思打分 | 原生日志不落库（L0 严格不可变），元数据与归属落库，阅读时按需流式读取并做安全截断 |
| **信封噪音处理** | 正则与结构识别跳过非用户输入 | 显式打标 `is_meta=1` 与三态 `visibility`（visible/inactive/hidden），查询层默认排除 | 清洗脱敏 Base64 与大附件，意图门控区分任务与闲聊 | 信封过滤与启发式标题抽取，用户元数据与墓碑防复活三道闸 |
| **Git / 项目概念** | 仅按工作目录（cwd）展示，无 Git 仓库概念，无 Commit 概念 | 从消息 cwd 多数投票推断 project_path，无 Git 归属概念 | 按 workspace 组织，无代码提交归因概念 | **核心强项**：Git Remote URL 作为项目唯一身份，work/touch/commit 三维证据分级（`declared > observed > candidate`），Commit 动机完整归因 |

### 1.3 检索、智能与演化机制对比

| 维度 | Wake | Obelisk | Memmy Agent | planofplan |
|---|---|---|---|---|
| **搜索机制** | SQLite FTS5 Trigram 分词器，秒级中文与代码子串搜索，结果精确定位高亮 | SQLite FTS5 全文搜索 + JS 沙箱过滤表达式 | **6 通道融合检索**：`vec_summary`, `vec_action`, `vec`, `fts`, `pattern`, `structural` + RRF + MMR + LLM 终审 | 目录/标题/Repo 属性快速索引，实时内存匹配与流式正文检索 |
| **经验与记忆演化** | 无认知记忆，纯检索工具 | 显式单次提炼：Agent 提议、用户批准后写入 Markdown 沉淀至 memories 表 | **全自动 RL 认知演化**：Episode 结算、$\gamma,\lambda,\delta$ 信用反向传播、L2 归纳、L3 场域聚类、Skill 结晶化、Dream 整理 | 意图与动机增量精炼（`refined_text`），保留原话永不覆写，生成谱系周报 |
| **面向 Agent 的消费** | 无，纯人类使用 | 提供 `obelisk --query` CLI 与 Agent Skill，供 Agent 查询历史 | 提供 Memory HTTP API、OpenAI 兼容端点、Composio MCP | **标准化只读 MCP**：通过 HTTP/SSE 暴露 9 大工具，直接提供给任意符合 MCP 标准的智能体 |

---

## 2. 各系统长板、短板与陷阱深度剖析

### 2.1 Wake：极致的本地查阅工具，但止步于“阅读器”
- **长板**：
  - 启动速度极快，Rust + GPUI 渲染极其流畅，设计感极强（对标 Things / Bear）；
  - 坚持对原文件只读、索引随时可重建的干净哲学；
  - 搜索命中直达消息行并高亮（seq 契约），排版与气泡体验是业界天花板。
- **短板与盲区**：
  - 缺乏业务数据层：没有 Git 归属，不知道代码提交到了哪里，不知道会话产出了什么价值；
  - 纯人类 UI，没有暴露给 Agent 调用的接口（无 MCP、无开放 API），Agent 无法从 Wake 受益。

### 2.2 Obelisk：优秀的消息级拓扑与噪音过滤，但缺乏成本与代码维度
- **长板**：
  - 将非结构化的 JSONL 真正还原成了关系型消息网络（Message、ToolCall、Subagent、Workflow），层级严密；
  - 数据层沉淀 `is_meta` 与 `visibility` 标记，彻底在查询底层屏蔽掉命令信封和废弃分支的干扰；
  - Agent 可通过 JS 沙箱自查历史（如“上一次 auth bug 改了哪个文件”）。
- **短板与盲区**：
  - 依旧没有 Git Repo 概念，把“目录”当作“项目”；
  - 完全缺失配额监控与 Token 成本概念；
  - Electron 架构资源开销大，未实现轻量级常驻。

### 2.3 Memmy Agent：顶级的认知演化与伴侣设计，但运行时过重且侵入性高
- **长板**：
  - 记忆科学体系非常健全，四层分层模型（L1-L3/Skill）和 6 通道检索（RRF+MMR）代表了目前 Agent 长期记忆的最高水平；
  - 桌宠（Pet）模式的设计非常惊艳，透明小窗、热区感知、Mini 任务列表与语音 ASR 让 Agent 的交互从冷冰冰的 IDE 延伸到了桌面。
- **短板与陷阱**：
  - **侵入性过高**：通过 Hook 和插件强行注入宿主 Agent，一旦宿主更新（如 Cursor 或 Claude Code 改版），Hook 极易失效报错；
  - **微服务架构过重**：多个 Node 进程、多个开放端口、重型 Electron，长时间运行对开发者机器造成持续负担；
  - **缺乏成本与代码归因**：完全不关心开发者用了多少 Token、花了多少钱、改动了哪个 Commit。

### 2.4 planofplan：不可替代的成本与代码中枢，亟需补齐正文检索与经验输出
- **我们的核心护城河**：
  - **独一无二的双轨设计**：唯一一个把「多 Plan 额度监控/Token 成本」与「跨 Agent 会话/Git Commit 归因」完全打通的系统；
  - **三维 Git 归属与 Commit 因果动机链**：业界最精准的 Project 定义（Git URL），严格区分 work/touch/commit，真正能回答“这个 Commit 是哪个 Agent 为了什么需求写出来的”；
  - **极简极轻的原生守护**：Swift 原生菜单栏 + Bun 单二进制，不消耗 CPU，启动只需几十毫秒；
  - **标准的只读 MCP 面向全生态赋能**：任何外部 Agent 都可以直接挂载 planofplan 的 9 大工具。
- **我们的当前薄弱项**：
  - **消息正文未建全局 FTS 索引**：目前主要按 Session 目录检索，跨 Session 搜正文仍依赖临时按需解析；
  - **缺乏经验沉淀产出**：记录了海量 Commit 动机和文件修改，但未把高价值经验提炼成轻量知识库供 Agent 再次消费；
  - **桌宠能力只有数据输出端**：提供了 `/api/agent-status`，但尚未拥有属于自己的原生桌宠伴侣或更丰富的桌面感知展示。

---

## 3. planofplan 的战略取舍：我们要什么，坚决不要什么

```
                                  [planofplan 战略定位]
                                            │
           ┌────────────────────────────────┴────────────────────────────────┐
           ▼                                                                 ▼
    【坚决做深的核心护城河】                                            【坚决不碰的技术陷阱】
 1. 多 Plan 配额调度与价格表穿透 (M1)                            1. 拒绝侵入式修改宿主 Agent (零 Hook 注入)
 2. Git 三维归属与 Commit 动机归因 (M2/M3)                       2. 拒绝臃肿的 Electron 微服务全家桶
 3. 原生常驻架构 (Swift Menubar + Bun Daemon)                    3. 拒绝不可靠的黑盒重型强化学习演化
 4. 只读安全的 Streamable HTTP MCP (M4)                          4. 拒绝破坏性覆写原生 L0 日志
```

### 抄什么（学习吸收）：
1. **吸收 Wake / Obelisk 的消息级 FTS5 引擎与信封过滤**：
   在现有的 `~/.planofplan/index.db` 中建立增量消息全文索引表，引入 `is_meta` 标记，让开发者和 Agent 都能秒级全文搜索历史会话中的代码片段与对话。
2. **吸收 Obelisk 的 Agent 历史自查沙箱思想**：
   增强现有 MCP 工具集，让外部 Coding Agent 能够精准自查“过去针对当前 Git Repo 讨论过哪些架构设计、修改过哪些文件”。
3. **吸收 Memmy Agent 的轻量经验卡片（Lightweight Policy）**：
   不搞复杂的动态 RL 信用反向传播，而是基于 planofplan 独有的 **“Git Commit + 需求动机 + 踩坑触碰”** 闭环，自动生成高质量的项目避坑经验卡片，并通过 MCP 注入给写代码的 Agent。
4. **赋能桌面桌宠生态**：
   深耕 4 槽位 `/api/agent-status`，为自研轻量原生桌宠或第三方桌宠（如 Memmy 桌宠、硬件 moyu-badge）提供零延迟的 Agent 运行态感知。

---

## 4. 全局 Milestone 演进蓝图与分阶段规划

基于当前 M1–M6 的完成状态，规划更高层级的 **M7** 与 **M8** 里程碑：

```
[PROJECT] INV-158: fakechris/planofplan
  │
  ├── [MILESTONE] INV-159: M1 额度监控与多 Plan 配额底座 (Completed / In Review)
  ├── [MILESTONE] INV-160: M2 工作谱系与会话多源索引引擎 (Completed / In Review)
  ├── [MILESTONE] INV-161: M3 需求抽取与 Commit 动机归因链 (Completed / In Review)
  ├── [MILESTONE] INV-162: M4 只读 MCP 互操作与 Agent 状态消费面 (Completed / In Review)
  ├── [MILESTONE] INV-163: M5 macOS 原生菜单栏与常驻守护系统 (Completed / In Review)
  ├── [MILESTONE] INV-164: M6 便携单二进制打包与免环境部署 (Backlog / Ready)
  │     ├── [ISSUE] INV-207: 单二进制打包与静态资源内嵌
  │     └── [ISSUE] INV-208: 免 Bun 环境的独立 App Bundle 与 launchd 自包含配置
  │
  ├── [MILESTONE] (Proposed) M7 跨 Agent 消息级内容检索与上下文交接引擎
  │     ├── [ISSUE] M7-1: SQLite FTS5 消息级增量全文索引与信封过滤清洗
  │     ├── [ISSUE] M7-2: 搜索命中精准代码行高亮与跨 Agent 会话定位协议
  │     └── [ISSUE] M7-3: 跨 Agent 需求意图打包与一键上下文交接 (Handoff) 机制
  │
  └── [MILESTONE] (Proposed) M8 研发经验图谱合成与外部伴侣感知消费
        ├── [ISSUE] M8-1: 基于 Commit 归因闭环的项目级避坑经验（Policy）自动提炼
        ├── [ISSUE] M8-2: 研发经验图谱向 MCP 工具链（knowledge query）只读投递
        └── [ISSUE] M8-3: 4 槽 Agent 状态总线与桌面伴侣（DeskPet/硬件徽章）双向感知联动
```

---

## 5. 近期任务分解与执行排期 (Near-Term Breakdown)

近期最关键的工作分为两步走：**收口 M6（便携打包）** 与 **启动 M7（消息级 FTS 与 Handoff）**：

### 阶段一：M6 独立免环境单二进制闭环 (当前紧迫度最高)
- **目标**：彻底摆脱对本地 Bun 环境的依赖，实现双击 `/Applications/planofplan.app` 直接自包含启动 daemon 与菜单栏。
- **拆解子任务**：
  1. `bun build --compile` 静态编译 `planofplan-daemon`，内置静态资源；
  2. Swift 原生应用检测 Bundle 内嵌二进制并直接拉起，移除外部 projectRoot 依赖；
  3. 完善 `scripts/build-menubar.sh` 生成自包含 DMG / Zip 安装包。

### 阶段二：M7-1 消息级增量 FTS5 索引与信封过滤 (核心体验升级)
- **目标**：在保持只读底线前提下，将会话正文纳入 `~/.planofplan/index.db` 的 FTS5 全文检索。
- **拆解子任务**：
  1. 扩展 Schema：新增 `session_messages` 与 `messages_fts` 虚表；
  2. 增量扫描优化：利用现有的 mtime + 行级游标，仅在检测到增量行时追加消息；
  3. 信封噪音过滤：引入 `is_meta` 判定，清洗命令信封、系统注入词与大段 Base64；
  4. 检索 API 与 MCP 联动：增强 `/api/session-search` 与 `session_search` MCP 工具，支持正文关键词匹配。
