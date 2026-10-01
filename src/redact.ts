/**
 * 脱敏:日志与消息索引共用(INV-898)。
 * 接入点:Scheduler 的 ctx.log(全部 adapter 日志的单一漏斗),以及
 * Store.upsertSessionMessages / upsertSessions(全部 provider 的消息与标题入库漏斗)。
 * 索引是可重建的 L1,经 MCP 提供给任意 agent;密钥不该被复制进第二个存储。
 * L0 原始日志不动。
 *
 * 两类规则:
 * - 按字段名(sourcebot jobLogger 实践),三种形态分别处理,避免误杀正常文案:
 *   - JSON 字段: `"access_token": "xxx"`(带引号的 key 无歧义);
 *   - HTTP 头: `Authorization: Bearer xxx` / `Cookie: ...`(仅限 header 语义的
 *     字段名,不含裸 "token",否则 "input token: 500" 会被误杀);
 *   - k=v 对: `refresh_token=xxx`(URL/表单形态,= 不会出现在计数文案里)。
 * - 按值的格式:正文里裸出现的密钥(粘贴的 key、命令行参数)没有字段名可依,
 *   只能靠各家固定前缀与长度识别。只收前缀明确、误杀概率低的格式。
 */

const JSON_SECRET_FIELDS = /("(?:authorization|cookie|credential|password|private_?key|secret|access_?token|refresh_?token|api_?key|token)"\s*:\s*")([^"]*)(")/gi;
const HEADER_SECRET = /\b(authorization|cookie|x-api-key)\s*:\s*[^\s,;"']+/gi;
const PAIR_SECRET = /\b(access_?token|refresh_?token|api_?key|apikey|client_?secret|secret|password|token)\s*=\s*[^&\s",;]+/gi;
const SCHEME_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** 有固定前缀的密钥格式。顺序:长前缀在前(sk-ant- 先于 sk-)。 */
const VALUE_SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, // OpenAI 及兼容(sk- 后足够长才算)
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\binv_agent_[A-Za-z0-9_-]{20,}/g, // Involute agent token
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of VALUE_SECRETS) out = out.replace(pattern, '[REDACTED]');
  return out
    .replace(JSON_SECRET_FIELDS, '$1[REDACTED]$3')
    // Bearer/Basic 串先处理,再吃剩余的裸头值,避免把 scheme 词当值截断
    .replace(SCHEME_TOKEN, '$1 [REDACTED]')
    .replace(HEADER_SECRET, (match) => `${match.split(':')[0]!.trim()}: [REDACTED]`)
    .replace(PAIR_SECRET, (match) => `${match.split('=')[0]!.trim()}=[REDACTED]`)
    // 头值与 scheme 串可能先后命中同一密钥,合并重复标记
    .replace(/\[REDACTED\](\s*\[REDACTED\])+/g, '[REDACTED]');
}

/** null 透传,供可空列使用。 */
export function redactNullable<T extends string | null | undefined>(text: T): T {
  return (typeof text === 'string' ? redactSecrets(text) : text) as T;
}
