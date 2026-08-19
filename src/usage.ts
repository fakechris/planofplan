import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type {
  UsageAggregate,
  UsageConfidence,
  UsageRecord,
  UsageReport,
  UsageSource,
} from './types.ts';
import { fetchOfficialUsage } from './official-usage.ts';

const DAY_MS = 86_400_000;

interface NumericUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface UsageScanOptions {
  since?: number;
  until?: number;
  project?: string | null;
}

export interface CollectUsageOptions extends UsageScanOptions {
  includeOfficial?: boolean;
  codexRoot?: string;
  claudeRoots?: string[];
  droidRoot?: string;
  zcodeRoot?: string;
  kimiRoot?: string;
  grokRoot?: string;
  dshRoot?: string;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function dayFor(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function usageFromRecord(value: Record<string, unknown>): NumericUsage {
  const inputTokens = finiteNumber(value.input_tokens);
  const cachedInputTokens = finiteNumber(value.cached_input_tokens) || finiteNumber(value.cache_read_input_tokens);
  const cacheCreationInputTokens = finiteNumber(value.cache_creation_input_tokens);
  const outputTokens = finiteNumber(value.output_tokens);
  const reasoningOutputTokens = finiteNumber(value.reasoning_output_tokens);
  const totalTokens = finiteNumber(value.total_tokens)
    || inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function usageFromCamelCase(value: Record<string, unknown>): NumericUsage {
  const inputTokens = finiteNumber(value.inputTokens);
  const cachedInputTokens = finiteNumber(value.cacheReadTokens)
    || finiteNumber(value.inputCacheRead);
  const cacheCreationInputTokens = finiteNumber(value.cacheWriteTokens)
    || finiteNumber(value.inputCacheCreation);
  const outputTokens = finiteNumber(value.outputTokens)
    || finiteNumber(value.output);
  const reasoningOutputTokens = finiteNumber(value.reasoningTokens);
  const totalTokens = finiteNumber(value.totalTokens)
    || inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function subtractUsage(current: NumericUsage, previous: NumericUsage | null): NumericUsage {
  if (!previous) return current;
  return {
    inputTokens: current.inputTokens >= previous.inputTokens
      ? current.inputTokens - previous.inputTokens
      : current.inputTokens,
    cachedInputTokens: current.cachedInputTokens >= previous.cachedInputTokens
      ? current.cachedInputTokens - previous.cachedInputTokens
      : current.cachedInputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens >= previous.cacheCreationInputTokens
      ? current.cacheCreationInputTokens - previous.cacheCreationInputTokens
      : current.cacheCreationInputTokens,
    outputTokens: current.outputTokens >= previous.outputTokens
      ? current.outputTokens - previous.outputTokens
      : current.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens >= previous.reasoningOutputTokens
      ? current.reasoningOutputTokens - previous.reasoningOutputTokens
      : current.reasoningOutputTokens,
    totalTokens: current.totalTokens >= previous.totalTokens
      ? current.totalTokens - previous.totalTokens
      : current.totalTokens,
  };
}

function hasTokens(usage: NumericUsage): boolean {
  return usage.inputTokens > 0
    || usage.cachedInputTokens > 0
    || usage.cacheCreationInputTokens > 0
    || usage.outputTokens > 0
    || usage.reasoningOutputTokens > 0
    || usage.totalTokens > 0;
}

function stableModel(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
}

function costFor(model: string, usage: NumericUsage): number | null {
  // Prices are deliberately conservative and only cover stable public model ids.
  // Unknown or future models stay unpriced instead of presenting false precision.
  const normalized = model.toLowerCase();
  const price = normalized.includes('sonnet')
    ? { input: 3, cached: 0.3, cacheCreation: 3.75, output: 15 }
    : normalized.includes('haiku')
      ? { input: 1, cached: 0.1, cacheCreation: 1.25, output: 5 }
      : normalized === 'gpt-5'
        ? { input: 1.25, cached: 0.125, cacheCreation: 1.25, output: 10 }
        : null;
  if (!price) return null;
  const billableInput = normalized.includes('claude')
    ? usage.inputTokens
    : Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (billableInput * price.input
      + usage.cachedInputTokens * price.cached
      + usage.cacheCreationInputTokens * price.cacheCreation
      + usage.outputTokens * price.output) / 1_000_000
  );
}

function record(
  id: string,
  provider: string,
  model: string,
  timestamp: number,
  usage: NumericUsage,
  source: UsageSource = 'local',
  confidence: UsageConfidence = 'measured',
  options: { sessionId?: string | null; project?: string | null; estimatedCostUsd?: number | null; billableTokens?: number | null } = {},
): UsageRecord {
  return {
    id,
    day: dayFor(timestamp),
    timestamp,
    provider,
    model,
    sessionId: options.sessionId ?? null,
    project: options.project ?? null,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    totalTokens: usage.totalTokens
      || usage.inputTokens
      + usage.cachedInputTokens
      + usage.cacheCreationInputTokens
      + usage.outputTokens,
    billableTokens: options.billableTokens ?? null,
    estimatedCostUsd: options.estimatedCostUsd ?? costFor(model, usage),
    source,
    confidence,
    fetchedAt: Date.now(),
  };
}

function jsonlFiles(root: string, since: number): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = statSync(path);
          const datedPath = path.match(/(?:^|[/\\])(\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/);
          const pathDay = datedPath
            ? Date.parse(`${datedPath[1]}-${datedPath[2]}-${datedPath[3]}T00:00:00.000Z`)
            : null;
          if (
            (pathDay != null && pathDay + DAY_MS >= since)
            || (pathDay == null && stat.mtimeMs >= since - 2 * DAY_MS)
          ) {
            files.push(path);
          }
        } catch {
          /* file may be rotated while scanning */
        }
      }
    }
  };
  visit(root);
  return files.sort();
}

function inRange(timestamp: number, since: number, until: number): boolean {
  return timestamp >= since && timestamp < until;
}

function filesForRoot(root: string, since: number, suffix = '.jsonl'): string[] {
  if (!existsSync(root)) return [];
  try {
    if (statSync(root).isFile()) return [root];
  } catch {
    return [];
  }
  return jsonlFiles(root, since).filter((file) => file.endsWith(suffix));
}

function readZstdJsonl(file: string): string[] {
  try {
    const output = execFileSync(
      process.env.ZSTD_PATH?.trim()
        || (existsSync('/opt/homebrew/bin/zstd') ? '/opt/homebrew/bin/zstd' : 'zstd'),
      ['-dc', file],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    );
    return output.split(/\r?\n/);
  } catch {
    return [];
  }
}

function scanJsonlFiles(
  files: string[],
  parse: (value: Record<string, unknown>, file: string, lineIndex: number) => UsageRecord | null,
): UsageRecord[] {
  const result: UsageRecord[] = [];
  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (let lineIndex = 1; lineIndex <= lines.length; lineIndex += 1) {
      const line = lines[lineIndex - 1]!;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const item = parse(value as Record<string, unknown>, file, lineIndex);
      if (item) result.push(item);
    }
  }
  return result;
}

function parseZcodeRecord(
  value: Record<string, unknown>,
  file: string,
  lineIndex: number,
  since: number,
  until: number,
): UsageRecord | null {
  if (value.type !== 'model_io') return null;
  const timestamp = parseTimestamp(value.completedAt ?? value.startedAt, statSync(file).mtimeMs);
  if (!inRange(timestamp, since, until)) return null;
  const response = value.response && typeof value.response === 'object'
    ? value.response as Record<string, unknown>
    : {};
  const usage = response.usage && typeof response.usage === 'object'
    ? response.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const modelInfo = value.model && typeof value.model === 'object'
    ? value.model as Record<string, unknown>
    : {};
  const model = stableModel(response.modelId ?? modelInfo.modelId ?? 'unknown');
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : null;
  return record(
    `local:zcode:${file}:${typeof value.requestId === 'string' ? value.requestId : lineIndex}`,
    'zcode',
    model,
    timestamp,
    usageFromCamelCase(usage),
    'local',
    'measured',
    { sessionId },
  );
}

export function scanZcodeLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  return scanJsonlFiles(
    filesForRoot(root, since),
    (value, file, lineIndex) => parseZcodeRecord(value, file, lineIndex, since, until),
  );
}

function parseKimiCliRecord(
  value: Record<string, unknown>,
  file: string,
  lineIndex: number,
  since: number,
  until: number,
): UsageRecord | null {
  if (value.type !== 'usage.record' || !value.usage || typeof value.usage !== 'object') return null;
  const timestamp = parseTimestamp(value.time, statSync(file).mtimeMs);
  if (!inRange(timestamp, since, until)) return null;
  const usage = value.usage as Record<string, unknown>;
  const numeric: NumericUsage = {
    inputTokens: finiteNumber(usage.inputOther),
    cachedInputTokens: finiteNumber(usage.inputCacheRead),
    cacheCreationInputTokens: finiteNumber(usage.inputCacheCreation),
    outputTokens: finiteNumber(usage.output),
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  numeric.totalTokens = numeric.inputTokens
    + numeric.cachedInputTokens
    + numeric.cacheCreationInputTokens
    + numeric.outputTokens;
  return record(
    `local:kimi-cli:${file}:${lineIndex}`,
    'kimi-cli',
    stableModel(value.model),
    timestamp,
    numeric,
    'local',
    'measured',
  );
}

export function scanKimiCliLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  return scanJsonlFiles(
    filesForRoot(root, since),
    (value, file, lineIndex) => parseKimiCliRecord(value, file, lineIndex, since, until),
  );
}

function parseGrokRecord(
  value: Record<string, unknown>,
  file: string,
  lineIndex: number,
  since: number,
  until: number,
): UsageRecord | null {
  const ctx = value.ctx;
  if (!ctx || typeof ctx !== 'object') return null;
  const context = ctx as Record<string, unknown>;
  if (
    context.prompt_tokens == null
    && context.completion_tokens == null
    && context.reasoning_tokens == null
  ) return null;
  const timestamp = parseTimestamp(value.ts, statSync(file).mtimeMs);
  if (!inRange(timestamp, since, until)) return null;
  const numeric: NumericUsage = {
    inputTokens: finiteNumber(context.prompt_tokens),
    cachedInputTokens: finiteNumber(context.cached_prompt_tokens),
    cacheCreationInputTokens: 0,
    outputTokens: finiteNumber(context.completion_tokens),
    reasoningOutputTokens: finiteNumber(context.reasoning_tokens),
    totalTokens: finiteNumber(context.prompt_tokens) + finiteNumber(context.completion_tokens),
  };
  return record(
    `local:grok-cli:${file}:${lineIndex}`,
    'grok-cli',
    stableModel(context.model ?? context.model_id ?? 'unknown'),
    timestamp,
    numeric,
    'local',
    'measured',
    { sessionId: typeof value.sid === 'string' ? value.sid : null },
  );
}

export function scanGrokLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  const file = existsSync(root) && statSync(root).isFile() ? root : join(root, 'logs', 'unified.jsonl');
  return scanJsonlFiles(
    filesForRoot(file, since),
    (value, path, lineIndex) => parseGrokRecord(value, path, lineIndex, since, until),
  );
}

function parseDshRecord(
  value: Record<string, unknown>,
  file: string,
  lineIndex: number,
  since: number,
  until: number,
): UsageRecord | null {
  if (value.type !== 'assistant/message' || !value.data || typeof value.data !== 'object') return null;
  const data = value.data as Record<string, unknown>;
  if (!data.usage || typeof data.usage !== 'object') return null;
  const timestamp = parseTimestamp(value.time, statSync(file).mtimeMs);
  if (!inRange(timestamp, since, until)) return null;
  const message = data.message && typeof data.message === 'object'
    ? data.message as Record<string, unknown>
    : {};
  const source = message.source && typeof message.source === 'object'
    ? message.source as Record<string, unknown>
    : {};
  const route = data.route && typeof data.route === 'object'
    ? data.route as Record<string, unknown>
    : {};
  return record(
    `local:dsh:${file}:${typeof value.seq === 'number' ? value.seq : lineIndex}`,
    'dsh',
    stableModel(source.model ?? data.model ?? route.model ?? 'unknown'),
    timestamp,
    usageFromCamelCase(data.usage as Record<string, unknown>),
    'local',
    'measured',
  );
}

export function scanDshLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  const files = filesForRoot(root, since);
  const compressed = existsSync(root) && !statSync(root).isFile()
    ? (() => {
      const result: string[] = [];
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
            try {
              if (statSync(path).mtimeMs >= since - 2 * DAY_MS) result.push(path);
            } catch { /* rotated file */ }
          }
        }
      };
      visit(root);
      return result;
    })()
    : [];
  const result = scanJsonlFiles(
    files,
    (value, file, lineIndex) => parseDshRecord(value, file, lineIndex, since, until),
  );
  for (const file of compressed) {
    let lineIndex = 0;
    for (const line of readZstdJsonl(file)) {
      lineIndex += 1;
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const item = parseDshRecord(value, file, lineIndex, since, until);
        if (item) result.push(item);
      } catch { /* malformed event */ }
    }
  }
  return result;
}

export function scanDroidLogs(_root: string, _since = Date.now() - 30 * DAY_MS, _until = Date.now()): UsageRecord[] {
  // Factory/Droid session JSONL currently has no per-turn usage record. Do not
  // treat compaction summaryTokens or message metadata as consumption.
  return [];
}

export function scanCodexLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  const result: UsageRecord[] = [];
  for (const file of jsonlFiles(root, since)) {
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    let sessionId: string | null = null;
    let model = 'unknown';
    let turnId: string | null = null;
    let previous: NumericUsage | null = null;
    let eventIndex = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rootValue: unknown;
      try {
        rootValue = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rootValue || typeof rootValue !== 'object') continue;
      const rootRecord = rootValue as Record<string, unknown>;
      const payload = rootRecord.payload;
      if (!payload || typeof payload !== 'object') continue;
      const payloadRecord = payload as Record<string, unknown>;
      if (rootRecord.type === 'session_meta') {
        const session = payloadRecord.session_id ?? payloadRecord.id;
        if (typeof session === 'string') sessionId = session;
      }
      if (rootRecord.type === 'turn_context') {
        model = stableModel(payloadRecord.model);
        turnId = typeof payloadRecord.turn_id === 'string' ? payloadRecord.turn_id : null;
        previous = null;
      }
      if (rootRecord.type !== 'event_msg' || payloadRecord.type !== 'token_count') continue;
      const info = payloadRecord.info;
      if (!info || typeof info !== 'object') continue;
      const usageValue = (info as Record<string, unknown>).last_token_usage;
      if (!usageValue || typeof usageValue !== 'object') continue;
      const current = usageFromRecord(usageValue as Record<string, unknown>);
      const delta = subtractUsage(current, previous);
      previous = current;
      if (!hasTokens(delta)) continue;
      const timestamp = parseTimestamp(rootRecord.timestamp, Date.now());
      if (!inRange(timestamp, since, until)) continue;
      eventIndex += 1;
      result.push(record(
        `local:codex:${file}:${eventIndex}`,
        'codex',
        model,
        timestamp,
        delta,
        'local',
        'measured',
        { sessionId, project: null },
      ));
      void turnId;
    }
  }
  return result;
}

export function scanClaudeLogs(
  root: string,
  since = Date.now() - 30 * DAY_MS,
  until = Date.now(),
  project: string | null = null,
): UsageRecord[] {
  const byMessage = new Map<string, UsageRecord>();
  for (const file of jsonlFiles(root, since)) {
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    let lineIndex = 0;
    for (const line of lines) {
      lineIndex += 1;
      if (!line.trim()) continue;
      let rootValue: unknown;
      try {
        rootValue = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rootValue || typeof rootValue !== 'object') continue;
      const rootRecord = rootValue as Record<string, unknown>;
      if (rootRecord.type !== 'assistant') continue;
      const message = rootRecord.message;
      if (!message || typeof message !== 'object') continue;
      const messageRecord = message as Record<string, unknown>;
      const usage = messageRecord.usage;
      if (!usage || typeof usage !== 'object') continue;
      const timestamp = parseTimestamp(rootRecord.timestamp, Date.now());
      if (!inRange(timestamp, since, until)) continue;
      const usageRecord = usage as Record<string, unknown>;
      const normalized: NumericUsage = {
        ...usageFromRecord(usageRecord),
        totalTokens: finiteNumber(usageRecord.total_tokens)
          || finiteNumber(usageRecord.input_tokens)
          + (finiteNumber(usageRecord.cached_input_tokens) || finiteNumber(usageRecord.cache_read_input_tokens))
          + finiteNumber(usageRecord.cache_creation_input_tokens)
          + finiteNumber(usageRecord.output_tokens),
      };
      if (!hasTokens(normalized)) continue;
      const messageId = typeof messageRecord.id === 'string' ? messageRecord.id : `line-${lineIndex}`;
      const requestId = typeof rootRecord.requestId === 'string' ? rootRecord.requestId : '';
      const dedupeKey = `${messageId}:${requestId}`;
      const candidate = record(
        `local:claude:${messageId}:${requestId}`,
        'claude',
        stableModel(messageRecord.model),
        timestamp,
        normalized,
        'local',
        'measured',
        { project },
      );
      const previous = byMessage.get(dedupeKey);
      if (!previous || candidate.timestamp >= previous.timestamp) byMessage.set(dedupeKey, candidate);
    }
  }
  return [...byMessage.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateKey(
  records: UsageRecord[],
  key: string,
  fields: { day?: string; provider?: string; model?: string; source?: UsageSource; confidence?: UsageConfidence } = {},
): UsageAggregate {
  const aggregate: UsageAggregate = {
    key,
    day: fields.day,
    provider: fields.provider ?? 'all',
    model: fields.model ?? 'all',
    recordCount: records.length,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    billableTokens: null,
    estimatedCostUsd: null,
    source: fields.source,
    confidence: fields.confidence,
    lastFetchedAt: null,
  };
  for (const item of records) {
    aggregate.inputTokens += item.inputTokens;
    aggregate.cachedInputTokens += item.cachedInputTokens;
    aggregate.cacheCreationInputTokens += item.cacheCreationInputTokens;
    aggregate.outputTokens += item.outputTokens;
    aggregate.reasoningOutputTokens += item.reasoningOutputTokens;
    aggregate.totalTokens += item.totalTokens;
    if (item.billableTokens != null) aggregate.billableTokens = (aggregate.billableTokens ?? 0) + item.billableTokens;
    if (item.estimatedCostUsd != null) aggregate.estimatedCostUsd = (aggregate.estimatedCostUsd ?? 0) + item.estimatedCostUsd;
    aggregate.lastFetchedAt = Math.max(aggregate.lastFetchedAt ?? 0, item.fetchedAt ?? 0) || null;
  }
  return aggregate;
}

function sortAggregates(a: UsageAggregate, b: UsageAggregate): number {
  return (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1)
    || b.totalTokens - a.totalTokens
    || a.provider.localeCompare(b.provider)
    || a.model.localeCompare(b.model);
}

export function buildUsageReport(
  input: UsageRecord[],
  options: { since: number; until: number; generatedAt?: number },
): UsageReport {
  const records = input.filter((record) => inRange(record.timestamp, options.since, options.until));
  const totals = aggregateKey(records, 'totals');
  const daily = new Map<string, UsageRecord[]>();
  const models = new Map<string, UsageRecord[]>();
  const providers = new Map<string, UsageRecord[]>();
  const sources = new Map<string, UsageRecord[]>();
  const append = (map: Map<string, UsageRecord[]>, key: string, record: UsageRecord): void => {
    const bucket = map.get(key);
    if (bucket) bucket.push(record);
    else map.set(key, [record]);
  };
  for (const record of records) {
    const dailyKey = record.day;
    append(daily, dailyKey, record);
    const modelKey = `${record.provider}:${record.model}:${record.source}:${record.confidence}`;
    append(models, modelKey, record);
    const providerKey = `${record.provider}:${record.source}:${record.confidence}`;
    append(providers, providerKey, record);
    const sourceKey = `${record.source}:${record.confidence}`;
    append(sources, sourceKey, record);
  }
  const aggregateEntries = (
    map: Map<string, UsageRecord[]>,
    makeFields: (key: string) => {
      day?: string;
      provider?: string;
      model?: string;
      source?: UsageSource;
      confidence?: UsageConfidence;
    },
  ): UsageAggregate[] => [...map.entries()]
    .map(([key, value]) => aggregateKey(value, key, makeFields(key)))
    .sort(sortAggregates);

  return {
    generatedAt: options.generatedAt ?? Date.now(),
    since: options.since,
    until: options.until,
    recordCount: records.length,
    totals: {
      recordCount: records.length,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      cacheCreationInputTokens: totals.cacheCreationInputTokens,
      outputTokens: totals.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens,
      totalTokens: totals.totalTokens,
      billableTokens: totals.billableTokens,
      estimatedCostUsd: totals.estimatedCostUsd,
    },
    daily: aggregateEntries(daily, (key) => ({ day: key, provider: 'all', model: 'all' }))
      .sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '')),
    models: aggregateEntries(models, (key) => {
      const parts = key.split(':');
      const source = parts.at(-2) as UsageSource;
      const confidence = parts.at(-1) as UsageConfidence;
      parts.splice(-2);
      const provider = parts.shift() ?? 'all';
      return {
        provider,
        model: parts.join(':') || 'all',
        source,
        confidence,
      };
    }),
    providers: aggregateEntries(providers, (key) => {
      const [provider, source, confidence] = key.split(':') as [string, UsageSource, UsageConfidence];
      return { provider, model: 'all', source, confidence };
    }),
    sources: [...sources.entries()]
      .map(([key, value]) => {
        const [source, confidence] = key.split(':') as [UsageSource, UsageConfidence];
        const aggregate = aggregateKey(value, key);
        return {
          source,
          confidence,
          recordCount: value.length,
          totalTokens: aggregate.totalTokens,
          estimatedCostUsd: aggregate.estimatedCostUsd,
          fetchedAt: aggregate.lastFetchedAt ?? null,
        };
      })
        .sort((a, b) => (a.source === b.source ? a.confidence.localeCompare(b.confidence) : a.source === 'official' ? -1 : 1)),
  };
}

export function defaultUsageRange(days = 30): { since: number; until: number } {
  const until = Date.now();
  return { since: until - Math.min(365, Math.max(1, days)) * DAY_MS, until };
}

export async function collectUsageReport(store: Store, options: CollectUsageOptions = {}): Promise<UsageReport> {
  const range = {
    since: options.since ?? defaultUsageRange(30).since,
    until: options.until ?? Date.now(),
  };
  const codexRoot = options.codexRoot ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const claudeRoots = options.claudeRoots ?? [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(homedir(), '.config', 'claude', 'projects'),
    join(homedir(), '.claude', 'projects'),
  ].filter(Boolean);
  const local = [
    ...scanCodexLogs(codexRoot, range.since, range.until),
    ...claudeRoots.flatMap((root) => scanClaudeLogs(root, range.since, range.until)),
    ...scanZcodeLogs(
      options.zcodeRoot ?? process.env.ZCODE_HOME ?? join(homedir(), '.zcode', 'cli'),
      range.since,
      range.until,
    ),
    ...scanKimiCliLogs(
      options.kimiRoot ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'),
      range.since,
      range.until,
    ),
    ...scanGrokLogs(
      options.grokRoot ?? process.env.GROK_HOME ?? join(homedir(), '.grok'),
      range.since,
      range.until,
    ),
    ...scanDshLogs(
      options.dshRoot ?? process.env.DSH_HOME ?? join(homedir(), '.dsh', 'sessions'),
      range.since,
      range.until,
    ),
    ...scanDroidLogs(
      options.droidRoot ?? process.env.FACTORY_HOME ?? join(homedir(), '.factory', 'sessions'),
      range.since,
      range.until,
    ),
  ];
  const official = options.includeOfficial === false ? [] : await fetchOfficialUsage(range);
  store.upsertUsageRecords([...local, ...official]);
  return store.getUsageReport(range.since, range.until);
}
