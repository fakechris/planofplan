# Factory / Kimi 鉴权调查 Handoff

更新时间：2026-08-19（以当前仓库 `HEAD` 为准）

## 0. 2026-08-19 深夜调查结论（最新，优先读这节）

两位 provider 的 401 根因均已用本机真实链路证据闭环，且 Kimi 已修复可用。

### Kimi 根因（已修复）

- `kimi-auth` cookie 与 apiv2 鉴权**无关**。实测：
  - 带 `Authorization: Bearer <kimi-auth>` → 服务端报 `token has invalid claims: token is expired`；
  - 纯 Cookie（无 Authorization）→ `REASON_INVALID_AUTH_TOKEN`，apiv2 根本不接受 Cookie 鉴权。
- kimi.com 前端（statics.moonshot.cn `request-*.js`）真实凭据在 **localStorage**：
  `access_token` / `refresh_token` / `msh_user_id`，API 用 `Authorization: Bearer <localStorage.access_token>`。
- token 刷新端点：`POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken`，
  Connect-JSON，字段 `refresh_token`，响应 `access_token` + `refresh_token`（会轮换）。
- Safari 的 localStorage 布局（Safari 17+）：
  `~/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3`
  （ItemTable；value 可能是 UTF-16LE BLOB；hash 预映像含设备盐，无法离线推导，代码用扫描 + 键名/JWT 形状匹配）。
- 修复实现：
  - `readSafariKimiWebTokens()`（src/browser-cookies.ts）只读 localStorage；
  - `readKimiWebSession()`（src/adapters/kimi.ts）优先级：env → localStorage 新鲜 access_token（读取穿透，
    页面打开时自己刷新）→ daemon 自持刷新链 `~/.planofplan/kimi-web-session.json`（0600，
    access 新鲜直接用，否则 RefreshToken 兑换并持久化；localStorage refresh_token 优先、
    持久化链仅在 JWT `sub` 锚点同账号时兜底）→ 旧 kimi-auth cookie 路径保留为最后兜底。
  - 实测与网页 quota 页数据一致（Week 97%、5H 0%、Month 0%）。
- 注意：daemon 兑换会消耗浏览器 localStorage 的 refresh_token（一次性轮换），用户下次打开
  kimi.com 页面可能需要重新登录一次；之后两边各持独立链，互不影响。
- 用户明确确认：Kimi 浏览器会话只允许 Safari（本节修复同样只读 Safari 存储）。

### Factory 根因（部分修复，待一次用户动作恢复）

- WorkOS refresh token 是**一次性轮换**的，daemon 和 app.factory.ai 页面共享 Comet localStorage
  里的同一个 token，谁先兑换谁消耗它。典型失败环：daemon 兑换成功（消耗浏览器 token）→
  daemon 重启/丢失内存 → 浏览器 localStorage 里只剩死 token → 401 → 用户哪天打开 Factory
  页面 → 页面静默重登写回新 token → 又恢复。这就是“反复 401 又偶尔自愈”的原因。
- 实测：浏览器 25 字符 refresh token 对 client `client_01HNM792M5G5G1A2THWPXKFMXB` 有效
  （另一个 client 400）；billing `/api/billing/limits` 只认 Bearer，纯 Cookie 401。
- 本次修复：`factory-session.json` 持久化轮换链增加 `userSub` 账号锚点（ exchanged access
  token JWT 的 `sub`）。Cookie 值高频轮换导致 fingerprint 失配时，只要 incoming
  `access-token` cookie 的 JWT sub 与持久化 userSub 一致，持久化链保留为 fallback
  （浏览器 token 已被上次兑换消耗时仍能恢复）。换号则丢弃。
- ⚠️ 本次调查中的诊断 probe 消耗掉了当前机器的轮换链（持久化文件里的 token 已失效）。
  恢复方法：在 Comet 打开一次 app.factory.ai（页面会写回新 token），然后 menubar 重新读取
  Factory Comet 会话（或重启 menubar app）。
- 长期可选改进：把 daemon 轮换后的 WorkOS refresh token 回写 Comet localStorage（对齐
  onWatch 对 kimi-code.json 的做法），彻底消除竞态；涉及第三方浏览器存储写入，需单独评估。

### 其他发现

- daemon（menubar app 子进程）stdout/stderr 被重定向到 `/dev/null`（main.swift
  `startDaemon()`），所有 `[kimi] ...` 类逐阶段日志被丢弃。排查时用 `/usr/bin/log show
  --predicate 'process == "PlanofplanMenuBar"'` 看 NSLog，或临时加诊断端点。
- daemon 实际端口 9288/9291 以 menubar 菜单为准（本机当前 9291）。
- `~/.kimi-code/credentials/kimi-code.json` 是空壳（access/refresh 全空），CLI 路径当前不可用，
  重新 `kimi-code login` 可恢复 CLI 主路径。

以下为原始调查背景，保留供参考。


这份文档给下一位 agent 使用。目标不是重新设计 provider，而是继续验证
Factory Droid 和 Kimi 的真实登录态、请求链路以及剩余的 HTTP 401 问题。

## 1. 当前结论

- 当前分支是 `main`，`HEAD` 为 `c9de880`：
  `fix: report refresh-all provider failures`。
- `/Applications/planofplan.app` 已安装，当前构建对应 `c9de880`。
- 源码改动已经提交；工作区唯一未跟踪项是
  `macos/PlanofplanMenuBar/.build/`，这是原生构建产物，不要当作源码改动删除。
- Factory 和 Kimi 的单元/集成回归测试、TypeScript 检查、Swift 构建和签名安装此前均已通过。
- Factory 曾经成功显示用量，约为 `2026-08-19T02:26:33Z`。因此不能把问题简单归结为
  “Factory 账号从来没有权限”。
- 后续 daemon 重启后 Factory 又反复出现 HTTP 401。调查发现一个确定的问题：
  WorkOS refresh token 会轮换，旧实现只把轮换后的 token 放在内存中，daemon 重启后丢失。
  现在已经持久化轮换 token，但当前本机的 Comet 登录态尚未完成一次“持久化后成功兑换并请求
  Factory 用量”的真实验证。
- Kimi Safari 页面可以正常打开，但当前网页会话调用 Kimi usage API 仍然返回 HTTP 401。
  “浏览器页面可访问”和“usage API 接受该会话”是两个不同结论。
- `/api/refresh` 仍然约定批量请求完成时返回 HTTP 200；现在当某些 provider 失败时，响应会有
  `ok: false` 和顶层 `error`，前端不再显示含糊的“请求失败（200）”。

## 2. 参考项目：CodexBar 和 onWatch

### 2.1 CodexBar 的作用

CodexBar 是 macOS 菜单栏/CLI provider tracker。这里主要借鉴它的 provider
规格、请求端点、窗口展示语义和浏览器会话读取，而不是照搬它的产品壳。

Factory 关键源码：

- [FactoryStatusProbe.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Factory/FactoryStatusProbe.swift)
- [FactoryLocalStorageImporter.swift](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Factory/FactoryLocalStorageImporter.swift)

Factory 的关键启发：

1. Factory 的浏览器登录态不一定只有 Cookie，还可能需要 WorkOS Local Storage 中的
   `workos:access-token` / `workos:refresh-token`。
2. WorkOS refresh token 通过
   `POST https://api.workos.com/user_management/authenticate` 换 access token。
3. 个人 Usage 页面和公开 Analytics API 不是一回事。公开 Analytics API 是组织级历史消费
   数据，不保证返回个人剩余额度、窗口和 reset 时间。

Kimi 关键源码（固定在调查时使用的 commit，避免上游变化导致结论漂移）：

- [KimiCookieImporter.swift](https://github.com/steipete/CodexBar/blob/f844f9882458b41c1dc919b48776cfc4957d0009/Sources/CodexBarCore/Providers/Kimi/KimiCookieImporter.swift#L6-L15)
- [KimiProviderDescriptor.swift](https://github.com/steipete/CodexBar/blob/f844f9882458b41c1dc919b48776cfc4957d0009/Sources/CodexBarCore/Providers/Kimi/KimiProviderDescriptor.swift#L238-L253)

CodexBar 的 Kimi 行为：

- 优先检查 Kimi Desktop，然后读取浏览器中的 `kimi-auth`。
- 使用网页会话 token 请求 Kimi web usage path。
- Cookie 导入覆盖 Safari、Firefox 以及多个 Chromium 浏览器，但每个浏览器的 Keychain、
  profile、Cookie 数据库格式不同，不能只靠一个通用 SQLite 查询。
- 当前调查引用的 SweetCookieKit revision 是
  `d5ea6d92298779ec0c3ddf7d3d99da186a305e14`。它会读取 Chromium Safe Storage、Firefox
  `moz_cookies` 和 Safari `Cookies.binarycookies`。不要把旧笔记中的“v10/v11”当作事实：
  该固定版本的 Chromium 解密实现明确只接受 `v10`，不处理 `v11`/`v20`。

Factory 官方公开资料：

- [Factory Analytics API](https://docs.factory.ai/reference/analytics-api)
- [Factory API keys](https://app.factory.ai/settings/api-keys)
- 研究记录：[`factory-usage-research.md`](./factory-usage-research.md)

Analytics API 的 `GET /api/v1/analytics/tokens` 是历史组织消费统计，需要 API key、
日期参数和 Manager/Owner 权限；它不是本项目当前 personal quota 的首选数据源。

### 2.2 onWatch 的作用

onWatch 是 Go daemon + SQLite + localhost Web dashboard。这里主要借鉴架构、轮询、
本地凭据自动发现和 OAuth refresh，而不是浏览器 Cookie。

- [onWatch repository](https://github.com/onllm-dev/onWatch)
- [onWatch Kimi client](https://github.com/onllm-dev/onWatch/blob/32fc35d7a096b9fc67b761607467617f4774cc45/internal/api/kimi_client.go#L149-L217)
- [onWatch Kimi setup](https://github.com/onllm-dev/onWatch/blob/32fc35d7a096b9fc67b761607467617f4774cc45/docs/KIMI_SETUP.md#L12-L35)

onWatch 的 Kimi 行为：

- 使用 Kimi Code API bearer token。
- 从环境变量或 `~/.kimi-code/credentials/kimi-code.json` 读取凭据。
- access token 过期时用 refresh token 刷新，并更新本地凭据文件。
- 没有 Kimi 浏览器 Cookie importer、Safari reader、Comet/Dia 路径或 macOS Keychain
  Cookie 解密。

所以两者的分工是：

| 主题 | CodexBar | onWatch | planofplan |
| --- | --- | --- | --- |
| provider 端点/窗口规格 | 主要参考 | 辅助参考 | 已移植并做统一 normalize |
| daemon + SQLite + Web | 菜单栏/CLI 为主 | 主要参考 | Bun + TypeScript + SQLite + localhost Web |
| API key/CLI OAuth 自动检测 | 支持 | 主要参考 | 主路线 |
| 浏览器 Cookie | 强项，macOS | Kimi 不支持 | 仅兜底；Factory/Kimi 分开处理 |
| Kimi 月额度 | 网页会话 | 不支持浏览器路径 | 网页会话 best-effort |

本地更完整的比较见：

- [`kimi-browser-cookie-research.md`](./kimi-browser-cookie-research.md)
- [`coding-plan-usage-trackers.md`](./coding-plan-usage-trackers.md)
- [`planofplan-design.md`](./planofplan-design.md)

## 3. planofplan 的架构和授权顺序

核心接口在 `src/types.ts`：

```text
detectCredentials(ctx) -> Credential | null
fetchUsage(ctx, credential) -> QuotaWindow[]
```

Scheduler 负责每个 plan 的轮询、失败分类、stale 快照和状态；adapter 负责凭据发现、
HTTP 请求和窗口 normalize；SQLite 保存快照；Web UI 读取 `/api/overview`。

总原则：

1. API key / provider-owned CLI credential 是主路径。
2. 浏览器读取只在网页端数据确实需要时兜底。
3. Cookie、refresh token 和 access token 不打印、不写数据库。
4. 只有手动 API key 按既有约定写入 `~/.planofplan/credentials.json`，权限 0600。
5. 浏览器会话主要在 Bun/native app 内存中保存；Factory 轮换 refresh token 为了跨重启恢复，
   有单独的 0600 文件，见下文。

## 4. Factory 当前实现

涉及文件：

- `src/adapters/factory.ts`
- `src/factory-session.ts`
- `src/types.ts`
- `src/server.ts`
- `macos/PlanofplanMenuBar/Sources/PlanofplanMenuBar/main.swift`
- `test/factory.test.ts`

### 4.1 API key 路径

Factory adapter 按以下来源找 key：

1. 手动 `credentials.json` 中的 Factory key。
2. `FACTORY_API_KEY`。
3. `~/.factory/.env` 中的 `FACTORY_API_KEY`。
4. 浏览器/native session。

API key 优先请求：

```text
GET https://api.factory.ai/api/billing/limits
```

当响应声明 `usesTokenRateLimitsBilling: true` 且有 `limits.standard` 时，解析
Standard/Core 的 5H、Week、Month 窗口。

老账号或不提供 token-rate-limits billing 时，回退到：

```text
GET /api/app/auth/me
GET /api/organization/subscription/usage?useCache=true&userId=...
```

老路径会在以下 host 之间尝试：

```text
https://api.factory.ai
https://app.factory.ai
https://auth.factory.ai
```

### 4.2 浏览器/native session 路径

原生 app 读取用户选定的浏览器会话，然后 POST 到 localhost 的
`/api/browser-session`。Factory payload 可包含：

- 选中的 Factory Cookie；
- WorkOS access token；
- WorkOS refresh token；
- JWT 中解析出的或 native 传入的 `organizationId`；
- WorkOS 相关 Cookie。

`src/factory-session.ts` 只接受已知 Factory session cookie 名称，包括：
`wos-session`、多种 next-auth/authjs 名称、`session`、`access-token` 和
`__recent_auth`。未知 Cookie 会被丢弃。

如果只有 WorkOS refresh token：

1. 调用 `POST https://api.workos.com/user_management/authenticate`；
2. body 使用 `grant_type: "refresh_token"`、Factory client id；
3. 有 organization id 时传 `organization_id`；
4. 有 WorkOS Cookie 时同时传 `Cookie` 和 `useCookie: true`；
5. 拿到 access token 后请求 Factory billing endpoint。

如果 WorkOS exchange 失败但还有 Factory Cookie，adapter 会回退到只带 Cookie 的
Factory 请求。若已有 stale `Authorization`，收到 401/403 后会重试一次，不再发送
`Authorization`，避免过期 bearer 阻断仍有效的 Cookie。

### 4.3 refresh token 轮换和跨重启

文件：`~/.planofplan/factory-session.json`。

文件内容只包含：

- 轮换后的 refresh token；
- organization id；
- 规范化 Factory Cookie header 的 SHA-256 fingerprint。

文件权限强制为 0600。下一次 native session 到来时，只有 Cookie fingerprint 匹配才使用
持久化 token；当前 browser 传来的 token 保留为 one-step fallback。这样可以同时覆盖：

- 上一次进程已经兑换并轮换了 token；
- 当前浏览器仍暴露旧 token；
- 浏览器 Cookie 已换账号，不能误用旧账号的 token。

这部分的重启回归测试是
`test/factory.test.ts` 中的
`reuses the rotated WorkOS refresh token after a process restart`。

### 4.4 Factory 当前未解决点

- 曾经成功过，但后续重启后仍可能 401，说明需要进一步验证本机实际 native import、
  Safe Storage 权限、WorkOS Cookie、organization id 和持久化 token 是否同一会话。
- 当前可见的 Comet WorkOS token 是旧的、长度约 25 的值；尚未完成一次新的、成功的
  exchange → Factory billing 全链路验证。
- 如果 Comet Safe Storage 读取失败，native bootstrap 可能没有拿到 credentials，UI 会显示
  missing，而不是 401。
- Factory 页面能显示 Usage，不等于 `api.factory.ai/api/billing/limits` 会接受当前 bearer；
  页面可能依赖 WorkOS Cookie、组织上下文或另一种内部请求状态。

## 5. Kimi 当前实现

涉及文件：

- `src/adapters/kimi.ts`
- `src/browser-cookies.ts`
- `src/server.ts`
- `macos/PlanofplanMenuBar/Sources/PlanofplanMenuBar/main.swift`
- `test/server.test.ts`

### 5.1 凭据顺序

自动模式大致是：

1. 手动 key；
2. `KIMI_CODE_API_KEY`；
3. `~/.kimi-code/credentials/kimi-code.json` 的 access token；
4. CLI OAuth refresh（过期时写回轮换后的 access/refresh token）；
5. 网页 `kimi-auth` session。

CLI/API 路径使用：

```text
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <token>
```

CLI token 还会带 JWT/device 相关的 `x-msh-device-id`、`x-msh-session-id`、
`x-traffic-id`（能解析时）。

网页路径使用：

```text
POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages
POST https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats
```

网页请求会带：

- `Authorization: Bearer <kimi-auth>`;
- 完整的选定浏览器 Cookie header；
- `Origin: https://www.kimi.com`;
- `Referer: https://www.kimi.com/code/console`;
- `connect-protocol-version`、`x-language`、`x-msh-platform`、`r-timezone`；
- 仅从网页 JWT 读取的 device/session/traffic identity headers。

周/5H 来自 `GetUsages(FEATURE_CODING)`；月度共享订阅池来自
`GetSubscriptionStats` 的 `subscriptionBalance.amountUsedRatio`。

### 5.2 Safari-only 约束

用户已经明确要求：Kimi 浏览器会话只能使用 Safari。

代码层有三处约束：

- `KIMI_BROWSER = 'safari'`；
- `/api/plans/kimi/browser` 拒绝非 Safari；
- `/api/browser-session` 对 Kimi 拒绝非 Safari native payload。

原生 app 的 Kimi 菜单也只提供 Safari。Factory 可以选择 Comet、Chrome、Dia、Firefox
等浏览器，但不要把这个能力扩展到 Kimi，除非用户重新确认。

Safari 读取由 SweetCookieKit/WebKit 路径完成，通常需要 Full Disk Access。Cookie token
只在当前进程内存中缓存，不写入 planofplan DB。

### 5.3 多个 Safari `kimi-auth`

Safari 可能保留多个同名 Cookie。native payload 到达后，server 按 native importer
顺序逐个尝试 `kimi-auth`，每个 candidate 都触发一次 usage refresh，直到成功。
这修复了“第一个 Cookie 已过期，后面的 Cookie 才是当前会话”的情况。

回归测试：

```text
test/server.test.ts
tries each Safari kimi-auth cookie until usage succeeds
```

### 5.4 Kimi 当前未解决点

- Safari 的 `kimi.com` 页面可以打开，但当前 usage API 仍返回 HTTP 401。
- 这不证明 Safari 登录态无效，只证明当前 API 请求组合不被服务端接受。
- 需要分别验证 `GetUsages` 和 `GetSubscriptionStats` 的 status/body，不要只看网页页面
  HTTP 200。
- 待排查变量包括：`kimi-auth` 是否已轮换、Cookie domain/path/同站上下文、网页 JWT
  identity headers、API endpoint 是否需要其他浏览器请求头，以及页面 session 与 billing
  API session 是否已经分离。
- 不要把 Kimi CLI token、Kimi Safari token、Factory WorkOS token 混用。它们的 audience、
  endpoint 和 header 契约不同。

本地研究记录还列出旧的 plain-Chromium fallback 缺口；当前 native 代码已加入选定
浏览器读取，但 Kimi 产品策略仍然是 Safari-only。详见
[`kimi-browser-cookie-research.md`](./kimi-browser-cookie-research.md)。

## 6. 已遇到的问题和修复时间线

按提交顺序，重要修复如下：

| Commit | 修复 |
| --- | --- |
| `24bd121` | 优先使用 Factory WorkOS browser session |
| `df194f2` | stale WorkOS token 失败时回退 |
| `11308f0` | 选择较新的 Factory WorkOS token |
| `6a8d565` | 加固 browser auth refresh lifecycle |
| `fea0d3d` | 稳定 quota window，并加入 Safari onboarding |
| `c5abd51` | 强制 Kimi Safari session |
| `a90022b` | web session 转发完整 Cookie |
| `f3c75c3` | 保留 native browser-session 的错误响应细节 |
| `b47747d` | WorkOS refresh 使用 browser Cookie 和 `useCookie` |
| `6de42ea` | 识别 Factory `__recent_auth` |
| `321406c` | 持久化轮换后的 Factory refresh token |
| `c9de880` | refresh-all 汇总 provider 失败信息 |

典型失败链路：

1. Factory 页面登录态看起来有效，但旧实现只发送 stale bearer，导致 401。
2. 去掉 stale bearer 后，发现 WorkOS refresh token exchange 本身会失败或轮换。
3. WorkOS exchange 缺少 organization id / browser Cookie 时，补充了上下文。
4. token 在一个 daemon 进程内成功轮换，但重启后内存状态消失，Factory 再次失败。
5. 加入 `factory-session.json` 和 Cookie fingerprint 后，仍需本机真实 session 验证。
6. Kimi 的第一个 Safari `kimi-auth` 可能不是当前 token，因此加入逐 candidate retry。
7. Kimi 只转发 bearer 不够，于是转发完整 Safari Cookie 和网页 JWT identity headers。
8. “刷新全部 请求失败（200）”实际是 batch HTTP 200 + provider `ok:false`，不是 HTTP
   状态码错误；现在 server 返回顶层错误，前端也检查 `data.ok === false`。

## 7. 回归测试和验证

相关测试：

```text
test/factory.test.ts
  - billing/legacy usage normalize
  - expired window cleanup
  - recognized cookie filtering
  - WorkOS exchange with organization_id/useCookie
  - WorkOS failure -> Factory Cookie fallback
  - stale bearer -> no-Authorization retry
  - rotated refresh token restart reuse

test/server.test.ts
  - refresh-all HTTP 200 but top-level provider error
  - Kimi non-Safari selection rejection
  - Kimi non-Safari native payload rejection
  - multiple Safari kimi-auth candidate retry
```

建议接手后先跑：

```bash
bun test
bun run typecheck
git diff --check
```

若要确认安装包身份，不要从 `dist` 启动旧副本；使用：

```bash
open /Applications/planofplan.app
```

menubar 菜单中的 build identity 应显示 `c9de880`。原生构建命令会修改
`/Applications/planofplan.app`，除非确实需要重新安装，不要无故重跑。

## 8. 下一位 agent 的检查清单

### 8.1 先确认环境和 build

1. `git status --short --branch`，保留 `.build/`，不要清理用户文件。
2. 确认 `/Applications/planofplan.app` 的 `/api/build-info` 是 `c9de880`。
3. 确认只运行一个本地 daemon，避免旧进程占用同一个监听端口。
4. 先跑单测和 typecheck，确认不是回归问题。

### 8.2 Factory 最小诊断顺序

1. 在已登录的 Comet/Factory 页面保持 session，不要先退出或清 Cookie。
2. 确认 Comet Safe Storage 的 Keychain 授权状态。
3. 通过 menubar 读取 Factory Comet session，观察 native response 的 status 和错误 body。
4. 只记录以下 metadata：Cookie 名称集合、token 长度、JWT claim 名称、HTTP status、
   response body 的非敏感错误字段。禁止记录 token/Cookie 值。
5. 检查 `~/.planofplan/factory-session.json` 是否存在、权限是否为 0600、fingerprint
   是否与当前 Factory Cookie 匹配；只输出 token 长度和 fingerprint，不输出 token。
6. 在同一次 session 中验证：

   ```text
   WorkOS exchange -> access token -> /api/billing/limits
   ```

   如果 exchange 成功但 billing 401，单独测试“带 bearer”和“无 Authorization 仅带
   Factory Cookie”两次请求的 status。
7. 如果 exchange 失败，记录 WorkOS HTTP status、是否 `invalid_grant`、是否发送
   `organization_id`/`useCookie`，但不要记录 body 中可能存在的 credential。

关键判断：

- native import 没拿到 token = import/Keychain/TCC 问题；
- WorkOS exchange 401/400 = refresh token、organization、Cookie 或 client context；
- exchange 成功、billing bearer 401、Cookie 成功 = Factory bearer 使用方式问题；
- bearer 和 Cookie 都 401 = 当前 Factory session 本身或 endpoint/account 资格问题。

### 8.3 Kimi 最小诊断顺序

1. 只选择 Safari，确认 Safari 已登录 `https://www.kimi.com/code/console`。
2. 确认 `/Applications/planofplan.app` 获得 Full Disk Access；不要切换到 Chrome/Comet
   来“绕过” Kimi 的 Safari-only 规则。
3. 记录 Safari `kimi-auth` 的数量、domain、path、长度和 hash，不记录值。
4. 对每个 candidate 分别记录：

   ```text
   GetUsages status/body metadata
   GetSubscriptionStats status/body metadata
   ```

5. 对比“页面能打开”和“API 401”时的 JWT claim 名称及过期时间；不要把完整 JWT 写入日志。
6. 如需增加临时 instrumentation，只打唯一前缀、status、endpoint、body 字段名和长度；
   调查结束前删除临时日志。

### 8.4 不要做的事

- 不要把 Factory WorkOS refresh token、Factory Cookie 或 Kimi `kimi-auth` 写进日志、测试
  fixture、handoff 或 git diff。
- 不要把 Kimi 改成自动扫描任意浏览器；Safari-only 是用户明确约束。
- 不要因为 Factory 401 就切换到组织 Analytics API，并声称它等价于个人剩余额度。
- 不要用页面 HTTP 200 推断 usage API 一定授权成功。
- 不要删除 `.build/`、`~/.planofplan/factory-session.json` 或现有用户凭据来“重置”问题，
  除非用户明确授权并已确认备份。

## 9. 安全的本地接口检查

这些只访问 localhost，不打印 provider token：

```bash
curl -sS http://127.0.0.1:9288/api/build-info
curl -sS http://127.0.0.1:9288/api/overview
curl -sS -X POST http://127.0.0.1:9288/api/refresh
```

如果 menubar 使用了非默认端口，以菜单栏 app 的配置为准。`/api/refresh` 返回 HTTP
200 并不代表所有 provider 成功，必须同时检查 JSON 的 `ok`、`results[*].ok` 和顶层
`error`。

## 10. 推荐的下一步

优先不要继续扩大代码改动，先拿到一份脱敏的真实链路结果：

```text
Factory:
  native import -> WorkOS exchange -> billing with bearer -> billing with Cookie

Kimi:
  Safari candidate #1/#2/... -> GetUsages -> GetSubscriptionStats
```

有了这份按阶段的 status/body metadata，下一位 agent 才能判断是：

- 本地浏览器读取/TCC；
- OAuth token rotation；
- WorkOS organization/cookie context；
- Factory endpoint/account 资格；
- Kimi 网页 session 与 usage API 的服务端授权差异。

当前最重要的事实是：Factory 曾成功，Kimi 页面可访问，但两者的 API 401 都还没有被
本机真实 session 的逐阶段证据完全解释。
