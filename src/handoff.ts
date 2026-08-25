/**
 * Handoff(ia-redesign §1.7 / §2.5,计划研究 §5):交接 = 指针 + 摘要,
 * 不是 transcript 搬运。包内容全部来自已物化的实体与跨实体关联:
 *   需求(为什么)→ 计划快照(打算怎么做 + 演进)→ Todo/尾总结(自报到哪)
 *   → commit(产出了什么)→ 相关会话/子代理(谁在推进)→ deep link。
 *
 * 交付三通道:剪贴板(前端)/ 导出 .md / 在目标目录起新 agent 会话把包
 * 作为首条消息(`cli "$(cat <pkg>)"` 注入,bin 解析与 resume 同一套)。
 * 每次交付落 handoffs 表一行——交接链本身可观测。
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Store } from './db.ts';
import { findExecutable } from './resume.ts';
import type { PlanFileRecord, SessionCommit, SessionRecord } from './types.ts';

export type HandoffSourceType = 'session' | 'requirement' | 'planfile';

export interface HandoffPackage {
  title: string;
  markdown: string;
  /** agent 模式默认目录(源会话 cwd / 计划文件所在目录)。 */
  defaultDir: string | null;
  sourceType: HandoffSourceType;
  sourceId: string;
}

/** 注入式首条消息:各 CLI 都接受位置参数 prompt;bin 与 resume 同源。 */
const HANDOFF_BINS: Record<string, string[]> = {
  claude: ['claude.sh', 'claude'],
  codex: ['codex'],
  grok: ['grok'],
  factory: ['droid'],
  kimi: ['kimi', 'kimi-cli'],
};

export function handoffProviders(): string[] {
  return Object.keys(HANDOFF_BINS);
}

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return '--';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function todoBlock(store: Store, sessionId: string): string {
  const todos = store.todoSnapshotsForSession(sessionId);
  if (todos.length === 0) return '';
  const latest = todos[todos.length - 1]!;
  const lines = (latest.items || []).slice(0, 12).map((item) => {
    const icon = item.status === 'completed' || item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
    return `- ${icon} ${item.title}`;
  });
  return `\n### Todo(最新快照,共 ${todos.length} 帧)\n${lines.join('\n')}\n`;
}

function noteBlock(store: Store, sessionId: string): string {
  const notes = store.progressNotesForSession(sessionId);
  if (notes.length === 0) return '';
  const latest = notes[notes.length - 1]!;
  return `\n### 干完总结(assistant 自报,inferred)\n\n${latest.text.slice(0, 800)}\n`;
}

function commitBlock(commits: SessionCommit[]): string {
  if (commits.length === 0) return '';
  const lines = commits.slice(0, 12).map((commit) => (
    `- \`${commit.sha.slice(0, 8)}\` ${commit.summary || '(no subject)'}${commit.pushed === false ? '(未推送)' : ''}`
  ));
  return `\n## 产出 commit\n${lines.join('\n')}\n`;
}

function planBlock(plans: PlanFileRecord[], store: Store): string {
  if (plans.length === 0) return '';
  const lines = plans.slice(0, 4).map((plan) => {
    const latest = store.planSnapshots(plan.id, 1)[0];
    const phase = latest?.currentPhase || plan.currentPhase || '--';
    const boxes = latest ? ` · ☑ ${latest.checkboxChecked}/${latest.checkboxTotal}` : '';
    const sections = (latest?.sections ?? []).slice(0, 6).map((section) => (
      `  - ${section.heading.slice(0, 50)}${section.status ? `(${section.status})` : ''}${section.total ? ` [${section.checked}/${section.total}]` : ''}`
    ));
    return `- **${plan.title || plan.path.split('/').pop()}** · 当前:${phase}${boxes}\n  (${plan.path})${sections.length ? `\n${sections.join('\n')}` : ''}`;
  });
  return `\n## 计划状态(最新快照)\n${lines.join('\n')}\n`;
}

function fileBlock(store: Store, sessionId: string, fromSeq = 0, toSeq: number | null = null): string {
  const touches = store.spanTouches(sessionId, fromSeq, toSeq);
  if (touches.length === 0) return '';
  const count = new Map<string, number>();
  for (const touch of touches) count.set(touch.filePath, (count.get(touch.filePath) ?? 0) + 1);
  const lines = [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, n]) => `- ${path} ×${n}`);
  return `\n## 涉及文件(按触碰次数,top 15)\n${lines.join('\n')}\n`;
}

function subagentBlock(store: Store, sessionId: string): string {
  const { spawned } = store.linksForSession(sessionId);
  if (spawned.length === 0) return '';
  return `\n(该会话还拉起过 ${spawned.length} 个子代理,详情见 deep link)\n`;
}

function requirementText(store: Store, sessionId: string): string | null {
  const req = store.firstRequirementBySession().get(sessionId);
  return req?.text ?? null;
}

function assemble(args: {
  title: string;
  deepLink: string;
  goal: string;
  planSection: string;
  progressSection: string;
  commitSection: string;
  fileSection: string;
  sessionLine: string;
  subagentNote: string;
  defaultDir: string | null;
  sourceType: HandoffSourceType;
  sourceId: string;
}): HandoffPackage {
  const markdown = `# Handoff:${args.title.slice(0, 80)}

> 由 planofplan 生成 · ${fmtTs(Date.now())}
> 源:${args.sourceType} \`${args.sourceId}\` · 完整上下文:${args.deepLink}

## 目标

${args.goal}
${args.planSection}${args.progressSection}${args.commitSection}${args.fileSection}
## 相关会话

${args.sessionLine}${args.subagentNote}
---

接手建议:先读上面的目标与计划状态,${args.defaultDir ? `工作目录在 \`${args.defaultDir}\`,` : ''}需要更多上下文时打开 ${args.deepLink}(需求原文、span 文件、快照时间线都在详情页)。
`;
  return {
    title: args.title,
    markdown,
    defaultDir: args.defaultDir,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
  };
}

/** 从 session / requirement / planfile 任一节点生成交接包。 */
export function buildHandoffPackage(
  store: Store,
  type: HandoffSourceType,
  id: string,
  deepLink: string,
): HandoffPackage | null {
  if (type === 'session') {
    const session = store.getSession(id);
    if (!session) return null;
    return sessionPackage(store, session, deepLink);
  }
  if (type === 'requirement') {
    const req = store.requirementById(id);
    if (!req) return null;
    const session = store.getSession(req.sessionId);
    if (!session) return null;
    const next = store.listRequirements()
      .filter((row) => row.sessionId === req.sessionId && row.seq > req.seq)
      .sort((a, b) => a.seq - b.seq)[0] ?? null;
    const commits = store.listSessionCommits(req.sessionId)
      .filter((commit) => commit.ts != null && commit.ts >= (req.ts ?? 0) && (!next?.ts || commit.ts < next.ts));
    return assemble({
      title: req.text,
      deepLink,
      goal: req.text,
      planSection: planBlock(store.planFilesForRequirement(req.sessionId, req.seq, next ? next.seq : null), store),
      progressSection: `${todoBlock(store, req.sessionId)}${noteBlock(store, req.sessionId)}`,
      commitSection: commitBlock(commits),
      fileSection: fileBlock(store, req.sessionId, req.seq, next ? next.seq : null),
      sessionLine: `- ${session.provider} · ${session.title || session.id}(${fmtTs(session.updatedAt)})`,
      subagentNote: subagentBlock(store, req.sessionId),
      defaultDir: session.cwd,
      sourceType: type,
      sourceId: id,
    });
  }
  if (type === 'planfile') {
    const plan = store.listPlanFiles().find((row) => row.id === id);
    if (!plan) return null;
    const sessions = store.sessionsTouchingPath(plan.path);
    const latestSession = sessions[0] ? store.getSession(sessions[0].id) : null;
    const goal = plan.goal || plan.title || plan.path;
    return assemble({
      title: goal,
      deepLink,
      goal: `${goal}\n\n(计划文件:\`${plan.path}\`)`,
      planSection: planBlock([plan], store),
      progressSection: latestSession ? `${todoBlock(store, latestSession.id)}${noteBlock(store, latestSession.id)}` : '',
      commitSection: commitBlock(store.commitsForPath(plan.path)),
      fileSection: latestSession ? fileBlock(store, latestSession.id) : '',
      sessionLine: sessions.length > 0
        ? sessions.slice(0, 5).map((s) => `- ${s.provider} · ${s.title || s.id}(${fmtTs(s.updatedAt)})`).join('\n')
        : '(窗口内没有 session 触碰过该文件)',
      subagentNote: latestSession ? subagentBlock(store, latestSession.id) : '',
      defaultDir: plan.path.slice(0, plan.path.lastIndexOf('/')) || null,
      sourceType: type,
      sourceId: id,
    });
  }
  return null;
}

function sessionPackage(store: Store, session: SessionRecord, deepLink: string): HandoffPackage {
  return assemble({
    title: requirementText(store, session.id) || session.title || session.id,
    deepLink,
    goal: requirementText(store, session.id) || session.title || '(未抽出需求,见 deep link)',
    planSection: planBlock(store.planFilesForSession(session.id), store),
    progressSection: `${todoBlock(store, session.id)}${noteBlock(store, session.id)}`,
    commitSection: commitBlock(store.listSessionCommits(session.id)),
    fileSection: fileBlock(store, session.id),
    sessionLine: `- ${session.provider} · ${session.title || session.id}(${fmtTs(session.updatedAt)}) · cwd ${session.cwd || '--'}`,
    subagentNote: subagentBlock(store, session.id),
    defaultDir: session.cwd,
    sourceType: 'session',
    sourceId: session.id,
  });
}

// ── 交付 ────────────────────────────────────────────────────────

function handoffDir(): string {
  return join(homedir(), '.planofplan', 'handoffs');
}

function slugOf(pkg: HandoffPackage): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const tail = pkg.sourceId.replace(/[^0-9A-Za-z_-]/g, '').slice(-10);
  return `${pkg.sourceType}-${tail}-${stamp}`;
}

/** 落包文件(所有服务端交付通道的第一步)。 */
export function writePackageFile(pkg: HandoffPackage): string {
  const dir = handoffDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slugOf(pkg)}.md`);
  writeFileSync(path, pkg.markdown, 'utf8');
  return path;
}

export interface HandoffLauncher {
  (provider: string, bin: string, targetDir: string, pkgPath: string): { ok: boolean; command?: string; error?: string };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 默认 launcher:在 Terminal 里 cd 到目标目录,把包作为首条消息注入。 */
export const terminalLauncher: HandoffLauncher = (provider, bin, targetDir, pkgPath) => {
  const names = HANDOFF_BINS[provider];
  if (!names) return { ok: false, error: `${provider} 不支持注入启动` };
  const cmd = `${shellQuote(bin)} "$(cat ${shellQuote(pkgPath)})"`;
  const script = `tell application "Terminal" to do script "cd ${targetDir.replaceAll('"', '\\"')} && ${cmd.replaceAll('"', '\\"')}"`;
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() || '无法打开 Terminal', command: `cd ${targetDir} && ${cmd}` };
  }
  return { ok: true, command: `cd ${targetDir} && ${cmd}` };
};

/**
 * 交付并记录。mode:'file' 导出 .md 到目标目录(默认 ~/Downloads);
 * 'agent' 落包后注入启动新会话。每次交付写 handoffs 一行。
 */
export function deliverHandoff(
  store: Store,
  pkg: HandoffPackage,
  options: { mode: 'file' | 'agent'; provider?: string; targetDir?: string; launcher?: HandoffLauncher },
): { ok: boolean; path?: string; command?: string; error?: string } {
  const pkgPath = writePackageFile(pkg);
  const targetDir = options.targetDir?.trim() || (options.mode === 'agent' ? pkg.defaultDir : '') || join(homedir(), 'Downloads');
  let result: { ok: boolean; path?: string; command?: string; error?: string };
  if (options.mode === 'agent') {
    const provider = options.provider || 'claude';
    const names = HANDOFF_BINS[provider];
    const bin = names ? findExecutable(names) : null;
    if (!bin) {
      result = { ok: false, path: pkgPath, error: `未找到 ${provider} CLI,包已导出:${pkgPath}` };
    } else {
      const launched = (options.launcher ?? terminalLauncher)(provider, bin, targetDir, pkgPath);
      result = { ...launched, path: pkgPath };
    }
  } else {
    try {
      const exportPath = join(targetDir, `${slugOf(pkg)}.md`);
      copyFileSync(pkgPath, exportPath);
      result = { ok: true, path: exportPath };
    } catch (error) {
      result = { ok: false, path: pkgPath, error: `导出失败:${(error as Error).message}` };
    }
  }
  store.insertHandoff({
    sourceType: pkg.sourceType,
    sourceId: pkg.sourceId,
    mode: options.mode,
    provider: options.provider ?? null,
    targetDir,
    packagePath: result.path ?? pkgPath,
    ok: result.ok,
  });
  return result;
}
