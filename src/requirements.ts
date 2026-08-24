/**
 * Requirement 实体(ia-redesign §1.5):从 session_messages 的用户消息流
 * 规则抽取需求实体,替代 /api/sessions 现场算的 requirement 字符串。
 *
 * 两个维度:
 *   - origin 分级:dsh-track 词汇表,invariant「agent 提议永远低一等」。
 *     v1 规则只落两档——用户原话(user_explicit)/ 头部解析退化推断
 *     (system_inferred);user_confirmed / agent_proposed 等 HITL 档是后话。
 *   - 意图分类:requirement(有可验收交付物)/ directive(执行步骤:
 *     commit、重启、装依赖)/ interruption(纠正)。只有 requirement 建实体,
 *     另两类留在消息层(这里只负责不建实体)。规则分类,不上 LLM judge。
 *
 * 项目归属按 span 不按 session(dsh-track 教训):需求归哪个项目看它自己
 * 证据窗口里 tool call 实际碰的 repo——[本条需求 seq, 下一条需求 seq)
 * 窗口内的 file_touches 按.repo root 最长前缀映射。
 */
import { isMetaEnvelope } from './motivation.ts';
import { isShortAck } from './sessions.ts';
import type { Store } from './db.ts';
import type { RequirementRecord, SessionRecord } from './types.ts';

export type MessageIntent = 'requirement' | 'directive' | 'interruption' | 'noise';
export type RequirementOriginLevel = 'user_explicit' | 'system_inferred';

/** 实体文本上限:存原话(详情页要高亮展示),超长截断;列表展示层再截。 */
const TEXT_MAX = 2000;

// 执行步骤类:本身不是需求,是「怎么做」。短消息才按 directive 处理,
// 长消息即使以这些词开头也更可能是带上下文的真实需求。
const DIRECTIVE_RE = /^(?:继续|接着|再来一次|重试|重启|重新启动|部署|上线|发布|装(?:个|一下)?依赖|安装依赖|跑(?:一下)?测试|commit\b|push\b|merge\b|rebase\b|git\s+(?:add|commit|push|checkout|stash|rebase)|npm\s+(?:i|install)|bun\s+i|pip\s+install|run\s+tests?|restart\b|retry\b|开个?pr|发个?pr|提个?pr|(?:请你?)?开始(?:运行|执行))/i;
// 纠正类:打断当前方向。开头的否定/停止词,且消息不长。
const INTERRUPTION_RE = /^(?:不对|不是这样|不是这|不是的|错了|你搞错|你理解错|别这样|别改|别动|别急|停下?|等一下|等下|停一下|收回|撤销|算了|undo\b|stop\b|wait\b|hold\s+on|no[,.])/i;
const DIRECTIVE_MAX_LEN = 120;
// 粘贴物:markdown 标题开头(AGENTS.md/文档转贴)、裸文件路径或 URL 单行
// ——真实数据的马拉松会话里是高频噪音。
const PASTE_HEADING_RE = /^#{1,6}\s/;
const PASTE_PATH_RE = /^(?:\/|[\w.-]+\/)[\w./~+-]*\.[A-Za-z0-9]{1,8}$/;
// 工具/传输注入:zcode 等把系统提醒写进 user 消息流(实测 30 天 442 条),
// 以及连接失败的错误回显。
const TOOL_REMINDER_RE = /^The Todo(?:Write)? tool hasn't been used/i;
const ERROR_ECHO_RE = /^(?:Unable to establish|API Error\b|Error:)/i;

/** 单条用户消息的意图(v1 规则)。 */
export function classifyMessageIntent(text: string): MessageIntent {
  const trimmed = text.trim();
  if (!trimmed || isShortAck(trimmed) || isMetaEnvelope(trimmed)) return 'noise';
  if (PASTE_HEADING_RE.test(trimmed) || PASTE_PATH_RE.test(trimmed)) return 'noise';
  if (TOOL_REMINDER_RE.test(trimmed) || ERROR_ECHO_RE.test(trimmed)) return 'noise';
  if (INTERRUPTION_RE.test(trimmed) && trimmed.length <= DIRECTIVE_MAX_LEN * 2) return 'interruption';
  if (DIRECTIVE_RE.test(trimmed) && trimmed.length <= DIRECTIVE_MAX_LEN) return 'directive';
  return 'requirement';
}

/** 需求实体推导的中间形态(span 归因在 materialize 里补)。 */
export interface DerivedRequirement {
  id: string;
  sessionId: string;
  /** 证据锚点:user 消息 seq;推断退化实体(无消息锚点)为 -1。 */
  seq: number;
  text: string;
  originLevel: RequirementOriginLevel;
  ts: number | null;
}

/**
 * 一个 session → 需求实体列表。
 *   - 每条 requirement 意图的用户消息 → user_explicit 实体(可多条)
 *   - 一条都没有时退 session.title → system_inferred 实体(保持
 *     「每个 user 会话都有可展示需求」的现状语义)
 */
export function deriveSessionRequirements(
  session: SessionRecord,
  messages: Array<{ seq: number; ts: number | null; text: string }>,
): DerivedRequirement[] {
  const explicit: DerivedRequirement[] = [];
  for (const message of messages) {
    if (classifyMessageIntent(message.text) !== 'requirement') continue;
    const text = message.text.trim().slice(0, TEXT_MAX);
    if (!text) continue;
    explicit.push({
      id: `req:${session.id}:${message.seq}`,
      sessionId: session.id,
      seq: message.seq,
      text,
      originLevel: 'user_explicit',
      ts: message.ts,
    });
  }
  if (explicit.length > 0) return explicit;
  const title = session.title?.trim();
  if (!title) return [];
  return [{
    id: `req:${session.id}:-1`,
    sessionId: session.id,
    seq: -1,
    text: title.slice(0, TEXT_MAX),
    originLevel: 'system_inferred',
    ts: session.startedAt ?? session.updatedAt,
  }];
}

/**
 * span 级项目归因:需求 → 它证据窗口里实际碰的 repo url。
 * 窗口 = [本条 seq, 下一条 seq);touch 的 ordinal 与消息 seq 同坐标空间
 * (源文件行号,ordinal = seq*1000 + part 序,见 file-touches.ts)。
 * 文件按 session_repos 的 root 最长前缀映射,映射不上跳过。
 */
function spanReposFor(
  session: SessionRecord,
  derived: DerivedRequirement[],
  touches: Array<{ filePath: string; ordinal: number }>,
): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  if (touches.length === 0) return byId;
  const bounds = derived.map((item) => item.seq);
  const roots = [...new Set(
    (session.repos ?? [])
      .filter((repo) => repo.root)
      .map((repo) => ({ root: repo.root, url: repo.url })),
  )].sort((a, b) => b.root.length - a.root.length);
  if (roots.length === 0) return byId;
  const reposOfTouch = new Map<number, string[]>();
  for (const touch of touches) {
    const line = Math.floor(touch.ordinal / 1000);
    let spanIndex = -1;
    for (let i = 0; i < bounds.length; i += 1) {
      const start = bounds[i];
      const end = i + 1 < bounds.length ? bounds[i + 1] : Number.POSITIVE_INFINITY;
      if (line >= start && line < end) {
        spanIndex = i;
        break;
      }
    }
    if (spanIndex < 0) continue; // 需求之前的 touch,不属于任何 span
    const hit = roots.find((entry) => touch.filePath === entry.root || touch.filePath.startsWith(`${entry.root}/`));
    if (!hit) continue;
    const urls = reposOfTouch.get(spanIndex) ?? [];
    if (!urls.includes(hit.url)) urls.push(hit.url);
    reposOfTouch.set(spanIndex, urls);
  }
  derived.forEach((item, index) => {
    const urls = reposOfTouch.get(index);
    if (urls?.length) byId.set(item.id, urls);
  });
  return byId;
}

/**
 * 物化(每轮 collect 末尾跑):全量重导,确定性 id,幂等。
 * 只覆盖 origin=user 的 session(subagent 的派工 prompt 不是需求,
 * 与 buildWorkGraph 的排除口径一致)。
 */
export function materializeRequirements(store: Store): number {
  const bySession = new Map<string, Array<{ seq: number; ts: number | null; text: string }>>();
  for (const row of store.listUserMessageRows()) {
    if (!row.text) continue;
    const list = bySession.get(row.sessionId) ?? [];
    list.push({ seq: row.seq, ts: row.ts, text: row.text });
    bySession.set(row.sessionId, list);
  }
  const rows: RequirementRecord[] = [];
  for (const session of store.listSessionRows()) {
    if ((session.origin ?? 'user') !== 'user') continue;
    const derived = deriveSessionRequirements(session, bySession.get(session.id) ?? []);
    if (derived.length === 0) continue;
    const spanRepos = spanReposFor(session, derived, store.listSessionTouches(session.id));
    for (const item of derived) {
      rows.push({ ...item, repos: spanRepos.get(item.id) ?? [] });
    }
  }
  store.replaceAllRequirements(rows);
  return rows.length;
}
