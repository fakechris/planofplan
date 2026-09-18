# 消息检索与稳定续读

Author: Astra · INV-276

MCP `message_search` / `read_message` 与 HTTP `GET /api/messages/search` /
`GET /api/messages/read` 使用同一查询服务。接口只读取索引及原日志文件的元数据，
不会修改原日志、调用模型或接受任意文件路径。

## 搜索与过滤

`message_search({q, limit?: 20, offset?: 0, ...filters})` 返回 JSON：
`items`、`truncated`、`next_offset`、`search_mode`、`freshness`、`warnings`。
每条命中包含 `source_ref`、`snippet`、`role`、`kind`、`timestamp`、
`content_complete`、`source_status` 和 `indexed_at`。

过滤字段在分页前生效，搜索和续读均支持：

| 字段 | 语义 |
| --- | --- |
| `project` | 精确匹配 session cwd、仓库 root、URL 或 name；属于会话级关联，不代表单条消息的文件归因 |
| `provider` | 精确 provider 名称 |
| `role` | user / assistant / system / tool |
| `kind` | text / summary / tool_use；搜索始终排除 tool_use |
| `since` / `until` | 消息时间戳，包含起点、不包含终点；epoch 毫秒或 ISO 日期；启用时无时间戳消息不匹配 |
| `exclude` | 排除一个 session ID |

`q` 长度为 1–500 个 UTF-16 code units，`limit` 为 1–100。
至少三个非空白 Unicode codepoints 时使用已有 FTS5 trigram 索引；短查询使用
LIKE，并在 `search_mode` 中标记 `like_short_query`。FTS 查询失败时标记
`like_fallback`。LIKE 可能扫描较多记录。

搜索范围仍是已有 `text` 字段的可见文本前 10,000 字符摘要，**不包含正文更后面的文字**。
完整正文的保留与续读不会扩大已有 FTS 的覆盖范围。搜索分页是实时结果视图，
新索引写入可能改变排序；它不是不可变结果集的游标。

## 稳定引用与正文续读

搜索结果、旧 `session_search` 命中及 `read_session` 消息都提供：

```json
{
  "provider": "claude",
  "session_id": "claude:example",
  "message_id": "claude:example:message-uuid",
  "source_seq": 42,
  "source_revision": "sha256:...",
  "parser_version": 8
}
```

引用绑定索引中的规范化消息身份、正文及解析器版本。`source_seq` 是解析器源序号，
不随 role 过滤改变。旧 `read_session.offset` 则是过滤后从 1 开始的消息位置，
其正文仍是预览；消息列表读完不表示每条正文读完。

调用 `read_message({source_ref, char_limit: 4000})`，然后使用返回的
`next_cursor` 调用 `read_message({cursor, char_limit: 4000})`，直到游标为 null。
也可显式传 `char_start`。HTTP 的 `source_ref` 是经过 URL 编码的 JSON，
其余参数为查询字符串。

结果包含 `text`、`char_start`、`char_end`、`total_chars`、`char_unit`、
`content_complete`、`truncated`、`next_cursor` 和来源状态。位置单位为 UTF-16
code units；`char_limit` 范围 2–16,000；接口不会从中间切开代理对。
游标携带原引用、下一个位置及过滤条件，每次读取重新检查可见性。
`cursor` 不能同时携带 `source_ref` 或 `char_start`。

`source_revision` 是索引消息内容的 SHA-256，**不是原始日志文件的校验值**。
索引内容或解析器版本发生改变时，旧引用返回 `STALE_SOURCE`（HTTP 409），
调用方需重新搜索。接口不保存每个历史 revision 的版本链。

## 完整性、原日志状态与可见性

数据库迁移 v13 增加可空的 `full_text`、`parser_version`，保留用户元数据。
消息解析器 v8 在正常扫描重解析时填充规范化可见正文，保留内部换行，
沿用既有信封过滤与首尾空白清理。旧记录在重扫前、以及只保存受限工具入参的记录，
返回 `content_complete: false`；即使 `truncated: false` 也不能宣称正文完整。

所有结果的 `freshness` 为 `indexed_snapshot`，`indexed_at` 是会话最近索引时间。
`source_status` 区分：

- `index_only`：记录没有原文件路径。
- `present_unverified`：文件存在，没有对应扫描水位可比较。
- `indexed_metadata_matches`：文件大小和 mtime 与水位一致，不等于内容校验通过。
- `changed_since_index`：原文件元数据已变化，仍返回带警告的索引快照。
- `missing`：原文件无法 stat。默认读取返回 `SOURCE_MISSING`（HTTP 404）；
  显式 `allow_archived: true` 才可读取保留快照，续读游标会保留该选项。

隐藏或墓碑会话在搜索、会话预览、消息续读时统一排除，即使已有旧引用或
`allow_archived` 也不能绕过。无效输入返回 `INVALID_ARGUMENT` / `INVALID_CURSOR` /
`INVALID_RANGE`（HTTP 400）。MCP 同样返回结构化错误并设置 `isError: true`。
