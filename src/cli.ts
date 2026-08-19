#!/usr/bin/env bun
import { join } from 'node:path';
import { ensureHome, loadConfig } from './config.ts';
import { openDb, openMemoryDb } from './db.ts';
import { Scheduler, buildOverview, formatResetCountdown, type OverviewPlan } from './core.ts';
import { createServer } from './server.ts';
import { readCredential, writeCredential, deleteCredential } from './auth.ts';
import { refreshKimiBrowserSession } from './adapters/kimi.ts';
import { KIMI_BROWSERS, type KimiBrowser } from './browser-cookies.ts';
import { acceptFactoryBrowserCookies } from './factory-session.ts';
import { readFactoryCliAuth } from './factory-cli-auth.ts';
import type { Store } from './db.ts';
import type { QuotaWindow } from './types.ts';
import { buildUsageReport, collectUsageReport } from './usage.ts';

const argv = process.argv.slice(2);

function syncStore(store: Store, cfg: ReturnType<typeof loadConfig>): void {
  const migrated = store.migrateLegacyGlmPlans();
  const source = migrated.sourceCredentialRef ? readCredential(migrated.sourceCredentialRef) : null;
  if (source) {
    writeCredential('glm', source.value);
    store.updatePlanRuntime('glm', { cred_ref: 'glm' });
  } else if (migrated.sourceCredentialRef) {
    store.updatePlanRuntime('glm', { cred_ref: null });
  }
  for (const ref of migrated.credentialRefs) deleteCredential(ref);
  for (const plan of cfg.plans) store.syncPlan(plan);
}

function help(): void {
  console.log(`planofplan — AI Coding Plan 用量 dashboard

用法:
  planofplan serve [--demo] [--port N]     启动守护进程 + Web dashboard（http://localhost:9288）
  planofplan usage [--json] [--provider sl] 全 plan 用量输出
  planofplan tokens [--json] [--days N] [--provider sl] token usage & spend 报表
  planofplan status                         各 plan 调度/凭据/最近抓取状态
  planofplan refresh [slug]                 手动刷新一个/全部 plan
  planofplan browser-auth                  读取 Safari kimi-auth 并刷新 Kimi
  planofplan factory-auth                  从 droid CLI 登录态导入 Factory 会话（会消耗 CLI 的 refresh token）
  planofplan auth set <slug> --key <v>     存手动 API Key（~/.planofplan/credentials.json, 0600）
  planofplan auth set <slug> --auto         改回自动检测（env / CLI 凭据）
  planofplan auth clear <slug>              清掉手动 key
`);
}

function flags(): { demo: boolean; port: number | null; json: boolean; provider: string | null; key: string | null; auto: boolean; browser: KimiBrowser | null; days: number; official: boolean; db: string | null } {
  const f = { demo: false, port: null as number | null, json: false, provider: null as string | null, key: null as string | null, auto: false, browser: null as KimiBrowser | null, days: 30, official: true, db: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--demo') f.demo = true;
    else if (a === '--json') f.json = true;
    else if (a === '--auto') f.auto = true;
    else if (a === '--port') f.port = Number(argv[++i]);
    else if (a === '--key') f.key = argv[++i] ?? null;
    else if (a === '--provider') f.provider = argv[++i] ?? null;
    else if (a === '--days') f.days = Math.min(365, Math.max(1, Number(argv[++i] ?? 30) || 30));
    else if (a === '--no-official') f.official = false;
    else if (a === '--db') f.db = argv[++i] ?? null;
    else if (a === '--browser') {
      const browser = argv[++i];
      if (browser && KIMI_BROWSERS.includes(browser as KimiBrowser)) f.browser = browser as KimiBrowser;
    }
  }
  return f;
}

async function tokenUsage(): Promise<void> {
  const f = flags();
  const cfg = loadConfig();
  const store = openDb(f.db ?? join(ensureHome(), 'planofplan.db'));
  syncStore(store, cfg);
  const now = Date.now();
  const since = now - f.days * 86_400_000;
  await collectUsageReport(store, { since, until: now, includeOfficial: f.official });
  const records = f.provider
    ? store.getUsageRecords(since, now).filter((record) => record.provider === f.provider)
    : store.getUsageRecords(since, now);
  const report = buildUsageReport(records, { since, until: now, generatedAt: now });
  if (f.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Token usage (${f.days} days) · ${report.recordCount} records`);
  console.log(
    `  total ${formatTokens(report.totals.totalTokens)} · input ${formatTokens(report.totals.inputTokens)} · cache-read ${formatTokens(report.totals.cachedInputTokens)} · cache-create ${formatTokens(report.totals.cacheCreationInputTokens)} · output ${formatTokens(report.totals.outputTokens)} · reasoning ${formatTokens(report.totals.reasoningOutputTokens)} · estimated $${report.totals.estimatedCostUsd?.toFixed(4) ?? '--'}`,
  );
  if (report.sources.length > 0) {
    console.log(`  sources ${report.sources.map((source) => `${source.source} ${formatTokens(source.totalTokens)}`).join(' · ')}`);
  }
  for (const model of report.models.slice(0, 12)) {
    console.log(`  ${model.provider}/${model.model}: ${formatTokens(model.totalTokens)} · $${model.estimatedCostUsd?.toFixed(4) ?? '--'}`);
  }
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

// ── serve ──────────────────────────────────────────────────────────
async function serve(): Promise<void> {
  const f = flags();
  const cfg = loadConfig();
  const port = f.port ?? cfg.port;
  const store = f.demo ? openMemoryDb() : openDb(join(ensureHome(), 'planofplan.db'));

  syncStore(store, cfg);
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
  syncStore(store, cfg);
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
  syncStore(store, cfg);
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
  syncStore(store, cfg);
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

async function browserAuth(): Promise<void> {
  const result = await refreshKimiBrowserSession('safari');
  if (!result.token) {
    console.error('未找到有效 kimi-auth 浏览器会话');
    for (const warning of result.warnings) console.error(`  ${warning}`);
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  const store = openDb(join(ensureHome(), 'planofplan.db'));
  syncStore(store, cfg);
  const scheduler = new Scheduler(store, cfg);
  const refreshed = await scheduler.refreshPlan('kimi');
  console.log(`kimi browser auth: ${refreshed.ok ? 'ok' : refreshed.error} (${result.source})`);
}

async function factoryCliAuth(): Promise<void> {
  const auth = await readFactoryCliAuth();
  if (!auth) {
    console.error('未找到 droid CLI 登录态（~/.factory/auth.v2.*）；请先运行 droid 登录');
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig();
  const store = openDb(join(ensureHome(), 'planofplan.db'));
  syncStore(store, cfg);
  const accepted = acceptFactoryBrowserCookies(
    [],
    `${auth.source} (local)`,
    { accessToken: auth.accessToken, refreshToken: auth.refreshToken },
    auth.organizationId,
  );
  if (!accepted) {
    console.error('droid CLI 凭据无法导入');
    process.exitCode = 1;
    return;
  }
  const scheduler = new Scheduler(store, cfg);
  const refreshed = await scheduler.refreshPlan('factory');
  console.log(`factory droid CLI 导入: ${refreshed.ok ? 'ok' : refreshed.error} (${auth.source})`);
  console.log('注意：WorkOS refresh token 一次性轮换，本次兑换会消耗 droid CLI 的 token，CLI 下次需要时会要求重新登录。');
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
  case 'tokens':
  case 'token-usage':
    await tokenUsage();
    break;
  case 'status':
    status();
    break;
  case 'refresh':
    await refresh();
    break;
  case 'browser-auth':
    await browserAuth();
    break;
  case 'factory-auth':
    await factoryCliAuth();
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
