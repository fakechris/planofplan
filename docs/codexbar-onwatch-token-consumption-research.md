# CodexBar / onWatch token-consumption research

Research date: 2026-08-19. Sources are public upstream repositories and first-party documentation. The
repository pages below were checked on their current `main`; the commit hashes are included to make the
observations reproducible.

## Short answer

- **Provider quota is not token consumption.** A `usedPercent` value for a five-hour or weekly plan window
  says how much of the provider's allowance is consumed, but it does not identify input/output/cache/reasoning
  tokens or a dollar cost.
- **CodexBar can do both, but through different sources.** Its Codex and Claude quota cards are remote
  plan-limit data. Separately, its Usage & Spend feature scans local JSONL logs and estimates token mix and
  cost. It also has provider-specific admin/billing integrations.
- **onWatch is primarily a quota history/projection daemon.** It stores periodic snapshots in SQLite and
  derives trends, burn rate, and reset cycles. Its public README/docs do not describe a general local
  session-log token scanner or a provider-neutral token/cost ledger.
- **Claude Code is the clearest exception in first-party APIs:** Anthropic's Claude Code Analytics Admin
  API returns per-model input/output/cache tokens and estimated cost, but it is an organization admin API,
  daily aggregated, and not the same as the Pro/Max subscription quota endpoint.

## CodexBar

**Pinned upstream state:** `steipete/CodexBar`, commit
[`453174fe13eebdf403cc0776268eb2b101fd9553`](https://github.com/steipete/CodexBar/commit/453174fe13eebdf403cc0776268eb2b101fd9553)
(the repository's latest `main` commit when researched).

Primary source: [`docs/providers.md`](https://github.com/steipete/CodexBar/blob/5436112ea7b0a12eae5fef474a2aaad26a4d719a/docs/providers.md).
The implementation is under `Sources/CodexBarCore/`; the provider-specific details below are also documented
in [`docs/codex.md`](https://github.com/steipete/CodexBar/blob/a29973fe9933c95b4d8073709d858604144e2a8b/docs/codex.md)
and [`docs/claude.md`](https://github.com/steipete/CodexBar/blob/199b96b393b497ee3a4e8f2e91550a6e17624547/docs/claude.md).

### What is quota-only

* **Codex plan quota:** OAuth `GET https://chatgpt.com/backend-api/wham/usage` and
  `codex app-server` JSON-RPC `account/rateLimits/read` expose primary/secondary windows, percentages,
  reset timestamps, and (where available) credits. These are plan/rate-limit meters, not per-turn token
  counts. The optional web dashboard adds review/credit history and usage breakdown, but it is still a
  dashboard/billing surface, not the local session ledger.
* **Claude Code subscription quota:** OAuth `GET https://api.anthropic.com/api/oauth/usage` and the
  cookie path `GET https://claude.ai/api/organizations/{orgId}/usage` expose five-hour, seven-day, and
  model-scoped utilization/reset windows. CLI `/usage` is parsed for the same percentages. CodexBar
  explicitly says it does not derive quota percentages from spend or token totals.
* **Factory Droid:** the provider fetches Factory API/web account data (see the `Droid/Factory` row and
  `docs/factory.md` in the upstream repository). The documented CodexBar provider contract is account/plan
  usage; no local Droid transcript scanner or token/cost field is documented for that provider.
* **Consumer Grok:** the `Grok` provider uses `grok agent stdio` JSON-RPC `x.ai/billing`, a grok.com
  billing gRPC-web fallback, and local session signals as a fallback. The remote subscription path is a
  billing/quota surface, not a general token ledger.

### What is actual usage/cost (or a local estimate)

CodexBar's **Settings → Usage & Spend** is explicitly a local estimated-cost history, not a billing receipt
and not the menu-bar quota card. It scans local files, deduplicates streaming records, keeps input/output/cache/
reasoning mix, and prices supported models. The relevant implementation areas are:

* `Sources/CodexBarCore/CostUsageFetcher.swift`
* `Sources/CodexBarCore/PiSessionCostScanner.swift`
* `Sources/CodexBarCore/Vendored/CostUsage/*`

For Codex, the scanner reads `~/.codex/sessions/**/*.jsonl` and archived sessions (or `$CODEX_HOME`), parsing
`event_msg` `token_count` records and `turn_context` model markers. For Claude, it reads
`~/.config/claude/projects`, `~/.claude/projects`, and supported Claude Desktop project stores, parsing
assistant `message.usage` fields (`input`, `cache_read`, `cache_creation`, `output`). These are local
measurements/estimates and do not prove the provider's billed amount.

CodexBar also documents non-local usage/cost integrations:

* OpenAI Admin API: organization completion usage and spend.
* Anthropic Admin API: `/v1/organizations/cost_report` and
  `/v1/organizations/usage_report/messages` for spend/message/token summaries.
* Grok is split from **xAI**: the xAI provider's management API supplies prepaid balance and daily USD
  spend, while consumer Grok supplies subscription quota.

## onWatch

**Pinned upstream state:** `onllm-dev/onWatch`, commit
[`32fc35d7a096b9fc67b761607467617f4774cc45`](https://github.com/onllm-dev/onWatch/commit/32fc35d7a096b9fc67b761607467617f4774cc45).
Public overview: [`README.md`](https://github.com/onllm-dev/onWatch/blob/32fc35d7a096b9fc67b761607467617f4774cc45/README.md)
and [onwatch.onllm.dev](https://onwatch.onllm.dev/).

The architecture is: provider API polling about every 60 seconds → SQLite snapshots → dashboard/history,
cycle detection, anomaly detection, and burn-rate projections. Its cards normalize provider quotas:
Anthropic five-hour/7-day percentages, Codex five-hour/weekly limits, and provider-specific meters such as
Z.ai token budget. “Tokens” on a Z.ai quota card are therefore a quota unit, not a universal token ledger.

The README advertises historical trends and “consumption” history, but the public provider list and FAQ
describe quota/reset fields rather than local JSONL parsing or per-request input/output/cache/reasoning
accounting. Therefore:

* **Can onWatch show that a quota was consumed over time?** Yes, by storing snapshots and computing deltas,
  projections, and reset cycles.
* **Can it produce actual provider token totals/cost for Claude Code, Codex, Factory Droid, or Grok?**
  Not from the documented generic onWatch pipeline. For Claude Code and Codex it polls plan quota APIs;
  it does not document the CodexBar-style local transcript scanners. The current public README/site lists
  eight providers (Anthropic, Codex, Synthetic, Z.ai, Copilot, MiniMax, Antigravity, Gemini CLI); Grok and
  Factory Droid are not in that current list. Search results mentioning Grok should not be treated as the
  current supported surface without a pinned source path.

Relevant upstream source areas visible in the pinned repository are `internal/` (provider/client, agents,
storage, tracker and web packages), `docs/`, and the provider setup/test files. The source-of-truth behavior
is the pinned commit, not the changing marketing page.

## Provider-by-provider conclusion

| Surface | CodexBar | onWatch | Token/cost conclusion |
| --- | --- | --- | --- |
| Claude Code Pro/Max | OAuth/web/CLI quota windows | Anthropic quota polling | Quota only unless using CodexBar local logs or Anthropic admin analytics |
| Claude Code org/admin | Anthropic Admin API summaries | Not documented | Actual token fields and estimated cost are available from Anthropic's API |
| ChatGPT Codex plan | OAuth/app-server/web quota, credits | Codex quota polling | Quota/credits; CodexBar local JSONL scan can count tokens and estimate cost |
| Factory Droid | Factory account/web usage provider | Not in current public onWatch provider list | CodexBar provider is not documented as a token ledger; Factory's separate Analytics API is the token/cost source |
| Consumer Grok | x.ai billing RPC/web quota plus local signal fallback | Not in current public onWatch provider list | Remote subscription quota; CodexBar may count local Grok signal token counts when fallback data exists |
| xAI developer API | Management balance + daily USD spend | Not documented | Billing spend is available via xAI management surface, distinct from consumer Grok |

## First-party documentation cross-check

* [OpenAI Codex app-server](https://developers.openai.com/codex/app-server) documents
  `account/rateLimits/read` fields such as `usedPercent` and reset timestamps, and also documents
  `account/usage/read` with `summary.lifetimeTokens`, `peakDailyTokens`, and optional daily token buckets.
  Thus Codex has a token-activity endpoint in the current app-server docs, but CodexBar's documented
  `account/rateLimits/read` path is quota-focused; an adapter would need to call `account/usage/read`
  explicitly.
* [Anthropic Claude Code Analytics API](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)
  documents daily aggregated `/v1/organizations/usage_report/claude_code` records with
  `model_breakdown[].tokens.input/output/cache_read/cache_creation` and
  `estimated_cost`. Data can be delayed up to one hour and requires an admin key.
* [Factory Telemetry & Analytics](https://docs.factory.ai/enterprise/usage-cost-and-analytics) says customer
  OTEL metrics are activity metrics (files, tools, commits, etc.), while Factory's hosted Analytics API is
  the surface for “token consumption and cost estimates.” The page explicitly says those token/cost values
  are not part of the customer OTEL metric set.
* [xAI pricing](https://docs.x.ai/developers/pricing) confirms input, output, reasoning, cached, and image
  tokens are billable dimensions for the developer API. Pricing is not a usage-history API; it establishes
  how to price token records if an authenticated usage export is available.

## planofplan adaptation recommendation

1. Keep two separate data models: `quota_snapshot` (window, used percent, reset, remaining credits) and
   `token_usage` (timestamp/day, provider, model, input/output/cache/reasoning tokens, source, estimated cost,
   currency, coverage/confidence).
2. For local desktop statistics, reuse the CodexBar approach: read-only, opt-in scanners for Codex and
   Claude JSONL, with deduplication and an “estimate, not invoice” label. Never infer tokens from quota
   percentages.
3. Add direct token adapters only where the documented source supports them: OpenAI
   `account/usage/read`, Anthropic Claude Code Analytics Admin API, and Factory Analytics API for eligible
   enterprise accounts. Store source freshness and aggregation granularity.
4. Treat consumer Grok and Factory Droid plan cards as quota/account data unless an explicit analytics or
   local-log source is configured. Keep consumer Grok separate from xAI developer billing.
5. Do not import browser cookies, OAuth files, or environment secrets by default. Use existing authenticated
   provider clients and redact credentials in diagnostics; keep local history on-device.
