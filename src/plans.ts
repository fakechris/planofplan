/**
 * 计划态实体(PlanFile + 快照序列 + TodoWrite 消息快照)。
 * 设计依据 docs/agent-plan-and-progress-research.md §5 与 thin-observer
 * 先例教训(§4.5):
 *   - 观察者侧:零 agent 协作,只读磁盘上已经落下的 markdown
 *   - 身份锚文件(路径 hash),不做任务级身份/谱系推断(thin-observer
 *     实测跨快照匹配失败 ~99.9%,该路线已被证伪)
 *   - 演进 = append-only 快照序列;「当前态」= 最新快照,永不由我们推
 *   - 快照带 commit_sha(git 锚),文件消失用 missing_since 保留历史
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Store } from './db.ts';
import type { PlanSection } from './types.ts';

const DIRECT_NAMES = new Set([
  'task_plan.md', 'progress.md', 'findings.md', 'plan.md', 'PLAN.md',
  'plan.zh.md', 'todo.md', 'TODO.md', 'backlog.md', 'BACKLOG.md',
]);
// 计划类命名的泛匹配:IMPLEMENTATION_PLAN.md / *-plan.md / roadmap /
// milestone / todo / handoff——真实项目约定远不止 task_plan 一种
// (实测:planofplan 和 lumen 全家族用 IMPLEMENTATION_PLAN.md,140 个
// 文件被旧规则漏掉)
const PLAN_NAME_RE = /(?:plan|roadmap|milestone|backlog|todo|handoff)/i;
// 明确不是计划的 md(README/变更日志/技能与指令文件/._ 垃圾)
const NOT_PLAN_RE = /^(?:\._|README|CHANGELOG|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|LICENSE|NOTICE|SKILL|AGENTS|CLAUDE|PROMPT|DESCRIPTION)/i;
/** 计划文档目录(plans/specs 下的 md 全收,无论文件名)。 */
const PLAN_DIR_RE = /(?:^|\/)(?:plans|specs)(?:$|\/)/;
const HANDOFF_RE = /^HANDOFF(?:[-_].*)?\.md$/i; // HANDOFF.md(无分隔符)也要认
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', 'venv']);
// 记忆/配置类:名字可能带 plan/roadmap 但不是计划文档
const NOT_PLAN_EXTRA = /^(?:MEMORY|feedback_)/i;

/** Spotlight 兜底通道:常见固定名的机器级搜索(未索引/无权限时为空)。 */
async function spotlightPlanFiles(): Promise<string[]> {
  const out: string[] = [];
  try {
    const proc = Bun.spawn(['mdfind',
      'kMDItemFSName == "task_plan.md"c || kMDItemFSName == "IMPLEMENTATION_PLAN.md"c || kMDItemFSName == "PLAN.md"c || kMDItemFSName == "plan.md"c || kMDItemFSName == "roadmap.md"c || kMDItemFSName == "progress.md"c',
    ], { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const res = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    for (const line of res.split('\n')) {
      if (line.endsWith('.md') && !line.includes('/node_modules/')) out.push(line);
    }
  } catch {
    /* best-effort */
  }
  return out;
}
const TEXT_CAP = 2000;

/** 发现根:session cwd ∪ project root(有界:百级)。 */
export function planRootsOf(cwds: Array<string | null>, projectRoots: Array<string | null>): string[] {
  const roots = new Set<string>();
  for (const cwd of cwds) if (cwd) roots.add(cwd);
  for (const root of projectRoots) if (root) roots.add(root);
  return [...roots];
}

export function planKindOf(path: string): string {
  const name = basename(path);
  if (PLAN_DIR_RE.test(dirname(path))) return 'detailed_plan';
  if (HANDOFF_RE.test(name) || /handoff/i.test(name)) return 'handoff';
  switch (name) {
    case 'task_plan.md': return 'task_plan';
    case 'progress.md': return 'progress';
    case 'findings.md': return 'findings';
    case 'plan.md':
    case 'PLAN.md':
    case 'plan.zh.md': return 'plan';
    case 'todo.md':
    case 'TODO.md': return 'todo';
    case 'backlog.md':
    case 'BACKLOG.md': return 'backlog';
  }
  if (/roadmap/i.test(name)) return 'roadmap';
  if (/milestone/i.test(name)) return 'milestone';
  return 'plan'; // 泛匹配的 *-plan.md / IMPLEMENTATION_PLAN.md 等
}

export function planFileId(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12);
}

/**
 * 一个根目录下的候选 plan 文件(深度 ≤2):固定名 + 计划类命名泛匹配 +
 * plans/specs 目录全收 + HANDOFF。跳过隐藏目录/依赖产物/明确非计划文件。
 */
export function discoverPlanFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录跳过
    }
    for (const entry of entries) {
      if (entry.name.startsWith('._')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.md') || NOT_PLAN_RE.test(entry.name)) continue;
      if (DIRECT_NAMES.has(entry.name) || HANDOFF_RE.test(entry.name) || PLAN_NAME_RE.test(entry.name)
        || PLAN_DIR_RE.test(dir)) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

/**
 * plan markdown 弱解析(thin-observer 的 best-effort 原则):
 * 标题/Goal/Current Phase + 各 `###` 节的 checkbox 统计与 `**Status:**` 行。
 * task_plan.md(skill 模板)字段最全;progress.md 的 Session 节同构复用。
 */
export function parsePlanMarkdown(text: string): {
  title: string | null;
  goal: string | null;
  currentPhase: string | null;
  sections: PlanSection[];
  checkboxChecked: number;
  checkboxTotal: number;
} {
  const lines = text.split(/\r?\n/);
  let title: string | null = null;
  let goal: string | null = null;
  let currentPhase: string | null = null;
  const sections: PlanSection[] = [];
  let checked = 0;
  let total = 0;
  let section: PlanSection | null = null;
  let inGoal = false;
  let goalLines: string[] = [];
  let inCurrentPhase = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^#\s+/.test(line)) {
      if (title === null) title = line.replace(/^#\s+/, '').replace(/^Task Plan:\s*/i, '').trim() || null;
      inGoal = false;
      inCurrentPhase = false;
      continue;
    }
    if (/^##\s+/.test(line)) {
      const heading = line.replace(/^##\s+/, '').trim();
      inGoal = /^goal\b/i.test(heading);
      inCurrentPhase = /^current phase\b/i.test(heading);
      if (inGoal) goalLines = [];
      continue;
    }
    if (/^###?\s+/.test(line)) {
      section = { heading: line.replace(/^###?\s+/, '').trim(), status: null, checked: 0, total: 0 };
      sections.push(section);
      inGoal = false;
      inCurrentPhase = false;
      continue;
    }
    if (inCurrentPhase && currentPhase === null && line.trim()) {
      currentPhase = line.trim().slice(0, 120);
      inCurrentPhase = false;
      continue;
    }
    if (inGoal) {
      goalLines.push(line);
      continue;
    }
    const checkbox = /^[-*]\s+\[( |x|X)\]/.exec(line.trim());
    if (checkbox) {
      total += 1;
      if (checkbox[1] && checkbox[1] !== ' ') checked += 1;
      if (section) {
        section.total += 1;
        if (checkbox[1] && checkbox[1] !== ' ') section.checked += 1;
      }
      continue;
    }
    const status = /^(?:[-*]\s+)?\*\*Status:\*\*\s*(.+?)\s*$/i.exec(line.trim());
    if (status && section && !section.status) section.status = status[1]!.slice(0, 40);
  }
  if (goalLines.length > 0) {
    goal = goalLines.join('\n').trim().slice(0, TEXT_CAP) || null;
  }
  return { title, goal, currentPhase, sections, checkboxChecked: checked, checkboxTotal: total };
}

/** TodoWrite(claude,items[].content)与 todo_write/TodoList(zcode,items[].title)
 * 两种消息形态统一解析;非 JSON 或无 todos 数组返回 null。 */
export function parseTodoToolText(text: string): Array<{ title: string; status: string }> | null {
  try {
    const doc = JSON.parse(text) as { todos?: unknown };
    if (!Array.isArray(doc.todos)) return null;
    const items: Array<{ title: string; status: string }> = [];
    for (const raw of doc.todos) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as { content?: unknown; title?: unknown; status?: unknown };
      const title = typeof item.title === 'string' ? item.title : typeof item.content === 'string' ? item.content : '';
      if (!title.trim()) continue;
      items.push({ title: title.trim().slice(0, 300), status: typeof item.status === 'string' ? item.status : 'unknown' });
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

/** 消息层快照物化(全量重导,确定性 id,幂等)。 */
export function materializeTodoSnapshots(store: Store): number {
  const rows = [];
  for (const row of store.todoToolRows()) {
    const items = parseTodoToolText(row.text);
    if (!items) continue;
    rows.push({
      id: `${row.sessionId}:${row.seq}`,
      sessionId: row.sessionId,
      seq: row.seq,
      ts: row.ts,
      items,
    });
  }
  store.replaceAllTodoSnapshots(rows);
  return rows.length;
}

/**
 * ④ 尾总结抽取(§5.3):assistant 干完活的自报(「已完成 X;当前 Y」/
 * 「本轮 …」句式),message_inferred 档。规则保守起步——前缀强信号 +
 * ≥40 字,先喂 session 详情,噪声多了再迭代(需求分类同款路径)。
 * 真实库量级:已完成 144 / 本轮 70 / 下一步 35 / 这一步 20,样本抽查
 * 基本都是真总结,且常带 commit sha(后续对账素材)。
 */
const SUMMARY_PREFIX_RE = /^(?:已完成|这一步|这一轮|本轮|下一步|总结[:：]|Summary:)/;
const SUMMARY_TEXT_MAX = 2000;

export function isSummaryMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 40 && SUMMARY_PREFIX_RE.test(trimmed);
}

export function materializeProgressNotes(store: Store): number {
  const rows = [];
  for (const row of store.assistantSummaryRows()) {
    if (!isSummaryMessage(row.text)) continue;
    rows.push({
      id: `${row.sessionId}:${row.seq}`,
      sessionId: row.sessionId,
      seq: row.seq,
      ts: row.ts,
      text: row.text.trim().slice(0, SUMMARY_TEXT_MAX),
    });
  }
  store.replaceAllProgressNotes(rows);
  return rows.length;
}

/** repo 归属(remote url,无 remote 退 root,非 git null)。同 root 同轮共享缓存。 */
function repoOfFactory(): (dir: string) => string | null {
  const cache = new Map<string, string | null>();
  return (dir: string): string | null => {
    if (cache.has(dir)) return cache.get(dir) ?? null;
    let repo: string | null = null;
    try {
      const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 4000 }).trim();
      let url: string | null = null;
      try {
        url = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 4000 }).trim() || null;
      } catch {
        /* 无 remote */
      }
      repo = url ?? root;
    } catch {
      repo = null;
    }
    cache.set(dir, repo);
    return repo;
  };
}

function headOfFactory(): (dir: string) => string | null {
  const cache = new Map<string, string | null>();
  return (dir: string): string | null => {
    if (cache.has(dir)) return cache.get(dir) ?? null;
    let sha: string | null = null;
    try {
      sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 4000 }).trim() || null;
    } catch {
      sha = null;
    }
    cache.set(dir, sha);
    return sha;
  };
}

/**
 * 扫盘物化(mtime 门控):内容变化才捕获新快照(确定性 id 幂等);
 * 文件消失置 missing_since,重现则清掉。git 调用每轮按 root 缓存。
 *
 * 发现三通道(根因修复:计划文件会写在任何地方,cwd 目录树猜不全)——
 *  A. file_touches 遥测:agent 实际写过的计划类路径(App Support 研究
 *     目录、~/.claude/plans 随机名 plan-mode 文件、memory 里的 roadmap
 *     都只能从这抓到);项目归属用「写它的会话」的 work repo
 *  B. cwd/project-root 目录树递归(新文件尚未进遥测时的兜底)
 *  C. Spotlight mdfind(人手写的、无会话遥测的机器级兜底)
 */
export async function materializePlanFiles(store: Store, options: { now?: number; spotlight?: boolean } = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const roots = planRootsOf(store.sessionCwds(), store.projectRoots());
  const rootSet = new Set(roots);
  const repoOf = repoOfFactory();
  const headOf = headOfFactory();
  const existing = new Map(store.listPlanFiles().map((row) => [row.path, row]));
  const seen = new Set<string>();
  let captured = 0;

  // 通道 A:touches(带会话的项目归属)
  const touchedRepo = new Map<string, string>();
  for (const row of store.touchedPlanFilePaths()) {
    if (NOT_PLAN_EXTRA.test(basename(row.path))) continue;
    touchedRepo.set(row.path, row.repoUrl ?? '');
  }
  // 通道 B:目录树
  const walked = new Set<string>();
  for (const root of roots) {
    for (const path of discoverPlanFiles(root)) walked.add(path);
  }
  // 通道 C:Spotlight
  const spotlit = new Set(options.spotlight === false ? [] : await spotlightPlanFiles());

  const candidates = new Set<string>([...touchedRepo.keys(), ...walked, ...spotlit]);
  for (const path of candidates) {
    seen.add(path);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // 竞态:刚消失
    }
    const prior = existing.get(path);
    // repo 为 NULL 的存量行(非 git 目录修复前入库)要重推导归属,
    // 不能被 mtime 门控拦住——否则永远挤在「(非 git 目录)」一组里
    if (prior && prior.missingSince == null && prior.lastSnapshotId
      && prior.repo != null
      && prior.lastSnapshotMtimeMs != null
      && Math.abs(prior.lastSnapshotMtimeMs - stat.mtimeMs) < 1) {
      store.touchPlanFile(prior.id, now); // 内容未变,只续命
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const rawHash = createHash('sha1').update(text).digest('hex');
    const parsed = parsePlanMarkdown(text);
    const id = planFileId(path);
    const dir = dirname(path);
    // 项目归属优先级:写它的会话的 work repo(通道 A 独有,把 ~/.claude/
    // plans 的随机名文件落到正确项目)→ git remote → git root →
    // 最近已知项目根 → 文件所在目录(目录即项目)
    const nearestRoot = [...rootSet]
      .filter((root) => path.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length)[0];
    const touched = touchedRepo.get(path);
    const repo = (touched && touched.length > 0 ? touched : null)
      ?? repoOf(dir)
      ?? nearestRoot
      ?? dir;
    const row = {
      id,
      path,
      kind: planKindOf(path),
      title: parsed.title,
      goal: parsed.goal,
      currentPhase: parsed.currentPhase,
      repo,
      mtimeMs: stat.mtimeMs,
      rawHash,
      sections: parsed.sections,
      checkboxChecked: parsed.checkboxChecked,
      checkboxTotal: parsed.checkboxTotal,
      commitSha: headOf(dir),
      now,
    };
    store.upsertPlanFileWithSnapshot(row);
    captured += 1;
  }
  // 消失的文件:置 missing_since(行保留,历史快照可查)
  for (const row of existing.values()) {
    if (seen.has(row.path) || row.missingSince != null) continue;
    if (!existsSync(row.path)) store.markPlanFileMissing(row.id, now);
  }
  return captured;
}
