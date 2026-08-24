# planofplan 信息架构重设计:实体模型与视图

> 2026-08-23。起因:对话页把「目录」和「项目」混为一个维度,用户意图和
> agent 派生行为在视图上分不开。先做数据模型抽象,再谈界面。
> 调研依据:docs/obelisk-ia-research.md、docs/obelisk-session-research.md、
> dsh-track(dsh-involute)本体、Wake、Conductor/Vibe Kanban/OpenCode/Codex/
> Devin/catchup/pickup 等业界调研(2026-08,要点已并入本文)。

## 0. 现状问题

1. **目录与项目不分**:session 的 cwd(目录)和它触碰的 git repo(项目)
   被压成同一个「项目」维度。用户有时想按目录看(我在这个文件夹下干过
   什么),有时想按 repo 看(这个项目上有哪些活动),当前模型分不开。
   业界对照:obelisk/Wake 干脆只有目录没有 repo;Conductor 干脆只有 repo
   没有目录——两种偏科都被用户骂过,两个维度都要,但必须分开。
2. **意图与派生不分**:图谱/列表里用户的需求、subagent 的派工 prompt、
   插件拉起的 review 调用混在一起。origin 归因(1802397)已在数据层
   解决,但需求实体本身还没有 origin 分级。
3. **「项目 → 哪些 agent 活动过」视角缺位**:obelisk 没有这个视角,
   Wake 只能靠逐行扫品牌图标,业界管理类产品只看得到自己发起的
   session。这是我们的差异化空档,数据已经齐了,缺一个一等视图。
4. **handoff 缺位**:用户的真实工作流是「找到一个需求 → 要一份交接 →
   到别处执行」。业界 2026 年形态已收敛(Devin 本地→云、Codex App
   本地↔SSH、catchup/pickup 跨 agent = 会话→Markdown 摘要→注入新会话),
   我们有全量本地 session + 归因链,做这件事边际成本最低。

## 1. 实体模型(v2)

七个一等/二等实体,证据分级贯穿全部:`declared > observed > candidate`。

### 1.1 Directory(目录)— 一等过滤维度,不是归属

- 定义:session 的 cwd,物理工作位置。
- 语义:「我在这个文件夹下开过哪些会」。一棵树(按路径前缀聚合),
  不做跨目录归并。
- 反例纪律(dsh-track 踩过的坑):目录 ≠ 项目。`~/source/dsh/explorer`
  里可能同时操作多个 repo;一个 repo 也可能从多个目录进入(worktree、
  symlink)。

### 1.2 Project(项目)— 一等实体,身份 = git remote URL

- 身份:remote origin URL;无 remote 退化为 repo root path。
  id = 确定性 hash(url)(dsh-track 同款,幂等)。
- 与 session 多对多,三种边已在库:work( cwd 落在这个 repo)/ touch
  (工具调用碰了它的文件)/ commit(产出落在这里)。
- 聚合字段:参与的 agent 集合、活跃时段、需求数、commit 数。

### 1.3 Agent — 一等 facet

- provider(claude/codex/kimi/…)+ 细分身份:originator(如
  'Claude Code' 插件)、codex 子代理的 nickname/role(Ramanujan/
  explorer…)。不是表,是 session 上的可聚合维度。

### 1.4 Session — 保持现状,两处增强

- 已有:origin(user/subagent/plugin:claude/exec/herdr)、parent_id
  (codex 子代理挂父)。
- 增强:claude subagent 也需要 parent 链接(现在只有 codex 有);
  来源文件路径 `<parent-uuid>/subagents/agent-*.jsonl` 里父 id 是
  现成的,补上即可。

### 1.4b Launch(启动)— 新一等关系:谁拉起了这个 session

origin 字段只回答了「启动的性质」,没回答「启动方是谁」。把启动方
建模为关系边 `session --spawned-by--> 启动方`,启动方三类:

- **另一个 session**(session 级):codex 子代理挂父 codex(已有
  parent_id);claude 插件拉起的 codex(plugin:claude)回链到发起它
  的 claude session——**这条边可以做到 declared 级**:claude 的
  tool_use 入参(Bash 调 `codex exec "Review the diff of commit…"`)
  在 session_messages 里,codex session 的首条用户消息是同一个
  prompt,文本对上即确定;对不上退 candidate(时间窗 + cwd)。
- **环境**(environment 级):herdr pane(pane id + 日志事件,
  candidate 级)、tmux、CI。有 identity 但不参与归因链主线。
- **用户直接启动**(user):无边,缺省态。

存储:通用 session↔session 边表 `session_links(from, to, kind,
evidence_kind)`,kind 首值 `spawned-by`;codex 的 parent_id 保留
(扫描期现成),查询层把两者统一成同一关系视图。环境型启动方存
`origin_detail`(如 `herdr:pane:10`),不进边表。

价值:需求页/项目页可以回答「这个 review 调用是谁发起的」并顺着
边跳回发起会话——agent 行为跟踪的派生树(claude → codexreview →
codex subagent → …)由此闭合。

### 1.5 Requirement(需求)— 从字段升级为实体

现在是 /api/sessions 里的一个字符串字段,升级为:

- **origin 分级**(dsh-track 词汇表,invariant:agent 提议永远低一等):
  `user_explicit`(用户原话)> `user_confirmed`(用户批准了提议)>
  `agent_proposed`(模型提议)> `system_inferred`(规则推断)。
  当前 motivation.ts 的抽取全部落 `system_inferred`/`user_explicit` 两档
  (直接取用户消息原文的是 explicit;从 meta 信封推断的是 inferred)。
- **意图分类**(v2 sync 的概念):用户消息分 requirement(有可验收
  交付物)/ directive(执行步骤:commit、restart、装依赖)/
  interruption(纠正)。只有 requirement 建实体;directive 和
  interruption 留在消息层。v1 先做规则分类,不上 LLM judge。
- **项目归属按 span,不按 session**(dsh-track 用缺陷换来的教训):
  一个 session 触多个 repo 时,需求归哪个项目看该需求的证据窗口
  (它自己引发的那段对话里 tool call 实际碰的 repo),不是 session 的
  第一个 repo。我们有 session_file_touches 的 ordinal,可以做同样
  的 seq 窗口归因。
- **状态机是后话**:dsh-track 的双轨制(inferred vs state,done 永不
  自动、模型自荐 done 权重为 0)是成熟答案,等需求实体稳定后再接。

### 1.6 FileTouch / Commit — 保持现状

归因链已有的两环,不动。

### 1.7 Handoff(交接)— 新实体,形态 = 指针 + 摘要,不是搬运

dsh-track 的答案「不做上下文搬运,做可回溯的稳定指针」+ 业界收敛的
「markdown 摘要注入新会话」合成我们的形态:

- 从 session 或 requirement 一键生成 **handoff 包**(markdown):
  动机原文、涉及文件(touch 聚合)、产出 commit(带 pushed 状态)、
  相关子代理摘要、deep link 回 planofplan 详情。
- 交付方式:复制到剪贴板 / 导出 .md / 直接在目标目录起一个新 agent
  会话并把包作为首条消息(各家 CLI 都支持 -p / stdin 注入,逐家适配
  和 resume 同一套机制)。
- 数据上 handoff 是一次导出动作,落一条记录(谁、从哪个 session/
  需求、到哪、何时),让「交接链」本身也可观测。

## 2. 视图设计

四个视图 + 一个动作,对应用户的查找维度。

### 2.1 项目页(新,一等)— 回答「这个项目上有哪些 agent 干过什么」

- 项目列表(按最近活跃)→ 项目详情:
  - **agent × 活动矩阵**:横轴 agent(claude/codex/…,细分身份可展开),
    纵轴时间/活跃度;一眼看出「pinboard 主要是 claude 在写,codex 只
    做过 review」。
  - 需求流(该项目的 requirement,按 origin 分级着色)
  - 产出 commit(landed-in,实点/空心点沿用现有语义)
  - session 时间线(可折叠 subagent)

### 2.2 对话页(改造)— 目录和项目拆开,派生折叠

- 过滤栏:**目录**(前缀树单选)和**项目**(repo 单选)是两个独立
  下拉,互不吞并;agent、origin(显示自动化)保持现有开关。
- 列表:**subagent 折叠在父 session 下**(Wake/OpenCode/Claude Code
  的业界共识:子代理默认不进主列表,但不是删除——作为父 session 的
  可展开子行,带 origin 徽标)。plugin/exec 会话默认隐藏(现状保持)。
- 计数与过滤口径一致(c8ed083 已修)。

### 2.3 需求页(新)— 独立于 session 的浏览维度

- 全部 requirement 的列表/看板,过滤:项目、agent、origin 分级、
  意图分类(requirement/directive/interruption)。
- 每条需求可下钻:源 session(高亮原话)→ 文件 → commit。
- 每条需求有「生成交接」动作(2.5)。

### 2.4 图谱页(保留)— 关系总览

保持现有三层列式,数据语义随实体模型升级(requirement 节点带
origin 分级着色)。

### 2.5 交接(动作,不是页面)

session 详情 + 需求详情都放「交接」按钮 → handoff 包预览 →
复制/导出/起新会话三选一。

## 3. 落地顺序(每步独立可用)

1. **Project 实体化 + 项目页**:projects 表(url hash id)+ 项目列表/
   详情 API + 项目页 UI。数据全部现成(session_repos),纯聚合。
   —— 直接解决「项目 → 哪些 agent」的核心诉求。
2. **对话页目录/项目过滤拆分 + subagent 折叠 + Launch 边**:前端为主;
   claude subagent parent 链接补上;plugin:claude 回链(declared:
   prompt 文本对碰;candidate:时间窗+cwd)和 herdr pane 标识落
   session_links / origin_detail。
3. **Requirement 实体化**:requirements 表(origin 分级 + 意图规则
   分类 + span 级项目归因),需求页 UI。
4. **Handoff**:导出端点 + UI 按钮 + 逐家 agent 注入适配。

## 4. 明确不做的

- 不做双轨状态机/HITL 确认(dsh-track 的答案,等我们需求实体稳定后
  再评,不超前)。
- 不做上下文搬运式 handoff(整段 transcript 复制注入)——dsh-track
  论证过指针优于搬运;我们只做摘要包 + deep link。
- 不做 LLM 意图 judge v1——规则分类先行(dsh-track 教训:模型自发
  纪律不可靠,capture 自发率 1/148)。
- 不做 agent 间实时通信/编排(Conductor/Vibe Kanban 的领域,我们是
  观测层)。
