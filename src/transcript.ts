/**
 * Read-only transcript rendering for WG-M4.
 * Streams JSONL with byte/turn caps so a 1GB Codex rollout cannot fill RAM.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import type { SessionRecord, SessionTranscript, TranscriptTurn } from './types.ts';
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
