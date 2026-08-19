# CodexBar provider research: local token usage

Research target: the current `main` branch of the primary CodexBar repository,
[`steipete/CodexBar`](https://github.com/steipete/CodexBar). The repository's
provider overview says that native Usage & Spend/token-cost sources are
currently Codex, Claude, OpenAI Admin, Mistral, AWS Bedrock, Vertex AI, Cursor,
and OpenCode Go. The providers below are therefore not native token-cost
sources unless explicitly noted.

## Summary

| Requested provider/surface | CodexBar source currently supported | Local log root / JSONL scanner | Cost source or quota/session signal |
| --- | --- | --- | --- |
| Droid / Factory | Factory API key or Factory web/session auth | None documented or implemented | Quota/billing-limit windows and subscription usage; no local token-cost history |
| zcode | No matching CodexBar provider or local source found. The closest registered provider is `z.ai` | None | z.ai quota API only; not zcode local usage |
| Kimi CLI | Kimi Code API, or read-only access token from the Kimi Code CLI credential file; web cookie fallback | No Kimi JSONL usage scanner | 5-hour and weekly request quotas; optional web membership enrichment; no token-cost history |
| Grok CLI | `grok agent stdio` JSON-RPC billing, CLI-proxy billing REST, web gRPC fallback | `~/.grok/sessions/<encoded-cwd>/<session-id>/signals.json` | Billing/quota is primary; local signals are informational session/token summaries, not priced cost history |
| DeepSeek web / Dsh harness | DeepSeek provider only reads API balance | None | Paid API balance only; no DeepSeek web/Dsh local scanner |

## CodexBar's applicable cost contract

`docs/providers.md` explicitly says that Usage & Spend is a local estimated-cost
history and that providers without the native token-cost contract are omitted,
rather than shown as empty subscriptions. `docs/provider.md` defines the host
`TokenCostAPI` as local-log integration and says the current integration is for
Codex and Claude. Thus a provider's quota endpoint, billing balance, or local
session diagnostic does not by itself make it a token-cost provider.

The Codex local scanner documentation gives the only relevant deduplication
rules: native Codex scans parse `event_msg` `token_count` entries and
`turn_context` model markers; `turn_context` wins for model bucketing; matching
assistant entry IDs within one session are counted once across roots while
distinct turns remain. Those rules are not documented as shared rules for
Factory, z.ai, Kimi, Grok, or DeepSeek, and CodexBar has no corresponding
JSONL scanner for them.

## Droid / Factory

The primary provider document calls the provider “Factory (displayed as
Droid)” and defines `auto`, `api`, and `web` sources. API auth resolves a
Factory key from CodexBar config, `FACTORY_API_KEY`, or `~/.factory/.env`.
Web auth tries cached cookies, CodexBar's stored session, bearer/WorkOS
tokens, browser local storage, and browser cookies.

Relevant API endpoints are:

* `GET https://api.factory.ai/api/billing/limits` (preferred for token-rate
  limit accounts, with 5-hour/weekly/monthly windows).
* `GET <baseURL>/api/app/auth/me` (organization/subscription metadata).
* `GET <baseURL>/api/organization/subscription/usage` (Standard/Premium token
  usage and billing window).

The documented snapshot mapping is quota-oriented: token-rate-limit accounts
become primary 5-hour, secondary weekly, tertiary monthly, with optional Core
windows; legacy accounts become Standard/Premium lanes. The document names no
Factory/Droid local log root, JSONL event schema, model attribution field, or
cross-root deduplication rule. It also is not listed in the native cost-history
source list, so these token usage values should be treated as quota/subscription
signals, not CodexBar token-cost events.

Source: [docs/factory.md](https://github.com/steipete/CodexBar/blob/main/docs/factory.md),
especially “Data sources + fallback order”, “Factory API endpoints”, and
“Snapshot mapping”; [docs/providers.md](https://github.com/steipete/CodexBar/blob/main/docs/providers.md#usage--spend-settings).

## zcode and z.ai

No `zcode` provider, local path, JSONL event shape, or token-cost scanner is
documented in the current CodexBar provider registry/docs. The closest match is
the registered `z.ai` provider, which is an API-token quota integration:
`~/.codexbar/config.json`/`Z_AI_API_KEY`, with global or BigModel CN quota hosts
and optional host overrides. This is not evidence of support for a local
“zcode” CLI or harness.

Accordingly, there is no CodexBar-supported zcode log root, event-to-model
attribution rule, or deduplication rule to reuse. z.ai is a quota API source,
not a native token-cost source.

Sources: [z.ai section in docs/providers.md](https://github.com/steipete/CodexBar/blob/main/docs/providers.md#zai);
[provider registry/authoring contract](https://github.com/steipete/CodexBar/blob/main/docs/provider.md).

## Kimi CLI / Kimi Code

CodexBar supports Kimi Code through:

1. API key or a fresh access token read from
   `~/.kimi-code/credentials/kimi-code.json` (the path can be changed with
   `KIMI_CODE_HOME`).
2. Browser/Desktop/manual `kimi-auth` JWT fallback/enrichment.

For API/CLI auth it calls `GET https://api.kimi.com/coding/v1/usages`. The
documented response is a `usage` object containing string-valued `limit`,
`used`, `remaining`, and `resetTime`, plus a `limits` array whose entries have
`window.duration`, `window.timeUnit`, and nested `detail` values. The web
fallback posts to
`https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages`
and reads the same shape under a `usages[]` item scoped to coding.

These shapes contain quota counters and reset times, not model IDs or
per-request token usage. The Kimi document names no Kimi CLI session/log root
and no JSONL scanner. It explicitly describes weekly request quota and a
5-hour rate limit, while the provider overview does not list Kimi among native
token-cost sources. Therefore Kimi CLI support is quota/session-account
monitoring, not local token-cost tracking; there are no Kimi-specific
deduplication rules.

Source: [docs/kimi.md](https://github.com/steipete/CodexBar/blob/main/docs/kimi.md),
especially “Method 2: Kimi Code CLI”, “API Details”, and “Authentication
Priority”; [Kimi provider overview](https://github.com/steipete/CodexBar/blob/main/docs/providers.md#kimi).

## Grok CLI

Grok's primary path is not a JSONL log scan. CodexBar launches
`grok agent stdio` and uses newline-delimited JSON-RPC 2.0:

* `initialize` with protocol/capability parameters.
* `x.ai/billing` with no parameters.

The documented billing result has `billingCycle` start/end, monetary
`monthlyLimit`/`onDemandCap`, and `usage` fields (`includedUsed`,
`onDemandUsed`, `totalUsed`). CodexBar maps
`usage.totalUsed / monthlyLimit` to a primary credit window and the billing
period end to reset time. If the CLI method is unavailable, it falls through
to CLI-proxy JSON billing, then grok.com billing gRPC-web.

The only local Grok source is an informational fallback:

`~/.grok/sessions/<encoded-cwd>/<session-id>/signals.json`

CodexBar walks sessions from the last 30 days and reads the documented
diagnostic fields `totalTokensBeforeCompaction`, `contextTokensUsed`,
`modelsUsed`, the latest session timestamp, and optionally `primaryModelId`.
It aggregates these into a `GrokLocalSessionSummary` (session count, total
tokens, last-session time, primary model) for diagnostics when billing RPC is
unavailable. This is the only requested provider with an explicit local token
shape, but it is not a priced Usage & Spend source: there is no per-event
JSONL schema, model-cost calculation, or cross-root/duplicate-event rule.
`modelsUsed`/`primaryModelId` provide coarse session attribution only.

Source: [docs/grok.md](https://github.com/steipete/CodexBar/blob/main/docs/grok.md),
especially “JSON-RPC contract”, “Mapping to UsageSnapshot”, and “Local fallback”.

## DeepSeek web / Dsh harness

The current provider overview registers **DeepSeek** as an API-key provider:
“API key from env or token accounts → balance endpoint”. It does not document a
DeepSeek web-cookie source, a Dsh harness integration, local log roots,
JSONL events, model attribution, or deduplication. DeepSeek is also absent from
the native Usage & Spend source list.

Therefore CodexBar currently provides only paid API balance/account telemetry
for DeepSeek. No CodexBar primary-source documentation supports treating
DeepSeek web or a Dsh harness as a local token-cost source. Any Dsh-specific
root/event contract would need to be researched from Dsh itself rather than
inferred from CodexBar.

Source: [DeepSeek section in docs/providers.md](https://github.com/steipete/CodexBar/blob/main/docs/providers.md#deepseek);
[Usage & Spend scope](https://github.com/steipete/CodexBar/blob/main/docs/providers.md#usage--spend-settings).

## Bottom line for provider parity

For local token-cost ingestion, CodexBar's current reusable precedent is the
Codex scanner: explicit roots, JSONL event parsing, model markers, pricing
lookup, and assistant-ID deduplication. Among the requested providers,
Grok's `signals.json` is only a coarse diagnostic/session signal. Factory,
z.ai, Kimi, and DeepSeek are remote quota/balance integrations; none has a
CodexBar-supported local JSONL cost source or provider-specific deduplication
contract.
