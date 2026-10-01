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
