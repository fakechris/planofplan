#!/usr/bin/env bun
import { join } from 'node:path';
import { ensureHome, loadConfig } from './config.ts';
import { openDb, openMemoryDb } from './db.ts';
import { Scheduler, buildOverview, formatResetCountdown, type OverviewPlan } from './core.ts';
import { createServer } from './server.ts';
import { writeCredential, deleteCredential } from './auth.ts';
import type { Store } from './db.ts';
import type { QuotaWindow } from './types.ts';

const argv = process.argv.slice(2);

function help(): void {
  console.log(`planofplan — AI Coding Plan 用量 dashboard

用法:
  planofplan serve [--demo] [--port N]     启动守护进程 + Web dashboard（http://localhost:9288）
  planofplan usage [--json] [--provider sl] 全 plan 用量输出
  planofplan status                         各 plan 调度/凭据/最近抓取状态
  planofplan refresh [slug]                 手动刷新一个/全部 plan
  planofplan auth set <slug> --key <v>     存手动 API Key（~/.planofplan/credentials.json, 0600）
  planofplan auth set <slug> --auto         改回自动检测（env / CLI 凭据）
  planofplan auth clear <slug>              清掉手动 key
`);
}

function flags(): { demo: boolean; port: number | null; json: boolean; provider: string | null; key: string | null; auto: boolean } {
  const f = { demo: false, port: null as number | null, json: false, provider: null as string | null, key: null as string | null, auto: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--demo') f.demo = true;
    else if (a === '--json') f.json = true;
    else if (a === '--auto') f.auto = true;
    else if (a === '--port') f.port = Number(argv[++i]);
    else if (a === '--key') f.key = argv[++i] ?? null;
    else if (a === '--provider') f.provider = argv[++i] ?? null;
  }
  return f;
}

// ── serve ──────────────────────────────────────────────────────────
async function serve(): Promise<void> {
  const f = flags();
  const cfg = loadConfig();
  const port = f.port ?? cfg.port;
  const store = f.demo ? openMemoryDb() : openDb(join(ensureHome(), 'planofplan.db'));

  for (const plan of cfg.plans) store.syncPlan(plan);
  if (f.demo) seedDemo(store);

  const scheduler = new Scheduler(store, cfg);
  scheduler.start();

  const server = createServer(store, scheduler, cfg);
  Bun.serve({ port, fetch: server.fetch });
  console.log(`planofplan 已启动: http://localhost:${port}${f.demo ? '  (demo 数据，内存库，不落盘)' : ''}`);
  if (f.demo) console.log('提示：demo 模式用内置示例数据预览界面；真实数据请配置 MINIMAX_CODING_API_KEY 后去掉 --demo 启动。');
}

// ── usage ───────────────────────────────────────────────────────────
function usage(): void {
  const f = flags();
  const cfg = loadConfig();
  const store = openDb(join(ensureHome(), 'planofplan.db'));
  for (const plan of cfg.plans) store.syncPlan(plan);
  const ov = buildOverview(store, cfg.plans, Date.now());
  const plans = f.provider ? ov.plans.filter((p) => p.slug === f.provider) : ov.plans;

  if (f.json) {
    console.log(JSON.stringify({ ...ov, plans }, null, 2));
    return;
  }

  for (const p of plans) {
    printPlanHuman(p);
  }
}

const STATUS_BADGE: Record<string, string> = {
  ok: '[ok]',
  stale: '[过期]',
  error: '[错误]',
  not_configured: '[未配置]',
  auth_error: '[凭据失效]',
  unavailable: '[未接入]',
};

function printPlanHuman(p: OverviewPlan): void {
  console.log(`${p.name} (${p.slug}) ${STATUS_BADGE[p.status] ?? '[' + p.status + ']'}`);
  if (p.windows.length === 0) {
    console.log(`  ${p.lastError ?? '暂无数据'}`);
    console.log('');
    return;
  }
  for (const w of p.windows) {
    const countdown = formatResetCountdown(w.resetAt, Date.now());
    const pct = w.percentage == null ? '--' : `${w.percentage}%`;
    const val = w.used != null && w.total != null ? `${w.used}/${w.total}` : w.used != null ? `${w.used}` : '--';
    console.log(`  ${w.label.padEnd(5)} ${pct.padStart(4)}  ${val.padStart(10)}  ${countdown ?? ''}${w.note ? '  (' + w.note + ')' : ''}`);
  }
  console.log('');
}

// ── status ──────────────────────────────────────────────────────────
function status(): void {
  const cfg = loadConfig();
  const store = openDb(join(ensureHome(), 'planofplan.db'));
  for (const plan of cfg.plans) store.syncPlan(plan);
  const ov = buildOverview(store, cfg.plans, Date.now());
  console.log('plan             adapter      enabled  auth       lastSuccess        lastError');
  for (const p of ov.plans) {
    const last = p.lastFetchedAt ? new Date(p.lastFetchedAt).toISOString().slice(11, 19) : '--';
    const err = p.lastError ? p.lastError.slice(0, 60) : '--';
    console.log(
      `${p.slug.padEnd(16)} ${p.adapter.padEnd(11)} ${String(p.enabled).padEnd(8)} ${p.authStatus.padEnd(10)} ${last.padEnd(18)} ${err}`,
    );
  }
}

// ── refresh ─────────────────────────────────────────────────────────
async function refresh(): Promise<void> {
  const cfg = loadConfig();
  const store = openDb(join(ensureHome(), 'planofplan.db'));
  for (const plan of cfg.plans) store.syncPlan(plan);
  const scheduler = new Scheduler(store, cfg);
  const slug = argv.slice(1).find((a) => a && !a.startsWith('-'));
  const targets = slug ? [slug] : store.listPlans().filter((p) => p.enabled).map((p) => p.slug);
  for (const s of targets) {
    const r = await scheduler.refreshPlan(s);
    if (r.ok) {
      console.log(`${s}: ok (${r.windows?.map((w: QuotaWindow) => `${w.label} ${w.percentage ?? '?'}%`).join(', ') ?? ''})`);
    } else {
      console.log(`${s}: ${r.error}`);
    }
  }
}

// ── auth ────────────────────────────────────────────────────────────
function auth(): void {
  const sub = argv[2];
  const slug = argv[3];
  if (!slug) {
    console.log('用法: planofplan auth set <slug> --key <v> | --auto | clear <slug>');
    return;
  }
  const f = flags();
  const store = openDb(join(ensureHome(), 'planofplan.db'));

  if (sub === 'set') {
    if (f.key && f.key.trim()) {
      writeCredential(slug, f.key.trim());
      store.updatePlanRuntime(slug, { cred_ref: slug });
      console.log(`${slug}: 手动 key 已保存（${f.key.trim().slice(0, 8)}...）`);
    } else if (f.auto) {
      deleteCredential(slug);
      store.updatePlanRuntime(slug, { cred_ref: null });
      console.log(`${slug}: 已切回自动检测（env / CLI 凭据）`);
    } else {
      console.log('需要 --key <v> 或 --auto');
    }
  } else if (sub === 'clear') {
    deleteCredential(slug);
    store.updatePlanRuntime(slug, { cred_ref: null });
    console.log(`${slug}: 手动 key 已清除`);
  } else {
    console.log('用法: planofplan auth set <slug> --key <v> | --auto | clear <slug>');
  }
}

// ── demo 数据（内存库）─────────────────────────────────────────────
function seedDemo(store: Store): void {
  const now = Date.now();
  const f: QuotaWindow = {
    window: 'rolling_5h',
    label: '5H',
    used: 382,
    total: 1000,
    unit: 'prompts',
    percentage: 38.2,
    resetAt: now + 2 * 3_600_000 + 13 * 60_000,
    note: null,
  };
  store.insertWindows('minimax', [f], now);
  // 一条历史（-6h）
  const older: QuotaWindow = { ...f, used: 210, percentage: 21, resetAt: now - 6 * 3_600_000 };
  store.insertWindows('minimax', [older], now - 6 * 3_600_000);
}

// ── main ────────────────────────────────────────────────────────────
const cmd = argv[0] ?? 'help';

switch (cmd) {
  case 'serve':
    await serve();
    break;
  case 'usage':
    usage();
    break;
  case 'status':
    status();
    break;
  case 'refresh':
    await refresh();
    break;
  case 'auth':
    auth();
    break;
  case 'demo':
    argv[0] = 'serve';
    argv.push('--demo');
    await serve();
    break;
  case 'help':
  case '-h':
  case '--help':
  default:
    help();
    break;
}
