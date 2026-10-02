/**
 * How a free-text query becomes SQL against the message index (INV-899).
 *
 * The FTS table uses the trigram tokenizer. A phrase shorter than three characters
 * matches nothing on its own and is silently ignored inside a multi-phrase AND, so
 * "部署 脚本" found nothing and "git 回滚" matched on "git" alone — Chinese two-character
 * words are the most common search terms. Every term must still be required:
 * terms of three or more characters go to FTS MATCH, shorter ones become LIKE
 * conditions in the same statement (so LIMIT and paging stay correct), and a query
 * made only of short terms is a conjunction of LIKEs.
 *
 * One home for this: message_search / session_search (message-evidence.ts) and the
 * web API (Store.searchSessionMessages) both plan through here.
 */

export interface MessageQueryPlan {
  /** FTS5 MATCH expression of the long terms, or null when every term is short. */
  match: string | null;
  /** LIKE patterns (with `\` escapes) every row must also satisfy. */
  likes: string[];
  /** The terms, for building snippets on the LIKE path. */
  terms: string[];
}

const TRIGRAM_MIN = 3;

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function planMessageQuery(query: string): MessageQueryPlan {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const long = terms.filter((term) => [...term].length >= TRIGRAM_MIN);
  const short = terms.filter((term) => [...term].length < TRIGRAM_MIN);
  return {
    match: long.length > 0 ? long.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ') : null,
    likes: short.map(likePattern),
    terms,
  };
}

/** Every term as a LIKE: the fallback when FTS cannot run the query. */
export function likeAllTerms(plan: MessageQueryPlan): string[] {
  return plan.terms.map(likePattern);
}

/** `col LIKE ? ESCAPE '\'` joined with AND, one per pattern; empty string for none. */
export function likeClauses(column: string, count: number): string {
  return Array.from({ length: count }, () => `${column} LIKE ? ESCAPE '\\'`).join(' AND ');
}

/** A short excerpt around the first term found, with the \u0001/\u0002 highlight markers FTS snippets use. */
export function likeSnippet(text: string, terms: string[], context = 24): string {
  const lower = text.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at < 0) continue;
    const start = Math.max(0, at - context);
    const end = at + term.length;
    return `${start > 0 ? '…' : ''}${text.slice(start, at)}\u0001${text.slice(at, end)}\u0002${text.slice(end, end + context)}${end + context < text.length ? '…' : ''}`;
  }
  return text.slice(0, context * 2);
}

/**
 * Tools whose calls are commands worth finding later (INV-900). "How did we deploy
 * last time" is answered by the ssh/sed/docker lines that ran, not by the prose
 * around them. Only these tools' command text enters the full-text index: other
 * tool input (Edit/Write bodies, file reads) stays out — it was most of the index
 * when everything was in.
 */
export const SEARCHABLE_TOOL_NAMES = ['bash', 'exec', 'exec_command', 'shell', 'local_shell', 'run_terminal_cmd'] as const;

export function isSearchableTool(name: string | null | undefined): boolean {
  return name != null && (SEARCHABLE_TOOL_NAMES as readonly string[]).includes(name.toLowerCase());
}

/** SQL: this row's text belongs in the full-text index. `row` is a table alias, or new/old in a trigger. */
export function searchableRowSql(row: string): string {
  return `(${row}.kind != 'tool_use' OR lower(${row}.tool_name) IN (${SEARCHABLE_TOOL_NAMES.map((name) => `'${name}'`).join(', ')}))`;
}

/**
 * The command a shell-like tool ran: `command` or `cmd` (a string or an argv array),
 * or the input itself when it is a plain string (codex `exec` code). Inputs arrive
 * as objects or, from some providers, as their JSON text.
 */
export function commandOfToolInput(input: unknown): string | null {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return trimmed || null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const key of ['command', 'cmd']) {
    const field = obj[key];
    if (typeof field === 'string' && field.trim()) return field.trim();
    if (Array.isArray(field) && field.every((part) => typeof part === 'string')) return field.join(' ');
  }
  return null;
}

/**
 * Whether an error from a MATCH query is the query itself being unacceptable to FTS5 — the
 * only case where falling back to LIKE is right (INV-904). Anything else (a locked or
 * corrupt database, a bug) must surface instead of being hidden behind a slower scan.
 */
export function isFtsQueryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fts5|syntax error|unterminated string|no such column|malformed MATCH/i.test(message);
}

/**
 * Snippets handed to agents (message_search, session_search) mark hits with visible
 * guillemets: «hit». The \u0001/\u0002 markers FTS emits are control characters that
 * end up invisible in an agent's context and in anything it quotes. The web UI keeps
 * the raw markers and turns them into <b>.
 */
export function visibleHighlights(snippet: string): string {
  return snippet.replaceAll('\u0001', '«').replaceAll('\u0002', '»');
}
