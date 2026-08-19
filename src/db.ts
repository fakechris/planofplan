import { Database } from 'bun:sqlite';
import type { PlanConfig, PlanStateRow, QuotaWindow } from './types.ts';

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
CREATE TABLE IF NOT EXISTS plan_state (
  plan_id TEXT PRIMARY KEY,
  last_success_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER,
  auth_status TEXT NOT NULL DEFAULT 'unknown'
);
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
    percentage: r.percentage,
    resetAt: r.reset_at,
    note: r.note,
    fetchedAt: r.fetched_at,
  };
}

export class Store {
  constructor(private db: Database) {
    db.exec(SCHEMA);
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
  latestByPlan(planId: string): QuotaWindow[] {
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
           FROM snapshots s WHERE plan_id = ?
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
      .all(planId) as SnapshotRow[];
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
    return Number(r.changes);
  }
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

export function openDb(path: string): Store {
  const db = new Database(path, { strict: true });
  db.exec(`PRAGMA journal_mode = WAL;`);
  return new Store(db);
}

export function openMemoryDb(): Store {
  const db = new Database(':memory:', { strict: true });
  return new Store(db);
}
