# 对标 Entire:任务接力与长期复用的架构定位

> 基准:main `93808fa`(2026-10-28 复核)。本文回答两个问题:planofplan 与 Entire
> 的能力差距在哪里、以什么架构补齐;哪些方向明确不做。落地项见 INV-1428(证据
> 口径修复)、INV-1427(任务接力)、INV-485(经验卡片)。

## 1. 产品定位

Entire 2026-10 起转型为「Agent-Human 协作的 Git forge」:代码托管、Trails 评审流、
Graph/Brain 上下文、checkpoint 随 Git 同步。它把团队协作基础设施重做了一遍。

planofplan 不跟这个方向。已有定位(INV-158 合同)依然成立且更聚焦:

> **跨 Agent 工作证据与上下文连续性是主定位;配额与成本辅助决策;Involute 是
> 正式合同和验收状态权威。**

与 Entire 的分界:

| 维度 | planofplan | Entire |
|---|---|---|
| 数据来源 | 本机原生日志(L0)只读索引,无需任何 Agent 安装 hook 才有数据 | Agent hooks 主动采集 + checkpoint |
| 工作身份 | Involute work ID 为正式状态;本地以需求 span + 交接回链串联 | Trails 自有一套目标/评审/审批 |
| 上下文消费 | 本机 MCP 只读工具面(13+ 工具) + web | Graph/Brain 私有栈 |
| 成本视角 | 跨订阅额度窗口 + 会话级 token/成本归集 | 会话与 token 记录 |
| 协作半径 | 单机多 Agent;Involute 承担跨人协作 | 团队 forge |

**吸收的是机制,不是产品**:Brain 的「任务开始前 brief」→ `planofplan_task_brief`;
Trails 的「同一项工作贯穿多会话」→ 交接回链 + Involute work ID;经验记忆 →
INV-485 证据卡。forge、自营 CI、评审流、区域镜像明确不做——那是另一条赛道,
且与「本机只读、证据分级」的架构底座冲突。

## 2. 顶层架构(现状 + 本次增量)

```
L0 原生日志(只读不可变)
 └─ L1 索引库 planofplan.db(可重建)
     ├─ 证据层  sessions/messages(FTS5)/requirements/touches/commits
     │          └─ 三档归因 declared > witnessed > candidate,Unknown 永不伪装
     │             [INV-1428] trailer 歧义不盖章;declared 与 witnessed 并存不互压
     ├─ 知识层  knowledge_cards(INV-485)
     │          └─ 人工审核的状态机 candidate/reviewed/rejected/expired;
     │             未审核卡绝不进入默认建议;来源 SourceRef 可回溯
     ├─ 接力层  handoffs + target_session_id 回链(INV-1427)
     │          └─ handoff → 接手会话 → 后续 commit 归因,同一条工作线可追
     └─ 消费面  MCP 只读工具(message_search/read_session/task_brief/
                knowledge_query/plan_quota_status/…) + web + 额度感知交接
```

关键不变量(全部有测试锁定):

1. **证据不升级**:推断(candidate)不得因钩子盖章变成声明(declared);歧义时
   宁可不盖章。declared 与 witnessed 对同一 commit 并存,消费侧自行对照。
2. **Unknown 诚实**:成本未知显示 null,不按 0 累加;「有提交关联」≠「已验证」
   ≠「已验收」三层分开(周报 landed 分档)。
3. **知识不自动权威**:经验卡必须人工 reviewed 才进默认查询;历史内容是数据,
   不是指令或授权。
4. **接力可观测不冒充**:回链只说明「交接后被该 provider 在该目录新起的会话
   接住」,不证明读完了包、更不证明验收完成。

## 3. 能力差距与本次补齐(对标复核结论 → 落地)

| 差距(93808fa 复核发现) | 落地 |
|---|---|
| trailer 误盖:并行 Agent 下「6h 内最新」被盖章为 declared,并压制真实 witness | INV-1428:唯一候选才盖章;多档并存 |
| linked worktree(.git 为文件)装钩子 ENOTDIR | INV-1428:gitdir 解析到公共 hooks 目录 |
| 周报把整 session commit 分摊给每条需求,candidate 也算「落地」 | INV-1428:逐需求复用 span 证据,landed 分档 |
| 成本未知按 0 累加,全未知会话显示 $0 | INV-1428:known 合计 + unknown 条数,全未知为 null |
| 项目上下文只有「最近 3 条」,与本次任务无关 | INV-1427:`planofplan_task_brief`(FTS×需求 span×touches×卡片×zg) |
| 交接面板只列 provider 名,不感知额度 | INV-1427:各 provider 窗口快照 + 重置倒计时 |
| 交接是否被接住不可观测(`ok` 只代表导出/启动成功) | INV-1427:target_session_id 回链 |
| 历史决定散在会话里,新任务前找不到 | INV-485:证据卡存储 + knowledge_query + brief 注入 |

## 4. 后续路线(本次不做,按收益排序)

1. **可携带证据包**:交接包内的 localhost 链接与 @session 引用跨机不可解析。
   方案:导出「经选择的证据片段 + 仓库身份 + commit 版本 + 相对路径 + 摘要校验
   + 证据等级」的自包含包(借鉴 checkpoint 的可携带性,不建托管)。
2. **接手效果评测**:INV-274 合同的 20 次真实接手评测,衡量 brief 是否真的减少
   重新解释;这是决定继续投入或停止的依据(和 INV-485 的对照实验同一方法论)。
3. **Involute work ID 融合**:本地证据向正式工作合同对齐(需求/交接卡携带
   INV-N 引用,由人确认),Involute 仍为状态权威,planofplan 只做证据侧聚合。
4. **失败尝试卡**: reverted/撤回 commit 的需求自动提候选卡(仍需人工 review)。
5. **External 证据源适配**:对已用 Entire 的仓库,把其 checkpoint 作为额外只读
   证据来源接入索引,planofplan 继续做跨工具汇总。

## 5. 明确不做

- Git 托管 / forge / 镜像网络 / 自营 CI(Entire 主战场,与本地只读底座无关)
- 评审与审批流(Involute 状态机已承担,重复建设)
- 自动把会话总结升级为规则/全局 memory/AGENTS 注入(INV-485 边界)
- 用 token 节约作为知识系统成功指标(实验设计已在 INV-485 排除)
