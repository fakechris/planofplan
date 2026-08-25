import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type {
  FileTouchSession,
  PlanConfig,
  PlanStateRow,
  Project,
  QuotaWindow,
  PlanFileRecord,
  PlanSection,
  PlanSnapshotRecord,
  ProgressNoteRecord,
  RequirementRecord,
  SessionCommit,
  SessionFileTouch,
  SessionLink,
  SessionLinkView,
  TodoSnapshotRecord,
  SessionIndexState,
  SessionMessageHit,
  SessionMessageRow,
  SessionRecord,
  SessionRepo,
  UsageRecord,
  UsageReport,
  UsageScanFile,
} from './types.ts';
import { buildUsageReport } from './usage.ts';
import { nameOfUrl } from './repos.ts';
import { isKnownEnvelope } from './motivation.ts';
import { backfillLaunchLinks } from './session-links.ts';
import { materializeRequirements } from './requirements.ts';
import { materializePlanFiles, materializeProgressNotes, materializeTodoSnapshots } from './plans.ts';

/** projects.id:url 的确定性短 hash(sha1 前 12 位)。无 remote 的 repo 用
 *  root path 做输入(dsh-track 同款退化),同输入必得同 id,物化幂等。 */
export function projectEntityId(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  poll_interval_sec INTEGER NOT NULL DEFAULT 60,
  cred_ref TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  window TEXT NOT NULL,
  label TEXT,
  used REAL,
  total REAL,
  unit TEXT NOT NULL DEFAULT 'percent',
  percentage REAL,
  reset_at INTEGER,
  fetched_at INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON snapshots(plan_id, window, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_plan_fetched ON snapshots(plan_id, fetched_at DESC);
CREATE TABLE IF NOT EXISTS plan_state (
  plan_id TEXT PRIMARY KEY,
  last_success_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER,
  auth_status TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  source_file TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  billable_tokens INTEGER,
  estimated_cost_usd REAL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  fetched_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_records_time ON usage_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_records_provider_model ON usage_records(provider, model, timestamp);
CREATE TABLE IF NOT EXISTS usage_scan_files (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  scanned_at INTEGER NOT NULL,
  scanned_since INTEGER NOT NULL,
  parsed_bytes INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_scan_files_provider ON usage_scan_files(provider);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  native_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  source_file TEXT,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL,
  seen_at INTEGER NOT NULL,
  git_root TEXT,
  git_url TEXT,
  git_name TEXT,
  origin TEXT NOT NULL DEFAULT 'user',
  parent_id TEXT,
  origin_detail TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_native ON sessions(provider, native_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE TABLE IF NOT EXISTS session_repos (
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  url TEXT NOT NULL,
  root TEXT,
  name TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  first_seq INTEGER,
  PRIMARY KEY (session_id, role, url)
);
CREATE INDEX IF NOT EXISTS idx_session_repos_session ON session_repos(session_id);
CREATE INDEX IF NOT EXISTS idx_session_repos_name ON session_repos(name);
-- 消息级索引：只存 user/assistant 可见文本 + tool_use 入参（截断），tool_result 正文不入库。
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  tool_name TEXT,
  text TEXT,
  timestamp INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, seq);
-- trigram：中文子串搜索的最短查询是 3 字符，更短的查询由 Store 回退 LIKE。
CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
  text, content=session_messages, content_rowid=rowid, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS session_messages_fts_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO session_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS session_messages_fts_ad AFTER DELETE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS session_messages_fts_au AFTER UPDATE ON session_messages BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO session_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
-- 消息级行级续扫水位（字节偏移 + 行号 + 解析器版本）。
CREATE TABLE IF NOT EXISTS session_index_state (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  parsed_bytes INTEGER NOT NULL DEFAULT 0,
  lines INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL DEFAULT 1
);
-- 文件 touch 行为层:tool_use 入参里的结构化文件路径(Bash command 不解析)。
CREATE TABLE IF NOT EXISTS session_file_touches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  file_path TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  op TEXT NOT NULL,
  ts INTEGER,
  ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_file_touches_path ON session_file_touches(file_path);
CREATE INDEX IF NOT EXISTS idx_session_file_touches_session ON session_file_touches(session_id, ordinal);
-- commit 归因:session ↔ git commit(declared trailer / candidate 时间窗)。
CREATE TABLE IF NOT EXISTS session_commits (
  session_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts INTEGER,
  summary TEXT,
  file_overlap INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_session_commits_sha ON session_commits(sha);
CREATE INDEX IF NOT EXISTS idx_session_commits_repo ON session_commits(repo, ts);
-- 一等项目实体:身份 = git remote URL(无 remote 退化为 root path)。
-- 从 session_repos 物化(collectSessionCatalog 末尾增量 upsert + v5 迁移 backfill)。
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  root TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
-- session↔session 关系边(Launch 实体,ia-redesign §1.4b)。首值 kind='spawned-by',
-- 方向:from=被拉起的(子)→ to=发起者(父)。to 允许悬空(窗口外/已删)。
CREATE TABLE IF NOT EXISTS session_links (
  from_session TEXT NOT NULL,
  to_session TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_session, to_session, kind)
);
CREATE INDEX IF NOT EXISTS idx_session_links_to ON session_links(to_session, kind);
-- 需求实体(ia-redesign §1.5):从 user 消息流规则抽取,origin 分级 + span
-- 级项目归因(requirement_repos,证据窗口内实际碰的 repo)。
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  origin_level TEXT NOT NULL,
  ts INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_requirements_session ON requirements(session_id);
CREATE INDEX IF NOT EXISTS idx_requirements_ts ON requirements(ts);
CREATE TABLE IF NOT EXISTS requirement_repos (
  requirement_id TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (requirement_id, url)
);
CREATE INDEX IF NOT EXISTS idx_requirement_repos_url ON requirement_repos(url);
-- 计划态实体(§5 计划研究):plan 文件身份锚路径,append-only 快照序列;
-- todo_snapshots 是消息层(TodoWrite)的演进快照。不做任务级身份(thin-observer 教训)。
CREATE TABLE IF NOT EXISTS plan_files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT,
  goal TEXT,
  current_phase TEXT,
  repo TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  missing_since INTEGER,
  last_snapshot_id TEXT,
  last_snapshot_mtime_ms INTEGER,
  last_snapshot_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_files_repo ON plan_files(repo);
CREATE TABLE IF NOT EXISTS plan_snapshots (
  id TEXT PRIMARY KEY,
  plan_file_id TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  commit_sha TEXT,
  sections_json TEXT NOT NULL,
  checkbox_checked INTEGER NOT NULL,
  checkbox_total INTEGER NOT NULL,
  current_phase TEXT,
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_snapshots_file ON plan_snapshots(plan_file_id, captured_at);
CREATE TABLE IF NOT EXISTS todo_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER,
  items_json TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_todo_snapshots_session ON todo_snapshots(session_id, seq);
-- ④ 尾总结:assistant 干完活的自报(已完成/本轮/下一步…),message_inferred 档。
CREATE TABLE IF NOT EXISTS progress_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER,
  text TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_progress_notes_session ON progress_notes(session_id, seq);
-- Handoff(§1.7):一次导出动作一行,交接链可观测。源悬空也保留(历史)。
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT,
  target_dir TEXT NOT NULL,
  package_path TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_source ON handoffs(source_type, source_id, created_at);
`;

interface SnapshotRow {
  id: number;
  plan_id: string;
  window: string;
  label: string | null;
  used: number | null;
  total: number | null;
  unit: string;
  percentage: number | null;
  reset_at: number | null;
  fetched_at: number;
  note: string | null;
}

function rowToWindow(r: SnapshotRow): QuotaWindow {
  return {
    window: r.window,
    label: r.label ?? r.window,
    used: r.used,
    total: r.total,
    unit: r.unit as QuotaWindow['unit'],
    // 历史 snapshots 里可能保留 8.799999999999999 之类的浮点尾巴，渲染前统一
    // 钳到 [0, 100] 并保留两位小数。
    percentage: r.percentage == null
      ? null
      : Math.round(Math.max(0, Math.min(100, r.percentage)) * 100) / 100,
    resetAt: r.reset_at,
    note: r.note,
    fetchedAt: r.fetched_at,
  };
}

export class Store {
  /** 简易嵌套事务:外层已开事务时直接执行,避免嵌套 BEGIN 报错。 */
  private txDepth = 0;

  withTransaction<T>(work: () => T): T {
    if (this.txDepth > 0) return work();
    this.db.exec('BEGIN');
    this.txDepth += 1;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  constructor(private db: Database) {
    db.exec(SCHEMA);
    try {
      db.exec('ALTER TABLE usage_records ADD COLUMN fetched_at INTEGER');
    } catch {
      // Existing databases already have the column, or were created by the current schema.
    }
    try {
      db.exec('ALTER TABLE usage_records ADD COLUMN source_file TEXT');
    } catch {
      // Existing databases already have the column, or were created by the current schema.
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_usage_records_source_file ON usage_records(source, source_file)');
    try {
      db.exec('ALTER TABLE usage_scan_files ADD COLUMN scanned_since INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Existing databases already have the column, or were created by the current schema.
    }
    try {
      db.exec('ALTER TABLE usage_scan_files ADD COLUMN parsed_bytes INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Existing databases already have the column, or were created by the current schema.
    }
    try {
      db.exec('ALTER TABLE usage_scan_files ADD COLUMN cursor_json TEXT');
    } catch {
      // Existing databases already have the column, or were created by the current schema.
    }
    for (const column of ['git_root TEXT', 'git_url TEXT', 'git_name TEXT']) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
      } catch {
        // Existing databases already have the column, or were created by the current schema.
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_git_name ON sessions(git_name)');
    db.exec(`CREATE TABLE IF NOT EXISTS session_repos (
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      url TEXT NOT NULL,
      root TEXT,
      name TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      first_seq INTEGER,
      PRIMARY KEY (session_id, role, url)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_repos_session ON session_repos(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_repos_name ON session_repos(name)');

    // v1：本地 usage 记录的 day 曾按 UTC 分桶，与 menubar/web 的「今日」（本地
    // 日期）不一致。一次性按本地时区重算（official 记录保留 provider 原样日期）。
    const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version < 1) {
      db.exec(`UPDATE usage_records
               SET day = strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime')
               WHERE source = 'local'`);
      db.exec('PRAGMA user_version = 1');
    }
    // v2:session_commits 加 pushed 列(本地未推送的 commit 不渲染远端链接)。
    // 新库已由 SCHEMA 带上该列,ALTER 会因重复列报错——容错跳过即可。
    if (version < 2) {
      try {
        db.exec('ALTER TABLE session_commits ADD COLUMN pushed INTEGER NOT NULL DEFAULT 1');
      } catch {
        // 列已存在(新库 SCHEMA 已含)
      }
      db.exec('PRAGMA user_version = 2');
    }
    // v3:sessions 加 origin/parent_id 列。列在这里补,但版本号不由这里推:
    // backfill(session-origin.ts,含文件重读)完成后才把 user_version 置 3,
    // 中途崩溃会在下次扫描时重跑 backfill(幂等)。
    if (version < 3) {
      for (const column of ["origin TEXT NOT NULL DEFAULT 'user'", 'parent_id TEXT']) {
        try {
          db.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
        } catch {
          // 列已存在(新库 SCHEMA 已含)
        }
      }
    }
    // v5:projects 实体表。表结构由 SCHEMA 建好,这里从 session_repos backfill
    // 物化一遍(幂等,与 collectSessionCatalog 末尾的增量物化同一条路径)。
    if (version < 5) {
      this.materializeProjects();
      db.exec('PRAGMA user_version = 5');
    }
    // v6:Launch 实体(session_links 由 SCHEMA 建好;sessions 加 origin_detail)。
    // backfill(claude parent / 边物化 / plugin 回链,纯 SQL+路径)在
    // session-links.ts,幂等;herdr 的 origin_detail 由 collect 时的 herdr pass 补。
    if (version < 6) {
      try {
        db.exec('ALTER TABLE sessions ADD COLUMN origin_detail TEXT');
      } catch {
        // 列已存在(新库 SCHEMA 已含)
      }
      backfillLaunchLinks(this);
      db.exec('PRAGMA user_version = 6');
    }
    // v7:Requirement 实体。表结构由 SCHEMA 建好;backfill 从已索引的
    // session_messages / file_touches / session_repos 全量重导(幂等)。
    if (version < 7) {
      materializeRequirements(this);
      db.exec('PRAGMA user_version = 7');
    }
    // v8:计划态实体。todo 快照纯库内重导;plan 文件扫盘(mtime 门控,
    // 之后每轮 collect 增量)。git/FS 调用一次性,失败不阻塞迁移。
    if (version < 8) {
      try {
        materializeTodoSnapshots(this);
        materializePlanFiles(this);
      } catch {
        /* backfill is best-effort;collect 轮会补 */
      }
      db.exec('PRAGMA user_version = 8');
    }
    // v9:④ 尾总结(assistant 自报)。纯库内重导,幂等。
    if (version < 9) {
      try {
        materializeProgressNotes(this);
      } catch {
        /* backfill is best-effort;collect 轮会补 */
      }
      db.exec('PRAGMA user_version = 9');
    }
    // v10:Handoff 交接记录表(无 backfill,动作发生时写入)。
    if (version < 10) {
      db.exec('PRAGMA user_version = 10');
    }
  }

  getUserVersion(): number {
    return (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  setUserVersion(version: number): void {
    this.db.exec(`PRAGMA user_version = ${Math.floor(version)}`);
  }

  /**
   * 从 session_repos 物化 projects(root 取多数值,name 取首个非空)。
   * 幂等:collectSessionCatalog 末尾增量调用,v5 迁移 backfill 也走这里。
   */
  materializeProjects(): number {
    const rows = this.db.query('SELECT url, name, root FROM session_repos').all() as Array<{
      url: string;
      name: string | null;
      root: string | null;
    }>;
    const byUrl = new Map<string, { name: string; roots: Map<string, number> }>();
    for (const row of rows) {
      if (!row.url) continue;
      let group = byUrl.get(row.url);
      if (!group) {
        group = { name: row.name ?? '', roots: new Map() };
        byUrl.set(row.url, group);
      }
      if (!group.name && row.name) group.name = row.name;
      if (row.root) group.roots.set(row.root, (group.roots.get(row.root) ?? 0) + 1);
    }
    const now = Date.now();
    const stmt = this.db.query(
      `INSERT INTO projects (id, url, name, root, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         name = COALESCE(NULLIF(excluded.name, ''), projects.name),
         root = COALESCE(excluded.root, projects.root),
         last_seen_at = excluded.last_seen_at`,
    );
    this.withTransaction(() => {
      for (const [url, group] of byUrl) {
        const root = [...group.roots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        stmt.run(projectEntityId(url), url, group.name || nameOfUrl(url), root, now, now);
      }
    });
    return byUrl.size;
  }

  listProjects(): Project[] {
    const rows = this.db.query(
      'SELECT id, url, name, root, created_at, last_seen_at FROM projects ORDER BY last_seen_at DESC',
    ).all() as Array<{
      id: string;
      url: string;
      name: string;
      root: string | null;
      created_at: number;
      last_seen_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      name: row.name,
      root: row.root,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  getProject(id: string): Project | null {
    const row = this.db.query(
      'SELECT id, url, name, root, created_at, last_seen_at FROM projects WHERE id = ?',
    ).get(id) as {
      id: string;
      url: string;
      name: string;
      root: string | null;
      created_at: number;
      last_seen_at: number;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      url: row.url,
      name: row.name,
      root: row.root,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  /** 窗口内 session↔project 活动(列表/详情聚合的公共原料,已按 url+session 去重)。 */
  projectActivity(since: number, until: number): Array<{
    url: string;
    sessionId: string;
    provider: string;
    origin: string;
    totalTokens: number;
    updatedAt: number;
  }> {
    return this.db.query(
      `SELECT DISTINCT r.url AS url, s.id AS sessionId, s.provider AS provider,
              s.origin AS origin, s.total_tokens AS totalTokens, s.updated_at AS updatedAt
       FROM session_repos r
       JOIN sessions s ON s.id = r.session_id
       WHERE s.updated_at >= ? AND s.updated_at < ?`,
    ).all(since, until) as Array<{
      url: string;
      sessionId: string;
      provider: string;
      origin: string;
      totalTokens: number;
      updatedAt: number;
    }>;
  }

  /** 窗口内各 repo 的 commit 计数。 */
  projectCommitCounts(since: number): Map<string, number> {
    const rows = this.db.query(
      'SELECT repo, COUNT(*) AS n FROM session_commits WHERE ts >= ? GROUP BY repo',
    ).all(since) as Array<{ repo: string; n: number }>;
    return new Map(rows.map((row) => [row.repo, row.n]));
  }

  /** 详情:窗口内该项目的 session 时间线(updated_at 倒排)。 */
  projectSessions(url: string, since: number, until: number): SessionRecord[] {
    const rows = this.db.query(
      `SELECT DISTINCT s.id, s.provider, s.native_id, s.cwd, s.title, s.source_file,
              s.started_at, s.updated_at, s.input_tokens, s.output_tokens, s.total_tokens,
              s.estimated_cost_usd, s.seen_at, s.git_root, s.git_url, s.git_name,
              s.origin, s.parent_id, s.origin_detail
       FROM sessions s
       JOIN session_repos r ON r.session_id = s.id
       WHERE r.url = ? AND s.updated_at >= ? AND s.updated_at < ?
       ORDER BY s.updated_at DESC`,
    ).all(url, since, until) as Array<{
      id: string;
      provider: string;
      native_id: string;
      cwd: string | null;
      title: string | null;
      source_file: string | null;
      started_at: number | null;
      updated_at: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number | null;
      seen_at: number;
      git_root: string | null;
      git_url: string | null;
      git_name: string | null;
      origin: string | null;
      parent_id: string | null;
      origin_detail: string | null;
    }>;
    return rows.map((row) => sessionFromRow(row));
  }

  /** 详情:窗口内落在该项目的 commit(ts 倒排)。 */
  projectCommits(url: string, since: number): SessionCommit[] {
    const rows = this.db.query(
      `SELECT session_id, repo, sha, kind, ts, summary, file_overlap, pushed
       FROM session_commits WHERE repo = ? AND ts >= ? ORDER BY ts DESC`,
    ).all(url, since) as Array<{
      session_id: string;
      repo: string;
      sha: string;
      kind: string;
      ts: number | null;
      summary: string | null;
      file_overlap: number;
      pushed: number;
    }>;
    return rows.map(sessionCommitFromRow);
  }

  /** 配置 → db plans 表（INSERT OR IGNORE；已存在时只更新非运行时字段） */
  syncPlan(cfg: PlanConfig): void {
    const existing = this.getPlan(cfg.slug);
    const now = Date.now();
    if (!existing) {
      this.db
        .query(
          `INSERT INTO plans (slug, name, adapter, enabled, poll_interval_sec, cred_ref, extra, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cfg.slug,
          cfg.name,
          cfg.adapter,
          cfg.enabled ? 1 : 0,
          cfg.pollIntervalSec,
          cfg.credRef ?? null,
          JSON.stringify(cfg.extra ?? {}),
          now,
          now,
        );
      return;
    }
    // 运行时字段（enabled/cred_ref/extra）不在启动同步时覆盖，以 db 为准。
    // extra 里可能包含 UI 保存的 provider 级 browser 选择。
    const extra = cfg.adapter === 'glm'
      ? stripGlmRegion({ ...cfg.extra, ...existing.extra })
      : { ...cfg.extra, ...existing.extra };
    this.db
      .query(
        `UPDATE plans SET name = ?, adapter = ?, poll_interval_sec = ?, extra = ?, updated_at = ? WHERE slug = ?`,
      )
      .run(
        cfg.name,
        cfg.adapter,
        cfg.pollIntervalSec,
        JSON.stringify(extra),
        now,
        cfg.slug,
      );
  }

  /** 将旧版 glm_legacy/glm_current 的本地快照与状态迁移到 canonical glm。 */
  migrateLegacyGlmPlans(): { credentialRefs: string[]; sourceCredentialRef: string | null } {
    const canonical = this.getPlan('glm');
    if (canonical) {
      const credentialRefs: string[] = [];
      for (const oldSlug of ['glm_current', 'glm_legacy']) {
        const old = this.getPlan(oldSlug);
        if (!old) continue;
        if (old.credRef && old.credRef !== canonical.credRef) credentialRefs.push(old.credRef);
        this.db.query(`UPDATE snapshots SET plan_id = 'glm' WHERE plan_id = ?`).run(oldSlug);
        this.db.query(`DELETE FROM plan_state WHERE plan_id = ?`).run(oldSlug);
        this.db.query(`DELETE FROM plans WHERE slug = ?`).run(oldSlug);
      }
      return { credentialRefs, sourceCredentialRef: null };
    }
    const current = this.getPlan('glm_current');
    const legacy = this.getPlan('glm_legacy');
    const source = current ?? legacy;
    if (!source) return { credentialRefs: [], sourceCredentialRef: null };

    this.db
      .query(
        `INSERT INTO plans (slug, name, adapter, enabled, poll_interval_sec, cred_ref, extra, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'glm',
        'GLM Coding Plan',
        'glm',
        source.enabled ? 1 : 0,
        source.pollIntervalSec,
        source.credRef ?? null,
        JSON.stringify(stripGlmRegion(source.extra)),
        Date.now(),
        Date.now(),
      );

    for (const oldSlug of ['glm_current', 'glm_legacy']) {
      if (!this.getPlan(oldSlug)) continue;
      this.db.query(`UPDATE snapshots SET plan_id = 'glm' WHERE plan_id = ?`).run(oldSlug);
      if (oldSlug === source.slug) {
        this.db.query(`UPDATE plan_state SET plan_id = 'glm' WHERE plan_id = ?`).run(oldSlug);
      } else {
        this.db.query(`DELETE FROM plan_state WHERE plan_id = ?`).run(oldSlug);
      }
      this.db.query(`DELETE FROM plans WHERE slug = ?`).run(oldSlug);
    }
    return {
      credentialRefs: [current?.credRef, legacy?.credRef].filter(
        (ref): ref is string => !!ref,
      ),
      sourceCredentialRef: source.credRef ?? null,
    };
  }

  getPlan(slug: string): PlanConfig | null {
    const row = this.db
      .query(`SELECT * FROM plans WHERE slug = ?`)
      .get(slug) as
      | {
          slug: string;
          name: string;
          adapter: string;
          enabled: number;
          poll_interval_sec: number;
          cred_ref: string | null;
          extra: string;
        }
      | null;
    if (!row) return null;
    return planFromRow(row);
  }

  listPlans(): PlanConfig[] {
    const rows = this.db
      .query(`SELECT * FROM plans ORDER BY slug`)
      .all() as Array<{
      slug: string;
      name: string;
      adapter: string;
      enabled: number;
      poll_interval_sec: number;
      cred_ref: string | null;
      extra: string;
    }>;
    return rows.map(planFromRow);
  }

  updatePlanRuntime(slug: string, patch: { enabled?: boolean; cred_ref?: string | null }): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.cred_ref !== undefined) {
      fields.push('cred_ref = ?');
      values.push(patch.cred_ref);
    }
    if (!fields.length) return;
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(slug);
    this.db.query(`UPDATE plans SET ${fields.join(', ')} WHERE slug = ?`).run(...values);
  }

  updatePlanExtra(slug: string, patch: Record<string, string | null>): void {
    const plan = this.getPlan(slug);
    if (!plan) return;
    const extra = { ...plan.extra };
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') delete extra[key];
      else extra[key] = value;
    }
    this.db
      .query(`UPDATE plans SET extra = ?, updated_at = ? WHERE slug = ?`)
      .run(JSON.stringify(extra), Date.now(), slug);
  }

  /** 写入一批新窗口快照（每窗口一行） */
  insertWindows(planId: string, windows: QuotaWindow[], fetchedAt: number): void {
    const stmt = this.db.query(
      `INSERT INTO snapshots (plan_id, window, label, used, total, unit, percentage, reset_at, fetched_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const w of windows) {
      stmt.run(
        planId,
        w.window,
        w.label,
        w.used,
        w.total,
        w.unit,
        w.percentage,
        w.resetAt,
        fetchedAt,
        w.note,
      );
    }
  }

  /** 每个稳定窗口（或额外模型车道）的最新一条；标签变化不应制造重复窗口。 */
  latestByPlan(planId: string, latestBatchOnly = false): QuotaWindow[] {
    const latestFetchedAt = latestBatchOnly
      ? (this.db.query(`SELECT MAX(fetched_at) AS fetchedAt FROM snapshots WHERE plan_id = ?`).get(planId) as { fetchedAt?: number | null } | null)?.fetchedAt ?? null
      : null;
    if (latestBatchOnly && latestFetchedAt == null) return [];
    const batchFilter = latestBatchOnly ? ' AND s.fetched_at = ?' : '';
    const rows = this.db
      .query(
        `SELECT * FROM (
           SELECT s.*, ROW_NUMBER() OVER (
             PARTITION BY plan_id,
               CASE
                 WHEN window IN ('rolling_5h', 'weekly', 'monthly', 'requests', 'credits_period') THEN window
                 ELSE window || '|' || COALESCE(label, '')
               END
             ORDER BY fetched_at DESC, id DESC
           ) rn
           FROM snapshots s WHERE plan_id = ?${batchFilter}
         ) WHERE rn = 1 ORDER BY
           CASE
             WHEN window = 'rolling_5h' OR window LIKE 'standard_%' THEN 10
             WHEN window LIKE 'core_%' OR window = 'weekly' THEN 20
             WHEN window = 'monthly' THEN 30
             WHEN window = 'requests' THEN 40
             WHEN window = 'credits_period' THEN 50
             ELSE 100
           END,
           CASE
             WHEN window = 'rolling_5h' OR window LIKE '%_5h' THEN 10
             WHEN window = 'weekly' OR window LIKE '%_weekly' THEN 20
             WHEN window = 'monthly' OR window LIKE '%_monthly' THEN 30
             ELSE 100
           END,
           window, label`,
      )
      .all(...(latestBatchOnly ? [planId, latestFetchedAt] : [planId])) as SnapshotRow[];
    return rows.map(rowToWindow);
  }

  latestAll(): Map<string, QuotaWindow[]> {
    const rows = this.db
      .query(
        `SELECT * FROM (
           SELECT s.*, ROW_NUMBER() OVER (
             PARTITION BY plan_id,
               CASE
                 WHEN window IN ('rolling_5h', 'weekly', 'monthly', 'requests', 'credits_period') THEN window
                 ELSE window || '|' || COALESCE(label, '')
               END
             ORDER BY fetched_at DESC, id DESC
           ) rn
           FROM snapshots s
         ) WHERE rn = 1 ORDER BY
           plan_id,
           CASE
             WHEN window = 'rolling_5h' OR window LIKE 'standard_%' THEN 10
             WHEN window LIKE 'core_%' OR window = 'weekly' THEN 20
             WHEN window = 'monthly' THEN 30
             WHEN window = 'requests' THEN 40
             WHEN window = 'credits_period' THEN 50
             ELSE 100
           END,
           CASE
             WHEN window = 'rolling_5h' OR window LIKE '%_5h' THEN 10
             WHEN window = 'weekly' OR window LIKE '%_weekly' THEN 20
             WHEN window = 'monthly' OR window LIKE '%_monthly' THEN 30
             ELSE 100
           END,
           window, label`,
      )
      .all() as SnapshotRow[];
    const map = new Map<string, QuotaWindow[]>();
    for (const r of rows) {
      const arr = map.get(r.plan_id) ?? [];
      arr.push(rowToWindow(r));
      map.set(r.plan_id, arr);
    }
    return map;
  }

  history(planId: string, window: string, since: number): Array<Record<string, unknown>> {
    const rows = this.db
      .query(
        `SELECT window, label, used, total, unit, percentage, reset_at AS resetAt, fetched_at AS fetchedAt
         FROM snapshots WHERE plan_id = ? AND window = ? AND fetched_at >= ?
         ORDER BY fetched_at ASC`,
      )
      .all(planId, window, since) as Array<Record<string, unknown>>;
    return rows;
  }

  getState(slug: string): PlanStateRow | null {
    const row = this.db.query(`SELECT * FROM plan_state WHERE plan_id = ?`).get(slug) as
      | PlanStateRow
      | null;
    return row ?? null;
  }

  setState(slug: string, patch: Partial<PlanStateRow>): void {
    const cur = this.getState(slug);
    const next: PlanStateRow = {
      plan_id: slug,
      last_success_at: patch.last_success_at ?? cur?.last_success_at ?? null,
      last_attempt_at: patch.last_attempt_at ?? cur?.last_attempt_at ?? null,
      last_error: patch.last_error !== undefined ? patch.last_error : (cur?.last_error ?? null),
      consecutive_failures: patch.consecutive_failures ?? cur?.consecutive_failures ?? 0,
      paused_until: patch.paused_until !== undefined ? patch.paused_until : (cur?.paused_until ?? null),
      auth_status: patch.auth_status ?? cur?.auth_status ?? 'unknown',
    };
    this.db
      .query(
        `INSERT INTO plan_state (plan_id, last_success_at, last_attempt_at, last_error, consecutive_failures, paused_until, auth_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET
           last_success_at = excluded.last_success_at,
           last_attempt_at = excluded.last_attempt_at,
           last_error = excluded.last_error,
           consecutive_failures = excluded.consecutive_failures,
           paused_until = excluded.paused_until,
           auth_status = excluded.auth_status`,
      )
      .run(
        next.plan_id,
        next.last_success_at,
        next.last_attempt_at,
        next.last_error,
        next.consecutive_failures,
        next.paused_until,
        next.auth_status,
      );
  }

  /** 清理早于保留期的快照；返回删除行数 */
  prune(retentionMs: number): number {
    const cutoff = Date.now() - retentionMs;
    const r = this.db
      .query(`DELETE FROM snapshots WHERE fetched_at < ?`)
      .run(cutoff);
    this.db.query(`DELETE FROM usage_records WHERE timestamp < ?`).run(cutoff);
    return Number(r.changes);
  }

  upsertUsageRecords(records: UsageRecord[]): void {
    if (records.length === 0) return;
    this.db.exec('BEGIN');
    try {
      this.writeUsageRecords(records, Date.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private writeUsageRecords(records: UsageRecord[], updatedAt: number): void {
    const stmt = this.db.query(
      `INSERT INTO usage_records (
         id, day, timestamp, provider, model, session_id, project,
         source_file,
         input_tokens, cached_input_tokens, cache_creation_input_tokens,
         output_tokens, reasoning_output_tokens, total_tokens,
         billable_tokens, estimated_cost_usd, source, confidence, fetched_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         day = excluded.day,
         timestamp = excluded.timestamp,
         provider = excluded.provider,
         model = excluded.model,
         session_id = excluded.session_id,
         project = excluded.project,
         source_file = excluded.source_file,
         input_tokens = excluded.input_tokens,
         cached_input_tokens = excluded.cached_input_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens,
         output_tokens = excluded.output_tokens,
         reasoning_output_tokens = excluded.reasoning_output_tokens,
         total_tokens = excluded.total_tokens,
         billable_tokens = excluded.billable_tokens,
         estimated_cost_usd = excluded.estimated_cost_usd,
         source = excluded.source,
         confidence = excluded.confidence,
         fetched_at = excluded.fetched_at,
         updated_at = excluded.updated_at`,
    );
    for (const record of records) {
      stmt.run(
        record.id,
        record.day,
        record.timestamp,
        record.provider,
        record.model,
        record.sessionId ?? null,
        record.project ?? null,
        record.sourceFile ?? null,
        record.inputTokens,
        record.cachedInputTokens,
        record.cacheCreationInputTokens,
        record.outputTokens,
        record.reasoningOutputTokens,
        record.totalTokens,
        record.billableTokens,
        record.estimatedCostUsd,
        record.source,
        record.confidence,
        record.fetchedAt ?? null,
        updatedAt,
      );
    }
  }

  hasUnattributedLocalUsageRecords(): boolean {
    const row = this.db.query(
      `SELECT 1 AS present FROM usage_records WHERE source = 'local' AND source_file IS NULL LIMIT 1`,
    ).get() as { present?: number } | null;
    return row?.present === 1;
  }

  oldestUnattributedLocalUsageTimestamp(): number | null {
    const row = this.db.query(
      `SELECT MIN(timestamp) AS timestamp
       FROM usage_records
       WHERE source = 'local' AND source_file IS NULL`,
    ).get() as { timestamp?: number | null } | null;
    return row?.timestamp == null ? null : Number(row.timestamp);
  }

  clearLocalUsageRecords(): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec(`DELETE FROM usage_records WHERE source = 'local'`);
      this.db.exec(`DELETE FROM usage_scan_files`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getUsageScanFiles(provider?: string): UsageScanFile[] {
    const rows = provider
      ? this.db.query(
        `SELECT path, provider, size, mtime_ms, scanned_at, scanned_since, parsed_bytes, cursor_json
         FROM usage_scan_files WHERE provider = ?`,
      ).all(provider)
      : this.db.query(
        `SELECT path, provider, size, mtime_ms, scanned_at, scanned_since, parsed_bytes, cursor_json
         FROM usage_scan_files`,
      ).all() as Array<{
        path: string;
        provider: string;
        size: number;
        mtime_ms: number;
        scanned_at: number;
      }>;
    return (rows as Array<{
      path: string;
      provider: string;
      size: number;
      mtime_ms: number;
      scanned_at: number;
      scanned_since: number;
      parsed_bytes: number;
      cursor_json: string | null;
    }>).map((row) => ({
      path: row.path,
      provider: row.provider,
      size: row.size,
      mtimeMs: row.mtime_ms,
      scannedAt: row.scanned_at,
      scannedSince: row.scanned_since,
      parsedBytes: row.parsed_bytes,
      cursorJson: row.cursor_json,
    }));
  }

  replaceUsageRecordsForFiles(
    files: Array<{
      file: Pick<UsageScanFile, 'path' | 'provider' | 'size' | 'mtimeMs'>;
      records: UsageRecord[];
      scannedSince: number;
      parsedBytes?: number;
      cursorJson?: string | null;
    }>,
  ): void {
    if (files.length === 0) return;
    this.db.exec('BEGIN');
    try {
      // 只删本次扫描窗口内的记录：轻量扫描（如启动时 3 天窗口）不应抹掉
      // 该文件更早的历史记录。
      const deleteRecords = this.db.query(
        `DELETE FROM usage_records WHERE source = 'local' AND source_file = ? AND timestamp >= ?`,
      );
      const updateScan = this.db.query(
        `INSERT INTO usage_scan_files (
           path, provider, size, mtime_ms, scanned_at, scanned_since, parsed_bytes, cursor_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           provider = excluded.provider,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           scanned_at = excluded.scanned_at,
           scanned_since = excluded.scanned_since,
           parsed_bytes = excluded.parsed_bytes,
           cursor_json = excluded.cursor_json`,
      );
      const scannedAt = Date.now();
      for (const item of files) {
        deleteRecords.run(item.file.path, item.scannedSince);
        this.writeUsageRecords(item.records, scannedAt);
        updateScan.run(
          item.file.path,
          item.file.provider,
          item.file.size,
          item.file.mtimeMs,
          scannedAt,
          item.scannedSince,
          item.parsedBytes ?? item.file.size,
          item.cursorJson ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  replaceUsageRecordsForFile(
    file: Pick<UsageScanFile, 'path' | 'provider' | 'size' | 'mtimeMs'>,
    records: UsageRecord[],
    scannedSince = 0,
  ): void {
    this.replaceUsageRecordsForFiles([{ file, records, scannedSince, parsedBytes: file.size }]);
  }

  appendUsageRecordsForFile(
    file: Pick<UsageScanFile, 'path' | 'provider' | 'size' | 'mtimeMs'>,
    records: UsageRecord[],
    scannedSince: number,
    parsedBytes: number,
    cursorJson: string,
  ): void {
    this.db.exec('BEGIN');
    try {
      if (records.length > 0) this.writeUsageRecords(records, Date.now());
      this.db.query(
        `INSERT INTO usage_scan_files (
           path, provider, size, mtime_ms, scanned_at, scanned_since, parsed_bytes, cursor_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           provider = excluded.provider,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           scanned_at = excluded.scanned_at,
           scanned_since = excluded.scanned_since,
           parsed_bytes = excluded.parsed_bytes,
           cursor_json = excluded.cursor_json`,
      ).run(
        file.path,
        file.provider,
        file.size,
        file.mtimeMs,
        Date.now(),
        scannedSince,
        parsedBytes,
        cursorJson,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getUsageRecords(since: number, until: number): UsageRecord[] {
    const rows = this.db
      .query(
        `SELECT id, day, timestamp, provider, model, session_id, project, source_file,
                input_tokens, cached_input_tokens, cache_creation_input_tokens,
                output_tokens, reasoning_output_tokens, total_tokens,
                billable_tokens, estimated_cost_usd, source, confidence
                , fetched_at
         FROM usage_records
         WHERE timestamp >= ? AND timestamp < ?
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(since, until) as Array<{
      id: string;
      day: string;
      timestamp: number;
      provider: string;
      model: string;
      session_id: string | null;
      project: string | null;
      source_file: string | null;
      input_tokens: number;
      cached_input_tokens: number;
      cache_creation_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      total_tokens: number;
      billable_tokens: number | null;
      estimated_cost_usd: number | null;
      source: UsageRecord['source'];
      confidence: UsageRecord['confidence'];
      fetched_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      day: row.day,
      timestamp: row.timestamp,
      provider: row.provider,
      model: row.model,
      sessionId: row.session_id,
      project: row.project,
      sourceFile: row.source_file,
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
      totalTokens: row.total_tokens,
      billableTokens: row.billable_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
      source: row.source,
      confidence: row.confidence,
      fetchedAt: row.fetched_at ?? undefined,
    }));
  }

  getUsageReport(since: number, until: number): UsageReport {
    return buildUsageReport(this.getUsageRecords(since, until), {
      since,
      until,
      generatedAt: Date.now(),
    });
  }

  /**
   * 指定 provider/model 最近一次在本地会话里被使用的 epoch ms；null 表示从未用过。
   * 走 idx_usage_records_provider_model(provider, model, timestamp)，单 MAX 查询。
   */
  lastModelUsed(provider: string, model: string): number | null {
    const row = this.db
      .query(
        `SELECT MAX(timestamp) AS last
         FROM usage_records
         WHERE provider = ? AND model = ?`,
      )
      .get(provider, model) as { last: number | null } | undefined;
    return row?.last ?? null;
  }

  upsertSessions(rows: SessionRecord[]): void {
    if (rows.length === 0) return;
    // 注意:excluded.* 引用的是 VALUES 的最终值,VALUES 里的 COALESCE(?, 'user')
    // 会让 excluded.origin 永远非空,导致冲突更新把已有 origin 重置回 'user'
    //(线上实测:subagent 被 stub 重扫洗掉)。所以 UPDATE 分支必须用独立的
    // 原始参数(SET 子句里的 ?),VALUES 里的 COALESCE 只服务新插入。
    const stmt = this.db.query(
      `INSERT INTO sessions (
         id, provider, native_id, cwd, title, source_file, started_at, updated_at,
         input_tokens, output_tokens, total_tokens, estimated_cost_usd, seen_at,
         git_root, git_url, git_name, origin, parent_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'user'), ?)
       ON CONFLICT(id) DO UPDATE SET
         cwd = COALESCE(excluded.cwd, sessions.cwd),
         title = COALESCE(excluded.title, sessions.title),
         source_file = COALESCE(excluded.source_file, sessions.source_file),
         started_at = COALESCE(excluded.started_at, sessions.started_at),
         git_root = COALESCE(excluded.git_root, sessions.git_root),
         git_url = COALESCE(excluded.git_url, sessions.git_url),
         git_name = COALESCE(excluded.git_name, sessions.git_name),
         -- origin 只在明确知道时覆盖:extract/stub 给 null(plain user)时保留
         -- 既有值(例如 herdr 升级),backfill/专用 pass 负责修正
         origin = COALESCE(?, sessions.origin),
         parent_id = COALESCE(?, sessions.parent_id),
         updated_at = excluded.updated_at,
         seen_at = excluded.seen_at`,
    );
    this.withTransaction(() => {
      for (const row of rows) {
        stmt.run(
          row.id,
          row.provider,
          row.nativeId,
          row.cwd,
          row.title,
          row.sourceFile,
          row.startedAt,
          row.updatedAt,
          row.inputTokens,
          row.outputTokens,
          row.totalTokens,
          row.estimatedCostUsd,
          row.seenAt,
          row.gitRoot ?? null,
          row.gitUrl ?? null,
          row.gitName ?? null,
          row.origin ?? null,
          row.parentId ?? null,
          row.origin ?? null,
          row.parentId ?? null,
        );
      }
    });
  }

  /** origin 修正入口:backfill / herdr 升级 / Launch 补链专用,不走 upsert 的 COALESCE 语义。 */
  updateSessionOrigins(patches: Array<{
    id: string;
    origin?: string | null;
    parentId?: string | null;
    originDetail?: string | null;
  }>): void {
    if (patches.length === 0) return;
    const stmt = this.db.query(
      `UPDATE sessions SET
         origin = COALESCE(?, origin),
         parent_id = COALESCE(?, parent_id),
         origin_detail = COALESCE(?, origin_detail)
       WHERE id = ?`,
    );
    this.withTransaction(() => {
      for (const patch of patches) {
        stmt.run(patch.origin ?? null, patch.parentId ?? null, patch.originDetail ?? null, patch.id);
      }
    });
  }

  upsertSessionLinks(rows: SessionLink[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO session_links (from_session, to_session, kind, evidence_kind, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(from_session, to_session, kind) DO UPDATE SET
         evidence_kind = excluded.evidence_kind`,
    );
    this.withTransaction(() => {
      for (const row of rows) {
        stmt.run(row.fromSession, row.toSession, row.kind, row.evidenceKind, row.createdAt);
      }
    });
  }

  /** 全量 Launch 边(物化/图构建用;行数小,内存过滤)。 */
  listSessionLinks(kind = 'spawned-by'): SessionLink[] {
    const rows = this.db.query(
      'SELECT from_session, to_session, kind, evidence_kind, created_at FROM session_links WHERE kind = ?',
    ).all(kind) as Array<{
      from_session: string;
      to_session: string;
      kind: string;
      evidence_kind: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      fromSession: row.from_session,
      toSession: row.to_session,
      kind: row.kind,
      evidenceKind: row.evidence_kind === 'declared' ? 'declared' : row.evidence_kind === 'observed' ? 'observed' : 'candidate',
      createdAt: row.created_at,
    }));
  }

  /**
   * 双向查 Launch 边:spawnedBy(谁发起了它)/ spawned(它发起了谁)。
   * 对端不在库里的悬空边照常返回,dangling=true。
   */
  linksForSession(id: string): { spawnedBy: SessionLinkView[]; spawned: SessionLinkView[] } {
    const out = this.db.query(
      `SELECT l.to_session AS sessionId, l.evidence_kind AS evidenceKind,
              s.provider AS provider, s.title AS title
       FROM session_links l LEFT JOIN sessions s ON s.id = l.to_session
       WHERE l.from_session = ? AND l.kind = 'spawned-by'
       ORDER BY l.created_at DESC`,
    ).all(id) as Array<{ sessionId: string; evidenceKind: string; provider: string | null; title: string | null }>;
    const into = this.db.query(
      `SELECT l.from_session AS sessionId, l.evidence_kind AS evidenceKind,
              s.provider AS provider, s.title AS title
       FROM session_links l LEFT JOIN sessions s ON s.id = l.from_session
       WHERE l.to_session = ? AND l.kind = 'spawned-by'
       ORDER BY l.created_at DESC`,
    ).all(id) as Array<{ sessionId: string; evidenceKind: string; provider: string | null; title: string | null }>;
    const map = (row: { sessionId: string; evidenceKind: string; provider: string | null; title: string | null }): SessionLinkView => ({
      sessionId: row.sessionId,
      evidenceKind: row.evidenceKind === 'declared' ? 'declared' : row.evidenceKind === 'observed' ? 'observed' : 'candidate',
      provider: row.provider,
      title: row.title,
      dangling: row.provider === null,
    });
    return { spawnedBy: out.map(map), spawned: into.map(map) };
  }

  /**
   * plugin 回链的 declared 匹配:claude 的 tool 消息(role=tool,含命令行/
   * Task 入参 JSON)里出现过这段 prompt 片段。按消息行返回(带消息时间
   * 戳),调用方自己做时间窗过滤 —— 长寿命 claude 会话的 updated_at 可以
   * 比拉起时刻晚好几天,不能当 spawn 时刻用。
   */
  claudeSessionsWithToolText(needle: string, limit = 40): Array<{ sessionId: string; ts: number | null; updatedAt: number }> {
    const pattern = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return this.db.query(
      `SELECT s.id AS sessionId, m.timestamp AS ts, s.updated_at AS updatedAt
       FROM session_messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.provider = 'claude' AND m.role = 'tool' AND m.text LIKE ? ESCAPE '\\'
       ORDER BY m.timestamp DESC
       LIMIT ?`,
    ).all(pattern, limit) as Array<{ sessionId: string; ts: number | null; updatedAt: number }>;
  }

  /**
   * session 首条真实用户 prompt(plugin 回链的原料)。跳过
   * <recommended_plugins> 等已知注入信封(isKnownEnvelope);<task> 包裹是
   * companion 插件的任务正文,剥掉首行取 body(正文可能被逐字传进
   * claude 的命令行,匹配要拿到裸正文)。
   */
  firstUserText(sessionId: string): string | null {
    const rows = this.db.query(
      `SELECT text FROM session_messages
       WHERE session_id = ? AND role = 'user' AND kind = 'text'
       ORDER BY seq LIMIT 20`,
    ).all(sessionId) as Array<{ text: string | null }>;
    for (const row of rows) {
      const text = row.text?.trim();
      if (!text || isKnownEnvelope(text)) continue;
      const task = /^<task[^>]*>[^\S\n]*/.exec(text);
      if (task) return text.slice(task[0].length).trim() || null;
      return text;
    }
    return null;
  }

  updateSessionTokens(patches: Array<{
    id: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  }>): void {
    if (patches.length === 0) return;
    const stmt = this.db.query(
      `UPDATE sessions
       SET input_tokens = ?, output_tokens = ?, total_tokens = ?, estimated_cost_usd = ?
       WHERE id = ?`,
    );
    this.db.exec('BEGIN');
    try {
      for (const patch of patches) {
        stmt.run(patch.inputTokens, patch.outputTokens, patch.totalTokens, patch.estimatedCostUsd, patch.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listSessionRows(): SessionRecord[] {
    const rows = this.db.query(
      `SELECT id, provider, native_id, cwd, title, source_file, started_at, updated_at,
              input_tokens, output_tokens, total_tokens, estimated_cost_usd, seen_at,
              git_root, git_url, git_name, origin, parent_id, origin_detail
       FROM sessions`,
    ).all() as Array<{
      id: string;
      provider: string;
      native_id: string;
      cwd: string | null;
      title: string | null;
      source_file: string | null;
      started_at: number | null;
      updated_at: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number | null;
      seen_at: number;
      git_root: string | null;
      git_url: string | null;
      git_name: string | null;
      origin: string | null;
      parent_id: string | null;
      origin_detail: string | null;
    }>;
    return this.attachSessionRepos(rows.map(sessionFromRow));
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query(
      `SELECT id, provider, native_id, cwd, title, source_file, started_at, updated_at,
              input_tokens, output_tokens, total_tokens, estimated_cost_usd, seen_at,
              git_root, git_url, git_name, origin, parent_id, origin_detail
       FROM sessions WHERE id = ?`,
    ).get(id) as {
      id: string;
      provider: string;
      native_id: string;
      cwd: string | null;
      title: string | null;
      source_file: string | null;
      started_at: number | null;
      updated_at: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      estimated_cost_usd: number | null;
      seen_at: number;
      git_root: string | null;
      git_url: string | null;
      git_name: string | null;
      origin: string | null;
      parent_id: string | null;
      origin_detail: string | null;
    } | null;
    if (!row) return null;
    return this.attachSessionRepos([sessionFromRow(row)])[0] ?? null;
  }

  replaceSessionRepos(sessionId: string, repos: SessionRepo[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.query('DELETE FROM session_repos WHERE session_id = ?').run(sessionId);
      const stmt = this.db.query(
        `INSERT INTO session_repos (session_id, role, url, root, name, evidence_kind, first_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const repo of repos) {
        stmt.run(
          sessionId,
          repo.role,
          repo.url,
          repo.root,
          repo.name,
          repo.evidenceKind,
          repo.firstSeq ?? null,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listSessionRepos(sessionId?: string): SessionRepo[] {
    const rows = sessionId
      ? this.db.query(
          `SELECT session_id, role, url, root, name, evidence_kind, first_seq
           FROM session_repos WHERE session_id = ?`,
        ).all(sessionId) as Array<{
          session_id: string;
          role: SessionRepo['role'];
          url: string;
          root: string | null;
          name: string;
          evidence_kind: SessionRepo['evidenceKind'];
          first_seq: number | null;
        }>
      : this.db.query(
          `SELECT session_id, role, url, root, name, evidence_kind, first_seq
           FROM session_repos`,
        ).all() as Array<{
          session_id: string;
          role: SessionRepo['role'];
          url: string;
          root: string | null;
          name: string;
          evidence_kind: SessionRepo['evidenceKind'];
          first_seq: number | null;
        }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      role: row.role,
      url: row.url,
      root: row.root ?? '',
      name: row.name,
      evidenceKind: row.evidence_kind,
      firstSeq: row.first_seq,
    }));
  }

  private attachSessionRepos(sessions: SessionRecord[]): SessionRecord[] {
    if (sessions.length === 0) return sessions;
    const grouped = new Map<string, SessionRepo[]>();
    for (const repo of this.listSessionRepos()) {
      const list = grouped.get(repo.sessionId) ?? [];
      list.push(repo);
      grouped.set(repo.sessionId, list);
    }
    return sessions.map((session) => ({
      ...session,
      repos: grouped.get(session.id) ?? session.repos ?? [],
    }));
  }

  upsertSessionMessages(rows: SessionMessageRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO session_messages (
         id, session_id, seq, role, kind, tool_name, text, timestamp, model, input_tokens, output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         seq = excluded.seq,
         role = excluded.role,
         kind = excluded.kind,
         tool_name = excluded.tool_name,
         text = excluded.text,
         timestamp = excluded.timestamp,
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens`,
    );
    this.withTransaction(() => {
      for (const row of rows) {
        stmt.run(
          row.id,
          row.sessionId,
          row.seq,
          row.role,
          row.kind,
          row.toolName,
          row.text,
          row.timestamp,
          row.model,
          row.inputTokens,
          row.outputTokens,
        );
      }
    });
  }

  deleteSessionMessages(sessionId: string): void {
    this.db.query('DELETE FROM session_messages WHERE session_id = ?').run(sessionId);
  }

  /** 级联删除：session 本体 + repo 归属 + 消息索引 + 文件 touch + commit 归因 + Launch 边(FTS 由触发器同步）。 */
  deleteSession(id: string): void {
    this.withTransaction(() => {
      this.db.query('DELETE FROM session_messages WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM session_file_touches WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM session_commits WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM session_links WHERE from_session = ? OR to_session = ?').run(id, id);
      this.db.query('DELETE FROM requirement_repos WHERE requirement_id IN (SELECT id FROM requirements WHERE session_id = ?)').run(id);
      this.db.query('DELETE FROM requirements WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM todo_snapshots WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM progress_notes WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM session_repos WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM sessions WHERE id = ?').run(id);
    });
  }

  countSessionMessages(sessionId?: string): number {
    const row = sessionId
      ? this.db.query('SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?').get(sessionId) as { n: number }
      : this.db.query('SELECT COUNT(*) AS n FROM session_messages').get() as { n: number };
    return row.n;
  }

  /** 全部 session 的有序用户文本(seq 升序),供动机抽取。66k 行量级,内存分组。 */
  listSessionUserTexts(): Map<string, string[]> {
    const rows = this.db.query(
      `SELECT session_id, text FROM session_messages
       WHERE role = 'user' AND kind = 'text'
       ORDER BY session_id, seq`,
    ).all() as Array<{ session_id: string; text: string | null }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.text) continue;
      const list = map.get(row.session_id) ?? [];
      list.push(row.text);
      map.set(row.session_id, list);
    }
    return map;
  }

  /** 全部用户消息行(seq 升序,带时间戳),需求实体推导的原料。 */
  listUserMessageRows(): Array<{ sessionId: string; seq: number; ts: number | null; text: string }> {
    return this.db.query(
      `SELECT session_id AS sessionId, seq, timestamp AS ts, text
       FROM session_messages
       WHERE role = 'user' AND kind = 'text' AND text IS NOT NULL
       ORDER BY session_id, seq`,
    ).all() as Array<{ sessionId: string; seq: number; ts: number | null; text: string }>;
  }

  /** 需求物化专用:全量替换(确定性 id,重导即幂等)。 */
  replaceAllRequirements(rows: RequirementRecord[]): void {
    this.withTransaction(() => {
      this.db.query('DELETE FROM requirement_repos').run();
      this.db.query('DELETE FROM requirements').run();
      const req = this.db.query(
        `INSERT INTO requirements (id, session_id, seq, text, origin_level, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const repo = this.db.query('INSERT INTO requirement_repos (requirement_id, url) VALUES (?, ?)');
      const now = Date.now();
      for (const row of rows) {
        req.run(row.id, row.sessionId, row.seq, row.text, row.originLevel, row.ts, now);
        for (const url of row.repos) repo.run(row.id, url);
      }
    });
  }

  listRequirements(): RequirementRecord[] {
    const rows = this.db.query(
      `SELECT r.id, r.session_id, r.seq, r.text, r.origin_level, r.ts
       FROM requirements r
       ORDER BY r.session_id, r.seq`,
    ).all() as Array<{ id: string; session_id: string; seq: number; text: string; origin_level: string; ts: number | null }>;
    if (rows.length === 0) return [];
    const repoRows = this.db.query('SELECT requirement_id, url FROM requirement_repos').all() as Array<{
      requirement_id: string;
      url: string;
    }>;
    const repos = new Map<string, string[]>();
    for (const row of repoRows) {
      const list = repos.get(row.requirement_id) ?? [];
      list.push(row.url);
      repos.set(row.requirement_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      text: row.text,
      originLevel: row.origin_level === 'user_explicit' ? 'user_explicit' : 'system_inferred',
      ts: row.ts,
      repos: repos.get(row.id) ?? [],
    }));
  }

  requirementById(id: string): RequirementRecord | null {
    return this.listRequirements().find((row) => row.id === id) ?? null;
  }

  /** 每 session 的首条需求(显式优先):/api/sessions requirement 字段的数据源。 */
  firstRequirementBySession(): Map<string, RequirementRecord> {
    const map = new Map<string, RequirementRecord>();
    for (const row of this.listRequirements()) {
      if (!map.has(row.sessionId)) map.set(row.sessionId, row);
    }
    return map;
  }

  /** 项目 → 窗口内需求数(去重,按 span 归因的 repo url 聚合)。 */
  projectRequirementCounts(since: number): Map<string, number> {
    const rows = this.db.query(
      `SELECT rr.url AS url, COUNT(DISTINCT r.id) AS n
       FROM requirement_repos rr
       JOIN requirements r ON r.id = rr.requirement_id
       WHERE COALESCE(r.ts, r.created_at) >= ?
       GROUP BY rr.url`,
    ).all(since) as Array<{ url: string; n: number }>;
    return new Map(rows.map((row) => [row.url, row.n]));
  }

  /** span 内的 touch 行(需求详情的证据窗口)。ordinal 与消息 seq 同空间。 */
  spanTouches(sessionId: string, fromSeq: number, toSeqExclusive: number | null): Array<{    filePath: string;
    toolName: string;
    op: string;
    ts: number | null;
    ordinal: number;
  }> {
    const from = fromSeq * 1000;
    const to = toSeqExclusive == null ? Number.POSITIVE_INFINITY : toSeqExclusive * 1000;
    const rows = toSeqExclusive == null
      ? this.db.query(
        `SELECT file_path, tool_name, op, ts, ordinal FROM session_file_touches
         WHERE session_id = ? AND ordinal >= ? ORDER BY ordinal`,
      ).all(sessionId, from)
      : this.db.query(
        `SELECT file_path, tool_name, op, ts, ordinal FROM session_file_touches
         WHERE session_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`,
      ).all(sessionId, from, to);
    return (rows as Array<{ file_path: string; tool_name: string; op: string; ts: number | null; ordinal: number }>).map((row) => ({
      filePath: row.file_path,
      toolName: row.tool_name,
      op: row.op,
      ts: row.ts,
      ordinal: row.ordinal,
    }));
  }

  // ── 计划态实体(v8:PlanFile / 快照 / TodoWrite)──────────────────

  /** plan 文件发现根:session cwd ∪ project root。 */
  sessionCwds(): string[] {
    const rows = this.db.query('SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL').all() as Array<{ cwd: string }>;
    return rows.map((row) => row.cwd);
  }

  projectRoots(): string[] {
    const rows = this.db.query('SELECT DISTINCT root FROM projects WHERE root IS NOT NULL').all() as Array<{ root: string }>;
    return rows.map((row) => row.root);
  }

  /** 消息层 todo 快照原料(role=tool 且 tool_name 含 todo)。 */
  todoToolRows(): Array<{ sessionId: string; seq: number; ts: number | null; text: string }> {
    return this.db.query(
      `SELECT session_id AS sessionId, seq, timestamp AS ts, text
       FROM session_messages
       WHERE role = 'tool' AND lower(tool_name) LIKE '%todo%' AND text LIKE '{%'
       ORDER BY session_id, seq`,
    ).all() as Array<{ sessionId: string; seq: number; ts: number | null; text: string }>;
  }

  replaceAllTodoSnapshots(rows: TodoSnapshotRecord[]): void {
    this.withTransaction(() => {
      this.db.query('DELETE FROM todo_snapshots').run();
      const stmt = this.db.query(
        `INSERT INTO todo_snapshots (id, session_id, seq, ts, items_json) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of rows) stmt.run(row.id, row.sessionId, row.seq, row.ts, JSON.stringify(row.items));
    });
  }

  /** ④ 尾总结候选行(SQL 预筛强前缀,JS 再精判,别全量拉 assistant)。 */
  assistantSummaryRows(): Array<{ sessionId: string; seq: number; ts: number | null; text: string }> {
    const prefixes = ['已完成%', '这一步%', '本轮%', '这一轮%', '下一步%', '总结:%', '总结：%', 'Summary:%'];
    const where = prefixes.map(() => "text LIKE ?").join(' OR ');
    return this.db.query(
      `SELECT session_id AS sessionId, seq, timestamp AS ts, text
       FROM session_messages
       WHERE role = 'assistant' AND length(text) >= 40 AND (${where})
       ORDER BY session_id, seq`,
    ).all(...prefixes) as Array<{ sessionId: string; seq: number; ts: number | null; text: string }>;
  }

  replaceAllProgressNotes(rows: ProgressNoteRecord[]): void {
    this.withTransaction(() => {
      this.db.query('DELETE FROM progress_notes').run();
      const stmt = this.db.query(
        `INSERT INTO progress_notes (id, session_id, seq, ts, text) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of rows) stmt.run(row.id, row.sessionId, row.seq, row.ts, row.text);
    });
  }

  progressNotesForSession(sessionId: string): ProgressNoteRecord[] {
    const rows = this.db.query(
      `SELECT id, session_id, seq, ts, text FROM progress_notes WHERE session_id = ? ORDER BY seq`,
    ).all(sessionId) as Array<{ id: string; session_id: string; seq: number; ts: number | null; text: string }>;
    return rows.map((row) => ({ id: row.id, sessionId: row.session_id, seq: row.seq, ts: row.ts, text: row.text }));
  }

  insertHandoff(row: {
    sourceType: string; sourceId: string; mode: string; provider: string | null;
    targetDir: string; packagePath: string; ok: boolean;
  }): void {
    this.db.query(
      `INSERT INTO handoffs (source_type, source_id, mode, provider, target_dir, package_path, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.sourceType, row.sourceId, row.mode, row.provider, row.targetDir, row.packagePath, row.ok ? 1 : 0, Date.now());
  }

  handoffsFor(sourceType: string, sourceId: string): Array<{
    mode: string; provider: string | null; targetDir: string; packagePath: string; ok: boolean; createdAt: number;
  }> {
    const rows = this.db.query(
      `SELECT mode, provider, target_dir, package_path, ok, created_at
       FROM handoffs WHERE source_type = ? AND source_id = ? ORDER BY created_at DESC LIMIT 10`,
    ).all(sourceType, sourceId) as Array<{
      mode: string; provider: string | null; target_dir: string; package_path: string; ok: number; created_at: number;
    }>;
    return rows.map((row) => ({
      mode: row.mode,
      provider: row.provider,
      targetDir: row.target_dir,
      packagePath: row.package_path,
      ok: row.ok !== 0,
      createdAt: row.created_at,
    }));
  }

  todoSnapshotsForSession(sessionId: string): TodoSnapshotRecord[] {
    const rows = this.db.query(
      `SELECT id, session_id, seq, ts, items_json FROM todo_snapshots
       WHERE session_id = ? ORDER BY seq`,
    ).all(sessionId) as Array<{ id: string; session_id: string; seq: number; ts: number | null; items_json: string }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      ts: row.ts,
      items: JSON.parse(row.items_json) as TodoSnapshotRecord['items'],
    }));
  }

  listPlanFiles(): PlanFileRecord[] {
    const rows = this.db.query(
      `SELECT id, path, kind, title, goal, current_phase, repo, first_seen_at, last_seen_at,
              missing_since, last_snapshot_id, last_snapshot_mtime_ms, last_snapshot_hash
       FROM plan_files`,
    ).all() as Array<{
      id: string; path: string; kind: string; title: string | null; goal: string | null;
      current_phase: string | null; repo: string | null; first_seen_at: number; last_seen_at: number;
      missing_since: number | null; last_snapshot_id: string | null;
      last_snapshot_mtime_ms: number | null; last_snapshot_hash: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      kind: row.kind,
      title: row.title,
      goal: row.goal,
      currentPhase: row.current_phase,
      repo: row.repo,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      missingSince: row.missing_since,
      lastSnapshotId: row.last_snapshot_id,
      lastSnapshotMtimeMs: row.last_snapshot_mtime_ms,
      lastSnapshotHash: row.last_snapshot_hash,
    }));
  }

  /** upsert 文件行 + 捕获快照(确定性 id,同内容重捕幂等)。 */
  upsertPlanFileWithSnapshot(row: {
    id: string; path: string; kind: string; title: string | null; goal: string | null;
    currentPhase: string | null; repo: string | null; mtimeMs: number; rawHash: string;
    sections: PlanSection[]; checkboxChecked: number; checkboxTotal: number;
    commitSha: string | null; now: number;
  }): void {
    const snapshotId = `${row.id}:${row.rawHash.slice(0, 12)}`;
    this.withTransaction(() => {
      this.db.query(
        `INSERT INTO plan_files (id, path, kind, title, goal, current_phase, repo,
           first_seen_at, last_seen_at, missing_since, last_snapshot_id, last_snapshot_mtime_ms, last_snapshot_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           kind = excluded.kind,
           title = COALESCE(excluded.title, plan_files.title),
           goal = excluded.goal,
           current_phase = excluded.current_phase,
           repo = excluded.repo,
           last_seen_at = excluded.last_seen_at,
           missing_since = NULL,
           last_snapshot_id = excluded.last_snapshot_id,
           last_snapshot_mtime_ms = excluded.last_snapshot_mtime_ms,
           last_snapshot_hash = excluded.last_snapshot_hash`,
      ).run(row.id, row.path, row.kind, row.title, row.goal, row.currentPhase, row.repo,
        row.now, row.now, snapshotId, row.mtimeMs, row.rawHash);
      this.db.query(
        `INSERT INTO plan_snapshots (id, plan_file_id, raw_hash, mtime_ms, commit_sha,
           sections_json, checkbox_checked, checkbox_total, current_phase, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(snapshotId, row.id, row.rawHash, row.mtimeMs, row.commitSha,
        JSON.stringify(row.sections), row.checkboxChecked, row.checkboxTotal, row.currentPhase, row.now);
    });
  }

  touchPlanFile(id: string, now: number): void {
    this.db.query(
      'UPDATE plan_files SET last_seen_at = ?, missing_since = NULL WHERE id = ?',
    ).run(now, id);
  }

  markPlanFileMissing(id: string, since: number): void {
    this.db.query('UPDATE plan_files SET missing_since = ? WHERE id = ?').run(since, id);
  }

  planSnapshots(planFileId: string, limit = 60): PlanSnapshotRecord[] {
    const rows = this.db.query(
      `SELECT id, plan_file_id, raw_hash, mtime_ms, commit_sha, sections_json,
              checkbox_checked, checkbox_total, current_phase, captured_at
       FROM plan_snapshots WHERE plan_file_id = ?
       ORDER BY captured_at DESC LIMIT ?`,
    ).all(planFileId, limit) as Array<{
      id: string; plan_file_id: string; raw_hash: string; mtime_ms: number; commit_sha: string | null;
      sections_json: string; checkbox_checked: number; checkbox_total: number;
      current_phase: string | null; captured_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      planFileId: row.plan_file_id,
      rawHash: row.raw_hash,
      mtimeMs: row.mtime_ms,
      commitSha: row.commit_sha,
      sections: JSON.parse(row.sections_json) as PlanSection[],
      checkboxChecked: row.checkbox_checked,
      checkboxTotal: row.checkbox_total,
      currentPhase: row.current_phase,
      capturedAt: row.captured_at,
    }));
  }

  planSnapshotCount(planFileId: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM plan_snapshots WHERE plan_file_id = ?').get(planFileId) as { n: number }).n;
  }

  /** 归因桥:碰过该文件的 session(PlanFile ← file_touches → session)。 */
  sessionsTouchingPath(path: string): Array<{ id: string; provider: string; title: string | null; updatedAt: number }> {
    const rows = this.db.query(
      `SELECT DISTINCT s.id, s.provider, s.title, s.updated_at
       FROM session_file_touches t JOIN sessions s ON s.id = t.session_id
       WHERE t.file_path = ?
       ORDER BY s.updated_at DESC`,
    ).all(path) as Array<{ id: string; provider: string; title: string | null; updated_at: number }>;
    return rows.map((row) => ({ id: row.id, provider: row.provider, title: row.title, updatedAt: row.updated_at }));
  }

  // ── 跨实体关联(计划↔对话↔需求↔项目↔commit 的导航层)──────────

  planFilesByPaths(paths: string[]): PlanFileRecord[] {
    if (paths.length === 0) return [];
    const files = this.listPlanFiles();
    const wanted = new Set(paths);
    return files.filter((file) => wanted.has(file.path));
  }

  /** session 碰过的计划文件(session → plan 导航)。 */
  planFilesForSession(sessionId: string): PlanFileRecord[] {
    const rows = this.db.query(
      'SELECT DISTINCT file_path FROM session_file_touches WHERE session_id = ?',
    ).all(sessionId) as Array<{ file_path: string }>;
    return this.planFilesByPaths(rows.map((row) => row.file_path));
  }

  /** 需求 span 内触碰的计划文件(requirement → plan;span 语义同需求详情)。 */
  planFilesForRequirement(sessionId: string, fromSeq: number, toSeqExclusive: number | null): PlanFileRecord[] {
    return this.planFilesByPaths(this.spanTouches(sessionId, fromSeq, toSeqExclusive).map((touch) => touch.filePath));
  }

  /** 项目下的计划文件(project → plan;repo url 对齐 projects 身份)。 */
  planFilesForRepo(repoUrl: string): PlanFileRecord[] {
    return this.listPlanFiles().filter((file) => file.repo === repoUrl);
  }

  /** 计划文件关联的需求(plan → requirement:触碰 session 的全部需求,不只首条)。 */
  requirementsForPath(path: string): Array<RequirementRecord & { provider: string; updatedAt: number }> {
    const rows = this.db.query(
      `SELECT r.id, r.session_id, r.seq, r.text, r.origin_level, r.ts,
              s.provider, s.updated_at
       FROM requirements r
       JOIN sessions s ON s.id = r.session_id
       WHERE r.session_id IN (SELECT DISTINCT session_id FROM session_file_touches WHERE file_path = ?)
       ORDER BY s.updated_at DESC, r.seq`,
    ).all(path) as Array<{
      id: string; session_id: string; seq: number; text: string; origin_level: string;
      ts: number | null; provider: string; updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      text: row.text,
      originLevel: row.origin_level === 'user_explicit' ? 'user_explicit' : 'system_inferred',
      ts: row.ts,
      repos: [],
      provider: row.provider,
      updatedAt: row.updated_at,
    }));
  }

  /** 计划文件关联的 commit(plan → commit:触碰 session 的归因 commit,按 sha 去重)。 */
  commitsForPath(path: string): SessionCommit[] {
    const rows = this.db.query(
      `SELECT c.session_id, c.repo, c.sha, c.kind, c.ts, c.summary, c.file_overlap, c.pushed
       FROM session_commits c
       WHERE c.session_id IN (SELECT DISTINCT session_id FROM session_file_touches WHERE file_path = ?)
       ORDER BY c.ts DESC`,
    ).all(path) as Array<{
      session_id: string; repo: string; sha: string; kind: string; ts: number | null;
      summary: string | null; file_overlap: number; pushed: number;
    }>;
    const seen = new Set<string>();
    const commits: SessionCommit[] = [];
    for (const row of rows) {
      if (seen.has(row.sha)) continue;
      seen.add(row.sha);
      commits.push({
        sessionId: row.session_id,
        repo: row.repo,
        sha: row.sha,
        kind: row.kind === 'declared' ? 'declared' : 'candidate',
        ts: row.ts,
        summary: row.summary ?? '',
        fileOverlap: !!row.file_overlap,
        pushed: row.pushed !== 0,
      });
    }
    return commits;
  }

  /** repo url → 项目实体(跨页跳转要 project id)。 */
  projectByRepo(repoUrl: string): { id: string; name: string } | null {
    const row = this.db.query('SELECT id, name FROM projects WHERE url = ? LIMIT 1').get(repoUrl) as
      | { id: string; name: string }
      | null;
    return row ?? null;
  }

  upsertSessionTouches(rows: SessionFileTouch[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO session_file_touches (id, session_id, provider, file_path, tool_name, op, ts, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_path = excluded.file_path,
         tool_name = excluded.tool_name,
         op = excluded.op,
         ts = excluded.ts,
         ordinal = excluded.ordinal`,
    );
    this.withTransaction(() => {
      for (const row of rows) {
        stmt.run(row.id, row.sessionId, row.provider, row.filePath, row.toolName, row.op, row.ts, row.ordinal);
      }
    });
  }

  deleteSessionTouches(sessionId: string): void {
    this.db.query('DELETE FROM session_file_touches WHERE session_id = ?').run(sessionId);
  }

  /** 一个 session 的文件 touch 时间线(按 ordinal 排序,即源文件出现顺序)。 */
  listSessionTouches(sessionId: string): SessionFileTouch[] {
    const rows = this.db.query(
      `SELECT id, session_id, provider, file_path, tool_name, op, ts, ordinal
       FROM session_file_touches WHERE session_id = ? ORDER BY ordinal`,
    ).all(sessionId) as Array<{
      id: string;
      session_id: string;
      provider: string;
      file_path: string;
      tool_name: string;
      op: string;
      ts: number | null;
      ordinal: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      provider: row.provider,
      filePath: row.file_path,
      toolName: row.tool_name,
      op: row.op,
      ts: row.ts,
      ordinal: row.ordinal,
    }));
  }

  /**
   * 文件 → 碰过它的 session 列表(fileHistory)。精确匹配 ∪ 后缀匹配
   * (用户可能传相对路径),按最近触碰倒排。
   */fileTouchSessions(path: string, limit = 50): FileTouchSession[] {
    const p = path.trim();
    if (!p) return [];
    const suffix = `%${p.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`;
    const rows = this.db.query(
      `SELECT t.session_id AS sessionId,
              MAX(t.ts) AS lastTs,
              COUNT(*) AS touches,
              GROUP_CONCAT(DISTINCT t.op) AS ops
       FROM session_file_touches t
       WHERE t.file_path = ? OR t.file_path LIKE ? ESCAPE '\\'
       GROUP BY t.session_id
       ORDER BY lastTs DESC
       LIMIT ?`,
    ).all(p, suffix, limit) as Array<{
      sessionId: string;
      lastTs: number | null;
      touches: number;
      ops: string | null;
    }>;
    return rows.map((row) => {
      const session = this.getSession(row.sessionId);
      return {
        sessionId: row.sessionId,
        provider: session?.provider ?? 'unknown',
        title: session?.title ?? null,
        lastTs: row.lastTs,
        touches: row.touches,
        ops: (row.ops ?? '').split(',').filter(Boolean).sort(),
      };
    });
  }

  /** 某 repo 根目录下的全部 touch(归因时换算成 repo 相对路径)。 */
  listTouchesUnderRoot(root: string): Array<{ sessionId: string; filePath: string }> {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return this.db.query(
      `SELECT session_id AS sessionId, file_path AS filePath
       FROM session_file_touches
       WHERE file_path LIKE ? ESCAPE '\\'`,
    ).all(`${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as Array<{ sessionId: string; filePath: string }>;
  }

  /** 有任何 touch 数据的 session 集合(commit 归因的分档依据)。 */
  listTouchedSessionIds(): Set<string> {
    const rows = this.db.query('SELECT DISTINCT session_id FROM session_file_touches').all() as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  }

  upsertSessionCommits(rows: SessionCommit[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO session_commits (session_id, repo, sha, kind, ts, summary, file_overlap, pushed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sha) DO UPDATE SET
         repo = excluded.repo,
         kind = excluded.kind,
         ts = excluded.ts,
         summary = excluded.summary,
         file_overlap = excluded.file_overlap,
         pushed = excluded.pushed`,
    );
    this.withTransaction(() => {
      for (const row of rows) {
        // pushed 未知(null)按已推送存(1),维持渲染链接的旧行为
        stmt.run(row.sessionId, row.repo, row.sha, row.kind, row.ts, row.summary, row.fileOverlap ? 1 : 0, row.pushed === false ? 0 : 1);
      }
    });
  }

  /** 重算前清掉指定 session 的旧归因(分块避免超长 IN)。 */
  deleteSessionCommitsFor(sessionIds: string[]): void {
    for (let i = 0; i < sessionIds.length; i += 500) {
      const chunk = sessionIds.slice(i, i + 500);
      this.db.query(
        `DELETE FROM session_commits WHERE session_id IN (${chunk.map(() => '?').join(',')})`,
      ).run(...chunk);
    }
  }

  /** 清掉已滚出扫描窗口的 session 的归因行(它们不会再被重算,留着只会腐烂)。 */
  deleteSessionCommitsBefore(since: number): void {
    this.db.query(
      'DELETE FROM session_commits WHERE session_id IN (SELECT id FROM sessions WHERE updated_at < ?)',
    ).run(since);
  }

  listSessionCommits(sessionId?: string): SessionCommit[] {
    const rows = sessionId
      ? this.db.query(
          `SELECT session_id, repo, sha, kind, ts, summary, file_overlap, pushed
           FROM session_commits WHERE session_id = ? ORDER BY ts`,
        ).all(sessionId)
      : this.db.query(
          `SELECT session_id, repo, sha, kind, ts, summary, file_overlap, pushed
           FROM session_commits ORDER BY ts`,
        ).all();
    return (rows as Array<{
      session_id: string;
      repo: string;
      sha: string;
      kind: string;
      ts: number | null;
      summary: string | null;
      file_overlap: number;
      pushed: number;
    }>).map(sessionCommitFromRow);
  }

  /** commit → 关联 session 反查(支持短 sha 前缀)。 */
  sessionsForCommit(sha: string): SessionCommit[] {
    const rows = this.db.query(
      `SELECT session_id, repo, sha, kind, ts, summary, file_overlap, pushed
       FROM session_commits WHERE sha = ? OR sha LIKE ? ORDER BY ts`,
    ).all(sha, `${sha}%`) as Array<{
      session_id: string;
      repo: string;
      sha: string;
      kind: string;
      ts: number | null;
      summary: string | null;
      file_overlap: number;
      pushed: number;
    }>;
    return rows.map(sessionCommitFromRow);
  }

  getSessionIndexState(path: string): SessionIndexState | null {
    const row = this.db.query(
      'SELECT path, mtime_ms, size, parsed_bytes, lines, parser_version FROM session_index_state WHERE path = ?',
    ).get(path) as {
      path: string;
      mtime_ms: number;
      size: number;
      parsed_bytes: number;
      lines: number;
      parser_version: number;
    } | null;
    if (!row) return null;
    return {
      path: row.path,
      mtimeMs: row.mtime_ms,
      size: row.size,
      parsedBytes: row.parsed_bytes,
      lines: row.lines,
      parserVersion: row.parser_version,
    };
  }

  upsertSessionIndexState(state: SessionIndexState): void {
    this.db.query(
      `INSERT INTO session_index_state (path, mtime_ms, size, parsed_bytes, lines, parser_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         parsed_bytes = excluded.parsed_bytes,
         lines = excluded.lines,
         parser_version = excluded.parser_version`,
    ).run(state.path, state.mtimeMs, state.size, state.parsedBytes, state.lines, state.parserVersion);
  }

  /**
   * 内容级搜索：trigram FTS5 命中按 session 聚合（count + 最佳片段）。
   * trigram 最少 3 个字符，更短的查询回退 LIKE 子串扫描。
   * snippet 里用 \u0001/\u0002 包住命中词，由展示层转高亮标签。
   */
  searchSessionMessages(query: string, limit = 80): SessionMessageHit[] {
    const q = query.trim();
    if (!q) return [];
    if ([...q.replace(/\s+/g, '')].length < 3) {
      return this.searchSessionMessagesLike(q, limit);
    }
    const ftsQuery = q.split(/\s+/).filter(Boolean)
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(' ');
    try {
      const rows = this.db.query(
        `SELECT m.session_id AS sessionId,
                snippet(session_messages_fts, 0, char(1), char(2), '…', 24) AS snippet,
                bm25(session_messages_fts) AS rank
         FROM session_messages_fts
         JOIN session_messages m ON m.rowid = session_messages_fts.rowid
         WHERE session_messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(ftsQuery, limit) as Array<{ sessionId: string; snippet: string; rank: number }>;
      return aggregateMessageHits(rows.map((row) => ({ sessionId: row.sessionId, snippet: row.snippet })));
    } catch {
      // FTS 语法错误（特殊字符等）兜底到 LIKE
      return this.searchSessionMessagesLike(q, limit);
    }
  }

  private searchSessionMessagesLike(query: string, limit: number): SessionMessageHit[] {
    const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = this.db.query(
      `SELECT session_id AS sessionId, text
       FROM session_messages
       WHERE text LIKE ? ESCAPE '\\'
       ORDER BY timestamp DESC
       LIMIT ?`,
    ).all(pattern, limit) as Array<{ sessionId: string; text: string | null }>;
    const needle = query.toLowerCase();
    return aggregateMessageHits(rows.map((row) => {
      const text = row.text ?? '';
      const at = text.toLowerCase().indexOf(needle);
      const start = Math.max(0, at - 24);
      const snippet = at < 0
        ? text.slice(0, 48)
        : `${start > 0 ? '…' : ''}${text.slice(start, at)}\u0001${text.slice(at, at + query.length)}\u0002${text.slice(at + query.length, at + query.length + 24)}${at + query.length + 24 < text.length ? '…' : ''}`;
      return { sessionId: row.sessionId, snippet };
    }));
  }
}

function sessionCommitFromRow(row: {
  session_id: string;
  repo: string;
  sha: string;
  kind: string;
  ts: number | null;
  summary: string | null;
  file_overlap: number;
  pushed: number;
}): SessionCommit {
  return {
    sessionId: row.session_id,
    repo: row.repo,
    sha: row.sha,
    kind: row.kind === 'declared' ? 'declared' : 'candidate',
    ts: row.ts,
    summary: row.summary ?? '',
    fileOverlap: row.file_overlap === 1,
    pushed: row.pushed !== 0,
  };
}

/** 命中行聚合成每 session 一条：保留最好（最靠前）的片段，统计命中条数。 */
function aggregateMessageHits(rows: Array<{ sessionId: string; snippet: string }>): SessionMessageHit[] {  const bySession = new Map<string, SessionMessageHit>();
  for (const row of rows) {
    const hit = bySession.get(row.sessionId);
    if (hit) {
      hit.count += 1;
    } else {
      bySession.set(row.sessionId, { sessionId: row.sessionId, count: 1, snippet: row.snippet });
    }
  }
  return [...bySession.values()];
}

function stripGlmRegion(extra: Record<string, string>): Record<string, string> {
  const { region: _region, ...rest } = extra ?? {};
  return rest;
}

function planFromRow(row: {
  slug: string;
  name: string;
  adapter: string;
  enabled: number;
  poll_interval_sec: number;
  cred_ref: string | null;
  extra: string;
}): PlanConfig {
  let extra: Record<string, string> = {};
  try {
    extra = JSON.parse(row.extra) as Record<string, string>;
  } catch {
    extra = {};
  }
  return {
    slug: row.slug,
    name: row.name,
    adapter: row.adapter,
    enabled: row.enabled === 1,
    pollIntervalSec: row.poll_interval_sec,
    credRef: row.cred_ref ?? null,
    extra,
  };
}

function sessionFromRow(row: {
  id: string;
  provider: string;
  native_id: string;
  cwd: string | null;
  title: string | null;
  source_file: string | null;
  started_at: number | null;
  updated_at: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  seen_at: number;
  git_root?: string | null;
  git_url?: string | null;
  git_name?: string | null;
  origin?: string | null;
  parent_id?: string | null;
  origin_detail?: string | null;
}): SessionRecord {
  return {
    id: row.id,
    provider: row.provider,
    nativeId: row.native_id,
    cwd: row.cwd,
    title: row.title,
    sourceFile: row.source_file,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    seenAt: row.seen_at,
    gitRoot: row.git_root ?? null,
    gitUrl: row.git_url ?? null,
    gitName: row.git_name ?? null,
    origin: (row.origin ?? 'user') as SessionRecord['origin'],
    parentId: row.parent_id ?? null,
    originDetail: row.origin_detail ?? null,
  };
}

export function openDb(path: string): Store {
  const db = new Database(path, { strict: true });
  db.exec(`PRAGMA journal_mode = WAL;`);
  return new Store(db);
}

export function openMemoryDb(): Store {
  const db = new Database(':memory:', { strict: true });
  return new Store(db);
}
