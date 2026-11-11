/**
 * MiniMax Code CLI 会话源(INV-1816)。
 *
 * L0 布局(实测 2026-11-11):
 * - `~/.minimax/v2/sessions/YYYY/MM/DD/<HH-mm-ss-xxx-session_<base64>>/messages.jsonl`
 *   行结构 {message_id, turn_id, message}。message.role: user / assistant /
 *   toolResult / custom / compactionSummary。
 * - assistant 行:message.usage = {input, output, cacheRead, cacheWrite,
 *   totalTokens, cost};实测 total = input + output + cacheRead(两样本精确
 *   成立)——四字段不相交,入库不再拆列。provider='minimax',
 *   api='anthropic-messages';模型在 message.model。
 * - user 行 content 为 text 块(含 <system-reminder> 信封,标题与消息索引排除);
 *   assistant content 块类型 text / thinking / toolCall(toolCall 出工具行,
 *   thinking 不入消息索引);compactionSummary 作 summary 行。
 * - `~/.newmax` 为另一独立产品,不含 MiniMax Code 台账,不接入。
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessageRow, SessionRecord } from './types.ts';
import { titleify } from './sessions.ts';
import { textRow, toolRow } from './transcript.ts';

const HEAD_BYTES = 256 * 1024;

export function minimaxCodeHome(): string {
  return process.env.MINIMAX_CODE_HOME ?? join(homedir(), '.minimax');
}

export function minimaxCodeSessionsRoot(root?: string): string {
  return join(root ?? minimaxCodeHome(), 'v2', 'sessions');
}

export function isMinimaxCodeSessionFile(name: string, path: string): boolean {
  return name === 'messages.jsonl' && !path.includes('/observability/');
}

/** user 文本里的 harness 信封(<system-reminder>/<background-task-*> 等),
 *  不入标题与消息索引。 */
export function isMinimaxCodeEnvelope(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<') && /<(system-reminder|environment_context|user-context|command-name|local-command|background-task)/i.test(trimmed);
}

export interface MinimaxCodeHead {
  nativeId: string | null;
  firstUserText: string | null;
  startedAt: number | null;
}

/** 只读文件头:nativeId(目录名尾部 base64 解出的内部 id,失败用目录名)、
 *  首条非信封用户输入(标题)、首行时间戳(起点)。 */
export function parseMinimaxCodeHead(path: string): MinimaxCodeHead {
  const head: MinimaxCodeHead = { nativeId: null, firstUserText: null, startedAt: null };
  let fd: number | null = null;
  let raw = '';
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    raw = buf.subarray(0, n).toString('utf8');
  } catch {
    return head;
  } finally {
    if (fd != null) closeSync(fd);
  }
  const lines = raw.split(/\r?\n/);
  if (!raw.endsWith('\n') && lines.length > 0) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; // truncated head line
    }
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown> : {};
    if (head.startedAt == null && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
      head.startedAt = message.timestamp > 1e12 ? message.timestamp : message.timestamp * 1000;
    }
    if (head.firstUserText == null && message.role === 'user') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const text = blocks
        .map((block) => (
          block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text : ''
        ))
        .join('\n')
        .trim();
      if (text && !isMinimaxCodeEnvelope(text)) head.firstUserText = text;
    }
    if (head.firstUserText != null && head.startedAt != null) break;
  }
  return head;
}

/** 目录名尾部 base64 段(…-session_<b64>)解出内部 id;失败返回目录名。 */
export function minimaxNativeIdOf(path: string): string {
  const dir = path.split('/').slice(0, -1).pop() ?? '';
  const marker = '-session_';
  const at = dir.lastIndexOf(marker);
  if (at >= 0) {
    const encoded = dir.slice(at + marker.length);
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (/^[\x20-\x7e]{8,80}$/.test(decoded)) return decoded;
    } catch {
      /* fall through to dir name */
    }
  }
  return dir;
}

export function extractMinimaxCodeSession(path: string, mtimeMs: number): SessionRecord | null {
  if (!existsSync(path)) return null;
  const head = parseMinimaxCodeHead(path);
  const nativeId = head.nativeId ?? minimaxNativeIdOf(path);
  if (!nativeId) return null;
  return {
    id: `minimax-code:${nativeId}`,
    provider: 'minimax-code',
    nativeId,
    cwd: null,
    title: titleify(head.firstUserText ?? '') || null,
    sourceFile: path,
    startedAt: head.startedAt,
    updatedAt: mtimeMs,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  };
}

// ── usage 行解析(usage.ts 消费) ────────────────────────────────────

/** assistant 行 usage 四字段不相交(total = input+output+cacheRead 实测成立),
 *  直接映射,不拆列。 */
export function minimaxCodeNumericUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
} {
  const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  const inputTokens = finite(usage.input);
  const cachedInputTokens = finite(usage.cacheRead);
  const cacheCreationInputTokens = finite(usage.cacheWrite);
  const outputTokens = finite(usage.output);
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: finite(usage.totalTokens) || inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens,
  };
}

export function minimaxCodeModelOf(message: Record<string, unknown>): string {
  const model = message.model;
  return typeof model === 'string' && model.trim() ? model.trim() : 'unknown';
}

// ── 消息行(transcript.ts 消费) ─────────────────────────────────────

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text : ''
    ))
    .join('\n');
}

/** 单条 record → 消息行:user 文本(信封排除)、assistant text(thinking 不入)、
 *  assistant toolCall → 工具行;toolResult/custom 不入,compactionSummary 出
 *  summary 行(role=system,可检索不进需求抽取)。 */
export function messagesFromMinimaxCodeRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown> : {};
  const role = typeof message.role === 'string' ? message.role : '';
  const ts = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? (message.timestamp > 1e12 ? message.timestamp : message.timestamp * 1000)
    : null;
  const id = `${sessionId}:${seq}`;
  if (role === 'user') {
    const text = contentText(message.content);
    if (!text || isMinimaxCodeEnvelope(text)) return [];
    const row = textRow(sessionId, id, seq, 'user', text, ts);
    return row ? [row] : [];
  }
  if (role === 'assistant') {
    const rows: SessionMessageRow[] = [];
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        const row = textRow(sessionId, `${id}:t`, seq, 'assistant', item.text, ts, minimaxCodeModelOf(message));
        if (row) rows.push(row);
      } else if (item.type === 'toolCall') {
        let input: unknown = item.input ?? item.arguments;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            /* 非 JSON 入参按原文本入行 */
          }
        }
        rows.push(toolRow(sessionId, `${id}:c`, seq, typeof item.name === 'string' ? item.name : 'tool', input, ts));
      }
    }
    return rows;
  }
  if (role === 'compactionSummary') {
    const text = contentText(message.content) || (typeof message.summary === 'string' ? message.summary : '');
    if (!text.trim()) return [];
    // parserVersion 留空:MESSAGE_PARSER_VERSION 在 transcript.ts(循环依赖),
    // 版本 bump 的全量重扫会重建本行,字段缺省无碍
    return [{
      id, sessionId, seq, role: 'system', kind: 'summary',
      toolName: null, text: text.slice(0, 2000), fullText: text,
      timestamp: ts, model: null, inputTokens: null, outputTokens: null,
    }];
  }
  return [];
}
