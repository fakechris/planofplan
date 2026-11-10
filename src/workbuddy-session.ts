/**
 * WorkBuddy 桌面版会话源(INV-1789)。
 *
 * L0 布局(实测 2026-11-09):
 * - `~/.workbuddy/projects/<cwd-slug>/<sessionId>.jsonl` — 消息正文,行类型
 *   session-meta / message / reasoning / function_call / function_call_result /
 *   file-history-snapshot / ai-title;usage 挂在 function_call 行的
 *   providerData.usage(每条是一次独立 chatcmpl 请求,OpenAI 风格字段)。
 * - `<sessionId>/subagents/agent-*.jsonl` + `.jsonl` 同构子会话;usage 全量
 *   统计,目录层只收主会话(子会话 parentId 归主,先行跳过)。
 * - `~/.workbuddy/workbuddy.db`(drizzle sqlite)sessions / session_usage 表:
 *   model / context_window / used(上下文水位,非累计消耗)。
 *   只读打开,缺席时纯 jsonl 降级。
 */
import { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { join } from 'node:path';
import type { SessionMessageRow, SessionRecord } from './types.ts';
import { titleify } from './sessions.ts';
import { textRow, toolRow } from './transcript.ts';

const HEAD_BYTES = 256 * 1024;

export function workbuddyHome(): string {
  return process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy');
}

export function workbuddyProjectsRoot(root?: string): string {
  return join(root ?? workbuddyHome(), 'projects');
}

/** workbuddy 主会话文件:<uuid>.jsonl,且不在 subagents/tool-results 子目录。 */
export function isWorkBuddySessionFile(name: string, path: string): boolean {
  if (!name.endsWith('.jsonl')) return false;
  if (path.includes('/subagents/') || path.includes('/tool-results/')) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name.replace(/\.jsonl$/i, ''));
}

/** user 消息里的 harness 信封(<system-reminder data-role="user-context"> 等):
 *  不是用户原话,标题与消息索引都要排除(INV-171 同规)。 */
export function isWorkBuddyEnvelope(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;
  return /<(system-reminder|environment_context|user-context|user_info|identity_context|command-name|local-command)/i.test(trimmed);
}

export interface WorkBuddyHead {
  sessionId: string | null;
  cwd: string | null;
  aiTitle: string | null;
  firstUserText: string | null;
  startedAt: number | null;
}

/** 只读文件头:sessionId/cwd/aiTitle/首条真实用户输入(标题与目录用,不碰正文)。 */
export function parseWorkBuddyHead(path: string): WorkBuddyHead {
  const head: WorkBuddyHead = { sessionId: null, cwd: null, aiTitle: null, firstUserText: null, startedAt: null };
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
    if (head.startedAt == null && typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
      head.startedAt = record.timestamp > 1e12 ? record.timestamp : record.timestamp * 1000;
    }
    if (head.sessionId == null && typeof record.sessionId === 'string' && record.sessionId) {
      head.sessionId = record.sessionId;
    }
    if (head.cwd == null && typeof record.cwd === 'string' && record.cwd.startsWith('/')) {
      head.cwd = record.cwd;
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
      head.aiTitle = record.aiTitle; // 取最后一条(标题随会话更新)
    }
    if (head.firstUserText == null && record.type === 'message' && record.role === 'user') {
      const blocks = Array.isArray(record.content) ? record.content : [];
      const text = blocks
        .map((block) => (
          block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : ''
        ))
        .join('\n')
        .trim();
      if (text && !isWorkBuddyEnvelope(text)) head.firstUserText = text;
    }
  }
  return head;
}

export function extractWorkBuddySession(path: string, mtimeMs: number): SessionRecord | null {
  const head = parseWorkBuddyHead(path);
  const nativeId = head.sessionId ?? basename(path).replace(/\.jsonl$/i, '');
  if (!nativeId) return null;
  const titleSource = head.aiTitle ?? head.firstUserText ?? '';
  return {
    id: `workbuddy:${nativeId}`,
    provider: 'workbuddy',
    nativeId,
    cwd: head.cwd,
    title: titleify(titleSource) || null,
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

/** OpenAI 风格 usage:{inputTokens(含 cached), outputTokens, totalTokens,
 *  inputTokensDetails[].cached_tokens, outputTokensDetails[].reasoning_tokens}。
 *  inputTokens 是全量 prompt:非缓存输入 = inputTokens - cached_tokens,
 *  保证 total = 非缓存输入 + cached + output 不重复计费。 */
export function workBuddyNumericUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
} {
  const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  const detail = (list: unknown, key: string): number => {
    if (!Array.isArray(list)) return 0;
    let total = 0;
    for (const item of list) {
      if (item && typeof item === 'object') total += finite((item as Record<string, unknown>)[key]);
    }
    return total;
  };
  const inputTokensAll = finite(usage.inputTokens);
  const cached = Math.min(detail(usage.inputTokensDetails, 'cached_tokens'), inputTokensAll);
  const outputTokens = finite(usage.outputTokens);
  const totalTokens = finite(usage.totalTokens) || inputTokensAll + outputTokens;
  return {
    inputTokens: inputTokensAll - cached,
    cachedInputTokens: cached,
    cacheCreationInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: detail(usage.outputTokensDetails, 'reasoning_tokens'),
    totalTokens,
  };
}

/** function_call 行的请求模型:providerData.requestModelId(如 hy4free)
 *  优先于展示名 model(如 hy4-free)。 */
export function workBuddyModelOf(record: Record<string, unknown>): string {
  const providerData = record.providerData && typeof record.providerData === 'object'
    ? record.providerData as Record<string, unknown>
    : {};
  const model = providerData.requestModelId ?? providerData.model;
  return typeof model === 'string' && model.trim() ? model.trim() : 'unknown';
}

// ── 消息行(transcript.ts 消费) ─────────────────────────────────────

/** 单条 record → 消息行:message(user/assistant 正文,信封排除)、
 *  function_call(tool 行)。reasoning/file-history-snapshot 不入消息索引。 */
export function messagesFromWorkBuddyRecord(sessionId: string, record: Record<string, unknown>, seq: number): SessionMessageRow[] {
  const type = typeof record.type === 'string' ? record.type : '';
  const id = `${sessionId}:${seq}`;
  const ts = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
    ? (record.timestamp > 1e12 ? record.timestamp : record.timestamp * 1000)
    : null;
  if (type === 'message') {
    const role = record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : null;
    if (!role) return [];
    const blocks = Array.isArray(record.content) ? record.content : [];
    const text = blocks
      .map((block) => (
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : typeof block === 'string' ? block : ''
      ))
      .join('\n');
    if (role === 'user' && isWorkBuddyEnvelope(text)) return [];
    const row = textRow(sessionId, id, seq, role, text, ts);
    return row ? [row] : [];
  }
  if (type === 'function_call') {
    const name = typeof record.name === 'string' ? record.name : 'tool';
    let input: unknown = record.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* 非 JSON 入参按原文本入行 */
      }
    }
    return [toolRow(sessionId, id, seq, name, input, ts)];
  }
  return [];
}

// ── workbuddy.db 只读元数据 ────────────────────────────────────────

export interface WorkBuddyDbSession {
  model: string | null;
  cwd: string | null;
  title: string | null;
  contextWindow: number | null;
}

/** sessions 表一次只读全读(百行量级):sessionId → 元数据。库缺席/加锁返回
 *  空 Map,调用方降级为纯 jsonl(workbuddy 运行中 WAL 并发读是安全的)。 */
export function readWorkBuddyDbSessions(root?: string): Map<string, WorkBuddyDbSession> {
  const map = new Map<string, WorkBuddyDbSession>();
  const dbPath = join(root ?? workbuddyHome(), 'workbuddy.db');
  if (!existsSync(dbPath)) return map;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.query(
      'SELECT id, model, cwd, title, context_window FROM sessions',
    ).all() as Array<{
      id: string;
      model: string | null;
      cwd: string | null;
      title: string | null;
      context_window: number | null;
    }>;
    for (const row of rows) {
      map.set(row.id, {
        model: row.model,
        cwd: row.cwd && row.cwd.startsWith('/') ? row.cwd : null,
        title: row.title,
        contextWindow: typeof row.context_window === 'number' ? row.context_window : null,
      });
    }
  } catch {
    /* 加锁/格式变化:降级为纯 jsonl */
  } finally {
    db?.close();
  }
  return map;
}
