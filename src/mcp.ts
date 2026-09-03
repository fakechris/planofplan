import type { Hono } from 'hono';
import type { Store } from './db.ts';
import type { AppConfig } from './config.ts';
import { buildOverview } from './core.ts';
import { buildUsageReport } from './usage.ts';
import { searchSessions } from './sessions.ts';
import { getBuildInfo } from './build-info.ts';
import { buildLineageReport } from './lineage-report.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionCommit, SessionRecord, UsageRecord } from './types.ts';
import { searchSkills, syncSkillsCatalog } from './skills.ts';

// ── 只读 MCP server(streamable HTTP 子集) ───────────────────────────
// 手写 JSON-RPC 2.0 的最小协议面而不引 SDK 依赖:initialize / ping /
// tools/list / tools/call;通知回 202,单 JSON 响应(不用 SSE 流),无会话状态。
// 定位是三家里没人做的错位面:agent 查配额与谱系,不做通用历史检索。
// Host 头校验(server.ts 的全局中间件)同样覆盖 /mcp。

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DAY_MS = 86_400_000;

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): { jsonrpc: '2.0'; id: unknown; result: unknown } {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

// ── 工具实现(全部只读、有界) ────────────────────────────────────────

function fmtCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtReset(resetAt: number | null, now: number): string {
  if (resetAt == null) return '';
  const ms = resetAt - now;
  if (ms <= 0) return 'reset imminent';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `resets in ${hours}h${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d`;
}

function toolPlanQuotaStatus(store: Store, cfg: AppConfig): string {
  const overview = buildOverview(store, cfg.plans, Date.now());
  const lines: string[] = ['Plans quota overview (fetched from local daemon):'];
  for (const plan of overview.plans) {
    const state = plan.enabled ? 'enabled' : 'disabled';
    const err = plan.lastError ? ` · last error: ${plan.lastError}` : '';
    lines.push(`- ${plan.slug} (${plan.adapter}) ${state}${err}`);
    if (plan.windows.length === 0) {
      lines.push('  no quota windows recorded');
      continue;
    }
    for (const w of plan.windows) {
      const used = w.used != null ? `${fmtCount(w.used)}` : '?';
      const total = w.total != null ? `/${fmtCount(w.total)}` : '';
      const pct = w.percentage != null ? ` ${Math.round(w.percentage)}%` : '';
      const unit = w.unit && w.unit !== 'percent' ? ` ${w.unit}` : '';
      const reset = w.resetAt != null ? `, ${fmtReset(w.resetAt, Date.now())}` : '';
      const note = w.note ? ` (${w.note})` : '';
      lines.push(`  ${w.label}: ${used}${total}${unit}${pct}${reset}${note}`);
    }
  }
  return lines.join('\n');
}

function toolUsageSummary(store: Store, args: { days?: unknown; provider?: unknown }): string {
  const days = Math.min(90, Math.max(1, Math.floor(Number(args.days ?? 7)) || 7));
  const provider = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : null;
  const now = Date.now();
  const since = now - days * DAY_MS;
  let records: UsageRecord[] = store.getUsageRecords(since, now);
  if (provider) records = records.filter((record) => record.provider === provider);
  const report = buildUsageReport(records, { since, until: now, generatedAt: now });
  const t = report.totals;
  const lines: string[] = [
    `Token usage, last ${days} days${provider ? ` · provider=${provider}` : ''} (本地日志估算,非账单):`,
    `total ${fmtCount(t.totalTokens)} tokens (input ${fmtCount(t.inputTokens)} · cache read ${fmtCount(t.cachedInputTokens)} · cache write ${fmtCount(t.cacheCreationInputTokens)} · output ${fmtCount(t.outputTokens)} · reasoning ${fmtCount(t.reasoningOutputTokens)})`,
  ];
  if (t.estimatedCostUsd != null) lines.push(`estimated cost: $${t.estimatedCostUsd.toFixed(2)}`);
  const byProvider = new Map<string, number>();
  for (const record of records) {
    byProvider.set(record.provider, (byProvider.get(record.provider) ?? 0) + record.totalTokens);
  }
  if (byProvider.size > 0) {
    const parts = [...byProvider.entries()].sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p} ${fmtCount(n)}`);
    lines.push(`by provider: ${parts.join(' / ')}`);
  }
  const recentDays = report.daily.slice(0, days);
  if (recentDays.length > 0) {
    const parts = recentDays.map((d) => `${(d.day ?? '').slice(5)} ${fmtCount(d.totalTokens)}`);
    lines.push(`by day: ${parts.join(' · ')}`);
  }
  const topModels = report.models.slice(0, 5);
  if (topModels.length > 0) {
    const parts = topModels.map((m) => `${m.model ?? '?'} ${fmtCount(m.totalTokens)}`);
    lines.push(`top models: ${parts.join(' / ')}`);
  }
  if (records.length === 0) lines.push('(no records; run `planofplan tokens` or the dashboard 扫描本地日志 first)');
  return lines.join('\n');
}

function toolSessionSearch(store: Store, args: { q?: unknown; days?: unknown; limit?: unknown; exclude?: unknown }): string {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  if (!q) throw new ToolArgError('q is required (search text)');
  const days = Math.min(365, Math.max(1, Math.floor(Number(args.days ?? 30)) || 30));
  const limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit ?? 10)) || 10));
  // 自指防护(obelisk invocation-identity 思路):agent 搜历史会把自己正在进行的
  // 会话当证据。exclude 传调用者自己的 session id,元数据与 FTS 命中两侧都排除。
  const exclude = typeof args.exclude === 'string' && args.exclude.trim() ? args.exclude.trim() : null;
  const now = Date.now();
  const since = now - days * DAY_MS;
  const rows = store.listSessionRows()
    .filter((row) => row.updatedAt >= since && row.updatedAt < now)
    .filter((row) => row.id !== exclude);
  const hits = store.searchSessionMessages(q).filter((hit) => hit.sessionId !== exclude);
  const hitBySession = new Map(hits.map((hit) => [hit.sessionId, hit]));
  const matched = searchSessions(rows, q);
  const have = new Set(matched.map((row) => row.id));
  for (const hit of hits) {
    if (have.has(hit.sessionId)) continue;
    const session = store.getSession(hit.sessionId);
    if (!session) continue;
    if (session.updatedAt < since) continue;
    matched.push(session);
    have.add(session.id);
  }
  matched.sort((a, b) => b.updatedAt - a.updatedAt);
  if (matched.length === 0) return `No sessions match "${q}" in the last ${days} days.`;
  const requirements = store.firstRequirementBySession();
  const lines: string[] = [`${matched.length} session(s) match "${q}" (last ${days} days, showing ${Math.min(limit, matched.length)}):`];
  for (const session of matched.slice(0, limit)) {
    const date = new Date(session.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
    const title = requirements.get(session.id)?.text ?? session.title ?? '无标题';
    lines.push(`- [${session.provider}] ${date} ${title} (${session.id})`);
    const hit = hitBySession.get(session.id);
    if (hit) lines.push(`  content hit: ${hit.snippet.replaceAll('\u0001', '').replaceAll('\u0002', '')} (${hit.count} 处)`);
  }
  return lines.join('\n');
}

class ToolArgError extends Error {}

function commitsBySession(store: Store): Map<string, SessionCommit[]> {
  const map = new Map<string, SessionCommit[]>();
  for (const commit of store.listSessionCommits()) {
    const list = map.get(commit.sessionId) ?? [];
    list.push(commit);
    map.set(commit.sessionId, list);
  }
  return map;
}

function sessionMatchesRepo(session: SessionRecord, repo: string): boolean {
  const needle = repo.toLowerCase();
  const fields: string[] = [session.gitName ?? '', session.gitRoot ?? '', session.gitUrl ?? '', session.cwd ?? ''];
  for (const r of session.repos ?? []) fields.push(r.name, r.url, r.root ?? '');
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function toolRepoLineage(store: Store, args: { repo?: unknown; days?: unknown; limit?: unknown }): string {
  const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
  if (!repo) throw new ToolArgError('repo is required (name/path/url fragment)');
  const days = Math.min(365, Math.max(1, Math.floor(Number(args.days ?? 30)) || 30));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 20)) || 20));
  const now = Date.now();
  const since = now - days * DAY_MS;
  const rows = store.listSessionRows()
    .filter((row) => row.updatedAt >= since && row.updatedAt < now)
    .filter((row) => sessionMatchesRepo(row, repo))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (rows.length === 0) return `No sessions in the last ${days} days touch a repo matching "${repo}".`;
  const commits = commitsBySession(store);
  const requirements = store.firstRequirementBySession();
  const lines: string[] = [`${rows.length} session(s) touch "${repo}" (last ${days} days, showing ${Math.min(limit, rows.length)}):`];
  for (const session of rows.slice(0, limit)) {
    const date = new Date(session.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
    const title = requirements.get(session.id)?.text ?? session.title ?? '无标题';
    const sessionCommits = commits.get(session.id) ?? [];
    const commitNote = sessionCommits.length > 0
      ? ` · ${sessionCommits.length} commit(s)${sessionCommits.some((c) => c.kind === 'declared') ? ' (含声明)' : ''}`
      : '';
    lines.push(`- [${session.provider}] ${date} ${title}${commitNote}`);
    for (const commit of sessionCommits.slice(0, 5)) {
      lines.push(`    ${commit.sha.slice(0, 8)} [${commit.kind}] ${commit.summary}`);
    }
  }
  return lines.join('\n');
}

function toolRequirementStatus(store: Store, args: { days?: unknown; limit?: unknown }): string {
  const days = Math.min(90, Math.max(1, Math.floor(Number(args.days ?? 14)) || 14));
  const limit = Math.min(60, Math.max(1, Math.floor(Number(args.limit ?? 30)) || 30));
  const now = Date.now();
  const since = now - days * DAY_MS;
  const requirements = store.firstRequirementBySession();
  const rows = store.listSessionRows()
    .filter((row) => row.updatedAt >= since && row.updatedAt < now)
    .filter((row) => (row.origin ?? 'user') === 'user')
    .filter((row) => requirements.has(row.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (rows.length === 0) return `No extracted requirements in the last ${days} days.`;
  const commits = commitsBySession(store);
  const lines: string[] = [`${rows.length} requirement(s) in the last ${days} days (showing ${Math.min(limit, rows.length)}):`];
  for (const session of rows.slice(0, limit)) {
    const date = new Date(session.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
    const text = requirements.get(session.id)?.text ?? '';
    const sessionCommits = commits.get(session.id) ?? [];
    const declared = sessionCommits.filter((c) => c.kind === 'declared').length;
    const witnessed = sessionCommits.filter((c) => c.kind === 'witnessed').length;
    const commitNote = sessionCommits.length > 0
      ? ` · landed ${sessionCommits.length} commit(s), ${declared} declared, ${witnessed} witnessed`
      : ' · no commits yet';
    lines.push(`- ${date} [${session.provider}] ${text}${commitNote}`);
  }
  return lines.join('\n');
}

function toolSearchSkills(store: Store, args: { q?: unknown; limit?: unknown }): string {
  const q = typeof args.q === 'string' ? args.q.trim() : '';
  const limit = Math.min(30, Math.max(1, Math.floor(Number(args.limit ?? 10)) || 10));

  try {
    const count = (store.db.query('SELECT COUNT(*) as c FROM skills').get() as { c: number } | null)?.c ?? 0;
    if (count === 0) {
      syncSkillsCatalog(store);
    }
  } catch {
    syncSkillsCatalog(store);
  }

  const hits = searchSkills(store, q, limit);
  if (hits.length === 0) {
    return q ? `未找到与 "${q}" 匹配的 Agent Skill。` : '当前系统未索引到任何 Agent Skill。';
  }

  const lines = [`找到 ${hits.length} 个匹配的 Skill${q ? ` (关键词: "${q}")` : ''}:`];
  for (const hit of hits) {
    lines.push(`- **${hit.name}**: ${hit.description.replace(/\s+/g, ' ').slice(0, 140)}`);
    if (hit.triggers && hit.triggers.length > 0) {
      lines.push(`  触发场景: ${hit.triggers.slice(0, 4).join(', ')}`);
    }
    lines.push(`  路径: ${hit.path}`);
  }
  return lines.join('\n');
}

function toolInspectProjectContext(store: Store, args: { project?: unknown }): string {
  const project = typeof args.project === 'string' ? args.project.trim() : '';
  if (!project) throw new ToolArgError('project is required (name or path)');

  const sessions = store.listSessionRows()
    .filter((s) => sessionMatchesRepo(s, project))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (sessions.length === 0) {
    return `在本地记录中未找到与 "${project}" 相关的 Agent 会话或项目谱系。`;
  }

  const needle = project.toLowerCase();
  const directSession = sessions.find((s) =>
    (s.gitName?.toLowerCase().includes(needle)) ||
    (s.gitRoot?.toLowerCase().includes(needle)) ||
    (s.cwd?.toLowerCase().includes(needle))
  );
  const targetSession = directSession ?? sessions[0]!;

  const matchedRepo = targetSession.repos?.find((r) =>
    r.name.toLowerCase().includes(needle) ||
    r.root?.toLowerCase().includes(needle) ||
    r.url.toLowerCase().includes(needle)
  );

  const repoName = matchedRepo?.name ?? (targetSession.gitName?.toLowerCase().includes(needle) ? targetSession.gitName : undefined) ?? project;
  const repoRoot = matchedRepo?.root ?? (targetSession.gitRoot?.toLowerCase().includes(needle) ? targetSession.gitRoot : undefined) ?? targetSession.cwd ?? '未知路径';
  const repoUrl = matchedRepo?.url ?? (targetSession.gitUrl?.toLowerCase().includes(needle) ? targetSession.gitUrl : undefined) ?? targetSession.gitUrl ?? '无远程仓库';


  // 检查 zg 语义索引状态
  const hasZg = repoRoot !== '未知路径' && existsSync(join(repoRoot, '.zvec-grep'));
  const zgNote = hasZg
    ? '✅ 已就绪 (可直接调用 zvec_grep_search 语义查代码)'
    : '⚠️ 未建立 (可在该项目根目录下运行 zg index 以启用语义搜索)';

  const lines: string[] = [
    `=== 项目上下文透视: ${repoName} ===`,
    `- 根目录: ${repoRoot}`,
    `- 远程地址: ${repoUrl}`,
    `- 代码语义索引 (.zvec-grep): ${zgNote}`,
    `- 历史被交互次数: ${sessions.length} 个会话 (最近活跃: ${new Date(targetSession.updatedAt).toISOString().slice(0, 16).replace('T', ' ')})`,
    '',
  ];

  // 最近需求动机 (Top 3)
  const requirements = store.firstRequirementBySession();
  const reqLines: string[] = [];
  const seenReqs = new Set<string>();
  for (const s of sessions) {
    const text = requirements.get(s.id)?.text;
    if (text && !seenReqs.has(text)) {
      seenReqs.add(text);
      reqLines.push(`- [${s.provider}] ${text}`);
      if (reqLines.length >= 3) break;
    }
  }
  if (reqLines.length > 0) {
    lines.push('【最近开发需求/用户意图】:');
    lines.push(...reqLines);
    lines.push('');
  }

  // 最近提交 (Top 3)
  const commits = commitsBySession(store);
  const repoCommits: SessionCommit[] = [];
  const seenCommits = new Set<string>();
  for (const s of sessions) {
    for (const c of commits.get(s.id) ?? []) {
      if (!seenCommits.has(c.sha)) {
        seenCommits.add(c.sha);
        repoCommits.push(c);
      }
    }
  }
  if (repoCommits.length > 0) {
    lines.push('【最近落地 Commits】:');
    for (const c of repoCommits.slice(0, 3)) {
      lines.push(`- ${c.sha.slice(0, 8)} [${c.kind}] ${c.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── 工具注册表 ──────────────────────────────────────────────────────


interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (store: Store, cfg: AppConfig, args: Record<string, unknown>) => string;
}

const TOOLS: ToolDef[] = [
  {
    name: 'plan_quota_status',
    description: '查询本机所有 AI coding plan 订阅的配额窗口状态(5H/周/月用量百分比与重置倒计时)。用户问"额度还剩多少""5H 窗口什么时候重置"时用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (store, cfg) => toolPlanQuotaStatus(store, cfg),
  },
  {
    name: 'usage_summary',
    description: '查询本地 agent 日志统计的 token 用量与成本估算(按天/按 provider/按模型)。用户问"最近烧了多少 token""这个月花了多少钱"时用它。数据是本地日志估算,不是账单。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回看天数,1-90,默认 7' },
        provider: { type: 'string', description: '按 provider 过滤(claude/codex/kimi/grok/dsh/zcode/factory)' },
      },
      additionalProperties: false,
    },
    run: (store, _cfg, args) => toolUsageSummary(store, args),
  },
  {
    name: 'session_search',
    description: '跨本机全部 coding agent 会话搜索:标题/项目等元数据 ∪ 消息正文全文(FTS,中文需 ≥3 字符)。用户问"之前哪个对话聊过 X"时用它。你是 coding agent 时建议在 arguments 里带上 exclude=你自己的 session id,避免把当前会话误当历史证据。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '搜索文本' },
        days: { type: 'number', description: '回看天数,默认 30' },
        limit: { type: 'number', description: '返回条数上限,默认 10,最大 30' },
        exclude: { type: 'string', description: '要排除的 session id(通常是调用者自己的,如 claude:<uuid>)' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    run: (store, _cfg, args) => toolSessionSearch(store, args),
  },
  {
    name: 'repo_lineage',
    description: '查一个 git 仓库最近的"谱系":哪些 agent 会话碰过它、各自的需求是什么、落了哪些 commit(declared=trailer 声明/witnessed=transcript 目击/candidate=时间窗推断)。用户问"这个 repo 最近做了什么""X 需求有没有落成 commit"时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名/路径/URL 片段' },
        days: { type: 'number', description: '回看天数,默认 30' },
        limit: { type: 'number', description: '返回条数上限,默认 20,最大 50' },
      },
      required: ['repo'],
      additionalProperties: false,
    },
    run: (store, _cfg, args) => toolRepoLineage(store, args),
  },
  {
    name: 'recent_edits',
    description: '最近被 agent 改动的文件流:哪个文件在被反复改、出自哪条对话。用户问"最近 agent 都在改什么文件""X 文件是哪个会话改的"时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回看天数,默认 7,最大 90' },
        limit: { type: 'number', description: '返回条数上限,默认 50,最大 200' },
      },
      additionalProperties: false,
    },
    run: (store, _cfg, args) => {
      const days = Math.min(90, Math.max(1, Math.floor(Number(args.days ?? 7)) || 7));
      const limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit ?? 50)) || 50));
      const userMeta = store.getSessionUserMetaMap();
      const hiddenIds = new Set([...userMeta.entries()].filter(([, meta]) => meta.hidden).map(([id]) => id));
      const files = store.recentFileEdits(Date.now() - days * DAY_MS, limit, hiddenIds);
      if (files.length === 0) return `最近 ${days} 天没有文件改动记录。`;
      const lines = [`最近 ${days} 天被 agent 改动的文件(前 ${files.length}):`];
      for (const file of files) {
        const names = file.sessions.map((s) => `${s.provider}:${(s.title ?? s.id).slice(0, 24)}`).join(' / ');
        lines.push(`- ${file.path}(${file.sessionCount} 个会话)← ${names}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'lineage_report',
    description: '谱系周报:窗口内需求 × commit × token 消耗的静态汇总(declared=trailer 声明/witnessed=transcript 目击/candidate=时间窗推断)。用户问"这周做了什么、落了多少、各烧多少"时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回看天数,默认 7,最大 90' },
        limit: { type: 'number', description: '条目上限,默认 15' },
      },
      additionalProperties: false,
    },
    run: (store, _cfg, args) => {
      const days = Math.min(90, Math.max(1, Math.floor(Number(args.days ?? 7)) || 7));
      const limit = Math.min(60, Math.max(1, Math.floor(Number(args.limit ?? 15)) || 15));
      const now = Date.now();
      const report = buildLineageReport(store, now - days * DAY_MS, now);
      const t = report.totals;
      const landedPct = t.requirements > 0 ? Math.round((t.landed / t.requirements) * 100) : 0;
      const lines = [
        `谱系周报(近 ${days} 天):${t.requirements} 个需求 · ${landedPct}% 落地`,
        `commits: ${t.commits}(声明 ${t.declaredCommits} / 目击 ${t.witnessedCommits} / 其余时间窗推断)`,
        `tokens: ${fmtCount(t.totalTokens)}${t.estimatedCostUsd != null ? ` · 估算 $${t.estimatedCostUsd.toFixed(2)}` : ''}`,
        '',
      ];
      for (const item of report.items.slice(0, limit)) {
        const mark = item.landed ? `[✓${item.commits.length}]` : '[…]';
        const cost = item.estimatedCostUsd != null ? ` · $${item.estimatedCostUsd.toFixed(2)}` : '';
        lines.push(`- ${mark} ${item.text.slice(0, 60)}(${item.provider}${item.project ? ` · ${item.project}` : ''}${cost})`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'requirement_status',
    description: '列出最近从用户消息里抽取的需求(会话 → 需求 → commit 归因链的中间层),附每个需求是否已落 commit。用户问"最近提了哪些需求""哪些还没落"时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回看天数,默认 14' },
        limit: { type: 'number', description: '返回条数上限,默认 30,最大 60' },
      },
      additionalProperties: false,
    },
    run: (store, _cfg, args) => toolRequirementStatus(store, args),
  },
  {
    name: 'planofplan_search_skills',
    description: '跨本机 150+ coding agent skills 库快速检索。当需要特定专业能力(如 obsidian 笔记整理、tldraw 画布、微信发布、PPT制作、系统化调试等)时用它。返回匹配的 skill 名称、作用与文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '搜索关键词或用户意图场景(如 "obsidian", "debug", "画架构图")' },
        limit: { type: 'number', description: '返回条数上限,默认 10,最大 30' },
      },
      additionalProperties: false,
    },
    run: (store, _cfg, args) => toolSearchSkills(store, args),
  },
  {
    name: 'planofplan_project_context',
    description: '跨项目切换时的上下文透视:查看任意本地项目的概况、最近的需求动机、落地的 commits、活跃的 agent 会话及触及文件流，并报告该项目是否已建立 zg 语义代码索引。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名称、路径或仓库 URL 片段' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    run: (store, _cfg, args) => toolInspectProjectContext(store, args),
  },
];



// ── JSON-RPC 分发 ───────────────────────────────────────────────────

function handleMessage(store: Store, cfg: AppConfig, message: RpcMessage): { jsonrpc: '2.0'; id: unknown; result: unknown } | { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } } | null {
  const { id, method } = message;
  if (method == null || id == null) return null; // 通知或不完整消息:不回应
  switch (method) {
    case 'initialize': {
      const params = message.params as { protocolVersion?: unknown } | undefined;
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'planofplan', version: `0.1.0+${getBuildInfo().shortCommitSha}` },
        instructions: 'planofplan 是本机 coding agent 的洞察中枢:查订阅配额、token 用量,以及 会话→需求→commit 的谱系。全部只读。',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      const name = typeof params?.name === 'string' ? params.name : '';
      const tool = TOOLS.find((t) => t.name === name)
        ?? (name === 'search_skills' ? TOOLS.find((t) => t.name === 'planofplan_search_skills') : undefined)
        ?? (name === 'inspect_project_context' ? TOOLS.find((t) => t.name === 'planofplan_project_context') : undefined);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name || '(missing)'}`);
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(id, textContent(tool.run(store, cfg, args)));
      } catch (error) {
        if (error instanceof ToolArgError) {
          return rpcResult(id, { ...textContent(error.message), isError: true });
        }
        return rpcResult(id, { ...textContent(`tool failed: ${error instanceof Error ? error.message : 'unknown error'}`), isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** 处理 POST /mcp 的 body。返回 null 表示全是通知(202 无 body),否则是 JSON 响应。 */
export function handleMcpBody(
  store: Store,
  cfg: AppConfig,
  body: unknown,
): { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } } | Array<{ jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } }> | null {
  const messages = Array.isArray(body) ? body : [body];
  const responses = messages
    .filter((m): m is RpcMessage => m != null && typeof m === 'object')
    .map((m) => handleMessage(store, cfg, m))
    .filter((r): r is NonNullable<ReturnType<typeof handleMessage>> => r != null);
  if (responses.length === 0) return null;
  return Array.isArray(body) ? responses : responses[0]!;
}

export function registerMcpRoutes(app: Hono, store: Store, cfg: AppConfig): void {
  app.post('/mcp', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'parse error'), 400);
    }
    const response = handleMcpBody(store, cfg, body);
    if (response == null) return c.body(null, 202);
    return c.json(response);
  });
  // streamable HTTP 的 GET(SSE 推送)与 DELETE(会话终止)都是可选能力:
  // 无会话状态的只读 server 直接 405,客户端会走 POST 请求/响应
  app.get('/mcp', (c) => c.text('method not allowed: POST JSON-RPC only', 405));
  app.delete('/mcp', (c) => c.body(null, 405));
}
