import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Database } from 'bun:sqlite';
import type { Store } from './db.ts';
import type { SkillHit } from './types.ts';

// ── Skills 目录探测 ──────────────────────────────────────────────────
// 自动探测 ~/.skills, ~/.claude/skills, ~/.codex/skills 以及当前项目 skills/
// 自动解析软链接并按 realpath 去重。

export function defaultSkillsRoots(): string[] {
  const home = homedir();
  const candidates = [
    process.env.SKILLS_DIR,
    join(home, '.skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(process.cwd(), 'skills'),
  ].filter(Boolean) as string[];

  const seen = new Set<string>();
  const roots: string[] = [];

  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      const real = realpathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      if (statSync(real).isDirectory()) {
        roots.push(real);
      }
    } catch {
      // 忽略无法访问的目录
    }
  }

  return roots;
}

// ── Frontmatter 与 Trigger 解析 ──────────────────────────────────────

export interface ParsedSkill {
  name: string;
  description: string;
  allowedTools?: string[];
  triggers: string[];
}

export function parseSkillContent(content: string, fallbackName: string): ParsedSkill | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;

  const fmText = fmMatch[1]!;
  let name = fallbackName;
  let description = '';
  const allowedTools: string[] = [];
  const triggers: string[] = [];

  // 1. 提取 name
  const nameMatch = fmText.match(/^name:\s*(.+)$/m);
  if (nameMatch) {
    name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
  }

  // 2. 提取 allowed-tools
  const toolsMatch = fmText.match(/^allowed-tools:\s*\n((?:\s*-[^\n]+\n?)+)/m);
  if (toolsMatch) {
    const lines = toolsMatch[1]!.split('\n');
    for (const line of lines) {
      const item = line.trim().replace(/^-\s*/, '');
      if (item) allowedTools.push(item);
    }
  }

  // 3. 提取 description (支持单行或多行 block scalar | / >)
  const descMatch = fmText.match(/^description:\s*([|>])?\s*\n?([\s\S]*?)(?=^(?:[a-zA-Z0-9_-]+:|$))/m);
  if (descMatch) {
    let rawDesc = descMatch[2]!;
    // 如果后面紧跟 allowed-tools 等其他字段，截断
    const nextKey = rawDesc.search(/\n[a-zA-Z0-9_-]+:\s/);
    if (nextKey !== -1) {
      rawDesc = rawDesc.slice(0, nextKey);
    }
    description = rawDesc.trim();
  } else {
    const singleDesc = fmText.match(/^description:\s*(.+)$/m);
    if (singleDesc) description = singleDesc[1]!.trim();
  }

  // 4. 从 description 或全篇提取常见 trigger 场景
  const triggerMatches = content.matchAll(/-\s*(?:用户(?:说|提到|要求)|场景|触发)\s*[:：]?\s*["“']([^"”']+)["”']/g);
  for (const m of triggerMatches) {
    if (m[1] && m[1].trim()) triggers.push(m[1].trim());
  }

  return {
    name: name || fallbackName,
    description: description || fallbackName,
    allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
    triggers,
  };
}

// ── SQLite 存储与 FTS5 虚拟表 ────────────────────────────────────────

const schemaReadyDbs = new WeakSet<Database>();

export function ensureSkillsSchema(db: Database): void {
  if (schemaReadyDbs.has(db)) return;
  db.exec(`

    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      description TEXT NOT NULL,
      allowed_tools TEXT,
      triggers TEXT,
      mtime_ms REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
      name, description, triggers, content=skills, content_rowid=rowid, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS skills_fts_ai AFTER INSERT ON skills BEGIN
      INSERT INTO skills_fts(rowid, name, description, triggers) VALUES (new.rowid, new.name, new.description, new.triggers);
    END;
    CREATE TRIGGER IF NOT EXISTS skills_fts_ad AFTER DELETE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, name, description, triggers) VALUES ('delete', old.rowid, old.name, old.description, old.triggers);
    END;
    CREATE TRIGGER IF NOT EXISTS skills_fts_au AFTER UPDATE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, name, description, triggers) VALUES ('delete', old.rowid, old.name, old.description, old.triggers);
      INSERT INTO skills_fts(rowid, name, description, triggers) VALUES (new.rowid, new.name, new.description, new.triggers);
    END;
  `);
  schemaReadyDbs.add(db);
}


// ── 增量扫描与索引 ──────────────────────────────────────────────────

export function syncSkillsCatalog(store: Store, rootsOverride?: string[]): { total: number; indexed: number; removed: number } {
  ensureSkillsSchema(store.db);
  const roots = rootsOverride ?? defaultSkillsRoots();
  const seenNames = new Set<string>();
  let indexed = 0;

  // 查询已有的 mtime
  const existingRows = store.db.query('SELECT name, mtime_ms FROM skills').all() as Array<{ name: string; mtime_ms: number }>;
  const existingMtime = new Map<string, number>(existingRows.map((r) => [r.name, r.mtime_ms]));

  const upsertStmt = store.db.prepare(`
    INSERT INTO skills(name, path, description, allowed_tools, triggers, mtime_ms, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      description = excluded.description,
      allowed_tools = excluded.allowed_tools,
      triggers = excluded.triggers,
      mtime_ms = excluded.mtime_ms,
      updated_at = excluded.updated_at
  `);

  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullDir = join(root, entry);
      let realDir: string;
      try {
        realDir = realpathSync(fullDir);
      } catch {
        continue;
      }

      const skillFile = join(realDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      let st;
      try {
        st = statSync(skillFile);
      } catch {
        continue;
      }

      const prevMtime = existingMtime.get(entry);
      if (prevMtime !== undefined && Math.abs(prevMtime - st.mtimeMs) < 1) {
        seenNames.add(entry);
        continue;
      }

      try {
        const text = readFileSync(skillFile, 'utf8');
        const parsed = parseSkillContent(text, entry);
        if (!parsed) continue;

        upsertStmt.run(
          parsed.name,
          skillFile,
          parsed.description,
          parsed.allowedTools ? JSON.stringify(parsed.allowedTools) : null,
          parsed.triggers.length > 0 ? parsed.triggers.join(' | ') : null,
          st.mtimeMs,
          Date.now(),
        );

        seenNames.add(parsed.name);
        indexed++;
      } catch {
        // 单个文件读取失败不影响整体
      }
    }
  }

  // 清理磁盘上已被删除的 skill
  let removed = 0;
  const deleteStmt = store.db.prepare('DELETE FROM skills WHERE name = ?');
  for (const name of existingMtime.keys()) {
    if (!seenNames.has(name)) {
      deleteStmt.run(name);
      removed++;
    }
  }

  const total = store.db.query('SELECT COUNT(*) as c FROM skills').get() as { c: number };
  return { total: total.c, indexed, removed };
}

// ── 技能检索 (FTS5 + Trigram + LIKE 兜底) ───────────────────────────

export function searchSkills(store: Store, query: string, limit = 10): SkillHit[] {
  ensureSkillsSchema(store.db);
  const q = query.trim();
  if (!q) {
    const rows = store.db.query(
      'SELECT name, path, description, allowed_tools, triggers FROM skills ORDER BY name ASC LIMIT ?'
    ).all(limit) as Array<{
      name: string;
      path: string;
      description: string;
      allowed_tools: string | null;
      triggers: string | null;
    }>;
    return rows.map(formatSkillRow);
  }

  const maxHits = Math.min(30, Math.max(1, limit));

  // 字符数小于 3 时直接用 LIKE
  if ([...q.replace(/\s+/g, '')].length < 3) {
    return searchSkillsLike(store, q, maxHits);
  }

  const ftsQuery = q.split(/\s+/).filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' ');

  try {
    const rows = store.db.query(
      `SELECT s.name, s.path, s.description, s.allowed_tools, s.triggers,
              bm25(skills_fts) AS rank
       FROM skills_fts
       JOIN skills s ON s.rowid = skills_fts.rowid
       WHERE skills_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    ).all(ftsQuery, maxHits) as Array<{
      name: string;
      path: string;
      description: string;
      allowed_tools: string | null;
      triggers: string | null;
      rank: number;
    }>;

    if (rows.length > 0) {
      return rows.map((r) => ({ ...formatSkillRow(r), score: r.rank }));
    }
  } catch {
    // FTS 异常降级到 LIKE
  }

  return searchSkillsLike(store, q, maxHits);
}

function searchSkillsLike(store: Store, query: string, limit: number): SkillHit[] {
  const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = store.db.query(
    `SELECT name, path, description, allowed_tools, triggers
     FROM skills
     WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR triggers LIKE ? ESCAPE '\\'
     ORDER BY name ASC
     LIMIT ?`
  ).all(pattern, pattern, pattern, limit) as Array<{
    name: string;
    path: string;
    description: string;
    allowed_tools: string | null;
    triggers: string | null;
  }>;
  return rows.map(formatSkillRow);
}

function formatSkillRow(row: {
  name: string;
  path: string;
  description: string;
  allowed_tools: string | null;
  triggers: string | null;
}): SkillHit {
  let allowedTools: string[] | undefined;
  if (row.allowed_tools) {
    try {
      allowedTools = JSON.parse(row.allowed_tools);
    } catch {
      allowedTools = undefined;
    }
  }
  const triggers = row.triggers ? row.triggers.split(' | ') : undefined;
  return {
    name: row.name,
    path: row.path,
    description: row.description,
    allowedTools,
    triggers,
  };
}
