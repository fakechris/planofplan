import { Database } from 'bun:sqlite';
import type {
  FileTouchSession,
  PlanConfig,
  PlanStateRow,
  QuotaWindow,
  SessionCommit,
  SessionFileTouch,
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
  git_name TEXT
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
  PRIMARY KEY (session_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_session_commits_sha ON session_commits(sha);
CREATE INDEX IF NOT EXISTS idx_session_commits_repo ON session_commits(repo, ts);
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
    const stmt = this.db.query(
      `INSERT INTO sessions (
         id, provider, native_id, cwd, title, source_file, started_at, updated_at,
         input_tokens, output_tokens, total_tokens, estimated_cost_usd, seen_at,
         git_root, git_url, git_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         cwd = COALESCE(excluded.cwd, sessions.cwd),
         title = COALESCE(excluded.title, sessions.title),
         source_file = COALESCE(excluded.source_file, sessions.source_file),
         started_at = COALESCE(excluded.started_at, sessions.started_at),
         git_root = COALESCE(excluded.git_root, sessions.git_root),
         git_url = COALESCE(excluded.git_url, sessions.git_url),
         git_name = COALESCE(excluded.git_name, sessions.git_name),
         updated_at = excluded.updated_at,
         seen_at = excluded.seen_at`,
    );
    this.db.exec('BEGIN');
    try {
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
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
              git_root, git_url, git_name
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
    }>;
    return this.attachSessionRepos(rows.map(sessionFromRow));
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query(
      `SELECT id, provider, native_id, cwd, title, source_file, started_at, updated_at,
              input_tokens, output_tokens, total_tokens, estimated_cost_usd, seen_at,
              git_root, git_url, git_name
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

  /** 级联删除：session 本体 + repo 归属 + 消息索引 + 文件 touch + commit 归因(FTS 由触发器同步）。 */
  deleteSession(id: string): void {
    this.withTransaction(() => {
      this.db.query('DELETE FROM session_messages WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM session_file_touches WHERE session_id = ?').run(id);
      this.db.query('DELETE FROM session_commits WHERE session_id = ?').run(id);
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

  upsertSessionCommits(rows: SessionCommit[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO session_commits (session_id, repo, sha, kind, ts, summary, file_overlap)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sha) DO UPDATE SET
         repo = excluded.repo,
         kind = excluded.kind,
         ts = excluded.ts,
         summary = excluded.summary,
         file_overlap = excluded.file_overlap`,
    );
    this.withTransaction(() => {
      for (const row of rows) {
        stmt.run(row.sessionId, row.repo, row.sha, row.kind, row.ts, row.summary, row.fileOverlap ? 1 : 0);
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

  listSessionCommits(sessionId?: string): SessionCommit[] {
    const rows = sessionId
      ? this.db.query(
          `SELECT session_id, repo, sha, kind, ts, summary, file_overlap
           FROM session_commits WHERE session_id = ? ORDER BY ts`,
        ).all(sessionId)
      : this.db.query(
          `SELECT session_id, repo, sha, kind, ts, summary, file_overlap
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
    }>).map(sessionCommitFromRow);
  }

  /** commit → 关联 session 反查(支持短 sha 前缀)。 */
  sessionsForCommit(sha: string): SessionCommit[] {
    const rows = this.db.query(
      `SELECT session_id, repo, sha, kind, ts, summary, file_overlap
       FROM session_commits WHERE sha = ? OR sha LIKE ? ORDER BY ts`,
    ).all(sha, `${sha}%`) as Array<{
      session_id: string;
      repo: string;
      sha: string;
      kind: string;
      ts: number | null;
      summary: string | null;
      file_overlap: number;
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
}): SessionCommit {
  return {
    sessionId: row.session_id,
    repo: row.repo,
    sha: row.sha,
    kind: row.kind === 'declared' ? 'declared' : 'candidate',
    ts: row.ts,
    summary: row.summary ?? '',
    fileOverlap: row.file_overlap === 1,
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
