/**
 * Devin Desktop 会话源（INV-1960）。
 *
 * L0 布局（实测 2026-11-20，调研附件 devin-research-2026-11-20.md §2）：
 * - `~/Library/Application Support/Devin/User/acp-messages/<uuid>.db` —— 每会话一个
 *   SQLite(WAL)：`messages(position, kind, payload)` append-only（kind: user_message /
 *   agent_message / tool_call / progress_marker）+ `meta`（schema_version=6、
 *   history_skeleton 全量骨架）。正文与元数据在 payload：user/agent 的
 *   `content[0].content.text` + `content[0]._meta."cognition.ai/*"`（eventId /
 *   createdAtMs / sender）；tool_call 的 `content.{title,status}` + `content._meta`。
 * - 索引：state.vscdb ItemTable `windsurf.acp.messageStore.session.<…>/devin-<32hex>`
 *   → `{"uuid","lastUpdated"}`；uuid 即库文件名，键尾段即 session_id（devin-<32hex>）。
 * - 本地是缓存窗口非全量（全量在云端）；ACU 消耗事件以 tool_call 形态落库
 *   （title "ACU usage reset"），如实入消息索引，不换算 token（零捏造：
 *   SessionRecord token 三项为 0、cost null，TurnStats 落盘形态待样本再扩展）。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SessionMessageRow, SessionRecord } from './types.ts';
import { sessionKey, titleify } from './sessions.ts';
import { textRow, toolRow } from './transcript.ts';

/** 当前实测 schema；不认识的版本 fail-soft 跳过（acceptance 要求）。 */
export const SUPPORTED_DEVIN_SCHEMA_VERSION = 6;

const DEVIN_SESSION_ID_RE = /^devin-[0-9a-f]{32}$/;
const DB_STEM_RE = /^[0-9a-f]{8,}$/;

export function devinAppSupport(): string {
  if (process.platform === 'darwin') {
    return process.env.DEVIN_HOME ?? join(homedir(), 'Library', 'Application Support', 'Devin');
  }
  return process.env.DEVIN_HOME ?? join(homedir(), '.config', 'Devin');
}

export function devinAcpMessagesRoot(root?: string): string {
  return join(root ?? devinAppSupport(), 'User', 'acp-messages');
}

export function devinStateDbPath(root?: string): string {
  return join(root ?? devinAppSupport(), 'User', 'globalStorage', 'state.vscdb');
}

/**
 * state.vscdb 消息库索引：uuid → { sessionId, lastUpdated }。
 * 键形如 `windsurf.acp.messageStore.session.acp/devin-cloud/…/devin-<32hex>`，
 * 取尾段为 session_id；非该形状或值不合法的键静默忽略（索引漂移不致命，
 * 兜底路径用 uuid 当 nativeId）。
 */
export function readDevinMessageStoreIndex(statePath = devinStateDbPath()): Map<string, { sessionId: string; lastUpdated: number | null }> {
  const index = new Map<string, { sessionId: string; lastUpdated: number | null }>();
  if (!existsSync(statePath)) return index;
  let db: Database | null = null;
  try {
    db = new Database(statePath, { readonly: true });
  } catch {
    return index;
  }
  try {
    const rows = db
      .query(`SELECT key, value FROM ItemTable WHERE key LIKE 'windsurf.acp.messageStore.session.%'`)
      .all() as Array<{ key: string; value: string | Uint8Array }>;
    for (const row of rows) {
      const sessionId = row.key.split('/').pop() ?? '';
      if (!DEVIN_SESSION_ID_RE.test(sessionId)) continue;
      try {
        const raw = typeof row.value === 'string' ? row.value : new TextDecoder('utf-8').decode(row.value);
        const parsed = JSON.parse(raw) as { uuid?: unknown; lastUpdated?: unknown };
        if (typeof parsed.uuid === 'string' && DB_STEM_RE.test(parsed.uuid)) {
          index.set(parsed.uuid, {
            sessionId,
            lastUpdated: typeof parsed.lastUpdated === 'number' ? parsed.lastUpdated : null,
          });
        }
      } catch {
        /* 单键损坏不影响其余索引 */
      }
    }
  } catch {
    /* state.vscdb 结构漂移：返回空索引，走 uuid 兜底 */
  } finally {
    db.close();
  }
  return index;
}

export interface DevinSqliteHandle {
  db: Database;
  /** 临时拷贝目录；直开成功时为 null（无清理动作）。 */
  cleanup: (() => void) | null;
}

/**
 * 只读语义打开 acp-messages 库。Devin 的库是 journal_mode=WAL：SQLite 不允许
 * 对"无 -shm 伴文件"的 WAL 库做只读连接（Devin.app 未运行、wal 已 checkpoint
 * 删除时也一样），所以直开 + 探针失败后落到拷贝路径——拷贝 db+wal+shm 到
 * 临时目录并以**读写**打开副本（副本是我们自己的文件，读写让 SQLite 自建
 * shm 完成恢复；对原库零写入，只读底线不破）。forceCopy 供测试强制走拷贝。
 */
export function openDevinSqlite(dbPath: string, options: { forceCopy?: boolean } = {}): DevinSqliteHandle | null {
  if (!options.forceCopy) {
    let direct: Database | null = null;
    try {
      direct = new Database(dbPath, { readonly: true });
      // WAL 库被活跃写方持有时 open 可能成功而首个查询才报锁——探针先行，
      // 失败即落到拷贝路径（实测 Devin.app 运行中即此形态）
      direct.query('SELECT 1 FROM sqlite_master LIMIT 1').get();
      return { db: direct, cleanup: null };
    } catch {
      direct?.close();
      /* fall through 到拷贝 */
    }
  }
  if (!existsSync(dbPath)) return null;
  let tmpDir: string | null = null;
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'devin-acp-'));
    tmpDir = tmp;
    const copy = join(tmp, 'cache.db');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
      } catch {
        /* wal/shm 不存在或正在轮转：主库拷贝已够读 */
      }
    }
    return {
      // 读写打开自有副本：WAL 库只读连接无 -shm 时被 SQLite 拒绝
      db: new Database(copy),
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  } catch {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
}

interface DevinMeta {
  schema_version?: unknown;
  history_skeleton?: unknown;
  lastUpdated?: unknown;
  [key: string]: unknown;
}

interface SkeletonItem {
  id?: unknown;
  type?: unknown;
  created_at_ms?: unknown;
}

function metaOf(db: Database): DevinMeta {
  try {
    const row = db.query(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>;
    const out: DevinMeta = {};
    for (const item of row) {
      if (item.key === 'schema_version') {
        const n = Number(item.value);
        out.schema_version = Number.isFinite(n) ? n : item.value;
      } else if (item.key === 'history_skeleton' || item.key === 'source_history') {
        try {
          out[item.key] = JSON.parse(item.value);
        } catch {
          /* 骨架损坏：忽略，时间范围退回消息行 */
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 事件时间戳：createdAtMs 优先（整数 ms），退回 ISO timestamp 解析。 */
function eventMs(contentMeta: Record<string, unknown> | undefined): number | null {
  const created = contentMeta?.['cognition.ai/createdAtMs'];
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  const ts = contentMeta?.['cognition.ai/timestamp'];
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function eventIdOf(contentMeta: Record<string, unknown> | undefined, position: number): string {
  const id = contentMeta?.['cognition.ai/eventId'];
  return typeof id === 'string' && id !== '' ? id : `pos-${position}`;
}

interface ParsedDevinMessages {
  rows: SessionMessageRow[];
  firstUserText: string | null;
  firstMs: number | null;
  lastMs: number | null;
  maxPosition: number | null;
}

/**
 * messages 表 → 消息行 + 会话摘要（首条用户文本、时间范围、最大 position）。
 * sincePosition 是行级水位（position 单调递增、append-only，首行 position=0，
 * 故初始水位为 -1）；只取 `position > sincePosition` 的新增行。
 * ACU 消耗事件（tool_call，eventType=acu_consumption_at_last_user_interaction）
 * 按原样入 tool 行（title 含 "ACU usage reset"，可被 FTS 命中）——如实记 ACU，
 * 不换算 token。progress_marker 无正文，跳过。
 */
export function parseDevinMessages(db: Database, sessionId: string, sincePosition = -1): ParsedDevinMessages {
  const out: ParsedDevinMessages = { rows: [], firstUserText: null, firstMs: null, lastMs: null, maxPosition: sincePosition > -1 ? sincePosition : null };
  let raw: Array<{ position: number; kind: string; payload: string }> = [];
  try {
    raw = db
      .query(`SELECT position, kind, payload FROM messages WHERE position > ? ORDER BY position`)
      .all(sincePosition) as Array<{ position: number; kind: string; payload: string }>;
  } catch {
    return out;
  }
  for (const item of raw) {
    out.maxPosition = Math.max(out.maxPosition ?? item.position, item.position);
    let payload: {
      kind?: string;
      content?: unknown;
      id?: string;
    };
    try {
      payload = JSON.parse(item.payload);
    } catch {
      continue; // 单行损坏：跳过，不拖垮整库
    }
    if (item.kind === 'user_message' || item.kind === 'agent_message') {
      const blocks = Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [];
      const block = blocks.find((b) => {
        const text = (b.content as Record<string, unknown> | undefined)?.text;
        return typeof text === 'string' && text.trim() !== '';
      });
      if (!block) continue;
      const text = String((block.content as Record<string, unknown>).text);
      const meta = (block._meta ?? undefined) as Record<string, unknown> | undefined;
      const ms = eventMs(meta);
      if (ms != null) {
        out.firstMs = out.firstMs ?? ms;
        out.lastMs = ms;
      }
      if (item.kind === 'user_message' && out.firstUserText == null && !text.trimStart().startsWith('<')) {
        out.firstUserText = text;
      }
      const row = textRow(sessionId, `${sessionId}:${eventIdOf(meta, item.position)}`, item.position, item.kind === 'user_message' ? 'user' : 'assistant', text, ms);
      if (row) out.rows.push(row);
    } else if (item.kind === 'tool_call') {
      const content = (payload.content ?? {}) as Record<string, unknown>;
      const meta = (content._meta ?? undefined) as Record<string, unknown> | undefined;
      const ms = eventMs(meta);
      if (ms != null) out.lastMs = ms;
      const title = typeof content.title === 'string' && content.title !== '' ? content.title : 'tool';
      out.rows.push(toolRow(sessionId, `${sessionId}:${eventIdOf(meta, item.position)}`, item.position, title, content, ms));
    }
  }
  return out;
}

/**
 * 单库 → SessionRecord（每库一会话）。schema 版本不认识 → 空数组（fail-soft，
 * 由调用方记录并保留水位不前进，升级支持后自动补扫）。
 */
export function extractDevinSessionFile(dbPath: string, mtimeMs: number): SessionRecord[] {
  const uuid = dbPath.split('/').pop()?.replace(/\.db$/i, '') ?? '';
  if (!DB_STEM_RE.test(uuid)) return [];
  const handle = openDevinSqlite(dbPath);
  if (!handle) return [];
  try {
    const meta = metaOf(handle.db);
    if (meta.schema_version !== SUPPORTED_DEVIN_SCHEMA_VERSION) {
      console.error(
        `[devin-session] skip ${dbPath}: schema_version=${String(meta.schema_version)} != ${SUPPORTED_DEVIN_SCHEMA_VERSION} (unsupported, will retry next scan)`,
      );
      return [];
    }
    // 索引库与消息库同根推导（root/User/{acp-messages,globalStorage}），
    // 不依赖 env——发现层已保证路径来自同一应用数据根
    const statePath = join(dirname(dbPath), '..', 'globalStorage', 'state.vscdb');
    const index = readDevinMessageStoreIndex(statePath);
    const entry = index.get(uuid);
    const nativeId = entry?.sessionId ?? uuid;
    const id = sessionKey('devin', nativeId);
    const parsed = parseDevinMessages(handle.db, id);
    // 骨架覆盖全量历史（缓存窗口之前的部分），起点优先用骨架首条
    let skeletonFirstMs: number | null = null;
    const skeleton = meta.history_skeleton as { items?: SkeletonItem[] } | undefined;
    if (skeleton && Array.isArray(skeleton.items)) {
      for (const it of skeleton.items) {
        if (typeof it.created_at_ms === 'number' && Number.isFinite(it.created_at_ms)) {
          skeletonFirstMs = it.created_at_ms;
          break;
        }
      }
    }
    const startedAt = skeletonFirstMs ?? parsed.firstMs;
    const updatedAt = parsed.lastMs ?? entry?.lastUpdated ?? mtimeMs;
    return [
      {
        id,
        provider: 'devin',
        nativeId,
        cwd: null, // 云端会话无本地 cwd；repo 归属在云端，本地缓存不含
        title: parsed.firstUserText != null ? titleify(parsed.firstUserText) : null,
        sourceFile: dbPath,
        startedAt,
        updatedAt,
        inputTokens: 0, // ACU 计费：本地无 token 明细，零捏造（不虚构 0 成本之外的数量）
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
        seenAt: Date.now(),
      },
    ];
  } finally {
    handle.cleanup?.();
    handle.db.close();
  }
}
