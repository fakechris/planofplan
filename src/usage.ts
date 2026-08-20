import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { Store } from './db.ts';
import type {
  UsageAggregate,
  UsageConfidence,
  UsageRecord,
  UsageReport,
  PlanUsageSummary,
  UsageScanFile,
  UsageSource,
} from './types.ts';
import { fetchOfficialUsage } from './official-usage.ts';
import { collectSessionCatalog } from './sessions.ts';

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

/**
 * 家族级估算价格表（USD / MTok）。coding plan 场景下这是「折算金额」而非
 * 账单——按 API 牌价折算消耗当量，未知家族保持 null 而不是虚构精度。
 * 数值可按各家公示价随时调整。
 */
const MODEL_PRICE_FAMILIES: Array<{
  match: RegExp;
  input: number;
  cached: number;
  cacheCreation: number;
  output: number;
}> = [
  { match: /opus/, input: 15, cached: 1.5, cacheCreation: 18.75, output: 75 },
  { match: /sonnet/, input: 3, cached: 0.3, cacheCreation: 3.75, output: 15 },
  { match: /haiku/, input: 1, cached: 0.1, cacheCreation: 1.25, output: 5 },
  { match: /fable/, input: 3, cached: 0.3, cacheCreation: 3.75, output: 15 },
  { match: /^gpt-5/, input: 1.25, cached: 0.125, cacheCreation: 1.25, output: 10 },
  { match: /deepseek.*flash/, input: 0.1, cached: 0.01, cacheCreation: 0.13, output: 0.4 },
  { match: /deepseek/, input: 0.5, cached: 0.05, cacheCreation: 0.63, output: 2 },
  { match: /^glm-?5/, input: 0.6, cached: 0.06, cacheCreation: 0.75, output: 2.2 },
  { match: /kimi/, input: 0.6, cached: 0.06, cacheCreation: 0.75, output: 2.2 },
  { match: /minimax-m/i, input: 0.6, cached: 0.06, cacheCreation: 0.75, output: 2.2 },
];

function costFor(model: string, usage: NumericUsage): number | null {
  const normalized = model.toLowerCase();
  const price = MODEL_PRICE_FAMILIES.find((family) => family.match.test(normalized));
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
  options: {
    sessionId?: string | null;
    project?: string | null;
    sourceFile?: string | null;
    estimatedCostUsd?: number | null;
    billableTokens?: number | null;
  } = {},
): UsageRecord {
  return {
    id,
    day: dayFor(timestamp),
    timestamp,
    provider,
    model,
    sessionId: options.sessionId ?? null,
    project: options.project ?? null,
    sourceFile: options.sourceFile ?? null,
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
  try {
    if (statSync(root).isFile()) {
      return root.endsWith('.jsonl') ? [root] : [];
    }
  } catch {
    return [];
  }
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
      if (item) result.push({ ...item, sourceFile: file });
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
    { sessionId: file.replace(/[/\\][^/\\]+$/, '').replace(/^.*[/\\]/, '') },
  );
}

export function scanDshLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  const files = filesForRoot(root, since);
  const rootIsFile = existsSync(root) && statSync(root).isFile();
  const compressed = rootIsFile && root.endsWith('.jsonl.zstd')
    ? [root]
    : existsSync(root) && !rootIsFile
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
        if (item) result.push({ ...item, sourceFile: file });
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

interface CodexCursor {
  parsedBytes: number;
  sessionId: string | null;
  model: string;
  turnId: string | null;
  previous: NumericUsage | null;
  eventIndex: number;
  cwd: string | null;
}

function emptyCodexCursor(): CodexCursor {
  return {
    parsedBytes: 0,
    sessionId: null,
    model: 'unknown',
    turnId: null,
    previous: null,
    eventIndex: 0,
    cwd: null,
  };
}

function parseCodexCursor(value: string | null | undefined): CodexCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CodexCursor>;
    if (
      typeof parsed.parsedBytes !== 'number'
      || typeof parsed.eventIndex !== 'number'
      || typeof parsed.model !== 'string'
    ) return null;
    const previous = parsed.previous && typeof parsed.previous === 'object'
      ? {
        inputTokens: finiteNumber((parsed.previous as NumericUsage).inputTokens),
        cachedInputTokens: finiteNumber((parsed.previous as NumericUsage).cachedInputTokens),
        cacheCreationInputTokens: finiteNumber((parsed.previous as NumericUsage).cacheCreationInputTokens),
        outputTokens: finiteNumber((parsed.previous as NumericUsage).outputTokens),
        reasoningOutputTokens: finiteNumber((parsed.previous as NumericUsage).reasoningOutputTokens),
        totalTokens: finiteNumber((parsed.previous as NumericUsage).totalTokens),
      }
      : null;
    return {
      parsedBytes: Math.max(0, parsed.parsedBytes),
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      model: stableModel(parsed.model),
      turnId: typeof parsed.turnId === 'string' ? parsed.turnId : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      previous,
      eventIndex: Math.max(0, parsed.eventIndex),
    };
  } catch {
    return null;
  }
}

function scanCodexFile(
  file: string,
  since: number,
  until: number,
  initialCursor: CodexCursor | null = null,
): { records: UsageRecord[]; cursor: CodexCursor } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return { records: [], cursor: initialCursor ?? emptyCodexCursor() };
  }
  const start = initialCursor && initialCursor.parsedBytes <= bytes.length
    ? initialCursor.parsedBytes
    : 0;
  const cursor = initialCursor && start > 0 ? { ...initialCursor } : emptyCodexCursor();
  const content = bytes.subarray(start).toString('utf8');
  const lines = content.split('\n');
  const completeLines = Math.max(0, lines.length - 1);
  const result: UsageRecord[] = [];
  let consumed = 0;
  for (let index = 0; index < completeLines; index += 1) {
    const line = lines[index]!;
    consumed += Buffer.byteLength(line, 'utf8') + 1;
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
      if (typeof session === 'string') cursor.sessionId = session;
    }
    if (rootRecord.type === 'turn_context') {
      cursor.model = stableModel(payloadRecord.model);
      cursor.turnId = typeof payloadRecord.turn_id === 'string' ? payloadRecord.turn_id : null;
      cursor.previous = null;
      if (typeof payloadRecord.cwd === 'string' && payloadRecord.cwd.trim()) {
        cursor.cwd = payloadRecord.cwd.trim();
      }
    }
    if (rootRecord.type !== 'event_msg' || payloadRecord.type !== 'token_count') continue;
    const info = payloadRecord.info;
    if (!info || typeof info !== 'object') continue;
    const usageValue = (info as Record<string, unknown>).last_token_usage;
    if (!usageValue || typeof usageValue !== 'object') continue;
    const current = usageFromRecord(usageValue as Record<string, unknown>);
    const delta = subtractUsage(current, cursor.previous);
    cursor.previous = current;
    if (!hasTokens(delta)) continue;
    const timestamp = parseTimestamp(rootRecord.timestamp, Date.now());
    if (!inRange(timestamp, since, until)) continue;
    cursor.eventIndex += 1;
    result.push(record(
      `local:codex:${file}:${cursor.eventIndex}`,
      'codex',
      cursor.model,
      timestamp,
      delta,
      'local',
      'measured',
      { sessionId: cursor.sessionId, project: cursor.cwd, sourceFile: file },
    ));
  }
  cursor.parsedBytes = start + consumed;
  return { records: result, cursor };
}

export function scanCodexLogs(root: string, since = Date.now() - 30 * DAY_MS, until = Date.now()): UsageRecord[] {
  const result: UsageRecord[] = [];
  for (const file of jsonlFiles(root, since)) {
    result.push(...scanCodexFile(file, since, until).records);
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
        { project, sourceFile: file, sessionId: file.replace(/^.*[/\\]/, '').replace(/\.jsonl$/i, '') },
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

/**
 * 本地 usage 的 provider/model → plan slug 归属。同一 usage provider 下的
 * 模型可能属于不同 plan（claude provider 下有 glm/MiniMax 模型），因此
 * 以模型名优先、provider 兜底。无法归属返回 null（不计入 byPlan）。
 */
export function usagePlanFor(provider: string, model: string): string | null {
  const m = model.toLowerCase();
  if (m.startsWith('kimi') || provider === 'kimi-cli') return 'kimi';
  if (m.startsWith('glm') || provider === 'zcode') return 'glm';
  if (m.includes('minimax')) return 'minimax';
  if (m.startsWith('deepseek') || provider === 'dsh') return 'deepseek';
  if (provider === 'grok-cli') return 'grok';
  if (m.startsWith('gpt') || provider === 'codex') return 'codex';
  // claude 壳是多租户入口：可经 router 跑任意第三方模型（实测有 MiniMax-M3、
  // glm-5.2 混在 provider=claude 下）。只有明确的 Anthropic 家族才归入
  // claude plan；未识别的第三方模型不归属任何 plan（保留在全局 totals，
  // 不虚构到某个 plan 的用量里）。
  const isAnthropicFamily = m.startsWith('claude') || /sonnet|opus|haiku|fable/.test(m);
  if (isAnthropicFamily && provider === 'claude') return 'claude';
  return null;
}

function buildPlanUsageSummary(records: UsageRecord[]): PlanUsageSummary[] {
  const byPlan = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const plan = usagePlanFor(record.provider, record.model);
    if (!plan) continue;
    const bucket = byPlan.get(plan);
    if (bucket) bucket.push(record);
    else byPlan.set(plan, [record]);
  }
  return [...byPlan.entries()]
    .map(([plan, bucket]) => {
      const models = new Map<string, number>();
      for (const record of bucket) {
        models.set(record.model, (models.get(record.model) ?? 0) + record.totalTokens);
      }
      const cost = bucket.reduce((sum, record) => sum + (record.estimatedCostUsd ?? 0), 0);
      const hasCost = bucket.some((record) => record.estimatedCostUsd != null);
      const projects = new Map<string, { totalTokens: number; cost: number }>();
      for (const record of bucket) {
        if (!record.project) continue;
        const entry = projects.get(record.project) ?? { totalTokens: 0, cost: 0 };
        entry.totalTokens += record.totalTokens;
        entry.cost += record.estimatedCostUsd ?? 0;
        projects.set(record.project, entry);
      }
      const dailyMap = new Map<string, { totalTokens: number; cost: number }>();
      for (const record of bucket) {
        const entry = dailyMap.get(record.day) ?? { totalTokens: 0, cost: 0 };
        entry.totalTokens += record.totalTokens;
        entry.cost += record.estimatedCostUsd ?? 0;
        dailyMap.set(record.day, entry);
      }
      return {
        plan,
        totalTokens: bucket.reduce((sum, record) => sum + record.totalTokens, 0),
        estimatedCostUsd: hasCost ? cost : null,
        topModels: [...models.entries()]
          .map(([model, totalTokens]) => ({ model, totalTokens }))
          .sort((a, b) => b.totalTokens - a.totalTokens)
          .slice(0, 3),
        topProjects: [...projects.entries()]
          .map(([project, value]) => ({ project, totalTokens: value.totalTokens, estimatedCostUsd: hasCost ? value.cost : null }))
          .sort((a, b) => b.totalTokens - a.totalTokens)
          .slice(0, 3),
        daily: [...dailyMap.entries()]
          .map(([day, value]) => ({ day, totalTokens: value.totalTokens, estimatedCostUsd: hasCost ? value.cost : null }))
          .sort((a, b) => a.day.localeCompare(b.day)),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
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
    byPlan: buildPlanUsageSummary(records),
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

function dshFiles(root: string, since: number): string[] {
  if (!existsSync(root)) return [];
  try {
    if (statSync(root).isFile()) {
      return root.endsWith('.jsonl') || root.endsWith('.jsonl.zstd') ? [root] : [];
    }
  } catch {
    return [];
  }
  const result = filesForRoot(root, since);
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
      } else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) {
        try {
          if (statSync(path).mtimeMs >= since - 2 * DAY_MS) result.push(path);
        } catch {
          /* file may be rotated while scanning */
        }
      }
    }
  };
  visit(root);
  return [...new Set(result)].sort();
}

function grokLogFile(root: string): string {
  try {
    if (existsSync(root) && statSync(root).isFile()) return root;
  } catch {
    return root;
  }
  return join(root, 'logs', 'unified.jsonl');
}

interface LocalScanFile extends UsageScanFile {
  project?: string | null;
}

function localScanFiles(options: CollectUsageOptions, since: number): LocalScanFile[] {
  const codexRoot = options.codexRoot ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const claudeRoots = options.claudeRoots ?? [
    process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : '',
    join(homedir(), '.config', 'claude', 'projects'),
    join(homedir(), '.claude', 'projects'),
  ].filter(Boolean);
  const roots: Array<{ provider: string; files: string[]; project?: string | null }> = [
    { provider: 'codex', files: jsonlFiles(codexRoot, since) },
    // Claude projects 目录的第一层路径段就是编码后的项目路径
    // （-Users-chris-workspace-planofplan）。解码为路径用于聚合与展示。
    ...claudeRoots.flatMap((root) => jsonlFiles(root, since).map((path) => {
      const segment = relative(root, path).split(sep)[0] ?? '';
      const decoded = segment.replace(/^-+/, '').replaceAll('-', '/');
      return { provider: 'claude', files: [path], project: decoded || null };
    })),
    {
      provider: 'zcode',
      files: filesForRoot(
        options.zcodeRoot ?? process.env.ZCODE_HOME ?? join(homedir(), '.zcode', 'cli'),
        since,
      ),
    },
    {
      provider: 'kimi-cli',
      files: filesForRoot(
        options.kimiRoot ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'),
        since,
      ),
    },
    {
      provider: 'grok-cli',
      files: filesForRoot(
        grokLogFile(options.grokRoot ?? process.env.GROK_HOME ?? join(homedir(), '.grok')),
        since,
      ),
    },
    {
      provider: 'dsh',
      files: dshFiles(options.dshRoot ?? process.env.DSH_HOME ?? join(homedir(), '.dsh', 'sessions'), since),
    },
  ];
  return roots.flatMap(({ provider, files, project }) => files.flatMap((path) => {
    try {
      const stat = statSync(path);
      return [{
        path,
        provider,
        project,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        scannedAt: 0,
        scannedSince: 0,
        parsedBytes: 0,
        cursorJson: null,
      }];
    } catch {
      return [];
    }
  }));
}

function scanLocalFile(
  file: LocalScanFile,
  since: number,
  until: number,
): UsageRecord[] {
  switch (file.provider) {
    case 'codex':
      return scanCodexLogs(file.path, since, until);
    case 'claude':
      return scanClaudeLogs(file.path, since, until, file.project ?? null);
    case 'zcode':
      return scanZcodeLogs(file.path, since, until);
    case 'kimi-cli':
      return scanKimiCliLogs(file.path, since, until);
    case 'grok-cli':
      return scanGrokLogs(file.path, since, until);
    case 'dsh':
      return scanDshLogs(file.path, since, until);
    default:
      return [];
  }
}

export async function collectUsageReport(store: Store, options: CollectUsageOptions = {}): Promise<UsageReport> {
  const range = {
    since: options.since ?? defaultUsageRange(30).since,
    until: options.until ?? Date.now(),
  };
  const needsMigration = store.hasUnattributedLocalUsageRecords();
  const migrationSince = needsMigration
    ? Math.min(range.since, store.oldestUnattributedLocalUsageTimestamp() ?? range.since)
    : range.since;
  if (needsMigration) store.clearLocalUsageRecords();
  const cached = new Map(store.getUsageScanFiles().map((file) => [file.path, file]));
  const discovered = localScanFiles(options, migrationSince);
  const changed = discovered.filter((file) => {
    const previous = cached.get(file.path);
    return !previous
      || previous.size !== file.size
      || previous.mtimeMs !== file.mtimeMs
      || previous.scannedSince > migrationSince
      || (file.provider === 'codex' && parseCodexCursor(previous.cursorJson) == null);
  });
  const replacements: Array<{
    file: LocalScanFile;
    records: UsageRecord[];
    scannedSince: number;
    parsedBytes?: number;
    cursorJson?: string | null;
  }> = [];
  for (const file of changed) {
    const previous = cached.get(file.path);
    const cursor = previous?.provider === 'codex'
      ? parseCodexCursor(previous.cursorJson)
      : null;
    const canAppend = file.provider === 'codex'
      && previous != null
      && cursor != null
      && file.size > previous.size
      && file.size >= cursor.parsedBytes
      && previous.scannedSince <= migrationSince;
    if (canAppend) {
      const result = scanCodexFile(file.path, migrationSince, range.until, cursor);
      store.appendUsageRecordsForFile(
        file,
        result.records,
        migrationSince,
        result.cursor.parsedBytes,
        JSON.stringify(result.cursor),
      );
      continue;
    }
    if (file.provider === 'codex') {
      const result = scanCodexFile(file.path, migrationSince, range.until);
      replacements.push({
        file,
        records: result.records,
        scannedSince: migrationSince,
        parsedBytes: result.cursor.parsedBytes,
        cursorJson: JSON.stringify(result.cursor),
      });
    } else {
      replacements.push({
        file,
        records: scanLocalFile(file, migrationSince, range.until),
        scannedSince: migrationSince,
      });
    }
  }
  store.replaceUsageRecordsForFiles(replacements);
  const official = options.includeOfficial === false ? [] : await fetchOfficialUsage(range);
  store.upsertUsageRecords(official);
  collectSessionCatalog(store, options);
  return store.getUsageReport(range.since, range.until);
}
