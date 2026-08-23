/**
 * 文件 touch 行为层(WG 归因链第一环):从 tool_use 入参的结构化字段
 * (file_path / path)提取文件触碰,不对截断文本做正则。
 * Bash/shell 的 command 先不解析(拼接、引号、变量展开都是坑)。
 */
import { isAbsolute, normalize, resolve } from 'node:path';
import type { SessionFileTouch } from './types.ts';

/** 工具名 → 操作类别。没列到的按工具名小写原样归类。 */
const OP_BY_TOOL: Record<string, string> = {
  read: 'read',
  read_file: 'read',
  write: 'write',
  write_file: 'write',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  edit_file: 'edit',
  apply_patch: 'edit',
  glob: 'search',
  grep: 'search',
  search: 'search',
};

export function opOfTool(toolName: string): string {
  return OP_BY_TOOL[toolName.toLowerCase()] ?? toolName.toLowerCase();
}

/** 从 tool_use 入参对象里取文件路径;只认结构化字段,取不到返回 null。 */
export function filePathOfInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** 入库前规范化成绝对路径:相对路径基于 record cwd / session cwd resolve。 */
export function normalizeTouchPath(filePath: string, cwd: string | null): string {
  if (isAbsolute(filePath)) return normalize(filePath);
  if (!cwd) return normalize(filePath);
  return resolve(cwd, filePath);
}

interface TouchSpec {
  toolName: string;
  input: unknown;
  timestamp: number | null;
  cwd: string | null;
  /** 同一行(同一条消息)里的第几个 tool_use,用于稳定 id。 */
  index: number;
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

function cwdOf(record: Record<string, unknown>): string | null {
  const cwd = record.cwd;
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null;
}

function specsFromRecord(record: Record<string, unknown>): TouchSpec[] {
  const ts = tsOf(record.timestamp ?? record.time);
  const cwd = cwdOf(record);
  const specs: TouchSpec[] = [];

  // claude / factory 风格:assistant 消息的 content 数组里嵌 tool_use 块
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : null;
  const content = message?.content ?? record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type !== 'tool_use' || typeof item.name !== 'string') continue;
      specs.push({ toolName: item.name, input: item.input, timestamp: ts, cwd, index: specs.length });
    }
  }

  // codex 风格:response_item 的 function_call / custom_tool_call
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : null;
  if (payload && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
    let input: unknown = payload.arguments ?? payload.input;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* 非 JSON 入参(如 shell command),不提取 */
      }
    }
    if (typeof payload.name === 'string') {
      specs.push({ toolName: payload.name, input, timestamp: ts, cwd, index: specs.length });
    }
  }

  // dsh 风格:tool/call 事件
  if (record.type === 'tool/call') {
    const data = record.data && typeof record.data === 'object'
      ? record.data as Record<string, unknown>
      : {};
    if (typeof data.name === 'string') {
      let input: unknown = data.arguments ?? data.input;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          /* 非 JSON 入参不提取 */
        }
      }
      specs.push({ toolName: data.name, input, timestamp: tsOf(record.time ?? data.time), cwd, index: specs.length });
    }
  }

  // grok 风格:顶层 tool_call / backend_tool_call
  if (record.type === 'backend_tool_call' || record.type === 'tool_call') {
    if (typeof record.name === 'string') {
      specs.push({
        toolName: record.name,
        input: record.arguments ?? record.input,
        timestamp: ts,
        cwd,
        index: specs.length,
      });
    }
  }

  // kimi wire 风格:context.append_loop_event 里的 tool.call
  if (record.type === 'context.append_loop_event') {
    const event = record.event && typeof record.event === 'object'
      ? record.event as Record<string, unknown>
      : {};
    if (event.type === 'tool.call' && typeof event.name === 'string') {
      specs.push({
        toolName: event.name,
        input: event.args,
        timestamp: tsOf(record.time ?? event.time),
        cwd,
        index: specs.length,
      });
    }
  }

  return specs;
}

/**
 * 单条已 parse record → 文件 touch 行。seq 是源文件绝对行号(与消息行一致)。
 * bash/shell 类命令行工具不出行(command 不解析);入参里没有结构化
 * 文件路径字段的工具也不出行。
 */
export function touchesFromRecord(
  provider: string,
  sessionId: string,
  record: Record<string, unknown>,
  seq: number,
  fallbackCwd: string | null,
): SessionFileTouch[] {
  const touches: SessionFileTouch[] = [];
  for (const spec of specsFromRecord(record)) {
    const op = opOfTool(spec.toolName);
    if (op === 'bash' || op === 'shell' || op === 'exec_command' || op === 'exec') continue;
    const rawPath = filePathOfInput(spec.input);
    if (!rawPath) continue;
    touches.push({
      id: `${sessionId}:${seq}:${spec.index}`,
      sessionId,
      provider,
      filePath: normalizeTouchPath(rawPath, spec.cwd ?? fallbackCwd),
      toolName: spec.toolName,
      op,
      ts: spec.timestamp,
      ordinal: seq * 1000 + spec.index,
    });
  }
  return touches;
}
