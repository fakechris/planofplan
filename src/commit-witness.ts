import type { SessionCommit } from './types.ts';

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

/** tool_use/call id → true(是 git commit 调用)。跨行、跨批次持续,文件级生命周期。 */
export type WitnessPairing = Map<string, boolean>;

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
        if (command && isGitCommitCommand(command)) pairing.set(item.id, true);
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
      if (command && isGitCommitCommand(command)) pairing.set(payload.call_id, true);
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
  return out;
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
