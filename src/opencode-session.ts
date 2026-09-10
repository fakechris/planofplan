/**
 * OpenCode session catalog and message extraction.
 *
 * OpenCode stores its conversation history in SQLite:
 * ~/.local/share/opencode/opencode.db (and opencode-next.db).
 *
 * Schema:
 *   - session: id, project_id, parent_id, directory, title, time_created, time_updated, tokens_*
 *   - message: id, session_id, time_created, data (JSON: role, model, tokens)
 *   - part: id, message_id, session_id, time_created, data (JSON: type=text|tool|patch|reasoning)
 *   - OpenCode 2 / next: session_message (type, data)
 */
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { sessionKey, titleify } from './sessions.ts';
import { textRow, toolRow } from './transcript.ts';
import { filePathOfInput, normalizeTouchPath, opOfTool } from './file-touches.ts';
import { isGitCommitCommand, shaFromOutput, type CommitWitness } from './commit-witness.ts';
import type { SessionFileTouch, SessionMessageRow, SessionRecord, TranscriptTurn } from './types.ts';

const OPENCODE_DEFAULT_TITLE_RE = /^(?:new session|child session)\s*-\s*\d{4}-\d{2}-\d{2}/i;

export function isOpenCodeDefaultTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  return OPENCODE_DEFAULT_TITLE_RE.test(title.trim());
}

interface OpenCodeSessionDbRow {
  id: string;
  project_id?: string | null;
  parent_id?: string | null;
  title?: string | null;
  directory?: string | null;
  path?: string | null;
  time_created: number;
  time_updated: number;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_reasoning?: number | null;
}

export function extractOpencodeDb(path: string, mtimeMs: number): SessionRecord[] {
  if (!existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    // Check if session table exists
    const hasSessionTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session'",
    ).get();
    if (!hasSessionTable) return [];
    const cols = new Set(
      (db.query("PRAGMA table_info('session')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    const selectCols = [
      'id',
      cols.has('parent_id') ? 'parent_id' : 'NULL AS parent_id',
      cols.has('title') ? 'title' : 'NULL AS title',
      cols.has('directory') ? 'directory' : 'NULL AS directory',
      cols.has('path') ? 'path' : 'NULL AS path',
      cols.has('time_created') ? 'time_created' : '0 AS time_created',
      cols.has('time_updated') ? 'time_updated' : '0 AS time_updated',
      cols.has('tokens_input') ? 'tokens_input' : '0 AS tokens_input',
      cols.has('tokens_output') ? 'tokens_output' : '0 AS tokens_output',
      cols.has('tokens_reasoning') ? 'tokens_reasoning' : '0 AS tokens_reasoning',
    ].join(', ');

    const rows = db.query(`SELECT ${selectCols} FROM session`).all() as OpenCodeSessionDbRow[];

    return rows.map((row) => {
      const rawTitle = row.title ? row.title.trim() : '';
      const displayTitle = isOpenCodeDefaultTitle(rawTitle) ? null : (titleify(rawTitle) || null);
      const inputTokens = Number(row.tokens_input) || 0;
      const outputTokens = Number(row.tokens_output) || 0;
      const reasoningTokens = Number(row.tokens_reasoning) || 0;
      const totalTokens = inputTokens + outputTokens + reasoningTokens;

      return {
        id: sessionKey('opencode', row.id),
        provider: 'opencode',
        nativeId: row.id,
        parentId: row.parent_id ? sessionKey('opencode', row.parent_id) : null,
        origin: row.parent_id ? 'subagent' : 'user',
        cwd: row.directory || row.path || null,
        title: displayTitle,
        sourceFile: path,
        startedAt: row.time_created || null,
        updatedAt: row.time_updated || mtimeMs,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCostUsd: null,
        seenAt: Date.now(),
      };
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function messagesFromOpencodeDb(path: string, nativeId: string, sessionId: string): SessionMessageRow[] {
  const rows: SessionMessageRow[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });

    // Check if v2 session_message table exists and has rows
    const hasSessionMessage = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message'",
    ).get();

    if (hasSessionMessage) {
      const v2Rows = db.query(
        `SELECT id, type, data, time_created
         FROM session_message
         WHERE session_id = ?
         ORDER BY time_created, id`,
      ).all(nativeId) as Array<{ id: string; type: string; data: string; time_created: number | null }>;

      if (v2Rows.length > 0) {
        let seq = 0;
        for (const r of v2Rows) {
          seq += 1;
          try {
            const data = JSON.parse(r.data) as Record<string, unknown>;
            const role = r.type === 'user' ? 'user' : 'assistant';
            const text = typeof data.text === 'string' ? data.text : (typeof data.content === 'string' ? data.content : '');
            const id = `${sessionId}:${r.id}`;
            if (text) {
              const textRowObj = textRow(sessionId, id, seq, role, text, r.time_created);
              if (textRowObj) rows.push(textRowObj);
            }
          } catch {
            /* skip */
          }
        }
        return rows;
      }
    }

    // Standard v1: message + part
    const hasPartTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='part'",
    ).get();
    if (!hasPartTable) return rows;

    const parts = db.query(
      `SELECT p.id AS part_id, m.data AS message, p.data AS part, m.time_created AS created, p.time_created AS part_created
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY m.time_created, p.time_created, p.id`,
    ).all(nativeId) as Array<{ part_id: string; message: string; part: string; created: number | null; part_created: number | null }>;

    let seq = 0;
    for (const row of parts) {
      seq += 1;
      try {
        const message = JSON.parse(row.message) as { role?: string };
        const part = JSON.parse(row.part) as {
          type?: string;
          text?: string;
          tool?: string;
          name?: string;
          files?: string[];
          state?: { input?: unknown; status?: string };
        };
        const id = `${sessionId}:${row.part_id}`;
        const role = message.role === 'user' ? 'user' : 'assistant';
        const ts = row.part_created ?? row.created;

        if (part.type === 'text' && part.text) {
          const text = textRow(sessionId, id, seq, role, part.text, ts);
          if (text) rows.push(text);
        } else if (part.type === 'tool') {
          const toolName = part.tool ?? part.name ?? 'tool';
          const inputStr = typeof part.state?.input === 'object' && part.state.input !== null
            ? JSON.stringify(part.state.input)
            : '';
          rows.push(toolRow(sessionId, id, seq, toolName, inputStr, ts));
        } else if (part.type === 'patch') {
          const files = Array.isArray(part.files) ? part.files : [];
          rows.push(toolRow(sessionId, id, seq, 'patch', JSON.stringify(files), ts));
        }
      } catch {
        /* skip parse failure */
      }
    }
  } catch {
    return rows;
  } finally {
    db?.close();
  }
  return rows;
}

export function touchesFromOpencodeDb(
  path: string,
  nativeId: string,
  sessionId: string,
  fallbackCwd: string | null,
): SessionFileTouch[] {
  const touches: SessionFileTouch[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const hasPartTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='part'",
    ).get();
    if (!hasPartTable) return touches;

    const parts = db.query(
      `SELECT p.id, p.data, p.time_created
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY m.time_created, p.time_created, p.id`,
    ).all(nativeId) as Array<{ id: string; data: string; time_created: number | null }>;

    let seq = 0;
    for (const row of parts) {
      seq += 1;
      try {
        const part = JSON.parse(row.data) as {
          type?: string;
          tool?: string;
          name?: string;
          files?: string[];
          state?: {
            input?: Record<string, unknown>;
            workdir?: string;
            status?: string;
          };
        };
        const ts = row.time_created;
        const cwd = (typeof part.state?.workdir === 'string' && part.state.workdir.startsWith('/'))
          ? part.state.workdir
          : fallbackCwd;

        if (part.type === 'tool') {
          const toolName = part.tool ?? part.name ?? '';
          const op = opOfTool(toolName);
          if (op === 'bash' || op === 'shell' || op === 'exec_command' || op === 'exec') continue;

          const rawPath = filePathOfInput(part.state?.input);
          if (rawPath) {
            touches.push({
              id: `${sessionId}:${row.id}`,
              sessionId,
              provider: 'opencode',
              filePath: normalizeTouchPath(rawPath, cwd),
              toolName,
              op,
              ts,
              ordinal: seq * 1000,
            });
          }
        } else if (part.type === 'patch') {
          const files = Array.isArray(part.files) ? part.files : [];
          for (let fIdx = 0; fIdx < files.length; fIdx++) {
            const rawPath = files[fIdx];
            if (typeof rawPath === 'string' && rawPath.trim()) {
              touches.push({
                id: `${sessionId}:${row.id}:${fIdx}`,
                sessionId,
                provider: 'opencode',
                filePath: normalizeTouchPath(rawPath, cwd),
                toolName: 'patch',
                op: 'edit',
                ts,
                ordinal: seq * 1000 + fIdx,
              });
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return touches;
  } finally {
    db?.close();
  }
  return touches;
}

export function commitWitnessesFromOpencodeDb(
  path: string,
  nativeId: string,
  sessionId: string,
): CommitWitness[] {
  const out: CommitWitness[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const hasPartTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='part'",
    ).get();
    if (!hasPartTable) return out;

    const rows = db.query(
      `SELECT p.data AS part, m.time_created AS created
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND json_extract(p.data, '$.tool') = 'bash'`,
    ).all(nativeId) as Array<{ part: string; created: number | null }>;

    for (const row of rows) {
      try {
        const part = JSON.parse(row.part) as {
          tool?: string;
          state?: {
            input?: { command?: unknown };
            output?: unknown;
            time?: { start?: number; end?: number } | number;
          } | null;
        };
        const command = typeof part.state?.input?.command === 'string' ? part.state.input.command : '';
        if (!command || !isGitCommitCommand(command)) continue;
        const rawOutput = typeof part.state?.output === 'string' ? part.state.output : '';
        const sha = shaFromOutput(rawOutput);
        if (sha) {
          const ts = typeof part.state?.time === 'number'
            ? part.state.time
            : (typeof (part.state?.time as { start?: number })?.start === 'number'
              ? (part.state?.time as { start?: number }).start!
              : row.created);
          out.push({ sessionId, sha, ts: ts ?? null });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return out;
  } finally {
    db?.close();
  }
  return out;
}

export function turnsFromOpencodeDb(path: string, nativeId: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const hasPartTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='part'",
    ).get();
    if (!hasPartTable) return turns;

    const rows = db.query(
      `SELECT m.data AS message, p.data AS part
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ?
       ORDER BY m.time_created, p.time_created, p.id`,
    ).all(nativeId) as Array<{ message: string; part: string }>;

    for (const row of rows) {
      try {
        const message = JSON.parse(row.message) as { role?: string };
        const part = JSON.parse(row.part) as {
          type?: string;
          text?: string;
          tool?: string;
          name?: string;
          state?: { input?: unknown; output?: unknown };
        };
        const role = message.role === 'user' ? 'user' : 'assistant';
        if (part.type === 'text' && part.text) {
          turns.push({ role, text: part.text });
        } else if (part.type === 'tool') {
          const toolName = part.tool ?? part.name ?? 'tool';
          const summary = typeof part.state?.input === 'object' && part.state.input !== null
            ? JSON.stringify(part.state.input).slice(0, 160)
            : toolName;
          turns.push({ role: 'tool', text: summary, toolName });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return turns;
  } finally {
    db?.close();
  }
  return turns;
}

export function recordsFromOpencodeDb(path: string, nativeId: string): unknown[] {
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const hasPartTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='part'",
    ).get();
    if (!hasPartTable) return [];

    const rows = db.query(
      `SELECT p.data AS part FROM part p WHERE p.session_id = ?`,
    ).all(nativeId) as Array<{ part: string }>;
    return rows.map((row) => {
      try {
        return JSON.parse(row.part);
      } catch {
        return row.part;
      }
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
