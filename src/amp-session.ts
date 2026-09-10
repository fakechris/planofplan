/**
 * Amp session catalog, transcript, touches, and commit witness extraction.
 *
 * Amp (Sourcegraph Amp) stores thread data in:
 * ~/.local/share/amp/threads/T-<uuid>.json
 *
 * Each thread JSON contains:
 *   - id: "T-..."
 *   - created: epoch ms
 *   - title: thread title
 *   - env.initial.trees[0]: uri, displayName, repository.url
 *   - messages[]: role (user|assistant), content[] (text|thinking|tool_use|tool_result), usage
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sessionKey, titleify } from './sessions.ts';
import { textRow, toolRow } from './transcript.ts';
import { normalizeTouchPath, opOfTool } from './file-touches.ts';
import { isGitCommitCommand, shaFromOutput, type CommitWitness } from './commit-witness.ts';
import type { SessionFileTouch, SessionMessageRow, SessionRecord, TranscriptTurn } from './types.ts';

interface AmpContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseID?: string;
  run?: {
    status?: string;
    result?: {
      output?: string;
      exitCode?: number;
    };
  };
  content?: string;
}

interface AmpMessage {
  role: 'user' | 'assistant';
  messageId?: number;
  content?: AmpContentBlock[];
  usage?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalInputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    timestamp?: string;
  };
  meta?: {
    sentAt?: number;
  };
}

interface AmpThreadDoc {
  id?: string;
  created?: number;
  title?: string;
  env?: {
    initial?: {
      trees?: Array<{
        displayName?: string;
        uri?: string;
        repository?: {
          type?: string;
          url?: string;
          ref?: string;
          sha?: string;
        };
      }>;
    };
  };
  messages?: AmpMessage[];
}

function readAmpJson(path: string): AmpThreadDoc | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as AmpThreadDoc;
  } catch {
    return null;
  }
}

export function extractAmpThread(path: string, mtimeMs: number): SessionRecord | null {
  const doc = readAmpJson(path);
  if (!doc) return null;

  const nativeId = doc.id || basename(path).replace(/\.json$/i, '');
  if (!nativeId) return null;

  const tree = doc.env?.initial?.trees?.[0];
  const cwd = tree?.uri ? tree.uri.replace(/^file:\/\//, '') : null;
  const gitUrl = tree?.repository?.url || null;
  const gitName = tree?.displayName || null;

  let inputTokens = 0;
  let outputTokens = 0;
  let latestTs = doc.created || 0;

  for (const m of doc.messages || []) {
    if (m.meta?.sentAt && m.meta.sentAt > latestTs) {
      latestTs = m.meta.sentAt;
    }
    if (m.usage) {
      const inp = (m.usage.totalInputTokens ?? m.usage.inputTokens) || 0;
      const out = m.usage.outputTokens || 0;
      inputTokens += inp;
      outputTokens += out;
      if (m.usage.timestamp) {
        const parsed = Date.parse(m.usage.timestamp);
        if (Number.isFinite(parsed) && parsed > latestTs) latestTs = parsed;
      }
    }
  }

  const rawTitle = typeof doc.title === 'string' ? doc.title.trim() : '';
  const title = rawTitle ? (titleify(rawTitle) || null) : null;

  return {
    id: sessionKey('amp', nativeId),
    provider: 'amp',
    nativeId,
    cwd,
    gitUrl,
    gitName,
    title,
    origin: 'user',
    sourceFile: path,
    startedAt: doc.created || null,
    updatedAt: latestTs || mtimeMs,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  };
}

export function messagesFromAmpThread(path: string, _nativeId: string, sessionId: string): SessionMessageRow[] {
  const doc = readAmpJson(path);
  if (!doc || !Array.isArray(doc.messages)) return [];

  const rows: SessionMessageRow[] = [];
  for (let mIdx = 0; mIdx < doc.messages.length; mIdx++) {
    const msg = doc.messages[mIdx]!;
    const role = msg.role === 'user' ? 'user' : 'assistant';
    const ts = msg.meta?.sentAt
      ?? (msg.usage?.timestamp ? Date.parse(msg.usage.timestamp) : null)
      ?? doc.created
      ?? null;
    const seq = mIdx + 1;

    for (let cIdx = 0; cIdx < (msg.content || []).length; cIdx++) {
      const block = msg.content![cIdx]!;
      const id = `${sessionId}:${msg.messageId ?? mIdx}:${cIdx}`;

      if (block.type === 'text' && block.text && block.text.trim()) {
        const textRowObj = textRow(sessionId, id, seq, role, block.text, ts);
        if (textRowObj) rows.push(textRowObj);
      } else if (block.type === 'tool_use' && block.name) {
        const inputStr = block.input ? JSON.stringify(block.input) : '';
        rows.push(toolRow(sessionId, id, seq, block.name, inputStr, ts));
      }
    }
  }

  return rows;
}

export function touchesFromAmpThread(
  path: string,
  _nativeId: string,
  sessionId: string,
  fallbackCwd: string | null,
): SessionFileTouch[] {
  const doc = readAmpJson(path);
  if (!doc || !Array.isArray(doc.messages)) return [];

  const touches: SessionFileTouch[] = [];
  const treeCwd = doc.env?.initial?.trees?.[0]?.uri?.replace(/^file:\/\//, '') || fallbackCwd;
  for (let mIdx = 0; mIdx < doc.messages.length; mIdx++) {
    const msg = doc.messages[mIdx]!;
    const ts = msg.meta?.sentAt
      ?? (msg.usage?.timestamp ? Date.parse(msg.usage.timestamp) : null)
      ?? doc.created
      ?? null;

    for (let cIdx = 0; cIdx < (msg.content || []).length; cIdx++) {
      const block = msg.content![cIdx]!;
      if (block.type !== 'tool_use' || !block.name) continue;

      const toolName = block.name;
      const op = opOfTool(toolName);
      if (op === 'bash' || op === 'shell' || op === 'exec_command' || op === 'exec') continue;

      const rawPath = typeof block.input?.path === 'string'
        ? block.input.path
        : (typeof block.input?.file_path === 'string' ? block.input.file_path : null);

      if (rawPath) {
        touches.push({
          id: `${sessionId}:${block.id || `${mIdx}:${cIdx}`}`,
          sessionId,
          provider: 'amp',
          filePath: normalizeTouchPath(rawPath, treeCwd),
          toolName,
          op,
          ts,
          ordinal: (mIdx + 1) * 1000 + cIdx,
        });
      }
    }
  }

  return touches;
}

export function commitWitnessesFromAmpThread(
  path: string,
  _nativeId: string,
  sessionId: string,
): CommitWitness[] {
  const doc = readAmpJson(path);
  if (!doc || !Array.isArray(doc.messages)) return [];

  const witnesses: CommitWitness[] = [];
  const toolResults = new Map<string, string>();

  // First collect tool_results
  for (const msg of doc.messages) {
    for (const block of msg.content || []) {
      if (block.type === 'tool_result' && block.toolUseID) {
        const out = block.run?.result?.output ?? (typeof block.content === 'string' ? block.content : '');
        if (out) toolResults.set(block.toolUseID, out);
      }
    }
  }

  // Then match Bash tool_use with commit
  for (const msg of doc.messages) {
    const ts = msg.meta?.sentAt
      ?? (msg.usage?.timestamp ? Date.parse(msg.usage.timestamp) : null)
      ?? doc.created
      ?? null;

    for (const block of msg.content || []) {
      if (block.type === 'tool_use' && (block.name === 'Bash' || block.name === 'bash') && block.id) {
        const cmd = typeof block.input?.cmd === 'string'
          ? block.input.cmd
          : (typeof block.input?.command === 'string' ? block.input.command : '');

        if (!cmd || !isGitCommitCommand(cmd)) continue;

        const output = toolResults.get(block.id);
        if (output) {
          const sha = shaFromOutput(output);
          if (sha) {
            witnesses.push({ sessionId, sha, ts });
          }
        }
      }
    }
  }

  return witnesses;
}

export function turnsFromAmpThread(path: string): TranscriptTurn[] {
  const doc = readAmpJson(path);
  if (!doc || !Array.isArray(doc.messages)) return [];

  const turns: TranscriptTurn[] = [];

  for (const msg of doc.messages) {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    for (const block of msg.content || []) {
      if (block.type === 'text' && block.text) {
        turns.push({ role, text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        turns.push({ role: 'assistant', text: block.thinking, toolName: 'thinking' });
      } else if (block.type === 'tool_use' && block.name) {
        const summary = block.input ? JSON.stringify(block.input).slice(0, 160) : block.name;
        turns.push({ role: 'tool', text: summary, toolName: block.name });
      }
    }
  }

  return turns;
}

export function recordsFromAmpThread(path: string): unknown[] {
  const doc = readAmpJson(path);
  if (!doc || !Array.isArray(doc.messages)) return [];

  const records: unknown[] = [];
  for (const msg of doc.messages) {
    for (const block of msg.content || []) {
      if (block.type === 'tool_use' && block.input) {
        records.push(block.input);
      }
    }
  }
  return records;
}
