# Obelisk 信息架构调研：目录/项目/agent 维度与导航设计

> 源码取证:/tmp/obelisk(main,1248352)。面向 planofplan「对话/项目/需求」视图重设计的五个特定问题。每条注明出处。

## 1. 目录(cwd/workspace)与项目(git repo)在数据模型里是分开的概念吗？

**不是分开的。obelisk 根本没有 git repo 实体。** 它只有"目录"一个概念，分两层存储：

- `sessions.project TEXT`:Claude Code 目录名的 dash 编码 slug(如 `-Users-chris-workspace-planofplan`),直接取自 transcript 文件路径(`packages/core/src/schema.sql:6`;发现逻辑 `packages/core/src/parsing.ts:184-190` 把目录名原样作为 project)。
- `sessions.project_path TEXT`:从消息里的 cwd 观测值**多数投票**推断的真实路径(`packages/core/src/indexer.ts:59-73` `refreshSessionProjectPaths`;`packages/core/src/parsing.ts:154-165` `inferProjectPath` —— 按出现次数最多的 cwd 胜出，取不到时回退 slug 解码)。
- git 在 schema 里只有 `git_branch TEXT` 一个字符串(`schema.sql:7`),**没有 repo url/root/归属**。obelisk 世界线里"项目 = 工作目录",不存在 planofplan 的 work/touch/commit 三维 git 归属。

UI 呈现：列表行显示项目标签，标签文案用 `formatProjectLabel(slug)` —— 找该 slug 下最短的 project_path 取最后一段(即目录 basename,`app/src/renderer/src/utils.js:164-176`);SessionDetail 头部直接展示完整 `project_path`(`app/src/renderer/src/views/SessionDetail.vue:495`)。过滤侧栏用的也是 slug(`app/src/renderer/src/sidebar-projects.mjs:4-7` `countByProject`)。

## 2. 导航维度：主界面按什么组织？有没有「项目 → 哪些 agent 活动过」视角？

**主轴是项目，agent(source)只是过滤器，不是导航实体。**

- 左侧栏：**项目列表**(slug + 计数),`App.vue:50-68` 调 `buildSidebarProjects`,按 session 数排序，另有"噪音项目"(session ≤1 且名字像随机目录)折叠区(`App.vue:63-64`)。侧栏同时服务 sessions 和 memory 两个路由(`sidebar-projects.mjs:38-46` 按 routeType 切换计数对象)。
- 主区：**session 列表**按时间倒排，行内只有 年龄石条 + 标题 + 项目标签 + msg 数 + 时间(`SessionList.vue:150-170`)。**行内没有 agent/provider 徽标** —— grep 全文件,`s.source` 只出现在过滤逻辑里(`SessionList.vue:29`),不渲染。
- agent 维度只有一个全局 source 下拉(`store.js:19` `sourceFilter`;`App.vue:234-241` 标签如 "All sources / Claude Code / Codex …"),以及 Activity 页的 usage 统计(`Activity.vue:370` `getUsageStats({source:'all'})`,按 provider 出 token 曲线)。

**没有「项目 → 哪些 agent 活动过」的一等视角。** 最接近的形态是：选中项目后看 session 列表，每行隐式代表一个 agent 的活动，但行上不标 agent；想知道项目里各 agent 占比需要自己心算。project × agent 的交叉视图不存在。

## 3. Session 内部次级结构(turn/task/subagent)在 UI 上怎么展示？

**时间线平铺 + 卡片化折叠 + 点击钻取到独立页**，不是树。

- 主线是虚拟滚动的消息时间线(`SessionDetail.vue:518-542`),turn 没有折叠层级。
- **subagent**:时间线里渲染为一张内联卡片(agent 类型/描述 + agents 计数),点击卡片里的 agent 条目触发 `navigate-subagent` 事件(`components/SessionTimelineRow.vue:47-48, 94, 234-236, 273`),路由跳转 `/sessions/:id/subagent/:agentId` 到**独立的 SubagentDetail 页**(`views/SubagentDetail.vue:1-60`),该页把子代理的完整对话渲染成和主会话一样的消息流，顶部有返回。即：**主线上一个摘要卡，详情在二级页**,子代理之间不嵌套展示。
- **workflow**(Claude 的多 agent 工作流)是更强的结构：时间线里一张 workflow 卡，显示名字、agent 数、status 徽标，卡内**按 phase 分组列出各 agent**(`SessionTimelineRow.vue:74-106`,`standaloneWorkflowGroups`),每个 agent 同样可点击钻取。
- **meta 消息**(system 注入、命令信封，即我们说的"信封噪音"):默认**折叠**成一行 "System" + 80 字符预览，点击 disclosure 展开(`session-timeline-items.mjs:17-19` 判 `is_meta=1` → kind='meta';`SessionTimelineRow.vue:53-61`)。这是 obelisk 对「用户意图 vs 注入内容」的主要视觉区分。

## 4. Handoff / resume / 导出上下文

**没有 resume/handoff 功能。** grep 全仓库,resume/handoff 只出现在 provider 类型注释里，没有任何"恢复会话"或"把上下文交给别处执行"的入口。相关能力只有三个，性质不同：

- **原始行回源**:`raw(lookup)` 按消息 uuid 从原 JSONL 文件取回完整原始行(`packages/core/src/providers/claude.ts:398-434`),用于 UI 里"查看原始 JSON",是只读取证，不是打包导出。
- **Recap 卡片导出**：周/月报卡片的渲染导出(`views/RecapExport.vue`),面向**分享/展示**,数据是卡片文案不是上下文。
- **「生成指令」流转**:RecapList 页有一个复制按钮，复制的是 `/obelisk recap this week` 这类**给 agent 用的命令文本**(`views/RecapList.vue:55-75`,`navigator.clipboard.writeText`)——这是 obelisk 特色的「人 → agent」交接：不打包数据，打包**意图**(让 agent 自己去索引里检索)。
- **Memory 层**是最接近"上下文打包"的机制：agent 提议、用户批准后，把结论写成 markdown 文件并 `remember()` 注册(`skill-doc/SKILL.md` Memory Layer 节；`packages/core/src/query.ts` attune API),记忆带 `session_id` + `message_start/end` 锚点回链源会话(`schema.sql:72-76`;MemoryList 点击跳回源 session 并 focus 到锚点消息,`views/MemoryList.vue:90-94`)。打包的是**结论 + 锚点**,不是消息本体。

## 5. Requirement / 动机层：有没有类似概念？怎么区分「用户意图」vs「agent 派生行为」?

**没有 requirement/动机概念。** obelisk 的 session 第一级属性里没有"用户想干什么"的抽取；它区分意图与派生的手段全部在消息层：

- **`is_meta` 标记**:provider adapter 在解析时给消息打 `is_meta=1`(注入的 caveat、命令信封等控制面内容),查询层 `search()`/`thread()` 默认排除 meta(`skill-doc/SKILL.md` Core API 节;`packages/core/src/query.ts:101-115`),UI 折叠成 "System" 卡(见 Q3)。这是「这条内容不是用户意图」的机器可读标记。
- **`visibility` 三态**(visible/inactive/hidden,ADR 0007):被取代的历史(branch/compaction)标 inactive，默认不出现在视图和查询里——区分「当前有效意图」vs「已被取代的过程」。
- **派生行为是一等结构**:subagent / workflow / workflow_agent 各成表(`schema.sql:23-34`),在 UI 上渲染为明确的卡片(见 Q3)——agent 派生活动有专属视觉容器，和用户消息泡区分。
- 标题侧：标题来自 `history.jsonl` 或 `ai-title` 记录(`providers/claude.ts:70-79, 299`),即**用 harness 自己生成的标题**,不做"从消息流抽需求"的二次推断;`isNoise`(无标题)session 折叠进 fold-banner(`SessionList.vue:53, 171-176`)。

## 对 planofplan 的启示

obelisk 和 planofplan 在信息架构上走了两条相反的路，值得对照着看：

1. **目录 vs git repo**:obelisk 证明「项目 = 目录」对单仓工作流足够简单好用(project_path 多数投票推断很务实);但 planofplan 的 work/touch/commit 三维 git 归属是真差异化——**我们的「项目」比 obelisk 的严格更准**(session 在 A 目录跑却改了 B 仓库的代码,obelisk 会归错项目，planofplan 不会)。重设计时应保留 git 归属为项目的主键，目录只作展示辅助。
2. **agent 维度缺位是 obelisk 的真实短板**:它的"项目→agents"只能靠肉眼数行。planofplan 已有 origin 归因(user/subagent/plugin/exec/herdr)+ provider 维度，可以在项目视图里做 obelisk 没有的**「项目 × agent」交叉**(比如项目泳道内按 provider/origin 分组计数),这是我们能做出差异化的一屏。
3. **次级结构学 obelisk 的「平铺卡片 + 二级页」**:不嵌套、不缩进树。planofplan 刚落地的 subagent origin 标记可以走同样形态——对话详情里 subagent 以卡片呈现、点击看完整子会话，而不是在列表里和主会话平级竞争注意力(目前我们用 origin 过滤默认隐藏,obelisk 则是默认展示但视觉降级，两种都合理,obelisk 的做法信息损失更小)。
4. **handoff 我们不缺,反而 obelisk 缺**:planofplan 的 resume 是真功能,obelisk 完全没有。它的「复制 agent 命令」模式(打包意图而非数据)值得借鉴——比 resume 更轻，适合「把这个需求交给另一个 plan 的 agent 做」的场景，和我们多 plan 聚合的定位天然契合。
5. **动机层 obelisk 没有，这是我们的护城河，但它的 is_meta 纪律值得学**:obelisk 从不为"用户想干什么"做推断,planofplan 的 motivation 抽取已在做了；反过来,obelisk 把 meta/visibility 做成机器可读标记并贯穿查询层默认排除，比我们 UI 层过滤更彻底——我们的 origin/meta 信息应该同样下沉到**数据层的默认排除**,而不是每层 UI 各自判一次。
