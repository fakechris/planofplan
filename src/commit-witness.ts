import type { SessionCommit } from './types.ts';
import { Database } from 'bun:sqlite';

// ── commit witness:transcript 目击式归因 ────────────────────────────
// 三家参考项目都没有这个层:agentsview 只做 repo×email×时间窗总量聚合,
// obelisk 到 file_path 为止,Wake 不碰 git。这里从 L0 事实里挖确定性证据:
// agent 执行 `git commit` 时,tool_result 里印着 `[branch sha] subject`——
// transcript 白纸黑字"目击"了 commit 的诞生。
//
// 两个防假阳性的关键设计:
// 1. 配对制:只有与「git commit 命令的 tool_use」配对(同 call id)的
//    tool_result 才算目击。git log 浏览输出的几十个 sha 一概不算。
// 2. 命令分段判定:按 shell 分隔符切开逐段看是否 `git ... commit` 子命令,
//    排除 `git log --grep commit` 这类浏览型命令。

export interface CommitWitness {
  sessionId: string;
  sha: string;
  ts: number | null;
}

/**
 * 配对状态:claude/codex 存 call id → 1(pending);antigravity 无 call id,
 * 用计数槽(一个 PLANNER 可带多个 commit 命令,后续 GENERIC 按序消费)。
 * 跨行、跨批次持续,文件级生命周期。>0 即 pending,与真值判断兼容。
 */
export type WitnessPairing = Map<string, number>;

/** antigravity 无 call id:单计数槽跨行配对。 */
const AGY_PENDING = 'antigravity:pending';

/** git commit 输出首行:`[main a1b2c3d] subject`;root-commit:`[main (root-commit) a1b2c3d]`。 */
const COMMIT_OUTPUT_RE = /\[[^\s\]]+ (?:(?:\(root-commit\)|\(amend\)) )?([0-9a-f]{7,40})\]/;

/** 这些 git 全局 flag 各吃一个值(-C /repo),token 扫描时要连值一起跳过。 */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '-S', '--gpg-sign']);

/** shell 包装词:codex 的 command 数组 join 后形如 "bash -lc git commit -m x"。 */
const SHELL_WRAPPER_RE = /^(?:(?:bash|sh|zsh|dash|ksh|env|exec|sudo|command|nohup|xargs|rtk|proxy)(?:\s+|$)|[-+][a-z]*c[a-z]*\s+)/;

export function isGitCommitCommand(command: string): boolean {
  if (!command.includes('commit')) return false;
  for (const rawSegment of command.split(/&&|\|\||;|\|/)) {
    // 剥掉 shell 包装前缀(可叠加:bash -lc / sudo env …),但普通词(echo)不剥
    let segment = rawSegment.trim();
    for (let i = 0; i < 4 && SHELL_WRAPPER_RE.test(segment); i += 1) {
      segment = segment.replace(SHELL_WRAPPER_RE, '');
    }
    // 注意不做行尾锚定:-m 的多行消息会让 ^git...$ 直接失配(实测踩过)
    if (!/^git\s/.test(segment)) continue;
    const args = segment.replace(/^git\s+/, '');
    // 跳过全局 flag(带值的一并跳值),第一个子命令 token 是 commit 才算
    const tokens = args.trim().split(/\s+/);
    let i = 0;
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      if (GIT_VALUE_FLAGS.has(tokens[i]!) || tokens[i]!.startsWith('--') && !tokens[i]!.includes('=')) i += 2;
      else i += 1;
    }
    if (tokens[i] === 'commit') return true;
  }
  return false;
}

/** 最小化反转义:cmd 从 JS/JSON 字符串里抠出来时带着 \" \\n 等转义。 */
function unescapeJsonish(raw: string): string {
  return raw.replace(/\\(["\\nrt])/g, (_, c: string) => (
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
  ));
}

function shaFromOutput(text: string): string | null {
  const match = COMMIT_OUTPUT_RE.exec(text);
  return match?.[1] ?? null;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''))
      .join('\n');
  }
  return '';
}

function recordTimestamp(record: Record<string, unknown>): number | null {
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 单条 record 的目击提取(有状态:pairing 跨 record 维护 call id)。
 * v1 覆盖 claude(tool_use/tool_result 按 id 配对)与 codex
 * (function_call/function_call_output 按 call_id 配对);zcode 的 SQLite
 * 路径与 dsh/factory(不落盘工具输出)留待后续/witness 盲区由 hook 兜底。
 */
export function commitWitnessesFromRecord(
  provider: string,
  sessionId: string,
  record: Record<string, unknown>,
  pairing: WitnessPairing,
): CommitWitness[] {
  const out: CommitWitness[] = [];
  const ts = recordTimestamp(record);
  if (provider === 'claude') {
    const message = record.message && typeof record.message === 'object'
      ? record.message as Record<string, unknown>
      : null;
    const content = message?.content;
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'tool_use' && typeof item.id === 'string') {
        const input = item.input && typeof item.input === 'object' ? item.input as Record<string, unknown> : {};
        const command = typeof input.command === 'string' ? input.command : '';
        if (command && isGitCommitCommand(command)) pairing.set(item.id, 1);
        continue;
      }
      if (item.type === 'tool_result' && typeof item.tool_use_id === 'string' && pairing.get(item.tool_use_id)) {
        pairing.delete(item.tool_use_id);
        const sha = shaFromOutput(textOfContent(item.content));
        if (sha) out.push({ sessionId, sha, ts });
      }
    }
    return out;
  }
  if (provider === 'codex') {
    if (record.type !== 'response_item') return out;
    const payload = record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, unknown>
      : null;
    if (!payload) return out;
    // custom_tool_call(exec 工具):input 是 JS 代码,cmd 藏在
    // tools.exec_command({"cmd":"..."}) 的字符串里(2026-08 本机实证主形态)
    if (payload.type === 'custom_tool_call' && typeof payload.call_id === 'string') {
      const input = typeof payload.input === 'string' ? payload.input : '';
      const cmdMatch = /["']cmd["']\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
      if (cmdMatch) {
        const command = unescapeJsonish(cmdMatch[1]!);
        if (isGitCommitCommand(command)) pairing.set(payload.call_id, 1);
      }
      return out;
    }
    if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string' && pairing.get(payload.call_id)) {
      pairing.delete(payload.call_id);
      // output 是字符串化的分块文本(单引号伪 JSON),直接在原文上找 sha
      const raw = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      const sha = shaFromOutput(raw);
      if (sha) out.push({ sessionId, sha, ts });
      return out;
    }
    if (payload.type === 'function_call' && typeof payload.call_id === 'string') {
      // codex shell 的 arguments 是 JSON 字符串;command 可能是字符串或数组
      let command = '';
      if (typeof payload.arguments === 'string') {
        try {
          const parsed = JSON.parse(payload.arguments) as { command?: unknown };
          const raw = parsed?.command;
          if (typeof raw === 'string') command = raw;
          else if (Array.isArray(raw)) command = raw.filter((x) => typeof x === 'string').join(' ');
        } catch {
          command = payload.arguments;
        }
      }
      if (command && isGitCommitCommand(command)) pairing.set(payload.call_id, 1);
      return out;
    }
    if (payload.type === 'function_call_output' && typeof payload.call_id === 'string' && pairing.get(payload.call_id)) {
      pairing.delete(payload.call_id);
      let text = '';
      if (typeof payload.output === 'string') {
        try {
          const parsed = JSON.parse(payload.output) as { output?: unknown; content?: unknown };
          text = typeof parsed?.output === 'string' ? parsed.output : typeof parsed?.content === 'string' ? parsed.content : payload.output;
        } catch {
          text = payload.output;
        }
      }
      const sha = shaFromOutput(text);
      if (sha) out.push({ sessionId, sha, ts });
    }
    return out;
  }
  if (provider === 'antigravity') {
    // 输入:PLANNER_RESPONSE.tool_calls[].args.CommandLine(值带 JSON 引号包裹)
    if (record.type === 'PLANNER_RESPONSE' && Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const args = (call as { args?: unknown }).args;
        const command = unquoteCommandLine(
          args && typeof args === 'object' ? (args as { CommandLine?: unknown }).CommandLine : undefined,
        );
        if (command && isGitCommitCommand(command)) {
          pairing.set(AGY_PENDING, (pairing.get(AGY_PENDING) ?? 0) + 1);
        }
      }
      return out;
    }
    // 输出:紧随的 GENERIC/MODEL("The command exited with code N.\nOutput:\n…")
    if (record.type === 'GENERIC' && record.source === 'MODEL' && typeof record.content === 'string') {
      const pending = pairing.get(AGY_PENDING) ?? 0;
      if (pending > 0) {
        pairing.set(AGY_PENDING, pending - 1);
        const sha = shaFromOutput(record.content);
        // antigravity 的时间字段是 created_at(recordTimestamp 只认 timestamp)
        const ts2 = typeof record.created_at === 'string' ? Date.parse(record.created_at) : NaN;
        if (sha) out.push({ sessionId, sha, ts: Number.isFinite(ts2) ? ts2 : ts });
      }
    }
    return out;
  }
  return out;
}

/** antigravity 的 CommandLine 值形如 "\"git commit -m x\""(JSON 字符串再包引号)。 */
function unquoteCommandLine(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1).replace(/\"/g, '"');
    }
  }
  return trimmed;
}

/** witness 与真实 commit 的匹配:前缀对齐(目击拿到的是 7+ 位缩写)。 */
export function witnessMatchesSha(witness: string, sha: string): boolean {
  return witness.length >= 7 && witness.length <= 40 && sha.startsWith(witness);
}

/** 归因行分级文案(图谱/详情共用口径)。 */
export function commitKindLabel(kind: SessionCommit['kind']): string {
  if (kind === 'declared') return '声明';
  if (kind === 'witnessed') return '目击';
  return '推断';
}

/**
 * zcode 目击:tool part 的 state.input.command 与 state.output 同 part 存放
 * (无配对问题);output 过大时 zcode 换成 persisted-output 指针 + 2KB 预览,
 * 预览含 sha 即可命中,截断的接受部分覆盖(钩子兜底)。
 */
export function commitWitnessesFromZcodeDb(path: string, nativeId: string, sessionId: string): CommitWitness[] {
  const out: CommitWitness[] = [];
  try {
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.query(
        `SELECT p.data AS part, m.time_created AS created
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'tool'`,
      ).all(nativeId) as Array<{ part: string; created: number | null }>;
      for (const row of rows) {
        try {
          const part = JSON.parse(row.part) as {
            callID?: unknown; tool?: unknown;
            state?: { input?: { command?: unknown }; output?: unknown; time?: unknown } | null;
          };
          const command = typeof part.state?.input?.command === 'string' ? part.state!.input!.command! : '';
          if (!command || !isGitCommitCommand(command)) continue;
          const raw = typeof part.state?.output === 'string' ? part.state.output : '';
          const sha = shaFromOutput(raw);
          if (sha) {
            const ts = typeof part.state?.time === 'number' ? part.state.time : row.created;
            out.push({ sessionId, sha, ts });
          }
        } catch {
          /* 单条 part 解析失败跳过 */
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* zcode db 不可读:跳过 */
  }
  return out;
}
