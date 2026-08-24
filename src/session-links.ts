/**
 * Launch 边(ia-redesign §1.4b):session --spawned-by--> 发起者。
 *
 * 三类来源:
 *   1. parent_id 已知的(codex thread_spawn、claude subagent 路径)
 *      → 边 evidence_kind='observed'
 *   2. plugin:claude 回链:codex session 首条真实用户 prompt(跳过
 *      <recommended_plugins> 信封)出现在某个 claude session 的 tool_use
 *      入参里(codex exec 命令行)→ 'declared';
 *      对不上退 candidate(发起前 10 分钟内活跃 + cwd 相同或子树)
 *   3. herdr 等环境型 → 不进边表,存 origin_detail(session-origin.ts)
 *
 * 幂等:backfill(v6 迁移)和每轮 collect 的物化走同一套逻辑;
 * 父 session 可能不在库(窗口外/已删),边照写,查询侧容忍悬空。
 */
import type { Store } from './db.ts';
import type { SessionLink, SessionRecord } from './types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLUGIN_PROMPT_PREFIX = 80;
const PLUGIN_GRACE_MS = 10 * 60_000;

/**
 * claude subagent 路径 → 父 session id。
 *   <proj>/<parent-uuid>/subagents/agent-*.jsonl → claude:<parent-uuid>
 *   <proj>/subagents/agent-*.jsonl(顶层形态)→ 路径里没有父 uuid,返回 null
 */
export function claudeParentOfPath(sourceFile: string): string | null {
  const marker = '/subagents/';
  const at = sourceFile.indexOf(marker);
  if (at < 0) return null;
  const before = sourceFile.slice(0, at);
  const parentDir = before.split('/').pop() ?? '';
  return UUID_RE.test(parentDir) ? `claude:${parentDir}` : null;
}

/**
 * declared 匹配的 probe 串,从严到宽逐级降:
 *   1. 正文前 80 字符(companion 脚本形态:命令行逐字包含 task 正文)
 *   2. 首行前 5 词 / 3 词(Task 工具形态:prompt 被改写,只共享开头词组)
 * 最短 probe 保留 16 字符,避免退化成泛词误配。
 */
function pluginProbes(prompt: string): string[] {
  const body = prompt.trim();
  const firstLine = (body.split('\n')[0] ?? body).trim();
  const words = firstLine.split(/\s+/);
  const probes = [body.slice(0, PLUGIN_PROMPT_PREFIX), words.slice(0, 5).join(' '), words.slice(0, 3).join(' ')];
  return [...new Set(probes)].filter((probe) => probe.trim().length >= 16);
}

/** plugin:claude session → 发起它的 claude session(declared/candidate)。 */
function linkPluginSession(store: Store, session: SessionRecord): SessionLink | null {
  const started = session.startedAt ?? session.updatedAt;
  // declared:prompt 片段出现在某条 claude tool 消息(命令行 / Task 入参)里,
  // 且该消息时间戳贴近 codex 拉起时刻(时间戳缺失退 session updated_at)。
  // 长寿命 claude 会话里同一句式的旧消息很常见,时间窗是防误配的关键。
  const prompt = store.firstUserText(session.id);
  if (prompt) {
    for (const needle of pluginProbes(prompt)) {
      const ranked = store.claudeSessionsWithToolText(needle)
        .filter((row) => row.sessionId !== session.id)
        .map((row) => ({ sessionId: row.sessionId, delta: (row.ts ?? row.updatedAt) - started }))
        .filter((row) => Math.abs(row.delta) <= PLUGIN_GRACE_MS)
        .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      const best = ranked[0];
      if (best) {
        return {
          fromSession: session.id,
          toSession: best.sessionId,
          kind: 'spawned-by',
          evidenceKind: 'declared',
          createdAt: Date.now(),
        };
      }
    }
  }
  // candidate:declared 对不上时退启发式——claude 会话在拉起时刻附近活跃
  // (±10min)且 cwd 相同或 codex cwd 在其子树,取最近的一个
  const candidates = store.listSessionRows().filter((row) => (
    row.provider === 'claude'
    && row.id !== session.id
    && row.updatedAt >= started - PLUGIN_GRACE_MS
    && row.updatedAt <= started + PLUGIN_GRACE_MS
    && row.cwd != null
    && session.cwd != null
    && (row.cwd === session.cwd || session.cwd.startsWith(`${row.cwd}/`))
  ));
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  const best = candidates[0];
  if (!best) return null;
  return {
    fromSession: session.id,
    toSession: best.id,
    kind: 'spawned-by',
    evidenceKind: 'candidate',
    createdAt: Date.now(),
  };
}

/**
 * 物化(每轮 collect 末尾跑,幂等):
 *  1. claude subagent 路径 → parent_id(只补缺的)
 *  2. 所有 parent_id → spawned-by/observed 边
 *  3. plugin:claude 还没有 spawned-by 边的 → 回链(declared/candidate)
 */
export function materializeSessionLinks(store: Store): void {
  const now = Date.now();
  const sessions = store.listSessionRows();

  // 1. claude parent_id(纯路径计算,不读文件)
  const parentPatches: Array<{ id: string; parentId: string | null }> = [];
  for (const session of sessions) {
    if (session.provider !== 'claude' || session.parentId || !session.sourceFile) continue;
    const parentId = claudeParentOfPath(session.sourceFile);
    if (parentId) parentPatches.push({ id: session.id, parentId });
  }
  if (parentPatches.length > 0) store.updateSessionOrigins(parentPatches);

  const links: SessionLink[] = [];
  const parentById = new Map<string, string>();
  for (const session of sessions) {
    const parentId = session.parentId
      ?? parentPatches.find((patch) => patch.id === session.id)?.parentId
      ?? null;
    if (parentId) parentById.set(session.id, parentId);
  }

  // 已有边一次拉全(别逐 session 查)
  const existing = new Set(store.listSessionLinks().map((link) => `${link.fromSession}→${link.toSession}`));
  const linkedFrom = new Set(store.listSessionLinks().map((link) => link.fromSession));
  for (const [fromSession, toSession] of parentById) {
    if (fromSession === toSession || existing.has(`${fromSession}→${toSession}`)) continue;
    links.push({ fromSession, toSession, kind: 'spawned-by', evidenceKind: 'observed', createdAt: now });
  }

  // 3. plugin:claude 回链(有界:这类 session 实测个位数到几十)
  for (const session of sessions) {
    if (session.origin !== 'plugin:claude') continue;
    if (linkedFrom.has(session.id)) continue;
    const link = linkPluginSession(store, session);
    if (link) {
      links.push(link);
      linkedFrom.add(session.id);
    }
  }

  store.upsertSessionLinks(links);
}

/** v6 迁移 backfill:与每轮物化同一条路径(幂等)。 */
export function backfillLaunchLinks(store: Store): void {
  materializeSessionLinks(store);
}
