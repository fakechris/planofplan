# CodexBar incremental scan research

Primary source reviewed: [steipete/CodexBar](https://github.com/steipete/CodexBar), `main` (Aug 2026).

## Findings

- **The generic cost scan is still a full-corpus operation.** `CostUsageScanExecutor` explicitly says cost-usage scans “read and parse the full local session corpus synchronously.” Its purpose is to serialize that work on a utility queue and support cancellation; it is not itself a cache:
  [CostUsageScanExecutor.swift](https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/CostUsageScanExecutor.swift).

- **Codex has a persistent, file-level incremental cache.** The Usage & Spend fetcher describes Codex as having an “incremental JSONL scanner,” and exposes bounded background catch-up. Cached per-file state includes `parsedBytes`, file size, completion, a file ID, JSONL resume state/offset, fork-retry buffers, discovery state, and active-lookback cursors:
  [CostUsageFetcher.swift](https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/CostUsageFetcher.swift).

- **Codex workspace attribution adds a SQLite sidecar.** `CodexWorkspaceUsageSidecar` stores `usage_rollouts`, daily rows, event rows, snapshots, and index state. A rollout is considered unchanged only when its source identity matches: modification time in Unix milliseconds, size, parsed bytes, session ID, cache-generation/producer key, pricing key, and a content fingerprint. Unchanged rows are merely “touched”; changed rows have their daily/events rows deleted and reinserted. This is deduplication by stable rollout path plus source identity, not blind reprocessing:
  [CodexWorkspaceUsageSidecar.swift](https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/CodexWorkspaceUsageSidecar.swift).

- **The scanner persists cursors, not just a report.** The progress key includes each incomplete file’s parsed-byte count, size, and JSONL resume offset, plus directory/file discovery indices and current-window lookback day/directory offsets. This supports bounded catch-up across refreshes rather than rescanning all historical files:
  [CostUsageFetcher.swift](https://raw.githubusercontent.com/steipete/CodexBar/main/Sources/CodexBarCore/CostUsageFetcher.swift).

- **Claude’s local cost path is different, but it does have a documented cache.** `CostUsageFetcher` calls the same `CostUsageScanner.loadDailyReportCancellable` for Codex and Claude, while its comments say Codex owns project/session attribution and optional Pi merge state, and Claude/Vertex share the transcript scanner with mutually exclusive provider filters. The Codex-only cache/catch-up checks (`codexScanCatchUpStatus`, roots fingerprints, `codexHistoryCoverageIsEstablished`) are gated to `.codex`. The Claude provider docs identify `~/Library/Caches/CodexBar/cost-usage/claude-v2.json` as the native + merged provider cache and `pi-sessions-v7.json` as the pi-compatible cache. They also specify deduplication: streaming chunks are deduplicated by `message.id + requestId`, and matching assistant entry IDs seen across roots count once. The docs do not state that Claude’s cache uses per-file mtime or byte cursors; do not assume Codex’s incremental JSONL machinery applies to Claude transcripts:
  [Claude provider docs](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/claude.md).

## Practical implication

For a Codex-like implementation, persist per-file metadata and a byte cursor, resume append-only JSONL reads, invalidate on truncation/identity changes, and deduplicate parsed events with stable `(file, event index)` keys. For Claude, first verify whether the current transcript scanner has an equivalent cache; the current CodexBar fetcher API only proves incremental behavior for Codex.
