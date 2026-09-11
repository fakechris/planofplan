/**
 * 日志脱敏（sourcebot jobLogger 实践：字段名匹配即脱敏值）。
 * 接入点是 Scheduler 的 ctx.log——全部 adapter 日志的单一漏斗,日志里的
 * token/key/cookie 值在落 terminal 与 ~/.planofplan/serve.log 之前被替换。
 *
 * 三种形态分别处理,避免误杀正常文案:
 * - JSON 字段: `"access_token": "xxx"`(带引号的 key 无歧义);
 * - HTTP 头: `Authorization: Bearer xxx` / `Cookie: ...`(仅限 header 语义的
 *   字段名,不含裸 "token",否则 "input token: 500" 会被误杀);
 * - k=v 对: `refresh_token=xxx`(URL/表单形态,= 不会出现在计数文案里)。
 */

const JSON_SECRET_FIELDS = /("(?:authorization|cookie|credential|password|private_?key|secret|access_?token|refresh_?token|api_?key|token)"\s*:\s*")([^"]*)(")/gi;
const HEADER_SECRET = /\b(authorization|cookie|x-api-key)\s*:\s*[^\s,;"']+/gi;
const PAIR_SECRET = /\b(access_?token|refresh_?token|api_?key|apikey|client_?secret|secret|password|token)\s*=\s*[^&\s",;]+/gi;
const SCHEME_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(JSON_SECRET_FIELDS, '$1[REDACTED]$3')
    // Bearer/Basic 串先处理,再吃剩余的裸头值,避免把 scheme 词当值截断
    .replace(SCHEME_TOKEN, '$1 [REDACTED]')
    .replace(HEADER_SECRET, (match) => `${match.split(':')[0]!.trim()}: [REDACTED]`)
    .replace(PAIR_SECRET, (match) => `${match.split('=')[0]!.trim()}=[REDACTED]`)
    // 头值与 scheme 串可能先后命中同一密钥,合并重复标记
    .replace(/\[REDACTED\](\s*\[REDACTED\])+/g, '[REDACTED]');
}
