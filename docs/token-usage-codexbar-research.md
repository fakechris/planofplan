# CodexBar token-usage research

Research date: 2026-08-19. CodexBar upstream is pinned to
[`453174fe13eebdf403cc0776268eb2b101fd9553`](https://github.com/steipete/CodexBar/commit/453174fe13eebdf403cc0776268eb2b101fd9553),
the `main` tip on the research date. Findings below distinguish local token estimates from provider quota
or billing data.

## Short answer

- CodexBar's **Usage & Spend** page is a local, read-only, list-price estimate, not an invoice or quota
  meter. It displays daily history, token mix, model/session/project breakdowns, cost, coverage, and a
  365-day token heatmap. Sources without the token-cost contract are omitted rather than shown as empty rows.
- Native Codex logs are `CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl` plus
  `CODEX_HOME/archived_sessions/*.jsonl` (default `~/.codex`). Native Claude logs are JSONL under
  `CLAUDE_CONFIG_DIR/projects` or the fallback `~/.config/claude/projects` and `~/.claude/projects`.
- Codex token rows come from `event_msg` `token_count` records, with `turn_context` model markers.
  Claude rows come from assistant records' `message.usage`. Both preserve input/output/cache dimensions;
  Codex also preserves reasoning when present.
- CodexBar uses persistent per-file caches, incremental offsets, file identity/mtime/size checks, and
  duplicate suppression. Claude streaming chunks are deduplicated by `message.id + requestId`; matching
  assistant entry IDs across roots are counted once.
- Factory/Droid has quota/account endpoints, but no CodexBar local token-cost scanner. Grok has a local
  informational session-signal scanner, but its normal provider paths expose subscription credits/quota,
  not a token ledger. xAI developer billing is a separate provider.

## Codex implementation

Documented source: [`docs/codex.md`](https://github.com/steipete/CodexBar/blob/453174fe13eebdf403cc0776268eb2b101fd9553/docs/codex.md).
Implementation paths:

- `Sources/CodexBarCore/CostUsageFetcher.swift` — chooses remote-vs-local snapshots, clamps the history
  window to 1–365 days, refreshes pricing, and returns `CostUsageTokenSnapshot`.
- `Sources/CodexBarCore/Vendored/CostUsage/CostUsageScanner.swift` — native Codex JSONL parsing,
  incremental cache, fork/lineage handling, cumulative-counter accounting, and daily reports.
- `Sources/CodexBarCore/Vendored/CostUsage/CostUsageModels.swift` and
  `Sources/CodexBarCore/Vendored/CostUsage/CostUsageStore.swift` — report/cache model and persisted store.
- `Sources/CodexBarCore/PiSessionCostScanner.swift` — optional compatible `~/.pi/agent/sessions` and
  `~/.omp/agent/sessions` JSONL input; it is merged into normal Codex totals only where the account scope
  permits it.

The native scanner's persisted row shape (`CodexUsageRow`) is:

```json
{
  "day": "YYYY-MM-DD",
  "model": "normalized-model",
  "rawModel": "optional-source-model",
  "turnID": "optional-turn-id",
  "eventIndex": 12,
  "timestampUnixMs": 0,
  "input": 1000,
  "cached": 200,
  "output": 300,
  "reasoning": 100,
  "knownCostNanos": null,
  "unpricedTokens": 0,
  "pricingModel": "optional",
  "pricingMode": "optional"
}
```

`event_msg` token-count data is cumulative in many rollouts. CodexBar calculates non-negative deltas
against a monotonic watermark and remembers up to 64 raw snapshots for exact re-emission suppression.
If a component drops below the watermark, it latches interleaved/fork mode and uses containment rules so
switching lineages cannot recount the gap. Fork children inherit parent baselines; unresolved parents are
buffered and retried after dependency discovery. Duplicate files are reconciled by file identity, and
changed files are rescanned or resumed from the cached byte offset. This is important for correctness:
naively summing every `token_count` line overcounts streaming/cumulative records.

Codex local estimates use bundled `CostUsagePricing` rates, optionally refreshed from a local models.dev
cache. Costs are stored in nanodollars internally and resolved by token class/model; `knownCostNanos` is
reserved for authoritative source costs, while model-table pricing is explicitly an estimate. Historical
pricing can be date-aware. The UI keeps currencies separate and labels local values as estimates.

## Claude implementation

Documented source: [`docs/claude.md`](https://github.com/steipete/CodexBar/blob/453174fe13eebdf403cc0776268eb2b101fd9553/docs/claude.md).
The same `CostUsageFetcher.swift`, `PiSessionCostScanner.swift`, and
`Vendored/CostUsage/CostUsageScanner.swift` paths handle local Claude usage. Native records are:

```json
{
  "type": "assistant",
  "message": {
    "id": "message-id",
    "model": "claude-model",
    "usage": {
      "input_tokens": 1000,
      "cache_read_input_tokens": 200,
      "cache_creation_input_tokens": 50,
      "output_tokens": 300
    }
  },
  "requestId": "stream-request-id"
}
```

The implementation accepts Claude's usage keys for input, cache read, cache creation, and output, then
produces daily/model totals and estimated USD cost. Streaming chunks are cumulative, so the scanner
deduplicates by `message.id + requestId`; assistant entry IDs are also deduplicated across overlapping
roots, while distinct turns remain. Pi/OMP records are attributed to Claude only when the assistant
provider is `anthropic`, and are bucketed by assistant timestamp (allowing one session to span days/models).

Claude's OAuth/web quota paths are separate from local cost history. An Anthropic Admin API key can also
provide organization-level summaries, but that is not the Pro/Max quota endpoint.

## Display/report pattern

The upstream provider contract calls the page “Settings → Usage & Spend.” Recommended report fields are:
`date`, provider, model, input tokens, output tokens, cache-read tokens, cache-creation tokens, reasoning
(when available), total tokens, estimated cost, pricing/coverage provenance, and optional session/project.
Daily entries and an overall summary are sorted by cost, then tokens, then model. A coverage gap means
“not scanned,” not zero usage. The page exposes 7/30/90-day and All (365-day scan) ranges; Codex account
rows use a fixed 30-day scan and do not fall back from a selected account home to ambient `~/.codex`.

## Factory and Grok boundaries

CodexBar's [`docs/factory.md`](https://github.com/steipete/CodexBar/blob/453174fe13eebdf403cc0776268eb2b101fd9553/docs/factory.md)
lists API/web auth and `GET https://api.factory.ai/api/billing/limits` plus legacy subscription-usage
endpoints. These map to 5h/weekly/monthly or Standard/Premium quota windows. The file has no local
Droid JSONL scanner or token-cost report. Factory's official [Telemetry & Analytics
documentation](https://docs.factory.ai/enterprise/usage-cost-and-analytics) says hosted Analytics
provides aggregated token consumption/cost estimates; customer OTEL metrics are activity metrics, not
the token ledger. Treat Factory quota and Factory Analytics as separate adapters.

CodexBar's [`docs/grok.md`](https://github.com/steipete/CodexBar/blob/453174fe13eebdf403cc0776268eb2b101fd9553/docs/grok.md)
describes `x.ai/billing`, CLI-proxy/grok.com billing fallbacks, and
`~/.grok/sessions/**/signals.json`. Signals contain fields such as `contextTokensUsed`,
`totalTokensBeforeCompaction`, `modelsUsed`, and `primaryModelId`; CodexBar exposes these as an
informational `GrokLocalSessionSummary`, not as the Codex/Claude Usage & Spend token ledger. The
consumer Grok provider reports credits/subscription periods. xAI's separate [developer pricing
page](https://docs.x.ai/developers/pricing) defines input, cached, output, reasoning, and image token
prices, but is not a usage-history endpoint.

## First-party API cross-check

- OpenAI's [Codex app-server docs](https://developers.openai.com/codex/app-server) document
  `account/rateLimits/read` (`usedPercent`, window, reset) as quota data and
  `account/usage/read` as token activity: `summary.lifetimeTokens`, `peakDailyTokens`, and optional
  `dailyUsageBuckets[{startDate,tokens}]`. This is a possible direct Codex activity adapter, distinct
  from local JSONL estimates.
- Anthropic's [Claude Code Analytics API](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api)
  is an admin, daily-aggregated endpoint, paginated by cursor. `model_breakdown[].tokens` contains
  `input`, `output`, `cache_read`, and `cache_creation`; `estimated_cost.amount` is cents USD.
  Data is delayed up to one hour and is organization/user scoped, not a local per-session feed.

## Planofplan implication

Keep `quota_snapshot` and `token_usage` separate. For desktop-local Codex/Claude statistics, follow
CodexBar's opt-in read-only scanners and cumulative-row deduplication, and label cost as an estimate.
Use OpenAI `account/usage/read`, Anthropic Claude Code Analytics, or Factory Analytics only as explicit
remote sources with their authentication, scope, freshness, and coverage recorded. Do not infer token
counts or cost from quota percentages, and do not treat Grok signals or Factory subscription windows as
equivalent to a token ledger.
