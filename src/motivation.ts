/**
 * 动机抽取 v2(WG 归因链):从 session_messages 的用户消息流离线规则抽取
 * 「需求」,替代 head 解析的 session.title(首条消息启发式)。
 * 不走 LLM 自报(dsh-track 教训,见 docs/work-graph-design.md)。
 */
import { isShortAck, titleify } from './sessions.ts';

// 已知的工具/系统注入信封(前缀匹配,大小写不敏感)
const KNOWN_ENVELOPE_RE = /^<\s*(?:recommended_plugins|system-reminder|command-|local-command|bash-|task-|tool_|environment_)/i;
// 其余 XML 风格标签开头的行也按信封处理(如 <user_prompt_...>、<plugin ...>)
const XML_ENVELOPE_RE = /^<[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?>/;

/**
 * 判断一条用户消息是不是已知的工具/系统注入信封(recommended_plugins、
 * system-reminder 等)。比 isMetaEnvelope 窄:不把任意 XML 标签当信封
 * ——<task> 这类承载任务正文的包裹由调用方自行剥壳。
 */
export function isKnownEnvelope(text: string): boolean {
  return KNOWN_ENVELOPE_RE.test(text.trim());
}

/**
 * 判断一条用户消息是不是 meta 信封(系统注入/命令包装/环境快照),
 * 而不是用户自己的需求文本。
 */
export function isMetaEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('Caveat:')) return true;
  // sessions.ts:226 的原有语义:[ 开头的是命令输出类消息
  if (trimmed.startsWith('[')) return true;
  if (KNOWN_ENVELOPE_RE.test(trimmed)) return true;
  if (XML_ENVELOPE_RE.test(trimmed)) return true;
  return false;
}

/**
 * 从有序的用户消息里挑第一条非 meta、非短回复的实质消息作为需求。
 * 全部不合格或列表为空时返回 null(调用方退回 session.title)。
 */
export function pickRequirement(texts: string[]): string | null {
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed || isShortAck(trimmed)) continue;
    if (isMetaEnvelope(trimmed)) continue;
    const titled = titleify(trimmed);
    if (titled) return titled;
  }
  return null;
}
