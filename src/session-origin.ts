/**
 * Session origin 归因:区分真实用户会话与被其它 agent/自动化拉起的会话。
 *
 * 分类(优先级从高到低):
 *   claude:source_file 含 /subagents/                    → subagent
 *   codex:source.subagent.thread_spawn                   → subagent(记 parentId)
 *   codex:originator == 'Claude Code'                    → plugin:claude
 *   codex:originator == 'codex_exec' || source == 'exec' → exec
 *   其余                                                 → user
 * herdr 关联只做 user → herdr 升级,不覆盖更强标记:session startedAt 落在
 * 某条 `agent changed ... agent=Some(X)` 日志事件 ±2 分钟内、且 session cwd
 * 等于该 pane 在 session.json 里的 cwd。herdr 不存在/解析失败 → 跳过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { SessionOrigin } from './types.ts';

export interface OriginTag {
  origin: SessionOrigin;
  parentId?: string | null;
}

/** codex session_meta payload → origin。plain user 时返回 null(不动既有值)。 */
export function classifyCodexMeta(payload: Record<string, unknown>): OriginTag | null {
  const source = payload.source;
  if (source && typeof source === 'object') {
    const subagent = (source as Record<string, unknown>).subagent;
    if (subagent && typeof subagent === 'object') {
      const spawn = (subagent as Record<string, unknown>).thread_spawn;
      const parentId = spawn && typeof spawn === 'object'
        && typeof (spawn as Record<string, unknown>).parent_thread_id === 'string'
        ? `codex:${(spawn as Record<string, unknown>).parent_thread_id}`
        : null;
      return { origin: 'subagent', parentId };
    }
  }
  const originator = typeof payload.originator === 'string' ? payload.originator : '';
  if (originator === 'Claude Code') return { origin: 'plugin:claude' };
  if (originator === 'codex_exec' || source === 'exec') return { origin: 'exec' };
  return null; // user:不产出标记,由 DB 默认值/既有值兜底
}

/** claude 的 subagent 布局靠路径判断。 */
export function classifySessionPath(provider: string, sourceFile: string): OriginTag | null {
  if (provider === 'claude' && sourceFile.includes('/subagents/')) return { origin: 'subagent' };
  return null;
}

// ── herdr 关联 ──────────────────────────────────────────────────

export interface HerdrAgentEvent {
  ts: number;
  pane: number;
  agent: string;
}

const HERDR_EVENT_RE = /^(\S+)\s+\S+\s+\S+.*\bagent changed pane=(\d+)\b.*\bagent=Some\((\w+)\)/;

export function parseHerdrLog(text: string): HerdrAgentEvent[] {
  const events: HerdrAgentEvent[] = [];
  for (const line of text.split('\n')) {
    const match = HERDR_EVENT_RE.exec(line);
    if (!match) continue;
    const ts = Date.parse(match[1]!);
    if (!Number.isFinite(ts)) continue;
    events.push({ ts, pane: Number(match[2]), agent: match[3]! });
  }
  return events;
}

/** session.json:workspaces[].tabs[].panes 是 { "<pane 编号>": { cwd } } 字典。 */
export function herdrPaneCwd(jsonText: string): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const doc = JSON.parse(jsonText) as {
      workspaces?: Array<{ tabs?: Array<{ panes?: Record<string, { cwd?: unknown }> }> }>;
    };
    for (const ws of doc.workspaces ?? []) {
      for (const tab of ws.tabs ?? []) {
        for (const [pane, info] of Object.entries(tab.panes ?? {})) {
          if (typeof info?.cwd === 'string') map.set(Number(pane), info.cwd);
        }
      }
    }
  } catch {
    /* 解析失败 → 空映射,调用方跳过 */
  }
  return map;
}

const HERDR_AGENT_PROVIDER: Record<string, string> = {
  Codex: 'codex',
  Claude: 'claude',
  Droid: 'factory',
};
const HERDR_WINDOW_MS = 2 * 60_000;

/**
 * herdr 升级 pass。只升 codex/claude/factory 的 user session。
 * 返回升级条数;herdr 不存在或解析失败返回 0。
 */
export function applyHerdrOrigin(
  store: Store,
  logPath = join(homedir(), '.config', 'herdr', 'herdr-server.log'),
  sessionJsonPath = join(homedir(), '.config', 'herdr', 'session.json'),
): number {
  if (!existsSync(logPath) || !existsSync(sessionJsonPath)) return 0;
  const events = parseHerdrLog(readFileSync(logPath, 'utf8'));
  const paneCwd = herdrPaneCwd(readFileSync(sessionJsonPath, 'utf8'));
  if (events.length === 0 || paneCwd.size === 0) return 0;

  const patches: Array<{ id: string; origin: SessionOrigin }> = [];
  for (const session of store.listSessionRows()) {
    if ((session.origin ?? 'user') !== 'user') continue; // 不覆盖更强标记
    const started = session.startedAt ?? session.updatedAt;
    for (const event of events) {
      const provider = HERDR_AGENT_PROVIDER[event.agent];
      if (provider !== session.provider) continue;
      if (Math.abs(started - event.ts) > HERDR_WINDOW_MS) continue;
      if (paneCwd.get(event.pane) !== session.cwd) continue;
      patches.push({ id: session.id, origin: 'herdr' });
      break;
    }
  }
  store.updateSessionOrigins(patches);
  return patches.length;
}

/**
 * 一次性 backfill:为升级前已落库的 session 补 origin。codex 重读
 * source_file 第一行(文件不在则跳过);claude 走路径判断。幂等。
 *
 * 完成标记用 session_index_state 的哨兵行 '__origin_backfill__',不复用
 * PRAGMA user_version —— schema 迁移(v5 projects)也会推它,双用途曾把
 * backfill 门永久关掉(v4 的教训)。
 */
export function backfillSessionOrigins(store: Store): void {
  if (store.getSessionIndexState('__origin_backfill__')) return;
  const patches: Array<{ id: string; origin: SessionOrigin; parentId?: string | null }> = [];
  for (const session of store.listSessionRows()) {
    const byPath = session.sourceFile ? classifySessionPath(session.provider, session.sourceFile) : null;
    if (byPath) {
      patches.push({ id: session.id, ...byPath });
      continue;
    }
    if (session.provider !== 'codex' || !session.sourceFile || !existsSync(session.sourceFile)) continue;
    try {
      const firstLine = readFileSync(session.sourceFile, 'utf8').split('\n', 1)[0] ?? '';
      const record = JSON.parse(firstLine) as { type?: string; payload?: unknown };
      if (record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') continue;
      const tag = classifyCodexMeta(record.payload as Record<string, unknown>);
      // 同一 session 拆成多个 rollout 文件时,thread_spawn 可能回指自身 id:
      // 保留 subagent 标记,但 parentId 置空(不写自指)
      if (tag) {
        patches.push({
          id: session.id,
          origin: tag.origin,
          parentId: tag.parentId && tag.parentId !== session.id ? tag.parentId : null,
        });
      }
    } catch {
      /* 单行解析失败跳过 */
    }
  }
  store.updateSessionOrigins(patches);
  store.upsertSessionIndexState({
    path: '__origin_backfill__',
    mtimeMs: Date.now(),
    size: 0,
    parsedBytes: 0,
    lines: 0,
    parserVersion: 0,
  });
}
