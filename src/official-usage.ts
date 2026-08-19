import type { UsageRecord } from './types.ts';
import { readCredential } from './auth.ts';

const DAY_MS = 86_400_000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/organizations/usage_report/claude_code';
const FACTORY_URL = 'https://api.factory.ai/api/v1/analytics/tokens';

function dateOnly(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestampForDay(day: string, fallback: number): number {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function recordsFromModelBreakdown(
  provider: string,
  day: string,
  breakdown: unknown,
  sourceId: string,
  fallbackBillableTokens: number | null = null,
): UsageRecord[] {
  if (!Array.isArray(breakdown)) return [];
  const result: UsageRecord[] = [];
  for (const item of breakdown) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const tokens = row.tokens && typeof row.tokens === 'object' ? row.tokens as Record<string, unknown> : row;
    const input = numberValue(tokens.input) ?? numberValue(tokens.input_tokens) ?? 0;
    const output = numberValue(tokens.output) ?? numberValue(tokens.output_tokens) ?? 0;
    const cached = numberValue(tokens.cache_read)
      ?? numberValue(tokens.cache_read_tokens)
      ?? numberValue(tokens.cache_read_input_tokens)
      ?? 0;
    const creation = numberValue(tokens.cache_creation)
      ?? numberValue(tokens.cache_write)
      ?? numberValue(tokens.cache_write_tokens)
      ?? numberValue(tokens.cache_creation_input_tokens)
      ?? 0;
    const total = numberValue(tokens.total) ?? input + output;
    if (total <= 0 && input <= 0 && output <= 0 && cached <= 0 && creation <= 0) continue;
    const model = stringValue(row.model) ?? stringValue(row.model_name) ?? 'all';
    const estimated = row.estimated_cost && typeof row.estimated_cost === 'object'
      ? numberValue((row.estimated_cost as Record<string, unknown>).amount)
      : numberValue(row.estimated_cost);
    result.push({
      id: `${sourceId}:${day}:${model}`,
      day,
      timestamp: timestampForDay(day, Date.now()),
      provider,
      model,
      inputTokens: input,
      cachedInputTokens: cached,
      cacheCreationInputTokens: creation,
      outputTokens: output,
      reasoningOutputTokens: numberValue(tokens.reasoning) ?? numberValue(tokens.reasoning_output_tokens) ?? 0,
      totalTokens: total,
      billableTokens: numberValue(row.billable_tokens) ?? fallbackBillableTokens,
      estimatedCostUsd: estimated == null
        ? null
        : row.estimated_cost && typeof row.estimated_cost === 'object'
          ? estimated / 100
          : estimated,
      source: 'official',
      confidence: 'official',
      fetchedAt: Date.now(),
    });
  }
  return result;
}

function modelBreakdown(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([model, row]) =>
    row && typeof row === 'object' ? { ...(row as Record<string, unknown>), model } : { model },
  );
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchAnthropic(start: number, end: number): Promise<UsageRecord[]> {
  const key = process.env.ANTHROPIC_ADMIN_API_KEY?.trim();
  if (!key) return [];
  const params = new URLSearchParams({
    starting_at: dateOnly(start),
    ending_at: dateOnly(Math.min(end - DAY_MS, Date.now() - DAY_MS)),
    limit: '100',
  });
  if (params.get('ending_at')! < params.get('starting_at')!) return [];
  const json = await fetchJson(`${ANTHROPIC_URL}?${params}`, {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  });
  if (!json || typeof json !== 'object') return [];
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const day = stringValue(item.date) ?? stringValue(item.day);
    return day ? recordsFromModelBreakdown('claude', day, modelBreakdown(item.model_breakdown), 'official:anthropic') : [];
  });
}

async function fetchFactory(start: number, end: number): Promise<UsageRecord[]> {
  const key = process.env.FACTORY_API_KEY?.trim() ?? readCredential('factory')?.value.trim();
  if (!key) return [];
  const lastDay = Math.min(end - DAY_MS, Date.now() - DAY_MS);
  if (lastDay < start) return [];
  const params = new URLSearchParams({
    startDate: dateOnly(start),
    endDate: dateOnly(lastDay),
  });
  const json = await fetchJson(`${FACTORY_URL}?${params}`, {
    Authorization: `Bearer ${key}`,
    accept: 'application/json',
  });
  if (!json || typeof json !== 'object') return [];
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const day = stringValue(item.date) ?? stringValue(item.day);
    if (!day) return [];
    const byModel = item.by_model;
    const breakdown = modelBreakdown(byModel);
    if (breakdown.length === 0) breakdown.push({ ...item, model: 'all' });
    return recordsFromModelBreakdown(
      'factory',
      day,
      breakdown,
      'official:factory',
      numberValue(item.billable_tokens),
    );
  });
}

async function fetchCodex(start: number, end: number): Promise<UsageRecord[]> {
  if (process.env.CODEX_APP_SERVER_USAGE !== '1') return [];
  const command = process.env.CODEX_CLI_PATH?.trim() || 'codex';
  try {
    const process = Bun.spawn([command, 'app-server', '--stdio'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextMessage = async (): Promise<Record<string, unknown> | null> => {
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (value && typeof value === 'object') return value;
          } catch {
            /* Ignore malformed or non-protocol output. */
          }
          continue;
        }
        const next = await reader.read();
        if (next.done) {
          if (!buffer.trim()) return null;
          const line = buffer;
          buffer = '';
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        }
        buffer += decoder.decode(next.value, { stream: true });
      }
    };
    process.stdin.write(JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'planofplan', title: 'planofplan', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    }) + '\n');
    const nextWithTimeout = async (): Promise<Record<string, unknown> | null> => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          nextMessage(),
          new Promise<null>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Codex app-server timeout')), 10_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    try {
      const first = await nextWithTimeout();
      if (first?.id !== 1) return [];
      process.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      process.stdin.write(JSON.stringify({ id: 2, method: 'account/usage/read', params: null }) + '\n');
      let response: Record<string, unknown> | null = null;
      while (!response) {
        const message = await nextWithTimeout();
        if (message?.id === 2) response = message;
        if (message == null) break;
      }
      const result = response?.result;
      if (!result || typeof result !== 'object') return [];
      const buckets = (result as Record<string, unknown>).dailyUsageBuckets;
      if (!Array.isArray(buckets)) return [];
      return buckets.flatMap((bucket) => {
        if (!bucket || typeof bucket !== 'object') return [];
        const row = bucket as Record<string, unknown>;
        const day = stringValue(row.startDate);
        const tokens = numberValue(row.tokens);
        if (!day || tokens == null) return [];
        const timestamp = timestampForDay(day, Date.now());
        if (timestamp < start || timestamp >= end) return [];
        return [{
          id: `official:codex:${day}`,
          day,
          timestamp,
          provider: 'codex',
          model: 'all',
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: tokens,
          billableTokens: null,
          estimatedCostUsd: null,
          source: 'official' as const,
          confidence: 'official' as const,
          fetchedAt: Date.now(),
        }];
      });
    } finally {
      await reader.cancel().catch(() => {});
      process.stdin.end();
      process.kill();
    }
  } catch {
    return [];
  }
}

export async function fetchOfficialUsage(range: { since: number; until: number }): Promise<UsageRecord[]> {
  const results = await Promise.all([
    fetchAnthropic(range.since, range.until),
    fetchFactory(range.since, range.until),
    fetchCodex(range.since, range.until),
  ]);
  return results.flat();
}
