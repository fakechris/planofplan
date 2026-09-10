// agent-status.ts —— 实时 coding-agent 状态快照,供桌宠等外部设备消费。
// GET /api/agent-status:每次调用(或 TTL 缓存命中)扫描本机各 agent 的可观测
// 痕迹,归并进 4 个优先级槽位。6 态模型与桌面宠固件协议一致:
//   0 idle / 1 working / 2 needs-you / 3 review / 4 failed / 5 celebrate。
// 三类机制,精度递减:HTTP 问状态(dsh/opencode) > hooks 事件文件(claude/droid)
// > 文件 mtime + 进程存活(codex/kimi/zcode/amp/grok/agy)。源缺席自动跳过,
// 绝不瞎猜——测不到的源不进槽位。
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const STATE_NAMES = ['idle', 'working', 'needs-you', 'review', 'failed', 'celebrate'] as const;

/** 桌宠 6 态。255 进度 = 未知。 */
export interface AgentView {
  source: string;
  name: string;      // ≤16 chars 展示
  state: number;     // 0-5,见 STATE_NAMES
  progress: number;  // 0-100,255 = unknown
  text: string;      // ≤32 chars 任务行
}

export interface AgentStatusSlot extends AgentView {
  slot: number;      // 0-3;occupied=false 时为占位空槽
  occupied: boolean;
  stateName: string; // 'idle'|'working'|'needs-you'|'review'|'failed'|'celebrate'
}

export interface AgentStatusSnapshot {
  generatedAt: number;
  slots: AgentStatusSlot[];   // 恒 4 项,未占用项 occupied=false/state=0
}

export interface AgentStatusOptions {
  dshUrl?: string;
  opencodeUrl?: string;
  /** 逗号分隔的禁用源名,如 "amp,agy"。 */
  disabled?: string;
  home?: string;               // 注入根目录(测试用);默认真实 home
  force?: boolean;             // 跳过 TTL 缓存强制重扫
}

const RECENT = 150;    // 秒:transcript/store 这么新 = 活跃 turn
const HOOK_STALE = 180; // 秒:hooks 状态文件过期线
const HTTP_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 3000;
const MAX_PER_SOURCE = 4;

const HOOK_STATE_MAP: Record<string, number> = {
  working: 1, needs: 2, review: 3, failed: 4, done: 5, idle: 0,
};

function ageSeconds(path: string): number {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 1000;
  } catch {
    return 1e9;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function getJson(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function baseLabel(path: string, fallback: string, max = 12): string {
  const last = path.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  return (last ?? fallback).slice(0, max) || fallback;
}

/** 进程扫描:word 边界匹配 argv0(子串会误伤 'Android File Transfer Agent')。 */
async function procRunning(pattern: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'command='], { timeout: 5000 });
    const rx = new RegExp(`(^|/)${pattern}(\\s|$)`, 'i');
    return stdout.split('\n').some((line) => rx.test(line));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 各源 poller(与 deskpet-sender Python 版逐条对齐;只改语言不改语义)
// ---------------------------------------------------------------------------

/** dsh obvious-grid:GET /obvious-grid/status 的 per-session state。 */
export async function pollDsh(baseUrl: string): Promise<AgentView[]> {
  let data: Record<string, unknown>;
  try {
    data = (await getJson(`${baseUrl.replace(/\/+$/, '')}/obvious-grid/status`)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const sessions = (data.sessions ?? data.cards ?? []) as Record<string, unknown>[];
  const out: AgentView[] = [];
  for (const s of sessions) {
    const st = String(s.state ?? '').toLowerCase();
    const state = ['waiting', 'blocked', 'approval'].includes(st) ? 2
      : ['error', 'failed'].includes(st) ? 4
      : ['running', 'working', 'busy'].includes(st) ? 1
      : ['done', 'completed', 'review'].includes(st) ? 3 : 0;
    if (!state) continue; // idle/绿:隐藏
    const title = String(s.title ?? '').slice(0, 16) || 'dsh';
    const ws = String(s.workspace ?? '').replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '';
    out.push({ source: 'dsh', name: (title || ws.slice(0, 12) || 'dsh').slice(0, 16), state, progress: 255, text: (title || ws).slice(0, 32) });
  }
  return out;
}

/** opencode serve:permission 列表非空 = 等你批准(最准的 needs-you 源)。 */
export async function pollOpencode(baseUrl: string): Promise<AgentView[]> {
  const base = baseUrl.replace(/\/+$/, '');
  let sessions: unknown;
  let statuses: unknown;
  try {
    sessions = await getJson(`${base}/session`);
    statuses = await getJson(`${base}/session/status`);
  } catch {
    return [];
  }
  const list = Array.isArray(sessions) ? sessions
    : ((sessions as Record<string, unknown>)?.data ?? (sessions as Record<string, unknown>)?.sessions ?? []);
  const statusMap = (statuses ?? {}) as Record<string, { type?: string }>;
  const out: AgentView[] = [];
  for (const raw of list as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const sid = String(s.id ?? s.sessionID ?? '');
    const title = String(s.title ?? '').slice(0, 16) || sid.slice(0, 8) || 'opencode';
    const st = (statusMap[sid] ?? {}) as { type?: string };
    const stype = String(st.type ?? '').toLowerCase();
    let perms: unknown[] = [];
    try {
      perms = (await getJson(`${base}/session/${sid}/permission`)) as unknown[];
    } catch { /* 无 permission 端点/会话:当作空 */ }
    let state: number;
    if (Array.isArray(perms) && perms.length > 0) state = 2;
    else if (['busy', 'retry', 'running', 'working'].includes(stype)) state = 1;
    else if (['error', 'failed'].includes(stype)) state = 4;
    else if (['idle', 'done', 'complete', 'completed'].includes(stype)) state = 3;
    else {
      // 未知状态:会话最近更新过当 working,否则 review
      const time = s.time as { updated?: unknown } | undefined;
      state = time?.updated ? 1 : 3;
    }
    out.push({ source: 'opencode', name: title, state, progress: 255, text: title.slice(0, 32) });
  }
  return out;
}

/** claude:hooks 状态文件(精确)→ transcript mtime 兜底(启发式)。 */
export function pollClaude(homeDir = homedir()): AgentView[] {
  const out: AgentView[] = [];
  const now = Date.now();
  const stateDir = join(homeDir, '.config', 'deskpet-sender');
  if (existsSync(stateDir)) {
    for (const fn of readdirSync(stateDir)) {
      if (!fn.startsWith('claude-') || !fn.endsWith('.json')) continue;
      const d = readJson(join(stateDir, fn));
      if (!d) continue;
      if (now / 1000 - Number(d.time ?? 0) > HOOK_STALE) continue;
      const st = HOOK_STATE_MAP[String(d.state ?? '')] ?? 0;
      if (!st) continue;
      const label = baseLabel(String(d.cwd ?? ''), 'claude');
      out.push({ source: 'claude', name: label, state: st, progress: 255, text: String(d.text ?? '').slice(0, 32) });
    }
  }
  if (out.length) return out;
  const projs = join(homeDir, '.claude', 'projects');
  if (existsSync(projs)) {
    const walk = (dir: string): void => {
      if (out.length >= MAX_PER_SOURCE) return;
      for (const fn of readdirSync(dir)) {
        const p = join(dir, fn);
        if (statSync(p).isDirectory()) walk(p);
        else if (fn.endsWith('.jsonl') && ageSeconds(p) < 90) {
          out.push({ source: 'claude', name: basename(dir), state: 1, progress: 255, text: 'transcript live' });
          if (out.length >= MAX_PER_SOURCE) return;
        }
      }
    };
    walk(projs);
  }
  return out;
}

/** codex CLI:遍历 ~/.codex/sessions 下各 session 的 meta.json,状态 + 新鲜度。 */
export function pollCodex(homeDir = homedir()): AgentView[] {
  const base = join(homeDir, '.codex', 'sessions');
  if (!existsSync(base)) return [];
  const now = Date.now();
  const cands: { age: number; view: AgentView }[] = [];
  const scan = (dir: string): void => {
    for (const fn of readdirSync(dir)) {
      const p = join(dir, fn);
      if (statSync(p).isDirectory()) scan(p);
      else if (fn === 'meta.json') {
        const d = readJson(p);
        if (!d) continue;
        const st = String(d.status ?? '').toLowerCase();
        const upd = Number(d.updated_at ?? d.updatedAt ?? 0);
        const age = upd ? (now - upd * (upd < 1e12 ? 1000 : 1)) / 1000 : ageSeconds(p);
        const title = String(d.title ?? '').slice(0, 16) || 'codex';
        if (st === 'failed') cands.push({ age: 0, view: { source: 'codex', name: title, state: 4, progress: 255, text: title.slice(0, 32) } });
        else if (st === 'active' && age < 120) cands.push({ age, view: { source: 'codex', name: title, state: 1, progress: 255, text: title.slice(0, 32) } });
        else if (st === 'completed' && age < 600) cands.push({ age, view: { source: 'codex', name: title, state: 3, progress: 255, text: title.slice(0, 32) } });
      }
    }
  };
  scan(base);
  cands.sort((a, b) => a.age - b.age);
  return cands.slice(0, MAX_PER_SOURCE).map((c) => c.view);
}

/** kimi-code:session_index.jsonl + sessionDir mtime。 */
export function pollKimi(homeDir = homedir()): AgentView[] {
  const idx = join(homeDir, '.kimi-code', 'session_index.jsonl');
  if (!existsSync(idx)) return [];
  const out: AgentView[] = [];
  for (const line of readFileSync(idx, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch { continue; }
    const sdir = String(e.sessionDir ?? '');
    if (!sdir || ageSeconds(sdir) > RECENT) continue;
    const wd = baseLabel(String(e.workDir ?? ''), 'kimi', 14);
    out.push({ source: 'kimi', name: wd, state: 1, progress: 255, text: 'session live' });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}

/** zcode:rollout mtime(桌面端在跑不是信号)。 */
export function pollZcode(homeDir = homedir()): AgentView[] {
  const dir = join(homeDir, '.zcode', 'cli', 'rollout');
  if (!existsSync(dir)) return [];
  const out: AgentView[] = [];
  for (const fn of readdirSync(dir)) {
    if (!fn.endsWith('.jsonl')) continue;
    if (ageSeconds(join(dir, fn)) < RECENT) {
      out.push({ source: 'zcode', name: 'zcode', state: 1, progress: 255, text: 'turn live' });
      if (out.length >= MAX_PER_SOURCE) break;
    }
  }
  return out;
}

/** amp:精确二进制名进程扫描(只有 running 可见)。 */
export async function pollAmp(): Promise<AgentView[]> {
  return (await procRunning('amp(\\.exe)?'))
    ? [{ source: 'amp', name: 'amp', state: 1, progress: 255, text: 'process alive' }] : [];
}

/** droid:hooks 状态文件(精确)→ factory jsonl 尾行关键词 → 进程。 */
export async function pollDroid(homeDir = homedir()): Promise<AgentView[]> {
  const out: AgentView[] = [];
  const now = Date.now();
  const stateDir = join(homeDir, '.config', 'deskpet-sender');
  if (existsSync(stateDir)) {
    for (const fn of readdirSync(stateDir)) {
      if (!fn.startsWith('droid-') || !fn.endsWith('.json')) continue;
      const st = readJson(join(stateDir, fn));
      if (!st) continue;
      if (now / 1000 - Number(st.time ?? 0) > HOOK_STALE) continue;
      const m = ({ working: 1, needs: 2, review: 3, failed: 4, done: 5 } as Record<string, number>)[String(st.state ?? '')] ?? 0;
      if (m) out.push({ source: 'droid', name: String(st.cwd ?? 'droid').slice(-12), state: m, progress: 255, text: String(st.text ?? '').slice(0, 32) });
    }
  }
  if (out.length) return out;
  const base = join(homeDir, '.factory', 'sessions');
  const cands: { age: number; p: string; st: number }[] = [];
  if (existsSync(base)) {
    const walk = (dir: string): void => {
      for (const fn of readdirSync(dir)) {
        const p = join(dir, fn);
        if (statSync(p).isDirectory()) walk(p);
        else if (fn.endsWith('.jsonl')) {
          const age = ageSeconds(p);
          if (age >= RECENT) continue;
          let tail = '';
          try {
            tail = readFileSync(p, 'utf8').split('\n').slice(-3).join(' ').slice(-500).toLowerCase();
          } catch { continue; }
          const st = /error|failed|exception/.test(tail) ? 4
            : /approve|approval|confirm|permission/.test(tail) ? 2 : 1;
          cands.push({ age, p, st });
        }
      }
    };
    walk(base);
    cands.sort((a, b) => a.age - b.age);
    for (const c of cands.slice(0, MAX_PER_SOURCE)) {
      out.push({ source: 'droid', name: baseLabel(dirname(c.p), 'droid'), state: c.st, progress: 255, text: 'transcript live' });
    }
  }
  if (out.length) return out;
  return (await procRunning('droid(\\.exe)?'))
    ? [{ source: 'droid', name: 'droid', state: 1, progress: 255, text: 'process alive' }] : [];
}

/** grok:`grok sessions list` 表 + UPDATED 日期新鲜度。 */
export async function pollGrok(): Promise<AgentView[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('grok', ['sessions', 'list'], { timeout: 10000 }));
  } catch {
    return [];
  }
  const out: AgentView[] = [];
  const now = Date.now();
  for (const line of stdout.split('\n').slice(2, 6)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [sid, , updated, statusRaw] = parts;
    const status = statusRaw.toLowerCase();
    const summary = parts.slice(4).join(' ').slice(0, 16);
    const parsed = Date.parse(`${updated}T00:00:00`);
    const age = Number.isNaN(parsed) ? 1e9 : (now - parsed) / 1000;
    const view: AgentView = { source: 'grok', name: (summary || sid.slice(0, 8)).slice(0, 16), state: 1, progress: 255, text: summary.slice(0, 32) };
    if (['failed', 'error'].includes(status)) view.state = 4;
    else if (['active', 'running', 'working'].includes(status)) view.state = 1;
    else if (['completed', 'done'].includes(status) && age < 600) view.state = 3;
    else if (age < RECENT) view.state = 1;
    else continue;
    out.push(view);
  }
  return out;
}

/** agy v1.1.26:无本地会话存储,活 turn 只能靠进程 etime。 */
export async function pollAgy(): Promise<AgentView[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,etime=,command='], { timeout: 5000 }));
  } catch {
    return [];
  }
  const out: AgentView[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/, 3);
    if (parts.length < 3) continue;
    const [, etime, cmd] = parts;
    const argv0 = cmd.split(' ')[0] ?? '';
    if (basename(argv0) !== 'agy') continue;
    if (cmd.includes('remote-control') || cmd.includes('--help') || cmd.includes('update')) continue;
    const m = /^(?:(\d+)-)?(\d+):(\d+):(\d+)$/.exec(etime.trim());
    const age = m
      ? (m[1] && m[1] !== '00' ? `${m[1]}d` : m[2] !== '00' ? `${m[2]}h` : `${m[3]}m`)
      : 'live';
    out.push({ source: 'agy', name: 'agy', state: 1, progress: 255, text: `turn live ${age}` });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4 槽归并:优先级选择 + (source,name) 跨轮询稳定占位 + 消失即释放。
// needs-you 必须能挤掉低优先级会话,而不是静默消失。占位状态存进程内
// (daemon 常驻,与 Python 版 SlotTable 语义一致);重启清空无副作用。
// ---------------------------------------------------------------------------

const PRIORITY: Record<number, number> = { 2: 0, 4: 1, 1: 2, 3: 3, 5: 4 };

const slotTable = {
  owner: new Map<string, number>(), // "source|name" -> slot
  view: new Map<number, AgentView>(), // slot -> view
};

const keyOf = (v: AgentView): string => `${v.source}|${v.name}`;

/** 归并进 4 槽,返回按槽位索引的数组(null = 空槽)。 */
export function updateSlots(views: AgentView[], maxSlots = 4): (AgentView | null)[] {
  const selected = [...views]
    .sort((a, b) => (PRIORITY[a.state] ?? 9) - (PRIORITY[b.state] ?? 9))
    .slice(0, maxSlots);
  const seen = new Set(selected.map(keyOf));
  for (const [key, slot] of [...slotTable.owner]) {
    if (!seen.has(key)) {
      slotTable.owner.delete(key);
      slotTable.view.delete(slot);
    }
  }
  for (const v of selected) {
    const key = keyOf(v);
    if (!slotTable.owner.has(key)) {
      const free = Array.from({ length: maxSlots }, (_, i) => i)
        .find((i) => !slotTable.view.has(i));
      if (free === undefined) continue;
      slotTable.owner.set(key, free);
    }
    slotTable.view.set(slotTable.owner.get(key)!, v);
  }
  return Array.from({ length: maxSlots }, (_, i) => slotTable.view.get(i) ?? null);
}

/** 测试钩子:清空槽位占位与 TTL 缓存。 */
export function resetAgentStatusCache(): void {
  slotTable.owner.clear();
  slotTable.view.clear();
  cache = null;
}

let cache: { atMs: number; snap: AgentStatusSnapshot } | null = null;

function toSnapshot(views: AgentView[]): AgentStatusSnapshot {
  const slots = updateSlots(views).map((v, i) => v
    ? { slot: i, occupied: true, stateName: STATE_NAMES[v.state] ?? 'idle', ...v }
    : { slot: i, occupied: false, source: '', name: '', state: 0, stateName: 'idle', progress: 0, text: '' });
  return { generatedAt: Date.now(), slots };
}

/** 扫全部源 + 归并。TTL 内直接回缓存;force=true 跳过。永不抛错。 */
export async function getAgentStatus(options: AgentStatusOptions = {}): Promise<AgentStatusSnapshot> {
  if (!options.force && cache && Date.now() - cache.atMs < CACHE_TTL_MS) return cache.snap;
  const homeDir = options.home ?? homedir();
  const disabled = new Set((options.disabled ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const dshUrl = options.dshUrl ?? process.env.PLANOFPLAN_DSH_URL ?? 'http://127.0.0.1:3080';
  const opencodeUrl = options.opencodeUrl ?? process.env.PLANOFPLAN_OPENCODE_URL ?? 'http://127.0.0.1:4096';
  const jobs: Promise<AgentView[]>[] = [];
  const run = (name: string, fn: () => Promise<AgentView[]> | AgentView[]): Promise<AgentView[]> =>
    disabled.has(name) ? Promise.resolve([]) : Promise.resolve().then(fn).catch(() => []);
  jobs.push(run('dsh', () => pollDsh(dshUrl)));
  jobs.push(run('opencode', () => pollOpencode(opencodeUrl)));
  jobs.push(run('claude', () => pollClaude(homeDir)));
  jobs.push(run('codex', () => pollCodex(homeDir)));
  jobs.push(run('kimi', () => pollKimi(homeDir)));
  jobs.push(run('zcode', () => pollZcode(homeDir)));
  jobs.push(run('amp', () => pollAmp()));
  jobs.push(run('droid', () => pollDroid(homeDir)));
  jobs.push(run('grok', () => pollGrok()));
  jobs.push(run('agy', () => pollAgy()));
  const views = (await Promise.all(jobs)).flat();
  const snap = toSnapshot(views);
  cache = { atMs: Date.now(), snap };
  return snap;
}
