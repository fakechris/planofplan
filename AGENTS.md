# AGENTS.md — planofplan

> 本文件为参与本仓库开发与维护的所有 AI Agent 与自动化工作流的操作契约与项目上下文索引。

---

## 1. Involute 绑定与项目工作图谱

本仓库已深度接入 **Involute** 工作流与内核状态机：

- **Team**: `INV`
- **Repository**: `fakechris/planofplan`
- **Root Project Node**: `INV-158` (fakechris/planofplan)
- **人类负责人 (Human Owner)**: `4fcdec6e-b921-4709-82a5-02b55e15f2c4`

### 1.1 三级拓扑层级 (Three-Tier Topology)

```
[PROJECT] INV-158: fakechris/planofplan
  │
  ├── [MILESTONE] INV-159: M1 额度监控与多 Plan 配额底座
  │     ├── [ISSUE] INV-165: 多订阅适配器与多时间窗轮询调度引擎 (In Review)
  │     ├── [ISSUE] INV-166: 本地日志 Token 消耗聚合与价格表快照引擎 (In Review)
  │     └── [ISSUE] INV-167: 浏览器原生 Cookie 提取与安全凭据管理 (In Review)
  │
  ├── [MILESTONE] INV-160: M2 工作谱系与会话多源索引引擎
  │     ├── [ISSUE] INV-168: 多 Agent 本地会话解析与行级水位增量扫描 (In Review)
  │     ├── [ISSUE] INV-169: 文件递归监听、防抖批处理与 SSE 实时推送 (In Review)
  │     ├── [ISSUE] INV-170: 用户元数据持久化、星标与墓碑防复活隔离 (In Review)
  │     └── [ISSUE] INV-171: 多元化标题流式提取、信封过滤与全文检索 (In Review)
  │
  ├── [MILESTONE] INV-161: M3 需求抽取与 Commit 动机归因链
  │     ├── [ISSUE] INV-172: 本地 Git 仓库多源识别与路径映射 (In Review)
  │     ├── [ISSUE] INV-173: 会话文件触碰与 Commit 启发式因果归因 (In Review)
  │     └── [ISSUE] INV-182: 开发者意图抽取与全链路谱系报告 (In Review)
  │
  ├── [MILESTONE] INV-162: M4 只读 MCP 互操作与 Agent 状态消费面
  │     ├── [ISSUE] INV-183: 只读 Streamable HTTP MCP 协议服务与 9 大工具集 (In Review)
  │     └── [ISSUE] INV-184: 外部 Agent 运行状态接入与跨工具协同 API (In Review)
  │
  ├── [MILESTONE] INV-163: M5 macOS 原生菜单栏与常驻守护系统
  │     ├── [ISSUE] INV-185: Swift 原生菜单栏应用与轻量状态监控 (In Review)
  │     └── [ISSUE] INV-195: 系统常驻 launchd 守护进程与平滑热重载 (In Review)
  │
  └── [MILESTONE] INV-164: M6 便携单二进制打包与免环境部署
        ├── [ISSUE] INV-207: 单二进制打包与静态资源内嵌 (Backlog / Ready)
        └── [ISSUE] INV-208: 免 Bun 环境的独立 App Bundle 与 launchd 自包含配置 (Backlog / Ready)
```

---

## 2. 核心架构与工程守则

1. **分层存储与只读底线**：
   - **L0 原生日志**：只读不可变，严禁任何形式的覆写、篡改、修剪或重新组织。
   - **L1 索引数据库**：存储于 `~/.planofplan/index.db`，可随时删除并由扫描器从 L0 重建。
   - **状态隔离**：星标、隐藏与墓碑必须沉淀于 `session_user_meta`，严禁与可重建的 `sessions` 表混存，保障墓碑防复活三道闸生效。
2. **零捏造价格**：
   - 价格数据以 LiteLLM 官方快照为准，支持模型家族正则降级兜底；未知模型花费必须显示为 Unknown，严禁虚构 $0 或捏造价格。
3. **单飞子进程与非阻塞**：
   - 监听器触发的索引重扫必须在单飞子进程中执行，严禁阻塞前端 SSE 或 HTTP API 响应。
4. **测试驱动 (TDD)**：
   - 所有变更必须伴随测试。测试运行基准：`bun test`。必须保持 400+ 项测试全绿。

---

## 3. Involute 任务流协作协议 (Agent Workflow Protocol)

每个参与本项目的 AI Agent 必须严格遵守 Involute 六步生命周期规范：

1. **查重防噪 (Search)**：
   - 创建新任务前必须调用 `involute___work_search`，避免重复提单。
2. **提案立项 (Propose)**：
   - 调用 `involute___work_propose`，设置 `team: "INV"`、`repository: "fakechris/planofplan"`、`parent_id` 绑定所属 Milestone。
   - 描述字段**强制**包含完整结构化中文：
     - `### 1. 目标与架构定位`
     - `### 2. 核心功能与交付范围`
     - `### 3. 验收标准与验证方案`
   - 禁止在标题添加 `[已交付]` 等状态标签（状态完全由状态机驱动）。
3. **合同提交 (Commit)**：
   - 必须指定人类负责人 `assignee_id: "4fcdec6e-b921-4709-82a5-02b55e15f2c4"` 晋升为正式交付合同。
4. **原子认领 (Claim)**：
   - 调用 `involute___work_claim` 获取排他租约。
5. **执行汇报 (Run Report)**：
   - 汇报阶段进展 `involute___run_report(status: "running", phase: "...")`。
   - 交付完成后标记 `status: "completed"`。
6. **物证挂载与送审 (Attach Evidence)**：
   - 严禁空口汇报，必须调用 `involute___evidence_attach` 上传可追溯的单元测试路径或编译物证。物证挂载后，状态机将自动推进至 `In Review`。
   - **终态 Done 仅限人类评审确认**。
