# Agent 计划态与进展态的结构化利用:本地数据摸底 + 业界与论文调研

> 2026-08-24。问题来自实际使用:① planning-with-files 产生的 plan 数据怎么
> 结构化利用;② agent 干完活后的总结(做了什么/还差什么)怎么抽取、索引、
> 利用——且这个状态是**演进**的;③ 业界项目/最佳实践/论文有哪些。
> 方法:本机数据一手摸底(§1)+ 三路网络调研(§2-§4,一手来源优先,
> 配额受限处已标注)+ 对 planofplan 的建模建议(§5)。
> 关联:docs/ia-redesign.md(实体模型)、docs/work-graph-design.md
> (dsh-track 先例与教训:capture 自发率 1/148 → 离线抽取、不依赖 agent 自报)。

## 1. 本机数据摸底(一手)

结论先行:**计划态和进展态在本机已经以三种形态大量存在,且互相可以桥接**
——缺的不是数据,是解析和实体化。

### Layer A:plan 文件(计划态 + 文件化进展)

| 形态 | 来源/约定 | 实测 |
|---|---|---|
| `task_plan.md` | planning-with-files skill(Manus 风格,本机 v2.1.2) | 全盘 ≥10 处;`# Task Plan:` / `## Goal` / `## Current Phase: Phase N` / `### Phase` + checkbox `- [x]/- [ ]` + `**Status:** pending/in_progress/complete` |
| `progress.md` | 同上 | **就是"干完总结"的文件化**:`## Session: <日期>` → Phase → Status / Actions taken / Files modified |
| `findings.md` | 同上 | 研究产出沉淀 |
| `PLAN.md` / `docs/plans/*.plan.md` | obra 方法论约定(见 §2.1) | file_touches 里 22 个文件 / 31 个 session 触碰过 |
| `HANDOFF-*.md` | 社区 handoff 约定 + 本机 handoff skill | ~/.dsh 顶层多个、各 repo docs/ 散布(current state / next steps 结构) |
| backlog 类 | Backlog.md 等工具 | 本机少量 |

skill 的 hook 机制值得注意:PreToolUse 每次把 `task_plan.md` 头 30 行
**重新注入上下文**(对抗 lost-in-the-middle),PostToolUse 在 Write/Edit 后
提醒更新状态——这保证了文件与实际进度的耦合度,是我们能放心离线解析的
前提。

### Layer B:session 消息流里的结构态(演进快照)

- **TodoWrite 快照**(claude):`session_messages` 里 `role='tool'` 行,
  body 是纯 JSON `{"todos":[{content,status}]}`。**天然的时间序列状态**——
  每次调用即一个快照点。实测 51 个 session 有使用。
- **assistant 尾部总结**:自然语言,「已完成 X;当前 Y;现在 Z」句式。
  实测(30 天全库):`已完成*` 151 条、`下一步*` 35、`这一步*` 20、
  `剩余*` 18。inferred 级证据。
- **dsh capture_thought**:agent 自发率 1/148(dsh-track 实测),不可依赖,
  但被动产生的仍可解析。

### Layer C:桥数据(已就绪)

- `session_file_touches`:谁在何时碰过哪个 plan 文件(30 天窗口内
  task_plan.md 只有 2 个文件被碰——多数 plan 工作在窗口外或非 git 目录,
  说明**扫盘**比依赖 touches 回溯更全)。
- `session_commits`(外部验证信号)、`requirements`(挂靠锚点)、
  `session_links`(谁在推进)。

## 2. 业界对照:planning-with-files 与计划管理

### 2.1 谱系源头:plan 文件是持久工件,上下文是消耗品

- **obra(Jesse Vincent)方法论**(一手,2025-06):
  `docs/plans/somefeature.plan.md` 作为 agent 指令序列写入;**每个阶段
  /clear 清空上下文,新 session 靠读文件重建**;关键句:"please commit
  these changes and **update the planning doc with your current status**"
  ——plan 文件兼任状态日志,这就是问题②模式的源头。他还给出 spec 尺寸
  经验:"model 能在两小时内烧完的 spec" 最好。
  来源:blog.fsck.com/2025/06/24/my-agentic-coding-methodology-of-june-2025/
- **Manus**(一手,官方博客):核心即 `todo.md`——文件系统承载状态;
  上下文多处「复述」对抗遗忘;**方向变化时重构 todo.md 而非丢弃**
  (append-only 设计,保 KV-cache 前缀)。
- **Claude Code**:plan mode 产物默认留在会话内(可另存 markdown);
  TodoWrite 状态存 session JSONL(即 Layer B);compaction 官方文档明确
  生成 `<summary>` 块记录 "state, next steps, learnings" ——官方认可
  这三要素是延续工作的最小集。**没有**结构化 session summary 的官方
  schema(社区 issue #6907 在要)。
- **Codex**:`final_answer` phase 收尾;`--output-last-message` 落盘。

### 2.2 计划/任务的结构化管理工具

| 工具 | 数据模型 | 状态语义 | 对我们的启示 |
|---|---|---|---|
| spec-kit(github) | `/constitution→/specify→/clarify→/plan→/tasks→/implement`,每阶段产物是**可 review 的 markdown 文件**,spec-approve 是 CI 校验 | 阶段即门 | 计划文件有固定 schema(tasks.md checkbox) |
| task-master | parse-prd 生成任务后**强制人工审查**依赖再执行 | pending/in-progress/done + 依赖图 | HITL 门是共识 |
| Backlog.md(一手) | `backlog/tasks/*.md`,TASK-N id,含 acceptance criteria / DoD checklist / milestones / deps;CLI+MCP+Web 三入口,`--json` 稳定输出;完成态永久留 git | To Do 等列 | 「一 task 一上下文一 PR」;markdown 即 DB |
| Conductor.build | 并行 Claude/Codex/Cursor + 隔离 worktree + "see at a glance what they're working on"(细节未取到,配额限制) | — | worktree = 我们的 Directory/launch 数据已有 |

### 2.3 观测平台(空白确认)

LangSmith(trace/span 树 + trajectory evals)、AgentOps(SESSION 根
span)、W&B Weave(Op→Call 带 summary dict)、Braintrust(OTel span)
——**四家全部是事件/span 级模型,没有任务级 done/remaining/next 聚合
视图**。跨 session 的计划/进展聚合是空白,是 planofplan 的差异化位置。

## 3. 自报状态的可信度(问题②的核心风险)

- **Agent-Diff 基准**:提出 "outcome hallucination"(agent 虚假声称完成)。
- **METR**(2026-06):frontier model 会为了隐藏未完成任务对用户说谎
  (reward hacking),且**模型往往自知**。
- **LLMs Cannot Self-Correct Reasoning Yet**(2310.01798):无外部反馈时
  自纠常把对改错。
- **Just Ask for Calibration**(2305.14975):口头报告的置信度比 token
  概率更校准——进展状态可带置信度字段,展示端可信。
- 共识做法:spec-kit / task-master / simi.studio 都强调**用外部状态
  (state-diff、测试)对账自报**,与我们 evidence_kind 词汇表天然对齐。

## 4. 论文谱系(对「从 session 日志提炼计划/进展」的启示)

| 方向 | 代表作 | 一句话启示 |
|---|---|---|
| 轨迹→可复用知识 | Reflexion 2303.11366 / Voyager 2305.16291 / ExpeL 2308.10144 / **AWM 2409.07429** / Memento 2508.16153 | 跨 session 挖重复 workflow 是 dashboard 的长期卖点;失败→重述片段本身是高价值信号 |
| 计划显式化与监控 | LLM+P 2304.11477 / HuggingGPT 2303.17580 / ADaPT 2311.05772 | 计划应是与 LLM 解耦的结构化对象;**计划粒度突然加深处 = 卡点** |
| 记忆分层 | MemGPT 2310.08560 / 综述 2404.13501 / 2512.13564 / Episodic 2502.06975 | episodic(原始轨迹)与 semantic(提炼规律)两层并存——我们的库=episodic,聚合视图=semantic |
| 轨迹即资产 | SWE-RL 2502.18449 / SWE-rebench 2505.20411(80k 开源轨迹) | 结构化清洗后的轨迹可输出为评测/训练数据产品 |

## 4.5 先例对照:thin-observer(~/workspace/thin-observer,2026-04)

> 本机已有的先行实验:Go 写的**被动观察者**,watch plan/todo/progress.md →
> 快照 → 启发式推任务身份+谱系 → kanban + time machine + recap。22 小时
> dogfood 后停用,但其架构决策和实测数据对本文结论是直接校准。

**架构决策(归档 PRD 的否决理由,docs/archived-prd-…/REASONS-ARCHIVED.md)**:
更早的 PRD 提过跨 agent 协作协议(planctl CLI + MCP + `[T-xx]` 稳定引用
+ skills 分发),被自己否决,四条理由:① 核心假设脆弱(「agent 会可靠
调 CLI 并保住 [T-xx]」不成立);② 三个真相源(markdown/planctl json/
board 缓存)的弱一致性问题;③ 与八家 agent 的 hook 生态强耦合;④ 从
「被动观察」原始研究膨胀了 ~100 倍范围。**与 dsh-track 的 1/148 教训
同源,再次验证观察者侧路线。**

**值得照搬的 schema 件**(internal/store/schema.sql):
- `plan_doc`:每文件一行,kind 分类(task_plan/progress/findings/
  detailed_plan/unknown)+ `missing_since` 生命周期(文件消失不清历史)
- `snapshot`:append-only,`raw_hash` + `phases_json` + **`commit_sha`**
  (快照时刻的 git 锚——verified 对账的天然挂点)
- `task_revision`:append-only 的逐快照任务态,专门为 time machine 回放
- **`override` 表**:观察者侧人工纠错(same_as/split_from/merged_from/
  drop/reopen/rename),永不动 agent 的 markdown——HITL 分层的一等实现
- `plan_link`:从 markdown 里抽跨文档引用
- 五 pass 纯函数谱系推断器(exact→alias→Levenshtein rename→split→merge,
  带 confidence)

**实测结果(教训本体)**:`~/.local/state/thin-observer/db.sqlite`,9 项目
34 worktree,847 快照,跑了一个 ~22 小时窗口(04-21→04-22)后停用:
`task_created 18100` vs `task_updated 22`——**跨快照身份匹配失败率
~99.9%**,留下 17778 个僵尸 pending 任务。真实 agent 改写 plan 时标题/
结构/顺序全变,启发式兜不住;「done」只有 314。结论:**任务级身份推断
在 v1 不做**——这不是能力问题,是被 22 小时真实数据证伪过的路线。

**对 §5 的三点修正**:
1. 身份只锚 PlanFile(文件级),连「当前任务列表」都不维护成可变行,
   只存逐快照状态;他们的 task 活行 + revision 双写正是为补活行失真
   的坑。谱系(renamed/split/merge)整体后置,若做必须带 confidence
   + override 表(照搬其设计)。
2. 停用的另一半原因是**独立工具成本**:独立配置、独立看板、多一个要
   打开的窗口。planofplan 已有 session/归因层与高频打开的 dashboard,
   plan 文件观察应折进来,补 thin-observer 缺的两块:谁在推进
   (session/touches 归因)和需求/commit 边。
3. `recap` 命令(plain-text 回顾,管道给下一个 agent)是 Handoff v0 的
   既有实证,第 4 步设计可直接参考 internal/recap。

## 5. 对 planofplan 的建模建议

### 5.1 实体设计:两个新实体,一条新边,复用全部旧边

```
PlanFile(身份 = 文件路径,像 Project 一样扫盘物化)
  ├─ plan_snapshots(append-only:每次解析存一份,时间序列 = 演进态)
  │    goal / phases[] {name, status, checkboxes{x,total}} / current_phase
  ├─ 解析器:task_plan.md(skill 模板,最规整)→ PLAN.md/plan.md
  │    (obra 约定,frontmatter+阶段)→ backlog/(Backlog.md)→ 兜底弱解析
  └─ 边:session --wrote--> PlanFile(file_touches 已有,declared)
         requirement --planned-via--> PlanFile(span 内触碰,observed)

ProgressNote(进展快照,两个来源分档)
  ├─ file-declared:progress.md 的 Session 节 / HANDOFF-*.md
  │    (结构:done[] / remaining[] / next)——declared 级
  ├─ message-inferred:TodoWrite JSON 快照(结构化,todo 序列)
  │    + assistant 尾总结规则抽取(inferred 级)
  └─ 边:session --reported--> ProgressNote
         ProgressNote --about--> PlanFile / requirement
         ProgressNote --verified-by--> commit(对账,见 5.3)
```

要点:
- **演进 = append-only 快照序列,不做状态机推断,也不做任务级身份**
  (thin-observer 22 小时实测:任务身份跨快照匹配失败 ~99.9%,见 §4.5)。
  dsh-track 双轨制的教训(inferred 永不自动改 state)在这里同样适用:
  我们只记录各时点的自报/文件状态,由视图做 timeline;"当前态" = 最新
  快照,永不由我们推。谱系推断(renamed/split/merged)若 v2 要做,必须
  带 confidence + 人工 override 表(照搬 thin-observer 的设计)。
- **PlanFile 而非 Plan**:身份锚在文件上(路径 + 内容 hash),跨 session
  稳定;「计划」的语义解析是文件之上的视图。这继承了 Project = url 的
  身份纪律,也继承 thin-observer 的 plan_doc 模型(kind 分类 +
  missing_since 生命周期)。
- TodoWrite 快照是最便宜的演进数据:已在库里,只差一个 pass。

### 5.2 状态可信分级(对齐 evidence_kind 与 §3 结论)

`self_reported`(TodoWrite/尾总结/progress.md)< `file_persisted`
(task_plan.md 的 checkbox) < `verified`(快照声称完成 ∧ span 内存在
对应 commit/测试通过)。UI 上 done 打 ●/○,「自称完成但无 commit 佐证」
标黄——这是业界没人做的对账视图。

### 5.3 v1 落地顺序(按性价比)

1. **TodoWrite 快照抽取**(纯库内,一个 pass + 一张表,最便宜)
2. **PlanFile 扫盘物化 + task_plan.md 解析**(模板规整,解析器 <100 行;
   快照表挂 mtime + raw_hash + commit_sha——后两者照搬 thin-observer)
3. **progress.md / HANDOFF 解析**(declared 级 ProgressNote)
4. **尾总结规则抽取**(踩需求分类同样的迭代路:先保守,图谱/详情先吃)
5. **对账视图**(done vs commit,后置)

与 IA 步骤的关系:这组实体是第 4 步 Handoff 的**直接原料**(handoff 包
= 最新 PlanFile 快照 + 最新 ProgressNote + commit 列表 + deep link;
形态参考 thin-observer 的 recap 命令),建议第 4 步与其合并设计。

## 6. 来源清单

一手:obra blog.fsck.com(2025-06-24 方法论;2026 agentic patterns)、
Manus 官方博客(Context Engineering)、docs.devin.ai(progress/Session
Insights)、platform.claude.com(compaction)、developers.openai.com
cookbook(codex)、github/spec-kit、docs.task-master.dev、
github.com/MrLesk/Backlog.md、conductor.build(仅定位页)。
论文:arxiv 2303.11366 / 2305.16291 / 2308.10144 / 2409.07429 /
2508.16153 / 2304.11477 / 2303.17580 / 2311.05772 / 2502.01390 /
2310.08560 / 2404.13501 / 2512.13564 / 2502.06975 / 2310.01798 /
2305.14975 / 2502.18449 / 2504.07164 / 2505.20411 / 2507.01701。
受限:WebSearch 配额 8-31 恢复;Conductor 细节、Backlog.md 完整状态枚举
未验证到文档级,已标注。观测平台四家为二手确认(官方 docs 路径在调研
记录中)。
