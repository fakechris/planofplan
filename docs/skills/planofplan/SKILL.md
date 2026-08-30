# planofplan:本机 agent 洞察中枢查询技能

> 给 coding agent 用的 planofplan MCP 工具使用指南。daemon 常驻本机
> (默认 `http://localhost:9291/mcp`,streamable HTTP)。未接入时:
> `claude mcp add --transport http planofplan http://localhost:9291/mcp`。

## 什么时候用

用户问以下任何一类问题时,优先调 planofplan 工具而不是猜或搜索:

- **额度**:"我还剩多少额度" "5H 窗口什么时候重置" → `plan_quota_status`
- **用量**:"最近烧了多少 token" "这周花了多少钱" → `usage_summary`(注意:本地日志估算,不是账单)
- **找历史对话**:"之前哪个对话聊过 X" → `session_search`
- **repo 脉络**:"这个 repo 最近做了什么" "X 需求落了没有" → `repo_lineage`
- **需求清单**:"最近提了哪些需求" "哪些还没落" → `requirement_status`
- **文件动向**:"最近 agent 都在改什么文件" → `recent_edits`
- **周期回顾**:"这周做了什么、落了多少、各烧多少" → `lineage_report`

## 惯例与坑

1. **自指防护**:你是 coding agent 时,`session_search` 请带上
   `exclude=<你自己的 session id>`——否则你正在进行的会话会混进"历史证据"。
2. **成本口径**:`usage_summary`/`lineage_report` 的金额是按本地日志 ×
   公开牌价的估算,不是账单;回答时保留这个限定。
3. **commit 三档证据**:`repo_lineage`/`lineage_report` 里 declared(trailer
   声明)> witnessed(transcript 目击)> candidate(时间窗推断)。
   引用 candidate 级关联时向用户说明是推断。
4. **中文搜索**:`session_search` 走 trigram,查询词 ≥3 字符;两字词用
   `limit` 放宽并接受更宽的召回。
5. 工具全部只读;quota 数据来自 daemon 的周期抓取,可能滞后数分钟。
