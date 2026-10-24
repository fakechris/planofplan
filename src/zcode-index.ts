import { Database } from 'bun:sqlite';
import { textRow, toolRow } from './transcript.ts';
import { opOfTool, filePathOfInput, normalizeTouchPath } from './file-touches.ts';
import { TOUCH_BYTES } from './session-repos.ts';
import { isGitCommitCommand, shaFromOutput, type CommitWitness } from './commit-witness.ts';
import type { SessionFileTouch, SessionMessageRow } from './types.ts';

/**
 * zcode 会话的单趟合并抽取(INV-1329)。
 *
 * 旧路径对每个 session 跑三个独立查询+各自 JSON.parse(messages /
 * touches / witnesses),同一 part 的 data 被反复解析与物化,69 个 session
 * 一轮重扫实测把子进程 RSS 推到 1.2GB。本模块在一条按消息序的流式游标上
 * 同趟产出三类行,堆占用收敛到单 session。
 *
 * 输出与旧三函数逐字节等价,等价要点:
 * - 消息:ORDER BY m.time_created, p.sequence, p.time_created 上的枚举序,
 *   text/tool/tool-call 三分支与 messagesFromZcodeDb 相同;
 * - touch:ordinal 编号沿用 touchesFromOpencodeDb part 路径的独立视图序
 *   (m.time_created, p.time_created, p.id)下的全 part 枚举位置 ×1000,
 *   patch 分支 +fIdx;bash/shell/exec 排除;state.workdir 覆盖 cwd;
 * - witness:只认 json_extract(type)='tool'(不含 tool-call),ts 取
 *   state.time ?? m.time_created。
 */
export interface ZcodeSessionExtraction {
  messages: SessionMessageRow[];
  touches: SessionFileTouch[];
  witnesses: CommitWitness[];
  /** 头部 TOUCH_BYTES 内的已解析 part(zcode 的 repo/touch 归因原料),
   *  与通用 JSONL 路径同语义;替代旧 recordsFromZcodeDb 的第三趟全量。 */
  headRecords: unknown[];
}

interface TouchSpec {
  partId: string;
  fIdx: number;
  toolName: string;
  op: string;
  rawPath: string;
  ts: number | null;
  cwd: string | null;
}

export function extractZcodeSession(
  db: Database,
  nativeId: string,
  sessionId: string,
  fallbackCwd: string | null,
): ZcodeSessionExtraction {
  const messages: SessionMessageRow[] = [];
  const { touches, witnesses, headRecords } = extractZcodeSessionStreaming(
    db, nativeId, sessionId, fallbackCwd,
    (batch) => { messages.push(...batch); },
  );
  return { messages, touches, witnesses, headRecords };
}

/**
 * 流式版(INV-1329):消息行按批回调(每 400 行),会话内的堆占用收敛到
 * 单批 + 轻量 touch/witness 引用——巨型会话(几十万 token)不再把全文
 * 消息整程驻留在内存后再落库。touch 的 ordinal 依赖全 part 枚举序,
 * 只保留轻量引用(part id + 时间戳),不持有解析对象。
 */
export function extractZcodeSessionStreaming(
  db: Database,
  nativeId: string,
  sessionId: string,
  fallbackCwd: string | null,
  onMessages: (rows: SessionMessageRow[]) => void,
): { touches: SessionFileTouch[]; witnesses: CommitWitness[]; headRecords: unknown[] } {
  const witnesses: CommitWitness[] = [];
  const touchSpecs: TouchSpec[] = [];
  // touch 视图的排序引用(全 part,含解析失败与不产 touch 的 part):
  // ordinal 是「位置」而非「命中数」,必须按完整枚举序编号
  const partRefs: Array<{ id: string; created: number | null; partCreated: number | null }> = [];
  let messageBatch: SessionMessageRow[] = [];
  let batchBytes = 0;
  const headRecords: unknown[] = [];
  let approxBytes = 0;

  const stmt = db.query(
    `SELECT p.id AS part_id, p.time_created AS part_created, m.data AS message, p.data AS part, m.time_created AS created
     FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ?
     ORDER BY m.time_created, p.sequence, p.time_created`,
  );
  let seq = 0;
  for (const row of stmt.iterate(nativeId) as Generator<{
    part_id: string;
    part_created: number | null;
    message: string;
    part: string;
    created: number | null;
  }>) {
    seq += 1;
    partRefs.push({ id: row.part_id, created: row.created, partCreated: row.part_created });
    let role: string | undefined;
    let part: {
      type?: string;
      text?: string;
      tool?: string;
      name?: string;
      files?: string[];
      input?: unknown;
      state?: { input?: { command?: unknown } & Record<string, unknown>; workdir?: string; time?: unknown; output?: unknown } | null;
    };
    try {
      const message = JSON.parse(row.message) as { role?: string };
      part = JSON.parse(row.part) as typeof part;
      role = message.role;
    } catch {
      /* 单条 part 解析失败跳过(旧三路径同条同步失败) */
      continue;
    }
    approxBytes += row.part.length + 1;
    batchBytes += row.part.length + 1;
    if (approxBytes <= TOUCH_BYTES) headRecords.push(part);
    const id = `${sessionId}:${row.part_id}`;
    const roleUserAssistant = role === 'user' ? 'user' : 'assistant';
    const ts = row.created;

    if (part.type === 'text' && part.text) {
      const text = textRow(sessionId, id, seq, roleUserAssistant, part.text, ts);
      if (text) messageBatch.push(text);
    } else if (part.type === 'tool' || part.type === 'tool-call') {
      const toolName = part.tool ?? part.name ?? 'tool';
      messageBatch.push(toolRow(sessionId, id, seq, toolName, part.state?.input ?? part.input ?? part.text ?? '', ts));

      // touch:工具名空串兜底、shell 族排除、workdir 覆盖——旧 touches 路径语义
      const touchToolName = part.tool ?? part.name ?? '';
      const op = opOfTool(touchToolName);
      if (op !== 'bash' && op !== 'shell' && op !== 'exec_command' && op !== 'exec') {
        const rawPath = filePathOfInput(part.state?.input);
        if (rawPath) {
          const cwd = (typeof part.state?.workdir === 'string' && part.state.workdir.startsWith('/'))
            ? part.state.workdir
            : fallbackCwd;
          touchSpecs.push({ partId: row.part_id, fIdx: -1, toolName: touchToolName, op, rawPath, ts: row.part_created, cwd });
        }
      }

      // witness:只认 type='tool'(旧查询的 json_extract 条件不含 tool-call)
      if (part.type === 'tool') {
        const command = typeof part.state?.input?.command === 'string' ? part.state!.input!.command! : '';
        if (command && isGitCommitCommand(command)) {
          const raw = typeof part.state?.output === 'string' ? part.state.output : '';
          const sha = shaFromOutput(raw);
          if (sha) {
            witnesses.push({ sessionId, sha, ts: typeof part.state?.time === 'number' ? part.state.time : ts });
          }
        }
      }
    } else if (part.type === 'patch') {
      const files = Array.isArray(part.files) ? part.files : [];
      for (let fIdx = 0; fIdx < files.length; fIdx += 1) {
        const rawPath = files[fIdx];
        if (typeof rawPath === 'string' && rawPath.trim()) {
          const cwd = (typeof part.state?.workdir === 'string' && part.state.workdir.startsWith('/'))
            ? part.state.workdir
            : fallbackCwd;
          touchSpecs.push({ partId: row.part_id, fIdx, toolName: 'patch', op: 'edit', rawPath: rawPath.trim(), ts: row.part_created, cwd });
        }
      }
    }
    // 行数与字节双阈值:tool_result 单行可达 MB 级,只按行数会让单批堆
    // 占用失控(INV-1329)
    if (messageBatch.length >= 400 || batchBytes >= 4 * 1024 * 1024) {
      onMessages(messageBatch);
      messageBatch = [];
      batchBytes = 0;
    }
  }
  if (messageBatch.length > 0) onMessages(messageBatch);

  // touch 视图序下的全 part 枚举位置(旧 touches 查询的 ORDER BY 等价重排)
  const touchViewOrder = [...partRefs].sort((a, b) => {
    const byCreated = (a.created ?? Number.NEGATIVE_INFINITY) - (b.created ?? Number.NEGATIVE_INFINITY);
    if (byCreated !== 0) return byCreated;
    const byPartCreated = (a.partCreated ?? Number.NEGATIVE_INFINITY) - (b.partCreated ?? Number.NEGATIVE_INFINITY);
    if (byPartCreated !== 0) return byPartCreated;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  const positionById = new Map(touchViewOrder.map((ref, index) => [ref.id, index + 1]));
  const touches: SessionFileTouch[] = touchSpecs.map((spec) => ({
    id: spec.fIdx >= 0 ? `${sessionId}:${spec.partId}:${spec.fIdx}` : `${sessionId}:${spec.partId}`,
    sessionId,
    provider: 'opencode',
    filePath: normalizeTouchPath(spec.rawPath, spec.cwd),
    toolName: spec.toolName,
    op: spec.op,
    ts: spec.ts,
    ordinal: (positionById.get(spec.partId) ?? 0) * 1000 + (spec.fIdx >= 0 ? spec.fIdx : 0),
  }));
  return { touches, witnesses, headRecords };
}
