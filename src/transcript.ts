/**
 * Read-only transcript rendering for WG-M4.
 * Streams JSONL with byte/turn caps so a 1GB Codex rollout cannot fill RAM.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import type { SessionMessageRow, SessionRecord, SessionTranscript, TranscriptTurn } from './types.ts';
import { textOf } from './sessions.ts';
import { sourcePathFor } from './session-repos.ts';
import { resumeFor } from './resume.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 160;
const TURN_TEXT_MAX = 2_000;
const ZSTD_BIN = process.env.ZSTD_PATH?.trim()
  || (existsSync('/opt/homebrew/bin/zstd') ? '/opt/homebrew/bin/zstd' : 'zstd');

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= TURN_TEXT_MAX) return cleaned;
  return `${cleaned.slice(0, TURN_TEXT_MAX)}…`;
}

async function readJsonlRecords(
  path: string,
  maxBytes = MAX_BYTES,
): Promise<{ records: Record<string, unknown>[]; truncated: boolean }> {
  if (!existsSync(path)) return { records: [], truncated: false };
  const compressed = path.endsWith('.jsonl.zstd') || path.endsWith('.jsonl.zst');
  const child = compressed
    ? spawn(ZSTD_BIN, ['-dc', path], { stdio: ['ignore', 'pipe', 'ignore'] })
    : null;
  const input = child?.stdout ?? createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const records: Record<string, unknown>[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for await (const line of rl) {
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > maxBytes) {
        truncated = true;
        break;
      }
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === 'object') records.push(value as Record<string, unknown>);
      } catch {
        /* skip malformed */
      }
    }
  } finally {
    rl.close();
    child?.kill();
  }
  return { records, truncated };
}

function pushTurn(turns: TranscriptTurn[], role: TranscriptTurn['role'], text: string, toolName?: string): void {
  const clipped = clip(text);
  if (!clipped && !toolName) return;
  turns.push(toolName ? { role, text: clipped, toolName } : { role, text: clipped });
}

function turnsFromClaude(records: Record<string, unknown>[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const record of records) {
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : record;
    const content = message.content;
    if (!Array.isArray(content)) {
      const text = textOf(content);
      if (record.type === 'user' && text && !text.startsWith('<command-') && !text.startsWith('<local-command')) {
        pushTurn(turns, 'user', text);
      } else if (record.type === 'assistant' && text) {
        pushTurn(turns, 'assistant', text);
      }
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'tool_use') {
        pushTurn(turns, 'tool', textOf(item.input), typeof item.name === 'string' ? item.name : 'tool');
      } else if (item.type === 'tool_result') {
        pushTurn(turns, 'tool', textOf(item.content ?? item), 'result');
      } else if (item.type === 'text' || typeof item.text === 'string') {
        const text = textOf(item);
        if (record.type === 'user' && text && !text.startsWith('<command-') && !text.startsWith('<local-command')) {
          pushTurn(turns, 'user', text);
        } else if (record.type === 'assistant' && text) {
          pushTurn(turns, 'assistant', text);
        }
      }
    }
  }
  return turns;
}

function turnsFromCodex(records: Record<string, unknown>[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const record of records) {
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, unknown>
      : null;
    if (!payload) continue;
    if (record.type === 'response_item') {
      const payloadType = typeof payload.type === 'string' ? payload.type : '';
      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        pushTurn(turns, 'tool', textOf(payload.arguments ?? payload.input), typeof payload.name === 'string' ? payload.name : 'tool');
        continue;
      }
      if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        pushTurn(turns, 'tool', textOf(payload.output ?? payload.content), 'result');
        continue;
      }
      const role = payload.role;
      if (role === 'user') pushTurn(turns, 'user', textOf(payload.content));
      if (role === 'assistant') pushTurn(turns, 'assistant', textOf(payload.content));
    }
  }
  return turns;
}

function turnsFromDsh(records: Record<string, unknown>[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const record of records) {
    const type = typeof record.type === 'string' ? record.type : '';
    const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
    if (type === 'user/message') {
      const source = data.source && typeof data.source === 'object' ? data.source as { kind?: unknown } : {};
      if (source.kind && source.kind !== 'user') continue;
      pushTurn(turns, 'user', textOf(data.content));
    } else if (type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {};
      pushTurn(turns, 'assistant', textOf(message.content ?? data.content));
    } else if (type === 'tool/call') {
      pushTurn(turns, 'tool', textOf(data.arguments ?? data.input), typeof data.name === 'string' ? data.name : 'tool');
    } else if (type === 'tool/result') {
      pushTurn(turns, 'tool', textOf(data.output ?? data.content ?? data), 'result');
    }
  }
  return turns;
}

function turnsFromGrokChat(records: Record<string, unknown>[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const record of records) {
    const type = typeof record.type === 'string' ? record.type : '';
    if (type === 'user') pushTurn(turns, 'user', textOf(record.content));
    else if (type === 'assistant') pushTurn(turns, 'assistant', textOf(record.content));
    else if (type === 'tool_result') pushTurn(turns, 'tool', textOf(record.content ?? record.output), 'result');
    else if (type === 'backend_tool_call' || type === 'tool_call') {
      pushTurn(turns, 'tool', textOf(record.arguments ?? record.input), typeof record.name === 'string' ? record.name : 'tool');
    }
  }
  return turns;
}

function turnsFromFactory(records: Record<string, unknown>[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const record of records) {
    if (record.type !== 'message') continue;
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : {};
    const role = message.role;
    const text = textOf(message.content);
    if (role === 'user') pushTurn(turns, 'user', text);
    else if (role === 'assistant') pushTurn(turns, 'assistant', text);
  }
  return turns;
}

function turnsFromZcodeDb(path: string, nativeId: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query(
      `SELECT m.data AS message, p.data AS part
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY m.time_created, p.sequence, p.time_created`,
    ).all(nativeId) as Array<{ message: string; part: string }>;
    for (const row of rows) {
      try {
        const message = JSON.parse(row.message) as { role?: string };
        const part = JSON.parse(row.part) as { type?: string; text?: string; name?: string };
        const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'tool';
        if (part.type === 'text' && part.text) pushTurn(turns, role === 'tool' ? 'assistant' : role, part.text);
        else if (part.type === 'tool' || part.type === 'tool-call') {
          pushTurn(turns, 'tool', part.text ?? part.name ?? '', part.name);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return turns;
  } finally {
    db?.close();
  }
  return turns;
}

export async function readTranscript(session: SessionRecord): Promise<SessionTranscript> {
  const resume = resumeFor(session);
  if (session.provider === 'zcode' && session.sourceFile?.endsWith('.sqlite')) {
    const turns = turnsFromZcodeDb(session.sourceFile, session.nativeId);
    return { session, turns: turns.slice(0, MAX_TURNS), truncated: turns.length > MAX_TURNS, resume };
  }
  const path = sourcePathFor(session);
  if (!path || !existsSync(path)) {
    return { session, turns: [], truncated: false, resume };
  }
  const { records, truncated: byteTruncated } = await readJsonlRecords(path);
  let turns: TranscriptTurn[];
  switch (session.provider) {
    case 'claude':
      turns = turnsFromClaude(records);
      break;
    case 'codex':
      turns = turnsFromCodex(records);
      break;
    case 'dsh':
      turns = turnsFromDsh(records);
      break;
    case 'grok':
      turns = turnsFromGrokChat(records);
      break;
    case 'factory':
      turns = turnsFromFactory(records);
      break;
    default:
      turns = [];
  }
  const truncated = byteTruncated || turns.length > MAX_TURNS;
  return { session, turns: turns.slice(0, MAX_TURNS), truncated, resume };
}

// ── 消息级索引抽取（session_messages 表）─────────────────────────
// 与上面的 turnsFromX 共享同一份已 parse 的 records。体积控制（见
// docs/obelisk-session-research.md 8.3）:只入 user/assistant 可见文本与
// tool_use 入参（截 2K),tool_result 正文不入库;text 统一截 10K。

export const MESSAGE_TEXT_MAX = 10_000;
export const TOOL_INPUT_MAX = 2_000;

function clipField(text: string, max = MESSAGE_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function tsOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inputTokensOf(usage: Record<string, unknown> | null): number | null {
  if (!usage) return null;
  const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  let seen = false;
  let total = 0;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

function toolInputText(input: unknown): string {
  if (typeof input === 'string') return clipField(input, TOOL_INPUT_MAX);
  try {
    return clipField(JSON.stringify(input ?? ''), TOOL_INPUT_MAX);
  } catch {
    return '';
  }
}

function textRow(
  sessionId: string,
  id: string,
  seq: number,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number | null,
  model: string | null = null,
  inputTokens: number | null = null,
  outputTokens: number | null = null,
): SessionMessageRow | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    id, sessionId, seq, role, kind: 'text', toolName: null,
    text: clipField(trimmed), timestamp, model, inputTokens, outputTokens,
  };
}

function toolRow(
  sessionId: string,
  id: string,
  seq: number,
  toolName: string,
  input: unknown,
  timestamp: number | null,
): SessionMessageRow {
  return {
    id, sessionId, seq, role: 'tool', kind: 'tool_use', toolName,
    text: toolInputText(input), timestamp, model: null, inputTokens: null, outputTokens: null,
  };
}

function messagesFromClaudeRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  if (record.type !== 'user' && record.type !== 'assistant') return [];
  const uuid = typeof record.uuid === 'string' ? record.uuid : null;
  if (!uuid) return [];
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : record;
  const usage = message.usage && typeof message.usage === 'object'
    ? message.usage as Record<string, unknown>
    : null;
  const output = usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
  const model = typeof message.model === 'string' ? message.model : null;
  const ts = tsOf(record.timestamp);
  const rows: SessionMessageRow[] = [];
  const content = message.content;
  const text = textOf(content).trim();
  if (text && !(record.type === 'user' && (text.startsWith('<command-') || text.startsWith('<local-command')))) {
    const row = textRow(sessionId, `${sessionId}:${uuid}`, seq, record.type, text, ts, model, inputTokensOf(usage), output);
    if (row) rows.push(row);
  }
  if (Array.isArray(content)) {
    let toolIndex = 0;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      // tool_result 正文不入库(体积大头),只留 tool_use 入参
      if (item.type !== 'tool_use' || typeof item.name !== 'string') continue;
      const toolId = typeof item.id === 'string' ? item.id : String(toolIndex);
      rows.push(toolRow(sessionId, `${sessionId}:${uuid}:${toolId}`, seq, item.name, item.input, ts));
      toolIndex += 1;
    }
  }
  return rows;
}

function messagesFromCodexRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  if (record.type !== 'response_item') return [];
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : null;
  if (!payload) return [];
  // Codex 没有消息 id:行号即稳定身份(append-only),补齐对齐方便肉眼排序
  const id = `${sessionId}:${String(seq).padStart(6, '0')}`;
  const ts = tsOf(record.timestamp ?? payload.timestamp);
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const name = typeof payload.name === 'string' ? payload.name : 'tool';
    return [toolRow(sessionId, id, seq, name, payload.arguments ?? payload.input, ts)];
  }
  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') return [];
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return [];
  const row = textRow(sessionId, id, seq, role, textOf(payload.content), ts);
  return row ? [row] : [];
}

function messagesFromDshRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  const type = typeof record.type === 'string' ? record.type : '';
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  const ts = tsOf(record.time ?? data.time);
  const id = `${sessionId}:${seq}`;
  if (type === 'user/message') {
    const source = data.source && typeof data.source === 'object' ? data.source as { kind?: unknown } : {};
    if (source.kind && source.kind !== 'user') return [];
    const row = textRow(sessionId, id, seq, 'user', textOf(data.content), ts);
    return row ? [row] : [];
  }
  if (type === 'assistant/message') {
    const message = data.message && typeof data.message === 'object' ? data.message as Record<string, unknown> : {};
    const row = textRow(sessionId, id, seq, 'assistant', textOf(message.content ?? data.content), ts);
    return row ? [row] : [];
  }
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : 'tool';
    return [toolRow(sessionId, id, seq, name, data.arguments ?? data.input, ts)];
  }
  return [];
}

function messagesFromGrokRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  const type = typeof record.type === 'string' ? record.type : '';
  const ts = tsOf(record.timestamp ?? record.ts ?? record.created_at);
  const id = `${sessionId}:${seq}`;
  if (type === 'user' || type === 'assistant') {
    const row = textRow(sessionId, id, seq, type, textOf(record.content), ts);
    return row ? [row] : [];
  }
  if (type === 'backend_tool_call' || type === 'tool_call') {
    const name = typeof record.name === 'string' ? record.name : 'tool';
    return [toolRow(sessionId, id, seq, name, record.arguments ?? record.input, ts)];
  }
  return [];
}

function messagesFromFactoryRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  if (record.type !== 'message') return [];
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : {};
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return [];
  const row = textRow(
    sessionId,
    `${sessionId}:${seq}`,
    seq,
    role,
    textOf(message.content),
    tsOf(message.timestamp ?? record.timestamp),
  );
  return row ? [row] : [];
}

function messagesFromKimiRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  const type = typeof record.type === 'string' ? record.type : '';
  const id = `${sessionId}:${seq}`;
  if (type === 'context.append_message') {
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : {};
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const row = textRow(sessionId, id, seq, role, textOf(message.content), tsOf(record.time ?? message.time));
    return row ? [row] : [];
  }
  if (type === 'context.append_loop_event') {
    const event = record.event && typeof record.event === 'object'
      ? record.event as Record<string, unknown>
      : {};
    const ts = tsOf(record.time ?? event.time);
    if (event.type === 'content.part') {
      const part = event.part && typeof event.part === 'object' ? event.part as Record<string, unknown> : {};
      if (part.type !== 'text' || typeof part.text !== 'string') return [];
      const row = textRow(sessionId, id, seq, 'assistant', part.text, ts);
      return row ? [row] : [];
    }
    if (event.type === 'tool.call') {
      const name = typeof event.name === 'string' ? event.name : 'tool';
      return [toolRow(sessionId, id, seq, name, event.args, ts)];
    }
  }
  return [];
}

/** 单条已 parse record → 消息行。seq 是源文件里的绝对行号(1 起)。 */
export function messagesFromRecord(
  provider: string,
  sessionId: string,
  record: Record<string, unknown>,
  seq: number,
): SessionMessageRow[] {
  switch (provider) {
    case 'claude':
      return messagesFromClaudeRecord(sessionId, record, seq);
    case 'codex':
      return messagesFromCodexRecord(sessionId, record, seq);
    case 'dsh':
      return messagesFromDshRecord(sessionId, record, seq);
    case 'grok':
      return messagesFromGrokRecord(sessionId, record, seq);
    case 'factory':
      return messagesFromFactoryRecord(sessionId, record, seq);
    case 'kimi':
      return messagesFromKimiRecord(sessionId, record, seq);
    default:
      return [];
  }
}

/** 连续 records 批量的便捷封装:seq = seqBase + 数组下标。 */
export function messagesFromRecords(
  provider: string,
  sessionId: string,
  records: Record<string, unknown>[],
  seqBase = 0,
): SessionMessageRow[] {
  return records.flatMap((record, index) => messagesFromRecord(provider, sessionId, record, seqBase + index));
}

/** ZCode 的消息在其自有 sqlite 里,part 表自带 id,upsert 幂等,配合"总是重扫"。 */
export function messagesFromZcodeDb(path: string, nativeId: string, sessionId: string): SessionMessageRow[] {
  const rows: SessionMessageRow[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const parts = db.query(
      `SELECT p.id AS part_id, m.data AS message, p.data AS part, m.time_created AS created
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY m.time_created, p.sequence, p.time_created`,
    ).all(nativeId) as Array<{ part_id: string; message: string; part: string; created: number | null }>;
    let seq = 0;
    for (const row of parts) {
      seq += 1;
      try {
        const message = JSON.parse(row.message) as { role?: string };
        const part = JSON.parse(row.part) as { type?: string; text?: string; name?: string };
        const id = `${sessionId}:${row.part_id}`;
        const role = message.role === 'user' ? 'user' : 'assistant';
        if (part.type === 'text' && part.text) {
          const text = textRow(sessionId, id, seq, role, part.text, row.created);
          if (text) rows.push(text);
        } else if (part.type === 'tool' || part.type === 'tool-call') {
          rows.push(toolRow(sessionId, id, seq, part.name ?? 'tool', part.text ?? part.name ?? '', row.created));
        }
      } catch {
        /* 单条 part 解析失败跳过 */
      }
    }
  } catch {
    return rows;
  } finally {
    db?.close();
  }
  return rows;
}
