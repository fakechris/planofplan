import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import type { Scheduler } from './core.ts';
import { buildOverview } from './core.ts';
import { registeredAdapters } from './adapters/index.ts';
import { writeCredential, deleteCredential, readAllCredentialIds } from './auth.ts';
import { acceptKimiBrowserCookies, refreshKimiBrowserSession } from './adapters/kimi.ts';
import { KIMI_BROWSER, KIMI_BROWSERS, type KimiBrowser } from './browser-cookies.ts';
import { acceptFactoryBrowserCookies } from './factory-session.ts';
import { spawnSync } from 'node:child_process';
import { getBuildInfo } from './build-info.ts';
import { buildUsageReport } from './usage.ts';
import { buildSessionList, searchSessions } from './sessions.ts';
import { pickRequirement } from './motivation.ts';
import { nameOfUrl, sessionProjectNames } from './repos.ts';
import { buildHandoffPackage, deliverHandoff, handoffProviders } from './handoff.ts';
import { LLM_PROVIDERS, llmKeyFor, llmProviderStatus, synthesizeHandoffSummary, withSummary } from './llm.ts';
import { loadConfig, saveLlmConfig, savePlansConfig } from './config.ts';
import type { PlanConfig, ProjectAgentStat, ProjectListItem, RequirementRecord } from './types.ts';
import { readTranscript } from './transcript.ts';
import { launchResume } from './resume.ts';
import { getStartupSettings, setLaunchOnStartup } from './startup.ts';
import { startSessionWatcher } from './watcher.ts';
import { registerMcpRoutes } from './mcp.ts';
import { buildLineageReport } from './lineage-report.ts';

// In dev (bun src/cli.ts), import.meta.dir points at src/ and ../web = repo/web.
// In a bun build --compile binary, import.meta.dir is a virtual $bunfs/root path
// that has no on-disk web/ sibling; fall back to the executable's real location
// (Contents/MacOS/planofplan-daemon -> Contents/web).
const WEB_DIR = (() => {
  const candidates = [
    resolve(import.meta.dir, '../web'),
    resolve(dirname(process.execPath), '../web'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
})();


/**
 * 构造扫描子进程参数。解释模式(execPath=bun)需要显式脚本路径;编译二进制
 * 的 process.argv 自带 $bunfs 入口占位,再传路径会把路径当命令,子进程直接
 * 打印 help 退出——2026-08-29 生产实测踩过:spawn 扫描全空转,归因/实时
 * 索引静默失效。stderr 一律 inherit:子进程本该安静,有输出即异常。
 */
function childProcessArgs(cliArgs: string[]): string[] {
  const compiled = import.meta.dir.startsWith('$bunfs');
  return [process.execPath, ...(compiled ? [] : [join(import.meta.dir, 'cli.ts')]), ...cliArgs];
}

export interface ServerOptions {
  /** true 时启动文件监听,变更自动触发 session 索引(demo 模式传 false)。 */
  live?: boolean;
}

export function createServer(store: Store, scheduler: Scheduler, cfg: AppConfig, options: ServerOptions = {}): Hono {
  const app = new Hono();

  // DNS rebinding 防护(参照 agentsview):服务只绑 loopback,但攻击者可把
  // 自己的域名解析到 127.0.0.1 让浏览器携带外域 Host 打进来。只信任本机
  // Host;SSH 端口转发/反向代理场景用 PLANOFPLAN_ALLOWED_HOSTS 显式放行。
  const allowedHosts = (process.env.PLANOFPLAN_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (host) {
      const bare = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      const ok = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
        || allowedHosts.includes(bare);
      if (!ok) return c.json({ ok: false, error: `host not allowed: ${bare}` }, 403);
    }
    await next();
  });

  // SSE 客户端池:/api/events 的活跃订阅者,索引状态变化时广播
  const sseClients = new Set<SSEStreamingApi>();
  const broadcastSSE = (event: string, data: unknown): void => {
    const payload = JSON.stringify(data);
    for (const stream of sseClients) {
      void stream.writeSSE({ event, data: payload })
        .catch(() => sseClients.delete(stream));
    }
  };

  let usageRefreshProcess: Bun.Subprocess | null = null;
  let usageRefreshStartedAt: number | null = null;
  let usageRefreshError: string | null = null;
  let sessionIndexProcess: Bun.Subprocess | null = null;
  // usage 报表缓存：usage_records 只随扫描子进程 / 手动 CLI 写入变化，聚合
  // 十几万行是秒级同步 CPU+IO 工作，前端 30s 一次的轮询不应每次重算。
  // 扫描完成时整体失效；TTL 兜底覆盖外部 CLI 的直写。
  const usageReportCache = new Map<string, { report: ReturnType<typeof buildUsageReport>; at: number }>();
  const USAGE_CACHE_TTL_MS = 60_000;

  const startUsageRefresh = (days: number, includeOfficial: boolean): void => {
    if (usageRefreshProcess) return;
    usageRefreshError = null;
    usageRefreshStartedAt = Date.now();
    const scanProcess = Bun.spawn(childProcessArgs(['tokens', '--days', String(days), ...(includeOfficial ? [] : ['--no-official'])]), {
      stdout: 'ignore',
      stderr: 'inherit',
    });
    usageRefreshProcess = scanProcess;
    void scanProcess.exited
      .then((exitCode) => {
        if (exitCode !== 0) {
          usageRefreshError = `本地日志扫描失败（exit ${exitCode}）`;
        }
      })
      .catch((error) => {
        usageRefreshError = error instanceof Error ? error.message : '本地日志扫描失败';
      })
      .finally(() => {
        usageRefreshProcess = null;
        usageRefreshStartedAt = null;
        usageReportCache.clear();
      });
  };

  app.get('/api/overview', (c) => {
    const overview = buildOverview(store, cfg.plans, Date.now());
    // 多账号校验:同 adapter 多 plan 时,未设 credRef 的会共用自动检测
    // 渠道(env/浏览器)——两个号读成同一个。提示而不是拒绝。
    const byAdapter = new Map<string, number>();
    for (const plan of cfg.plans) byAdapter.set(plan.adapter, (byAdapter.get(plan.adapter) ?? 0) + 1);
    const warnings: string[] = [];
    for (const [adapter, count] of byAdapter) {
      if (count < 2) continue;
      const missing = cfg.plans.filter((plan) => plan.adapter === adapter && !plan.credRef).map((plan) => plan.slug);
      if (missing.length > 0) {
        warnings.push(`${adapter} 有 ${count} 个 plan,其中 ${missing.join('/')} 未设置专属凭据(credRef),会与其它账号共用自动检测渠道`);
      }
    }
    return c.json({ ...overview, warnings });
  });

  app.get('/api/build-info', (c) => {
    return c.json(getBuildInfo());
  });

  // SSE:dashboard 常驻订阅,索引开始/完成实时推送;15s ping 防中间层掐空闲连接。
  // 必须注册在静态兜底 app.get('*') 之前。
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    sseClients.add(stream);
    stream.onAbort(() => {
      sseClients.delete(stream);
    });
    try {
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: Date.now() }) });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: 'ping', data: JSON.stringify({ at: Date.now() }) });
      }
    } catch {
      /* client gone */
    } finally {
      sseClients.delete(stream);
    }
  }));

  app.get('/api/settings', (c) => {
    return c.json(getStartupSettings());
  });

  app.put('/api/settings/launch-on-startup', async (c) => {
    let body: { enabled?: boolean } | null = null;
    try {
      body = (await c.req.json()) as { enabled?: boolean };
    } catch {
      return c.json({ ok: false, error: 'body 必须是 JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled 必须是 boolean' }, 400);
    }
    try {
      return c.json(setLaunchOnStartup(body.enabled));
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : '设置失败' }, 400);
    }
  });

  // ── 日历纱线数据(dsh-track calendar-yarn 同构,数据全来自已物化实体)──
  // X=天, Y=项目泳道, 节点=需求(span 归因项目), 纱线=会话的需求序列,
  // 金色菱形=项目切换点, 紫色边=spawned-by, 跨天连续会话的活跃天数序列。
  app.get('/api/calendar', (c) => {
    const days = Math.min(90, Math.max(7, Number(c.req.query('days') ?? 30) || 30));
    const now = Date.now();
    const since = now - days * 86_400_000;
    const dayBase = since - (since % 86_400_000);

    // 需求:窗口内 user 起源,带 span 归因的项目名 + 事件量(touch+commit 数)
    const reqs = store.listRequirements().filter((r) => {
      const ts = r.ts ?? 0;
      return ts >= since && ts < now;
    });
    const projectByUrl = new Map(store.listProjects().map((p) => [p.url, p]));
    const reqRepos = store.requirementRepoUrls();
    // 每个需求的事件量:span 内 touch 数(有 touches 表的行)
    const eventsByReq = new Map<string, number>();
    for (const r of reqs) {
      const touches = store.spanTouches(r.sessionId, r.seq, null);
      eventsByReq.set(r.id, touches.length);
    }

    // 会话:窗口内每个 session 的需求序列(按 seq 排序)
    const sessionById = new Map(store.listSessionRows().map((s) => [s.id, s]));
    const reqsBySession = new Map<string, typeof reqs>();
    for (const r of reqs) {
      const list = reqsBySession.get(r.sessionId) ?? [];
      list.push(r);
      reqsBySession.set(r.sessionId, list);
    }
    // 活跃天:每个 session 的需求分布在不同天的列表
    const activeDaysBySession = new Map<string, number[]>();
    for (const r of reqs) {
      const day = Math.floor(((r.ts ?? 0) - dayBase) / 86_400_000);
      if (day < 0 || day >= days) continue;
      const list = activeDaysBySession.get(r.sessionId) ?? [];
      if (!list.includes(day)) list.push(day);
      activeDaysBySession.set(r.sessionId, list);
    }

    // 项目泳道:有活动的项目按需求量排序,零活动折叠
    const evByProj = new Map<string, number>();
    for (const r of reqs) {
      for (const url of reqRepos.get(r.id) ?? []) {
        const p = projectByUrl.get(url);
        if (p) evByProj.set(p.name, (evByProj.get(p.name) ?? 0) + 1);
      }
    }
    const activeProjects = [...evByProj.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const allProjectNames = new Set(store.listProjects().map((p) => p.name));

    // session_links 边(spawned-by 的紫色线)
    const edges: Array<{ from: string; to: string; kind: string }> = [];
    for (const link of store.listSessionLinks()) {
      if (link.kind !== 'spawned-by') continue;
      edges.push({ from: link.fromSession, to: link.toSession, kind: link.kind });
    }

    interface CalReq {
      id: string; sessionId: string; proj: string; text: string;
      day: number; events: number; originLevel: string;
    }
    interface CalSession {
      id: string; provider: string; reqIds: string[]; activeDays: number[]; projects: string[];
    }
    // 无 span 归因的需求退到「会话的 work 项目」——比 unk 有信息量得多
    const sessionWorkProject = new Map<string, string>();
    {
      const rows = store.sessionWorkRepoUrls();
      for (const row of rows) {
        const p = projectByUrl.get(row.url);
        if (p && !sessionWorkProject.has(row.sid)) sessionWorkProject.set(row.sid, p.name);
      }
    }
    const calReqs: CalReq[] = [];
    for (const r of reqs) {
      const day = Math.floor(((r.ts ?? 0) - dayBase) / 86_400_000);
      if (day < 0 || day >= days) continue;
      const repos = reqRepos.get(r.id) ?? [];
      const projNames = repos.map((u) => projectByUrl.get(u)?.name ?? '').filter(Boolean);
      calReqs.push({
        id: r.id,
        sessionId: r.sessionId,
        proj: projNames[0] ?? sessionWorkProject.get(r.sessionId) ?? 'unk',
        text: r.text.slice(0, 80),
        day,
        events: eventsByReq.get(r.id) ?? 0,
        originLevel: r.originLevel,
      });
    }
    const calSessions: CalSession[] = [];
    for (const [sid, list] of reqsBySession) {
      const session = sessionById.get(sid);
      if (!session) continue;
      const sorted = list.slice().sort((a, b) => a.seq - b.seq);
      const projSet = new Set<string>();
      for (const r of sorted) {
        for (const url of reqRepos.get(r.id) ?? []) {
          const p = projectByUrl.get(url);
          if (p) projSet.add(p.name);
        }
      }
      calSessions.push({
        id: sid,
        provider: session.provider,
        reqIds: sorted.map((r) => r.id),
        activeDays: (activeDaysBySession.get(sid) ?? []).sort((a, b) => a - b),
        projects: [...projSet],
      });
    }

    return c.json({
      days,
      dayBase: new Date(dayBase).toISOString(),
      projects: [...allProjectNames].map((name) => ({ name, hue: '' })),
      activeProjects,
      requirements: calReqs,
      sessions: calSessions,
      edges,
    });
  });

  app.get('/api/plans/:slug', (c) => {
    const slug = c.req.param('slug');
    const plan = store.getPlan(slug);
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);
    const overview = buildOverview(store, [plan], Date.now());
    return c.json(overview.plans[0] ?? { ok: false, error: 'no data' });
  });

  app.get('/api/plans/:slug/history', (c) => {
    const slug = c.req.param('slug');
    const window = c.req.query('window') ?? 'rolling_5h';
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7)));
    const since = Date.now() - days * 86_400_000;
    const rows = store.history(slug, window, since);
    return c.json({ slug, window, days, rows });
  });

  app.get('/api/usage', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
    const provider = c.req.query('provider')?.trim() || null;
    const refresh = c.req.query('refresh') === '1';
    const includeOfficial = c.req.query('official') !== '0';
    const now = Date.now();
    const since = now - days * 86_400_000;
    if (refresh && !usageRefreshProcess) {
      usageReportCache.clear();
      startUsageRefresh(days, includeOfficial);
    }
    const cacheKey = `${days}:${provider ?? 'all'}`;
    if (!refresh) {
      const cached = usageReportCache.get(cacheKey);
      if (cached && now - cached.at < USAGE_CACHE_TTL_MS) {
        return c.json({
          ...cached.report,
          scanStatus: usageRefreshProcess
            ? { state: 'running', startedAt: usageRefreshStartedAt }
            : usageRefreshError
              ? { state: 'error', startedAt: null, error: usageRefreshError }
              : { state: 'idle', startedAt: null },
        });
      }
    }
    const records = store.getUsageRecords(since, now);
    const filtered = provider ? records.filter((record) => record.provider === provider) : records;
    const report = buildUsageReport(filtered, { since, until: now, generatedAt: now });
    usageReportCache.set(cacheKey, { report, at: now });
    return c.json({
      ...report,
      scanStatus: usageRefreshProcess
        ? { state: 'running', startedAt: usageRefreshStartedAt }
        : usageRefreshError
          ? { state: 'error', startedAt: null, error: usageRefreshError }
          : { state: 'idle', startedAt: null },
    });
  });

  // session 索引触发(单飞 + trailing 重触发):页面打开与 watcher flush 走同一道闸,
  // 保证同一时刻只有一个扫描子进程;扫描期间到来的触发记为 pending,结束后补跑一轮。
  let sessionIndexStartedAt: number | null = null;
  let sessionIndexPending = false;
  const sessionIndexLast: { at: number | null; source: string | null; changedFiles: number | null } = {
    at: null,
    source: null,
    changedFiles: null,
  };
  const startSessionIndex = (days: number, source = 'page'): void => {
    if (sessionIndexProcess) {
      sessionIndexPending = true;
      return;
    }
    sessionIndexStartedAt = Date.now();
    sessionIndexProcess = Bun.spawn(childProcessArgs(['sessions', '--refresh', '--days', String(days)]), { stdout: 'ignore', stderr: 'inherit' });
    broadcastSSE('index', { state: 'running', source, startedAt: sessionIndexStartedAt });
    void sessionIndexProcess.exited.finally(() => {
      sessionIndexProcess = null;
      sessionIndexStartedAt = null;
      sessionIndexLast.at = Date.now();
      sessionIndexLast.source = source;
      broadcastSSE('sessions-indexed', { at: sessionIndexLast.at, source });
      if (sessionIndexPending) {
        sessionIndexPending = false;
        startSessionIndex(days, source);
      }
    });
  };

  app.get('/api/sessions', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
    const provider = c.req.query('provider')?.trim() || null;
    const project = c.req.query('project')?.trim() || null;
    const query = c.req.query('q')?.trim() || '';
    const refresh = c.req.query('refresh') === '1';
    const includeSubagents = c.req.query('subagents') === '1';
    const includeHidden = c.req.query('hidden') === '1';
    const now = Date.now();
    const since = now - days * 86_400_000;
    const allRows = store.listSessionRows();
    if (refresh || allRows.length === 0) startSessionIndex(days);
    // 用户数据层联入:星标/隐藏标志。hidden 默认排除(图谱/列表都不吃),
    // 「显示已隐藏」显式带 hidden=1 才包含;墓碑 session 已不在库,天然不出现。
    const userMeta = store.getSessionUserMetaMap();
    let rows = allRows.filter((row) => includeHidden || !userMeta.get(row.id)?.hidden)
      .map((row) => {
        const meta = userMeta.get(row.id);
        return meta ? { ...row, starred: meta.starred, hidden: meta.hidden } : row;
      });
    if (provider) rows = rows.filter((row) => row.provider === provider);
    if (project) rows = rows.filter((row) => sessionProjectNames(row).includes(project));
    if (query) {
      // 元数据子串匹配 ∪ 消息正文 FTS;FTS 命中的 session 附上命中片段
      const hits = store.searchSessionMessages(query);
      const hitBySession = new Map(hits.map((hit) => [hit.sessionId, hit]));
      const matched = searchSessions(rows, query);
      const have = new Set(matched.map((row) => row.id));
      for (const hit of hits) {
        if (have.has(hit.sessionId)) continue;
        const session = store.getSession(hit.sessionId);
        if (!session) continue;
        if (!includeHidden && userMeta.get(session.id)?.hidden) continue;
        if (provider && session.provider !== provider) continue;
        if (project && !sessionProjectNames(session).includes(project)) continue;
        const meta = userMeta.get(session.id);
        matched.push(meta ? { ...session, starred: meta.starred, hidden: meta.hidden } : session);
        have.add(session.id);
      }
      rows = matched.map((row) => ({ ...row, messageHit: hitBySession.get(row.id) ?? null }));
    }
    // 需求(§1.5 实体化):user session 读 requirements 表(首条,显式
    // 优先,带 origin 分级);user 会话没有实体就保持 null——不再现场
    // pickRequirement 兜底,它没有噪音规则,注入类消息会绕过实体层直接
    // 进图谱。非 user(subagent 派工 prompt 等)保持现场抽取,列表行展示用
    const firstRequirements = store.firstRequirementBySession();
    const userTexts = store.listSessionUserTexts();
    const requirements = new Map<string, string>();
    const requirementLevels = new Map<string, string>();
    rows = rows.map((row) => {
      const fromStore = firstRequirements.get(row.id);
      if (fromStore) {
        requirements.set(row.id, fromStore.text);
        requirementLevels.set(row.id, fromStore.originLevel);
        return { ...row, requirement: fromStore.text };
      }
      if ((row.origin ?? 'user') === 'user') return { ...row, requirement: null };
      const text = pickRequirement(userTexts.get(row.id) ?? []);
      if (text) requirements.set(row.id, text);
      return { ...row, requirement: text ?? null };
    });
    const list = buildSessionList(rows, {
      since,
      until: now,
      generatedAt: now,
      requirements,
      requirementLevels,
      commits: store.listSessionCommits(),
      includeSubagents,
    });
    return c.json({
      ...list,
      indexStatus: sessionIndexProcess ? 'running' : 'idle',
      indexDetail: {
        state: sessionIndexProcess ? 'running' : 'idle',
        startedAt: sessionIndexStartedAt,
        lastIndexedAt: sessionIndexLast.at,
        lastSource: sessionIndexLast.source,
        changedFiles: sessionIndexLast.changedFiles,
      },
    });
  });

  // 已删除列表(恢复入口);必须先于 /api/sessions/:id 注册,否则 'deleted' 被当 id
  app.get('/api/sessions/deleted', (c) => {
    return c.json({ deleted: store.listTombstonedSessions() });
  });

  // commit trailer 钩子的查询面:当前 repo 最近活跃的 session(6h 内)。
  // 同样必须先于 /api/sessions/:id 注册。
  app.get('/api/sessions/current', (c) => {
    const cwd = c.req.query('cwd')?.trim() ?? '';
    if (!cwd.startsWith('/')) return c.json({ ok: false, error: 'cwd 必须是绝对路径' }, 400);
    const now = Date.now();
    const maxAge = 6 * 3_600_000;
    // macOS 路径规范化:pwd/git 可能给 /private/var/...,session cwd 记的是
    // /var/...(或反过来)——比较前去掉 /private 前缀,否则符号路径永远配不上
    const norm = (p: string): string => p.replace(/^\/private(?=\/)/, '');
    const match = (session: { cwd: string | null; gitRoot?: string | null }): boolean => {
      const scwd = session.cwd ? norm(session.cwd) : null;
      const root = session.gitRoot ? norm(session.gitRoot) : null;
      const here = norm(cwd);
      if (scwd === here) return true;
      // 提交发生在 session 所属 repo 内(含子目录)
      if (root && (here === root || here.startsWith(`${root}/`))) return true;
      // session 跑在提交目录的子目录里(worktree/monorepo 场景)
      if (scwd && scwd.startsWith(`${here}/`)) return true;
      return false;
    };
    const rows = store.listSessionRows()
      .filter((row) => now - row.updatedAt < maxAge)
      .filter((row) => (row.origin ?? 'user') === 'user')
      .filter(match)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const session = rows[0];
    if (!session) return c.json({ ok: true, session: null });
    return c.json({
      ok: true,
      session: { sessionId: session.id, provider: session.provider, title: session.title, updatedAt: session.updatedAt },
    });
  });

  // 谱系周报 v0:需求 × commit × 额度 的静态聚合(纯 SQL 侧,不引 LLM)
  app.get('/api/lineage-report', (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
    const now = Date.now();
    return c.json(buildLineageReport(store, now - days * 86_400_000, now));
  });

  // 最近被 agent 改动的文件(recent-edits feed):session_file_touches 的文件维度查询面
  app.get('/api/recent-edits', (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const now = Date.now();
    const userMeta = store.getSessionUserMetaMap();
    const hiddenIds = new Set([...userMeta.entries()].filter(([, meta]) => meta.hidden).map(([id]) => id));
    return c.json({
      generatedAt: now,
      days,
      files: store.recentFileEdits(now - days * 86_400_000, limit, hiddenIds),
    });
  });

  // 用户数据层动作:星标/隐藏/删除(墓碑)/恢复。L0 源文件永远不动。
  const readBoolBody = async (c: { req: { json(): Promise<unknown> } }, field: string) => {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return { error: 'body 必须是 JSON' };
    }
    const value = body?.[field];
    if (typeof value !== 'boolean') return { error: `${field} 必须是 boolean` };
    return { value };
  };

  app.post('/api/sessions/:id/star', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const parsed = await readBoolBody(c, 'starred');
    if ('error' in parsed) return c.json({ ok: false, error: parsed.error }, 400);
    store.setSessionStar(id, parsed.value!);
    broadcastSSE('sessions-changed', { kind: 'star', id, on: parsed.value });
    return c.json({ ok: true, starred: parsed.value });
  });

  app.post('/api/sessions/:id/hide', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const parsed = await readBoolBody(c, 'hidden');
    if ('error' in parsed) return c.json({ ok: false, error: parsed.error }, 400);
    store.setSessionHidden(id, parsed.value!);
    broadcastSSE('sessions-changed', { kind: 'hide', id, on: parsed.value });
    return c.json({ ok: true, hidden: parsed.value });
  });

  app.delete('/api/sessions/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    store.tombstoneSession(id, session?.sourceFile ?? null);
    broadcastSSE('sessions-changed', { kind: 'deleted', id });
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/restore', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    store.restoreSession(id);
    // 墓碑已清,立刻补一轮扫描把 session 扫回来
    startSessionIndex(30, 'restore');
    broadcastSSE('sessions-changed', { kind: 'restored', id });
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    // 跨实体关联:该 session 碰过的计划文件(对话 → 计划)
    const plans = store.planFilesForSession(id).slice(0, 10)
      .map((file) => ({ id: file.id, title: file.title, kind: file.kind, path: file.path }));
    return c.json({ ...session, plans });
  });

  app.get('/api/sessions/:id/transcript', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    return c.json(await readTranscript(session));
  });

  // 文件 → 碰过它的 session(obelisk fileHistory 的对应物)
  app.get('/api/files/sessions', (c) => {
    const path = c.req.query('path')?.trim() ?? '';
    if (!path) return c.json({ ok: false, error: 'path is required' }, 400);
    return c.json({ path, sessions: store.fileTouchSessions(path) });
  });

  // session → 它碰过的文件时间线
  app.get('/api/sessions/:provider/:id/touches', (c) => {
    const sessionId = `${c.req.param('provider')}:${c.req.param('id')}`;
    const session = store.getSession(sessionId);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    return c.json({ sessionId, touches: store.listSessionTouches(sessionId) });
  });

  // session → 归因到的 commit(commit 归因第二环)
  app.get('/api/sessions/:provider/:id/commits', (c) => {
    const sessionId = `${c.req.param('provider')}:${c.req.param('id')}`;
    const session = store.getSession(sessionId);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    return c.json({ sessionId, commits: store.listSessionCommits(sessionId) });
  });

  // ── 项目页(IA 重设计第一步)──────────────────────────────────

  /** 列表/详情共用的聚合:projectActivity 行 → 每个 url 的 agents 分解与计数。 */
  const projectAggregates = (since: number, until: number) => {
    const byUrl = new Map<string, {
      sessions: Set<string>;
      userSessions: Set<string>;
      agents: Map<string, ProjectAgentStat>;
      lastActive: number;
    }>();
    for (const row of store.projectActivity(since, until)) {
      let agg = byUrl.get(row.url);
      if (!agg) {
        agg = { sessions: new Set(), userSessions: new Set(), agents: new Map(), lastActive: 0 };
        byUrl.set(row.url, agg);
      }
      agg.sessions.add(row.sessionId);
      const isUser = row.origin === 'user';
      if (isUser) agg.userSessions.add(row.sessionId);
      let agent = agg.agents.get(row.provider);
      if (!agent) {
        agent = { provider: row.provider, sessions: 0, userSessions: 0, automatedSessions: 0, tokens: 0, lastActive: null };
        agg.agents.set(row.provider, agent);
      }
      agent.sessions += 1;
      if (isUser) agent.userSessions += 1;
      else agent.automatedSessions += 1;
      agent.tokens += row.totalTokens;
      if (row.updatedAt > (agent.lastActive ?? 0)) agent.lastActive = row.updatedAt;
      if (row.updatedAt > agg.lastActive) agg.lastActive = row.updatedAt;
    }
    return byUrl;
  };

  const toListItem = (
    project: { id: string; url: string; name: string; root: string | null; createdAt: number; lastSeenAt: number },
    agg: { sessions: Set<string>; userSessions: Set<string>; agents: Map<string, ProjectAgentStat>; lastActive: number } | undefined,
    commitCount: number,
    requirementCount: number | null,
  ): ProjectListItem => ({
    ...project,
    sessionCount: agg?.sessions.size ?? 0,
    userSessionCount: agg?.userSessions.size ?? 0,
    agents: [...(agg?.agents.values() ?? [])].sort((a, b) => b.sessions - a.sessions || a.provider.localeCompare(b.provider)),
    lastActive: agg?.lastActive || null,
    commitCount,
    requirementCount,
  });

  app.get('/api/projects', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
    const now = Date.now();
    const since = now - days * 86_400_000;
    const aggregates = projectAggregates(since, now);
    const commitCounts = store.projectCommitCounts(since);
    const requirementCounts = store.projectRequirementCounts(since);
    const projects = store.listProjects()
      .map((project) => toListItem(project, aggregates.get(project.url), commitCounts.get(project.url) ?? 0, requirementCounts.get(project.url) ?? 0))
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0) || b.sessionCount - a.sessionCount);
    return c.json({ days, since, until: now, projects });
  });

  app.get('/api/projects/:id', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
    const now = Date.now();
    const since = now - days * 86_400_000;
    const project = store.getProject(c.req.param('id'));
    if (!project) return c.json({ ok: false, error: 'unknown project' }, 404);
    const sessions = store.projectSessions(project.url, since, now);
    // requirements:需求实体(§1.5)按 span 归因落到本项目的,带 origin 分级;
    // 归属依据是需求自己证据窗口里碰的 repo,不再按 session 整体推导
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const requirements = store.listRequirements()
      .filter((req) => req.repos.includes(project.url))
      .map((req) => {
        const session = sessionById.get(req.sessionId) ?? store.getSession(req.sessionId);
        if (!session) return null;
        const ts = req.ts ?? session.updatedAt;
        if (ts < since || ts >= now) return null;
        return {
          id: req.id,
          text: req.text,
          originLevel: req.originLevel,
          sessionId: session.id,
          provider: session.provider,
          updatedAt: session.updatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const aggregates = projectAggregates(since, now);
    const commitCounts = store.projectCommitCounts(since);
    return c.json({
      ...toListItem(project, aggregates.get(project.url), commitCounts.get(project.url) ?? 0, requirements.length),
      sessions,
      requirements,
      commits: store.projectCommits(project.url, since),
      // 跨实体关联:项目下的计划文件(项目 → 计划;身份 = repo url 对齐)
      plans: store.planFilesForRepo(project.url).slice(0, 30)
        .map((file) => ({ id: file.id, title: file.title, kind: file.kind, path: file.path, lastSeenAt: file.lastSeenAt }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    });
  });

  // commit → 关联 session 反查(支持短 sha 前缀)
  app.get('/api/commits/:sha/sessions', (c) => {
    const sha = c.req.param('sha').trim();
    if (!sha) return c.json({ ok: false, error: 'sha is required' }, 400);
    const rows = store.sessionsForCommit(sha).map((row) => {
      const session = store.getSession(row.sessionId);
      return { ...row, title: session?.title ?? null, provider: session?.provider ?? null };
    });
    return c.json({ sha, sessions: rows });
  });

  // Launch 边:谁发起了这个 session / 它发起了谁(对端悬空也返回)
  app.get('/api/sessions/:provider/:id/links', (c) => {
    const sessionId = `${c.req.param('provider')}:${c.req.param('id')}`;
    const session = store.getSession(sessionId);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    return c.json({ sessionId, ...store.linksForSession(sessionId) });
  });

  // ── 需求实体(ia-redesign §1.5 / §2.3)──────────────────────────

  app.get('/api/requirements', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
    const project = c.req.query('project')?.trim() || null;
    const provider = c.req.query('provider')?.trim() || null;
    const level = c.req.query('level')?.trim() || null;
    const now = Date.now();
    const since = now - days * 86_400_000;
    const sessions = new Map(store.listSessionRows().map((row) => [row.id, row]));
    interface Item extends RequirementRecord {
      provider: string;
      updatedAt: number;
      repoNames: string[];
    }
    const items: Item[] = [];
    for (const req of store.listRequirements()) {
      const session = sessions.get(req.sessionId);
      if (!session) continue; // 悬空(session 被清)防御
      const ts = req.ts ?? session.updatedAt;
      if (ts < since || ts >= now) continue;
      items.push({
        ...req,
        provider: session.provider,
        updatedAt: session.updatedAt,
        repoNames: req.repos.map((url) => nameOfUrl(url)),
      });
    }
    // facet 惯例(c8ed083):各维度计数互不吃对方的选择
    const byProvider = new Map<string, number>();
    const byLevel = new Map<string, number>();
    const sortDesc = (a: [string, number], b: [string, number]) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
    const projectFacetSource = items
      .filter((item) => (!provider || item.provider === provider) && (!level || item.originLevel === level));
    const providerFacetSource = items
      .filter((item) => (!project || item.repoNames.includes(project)) && (!level || item.originLevel === level));
    const levelFacetSource = items
      .filter((item) => (!project || item.repoNames.includes(project)) && (!provider || item.provider === provider));
    const projectCounts = new Map<string, number>();
    for (const item of projectFacetSource) for (const name of item.repoNames) projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1);
    for (const item of providerFacetSource) byProvider.set(item.provider, (byProvider.get(item.provider) ?? 0) + 1);
    for (const item of levelFacetSource) byLevel.set(item.originLevel, (byLevel.get(item.originLevel) ?? 0) + 1);
    const filtered = items.filter((item) => (
      (!project || item.repoNames.includes(project))
      && (!provider || item.provider === provider)
      && (!level || item.originLevel === level)
    )).sort((a, b) => (b.ts ?? b.updatedAt) - (a.ts ?? a.updatedAt));
    return c.json({
      days,
      since,
      until: now,
      requirements: filtered,
      byProject: [...projectCounts.entries()].sort(sortDesc).map(([name, count]) => ({ name, count })),
      byProvider: [...byProvider.entries()].sort(sortDesc).map(([name, count]) => ({ name, count })),
      byLevel: [...byLevel.entries()].sort(sortDesc).map(([name, count]) => ({ name, count })),
    });
  });

  app.get('/api/requirements/:id', (c) => {
    const id = c.req.param('id');
    const req = store.requirementById(id);
    if (!req) return c.json({ ok: false, error: 'unknown requirement' }, 404);
    const session = store.getSession(req.sessionId);
    if (!session) return c.json({ ok: false, error: 'session missing' }, 404);
    // span:本条需求 seq → 下一条需求 seq(推断退化实体 seq=-1 → 覆盖全 session)
    const sameSession = store.listRequirements()
      .filter((row) => row.sessionId === req.sessionId && row.seq > req.seq)
      .sort((a, b) => a.seq - b.seq);
    const next = sameSession[0] ?? null;
    const fromSeq = req.seq >= 0 ? req.seq : 0;
    const touches = store.spanTouches(req.sessionId, fromSeq, next ? next.seq : null);
    const files = new Map<string, { path: string; ops: Set<string>; count: number; lastTs: number | null }>();
    for (const touch of touches) {
      const entry = files.get(touch.filePath) ?? { path: touch.filePath, ops: new Set<string>(), count: 0, lastTs: null };
      entry.ops.add(touch.op);
      entry.count += 1;
      if (touch.ts != null && (entry.lastTs == null || touch.ts > entry.lastTs)) entry.lastTs = touch.ts;
      files.set(touch.filePath, entry);
    }
    const fileList = [...files.values()]
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, 30)
      .map((entry) => ({ path: entry.path, ops: [...entry.ops], count: entry.count }));
    // span 内 commit:ts 落在本条需求与下一条需求之间
    const fromTs = req.ts ?? session.startedAt ?? session.updatedAt;
    const toTs = next?.ts ?? Number.POSITIVE_INFINITY;
    const commits = store.listSessionCommits(req.sessionId)
      .filter((commit) => commit.ts != null && commit.ts >= fromTs && commit.ts < toTs)
      .map((commit) => ({
        sha: commit.sha,
        summary: commit.summary,
        kind: commit.kind,
        pushed: commit.pushed,
        ts: commit.ts,
      }));
    return c.json({
      requirement: { ...req, repoNames: req.repos.map((url) => nameOfUrl(url)) },
      session: {
        id: session.id,
        provider: session.provider,
        title: session.title,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
      },
      filesTotal: files.size,
      files: fileList,
      commits,
      nextRequirementId: next?.id ?? null,
      // 跨实体关联:span 内触碰的计划文件(需求 → 计划)
      plans: store.planFilesForRequirement(req.sessionId, fromSeq, next ? next.seq : null)
        .slice(0, 10)
        .map((file) => ({ id: file.id, title: file.title, kind: file.kind, path: file.path })),
    });
  });

  // ── 计划态实体(计划研究 §5:PlanFile + 快照 + TodoWrite)─────────
  // 注意路由名:/api/plans 已被额度 plan 占用,这里用 /api/planfiles。

  app.get('/api/planfiles', (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
    const now = Date.now();
    const since = now - days * 86_400_000;
    // 活跃口径 = 文件 mtime(最新快照),不是扫描时间——扫描器每轮会给
    // 所有发现的文件续命 lastSeenAt,按它过滤会让一年没动的死计划挤满
    // 窗口(线上实测踩过)
    const plans = store.listPlanFiles()
      .map((plan) => {
        const latest = store.planSnapshots(plan.id, 1)[0] ?? null;
        const activeAt = plan.lastSnapshotMtimeMs ?? latest?.mtimeMs ?? plan.lastSeenAt;
        return {
          ...plan,
          activeAt,
          goal: plan.goal ? plan.goal.slice(0, 400) : null,
          checkboxChecked: latest?.checkboxChecked ?? 0,
          checkboxTotal: latest?.checkboxTotal ?? 0,
          snapshotCount: store.planSnapshotCount(plan.id),
        };
      })
      .filter((plan) => plan.activeAt >= since)
      .sort((a, b) => b.activeAt - a.activeAt);
    return c.json({ days, since, until: now, plans });
  });

  app.get('/api/planfiles/:id', (c) => {
    const plan = store.listPlanFiles().find((row) => row.id === c.req.param('id'));
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);
    const snapshots = store.planSnapshots(plan.id, 60);
    // 归因桥(thin-observer 缺的一层):谁在推进(触碰 session)+ 为什么(需求)
    // + 产出(commit)+ 项目(跨页跳转)
    const sessions = store.sessionsTouchingPath(plan.path).map((session) => {
      const req = store.firstRequirementBySession().get(session.id);
      return {
        ...session,
        requirement: req ? { id: req.id, text: req.text, originLevel: req.originLevel } : null,
      };
    });
    return c.json({
      plan: { ...plan, goal: plan.goal ? plan.goal.slice(0, 2000) : null },
      snapshots,
      sessions,
      requirements: store.requirementsForPath(plan.path).slice(0, 20),
      commits: store.commitsForPath(plan.path).slice(0, 20),
      project: plan.repo ? store.projectByRepo(plan.repo) : null,
    });
  });

  app.get('/api/sessions/:id/todos', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    return c.json({ sessionId: id, todos: store.todoSnapshotsForSession(id) });
  });

  // ④ 尾总结(assistant 自报,message_inferred)+ ⑤ 对账素材(该 session
  // 的归因 commit 数):自报完成与外部证据的并排入口
  app.get('/api/sessions/:id/notes', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    return c.json({
      sessionId: id,
      notes: store.progressNotesForSession(id),
      commitCount: store.listSessionCommits(id).length,
    });
  });

  // ── Handoff(§1.7/§2.5:指针 + 摘要,三通道交付)──────────────────

  const handoffLink = (type: string, id: string): string =>
    `http://localhost:${cfg.port}/#${type === 'planfile' ? 'planfiles' : type === 'session' ? 'sessions' : 'requirements'}/${encodeURIComponent(id)}`;

  /** 已配置 LLM 时合成交接摘要头;失败退化纯证据包,错误带回给前端提示。 */
  const withLlmSummary = async (pkg: ReturnType<typeof buildHandoffPackage>): Promise<{
    pkg: NonNullable<ReturnType<typeof buildHandoffPackage>>;
    summaryError: string | null;
  }> => {
    if (!pkg || !cfg.llm?.provider) return { pkg: pkg!, summaryError: null };
    const summary = await synthesizeHandoffSummary(pkg, cfg.llm);
    if (!summary) return { pkg, summaryError: 'AI 摘要生成失败,已退化为纯证据包' };
    return { pkg: withSummary(pkg, summary), summaryError: null };
  };

  app.get('/api/handoff/:type/:id', async (c) => {
    const type = c.req.param('type') as 'session' | 'requirement' | 'planfile';
    const id = decodeURIComponent(c.req.param('id'));
    const raw = buildHandoffPackage(store, type, id, handoffLink(type, id));
    if (!raw) return c.json({ ok: false, error: 'unknown source' }, 404);
    const { pkg, summaryError } = await withLlmSummary(raw);
    return c.json({
      ...pkg,
      deepLink: handoffLink(type, id),
      providers: handoffProviders(),
      history: store.handoffsFor(type, id),
      llmUsed: !!cfg.llm?.provider,
      summaryError,
    });
  });

  app.post('/api/handoff/:type/:id/deliver', async (c) => {
    const type = c.req.param('type') as 'session' | 'requirement' | 'planfile';
    const id = decodeURIComponent(c.req.param('id'));
    const raw = buildHandoffPackage(store, type, id, handoffLink(type, id));
    if (!raw) return c.json({ ok: false, error: 'unknown source' }, 404);
    const body = await c.req.json().catch(() => ({})) as {
      mode?: 'file' | 'agent'; provider?: string; targetDir?: string;
    };
    const { pkg, summaryError } = await withLlmSummary(raw);
    const mode = body.mode === 'agent' ? 'agent' : 'file';
    const result = deliverHandoff(store, pkg, {
      mode,
      provider: body.provider,
      targetDir: body.targetDir,
    });
    return c.json({ ...result, summaryError }, result.ok ? 200 : 400);
  });

  // ── LLM 配置(provider = 已配置 key 的;model 自由填)─────────────

  app.get('/api/llm/config', (c) => {
    return c.json({
      llm: cfg.llm ?? null,
      providers: llmProviderStatus(),
    });
  });

  // ── 设置:plans 增删改 + auth key(多账号入口)──────────────────

  app.get('/api/config', (c) => {
    return c.json({
      plans: cfg.plans,
      adapters: registeredAdapters(),
      credentials: readAllCredentialIds(),
    });
  });

  app.put('/api/config/plans', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      slug?: string; name?: string; adapter?: string;
      enabled?: boolean; pollIntervalSec?: number; credRef?: string | null;
    } | null;
    if (!body?.slug || !/^[0-9a-z_-]{1,32}$/i.test(body.slug)) {
      return c.json({ ok: false, error: 'slug 必填(字母数字-_，≤32 字符)' }, 400);
    }
    if (!body.adapter || !registeredAdapters().includes(body.adapter)) {
      return c.json({ ok: false, error: `adapter 必须是:${registeredAdapters().join('/')}` }, 400);
    }
    const existing = cfg.plans.find((plan) => plan.slug === body.slug);
    const next: PlanConfig = {
      slug: body.slug,
      name: body.name?.trim() || body.slug,
      adapter: body.adapter,
      enabled: body.enabled ?? existing?.enabled ?? true,
      pollIntervalSec: Math.max(15, body.pollIntervalSec ?? existing?.pollIntervalSec ?? 60),
      credRef: body.credRef ?? existing?.credRef ?? null,
      extra: existing?.extra ?? {},
    };
    cfg.plans = existing
      ? cfg.plans.map((plan) => (plan.slug === body.slug ? next : plan))
      : [...cfg.plans, next];
    savePlansConfig(cfg.plans);
    store.syncPlan(next);
    return c.json({ ok: true, plans: cfg.plans });
  });

  app.delete('/api/config/plans/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!cfg.plans.some((plan) => plan.slug === slug)) {
      return c.json({ ok: false, error: 'unknown plan' }, 404);
    }
    cfg.plans = cfg.plans.filter((plan) => plan.slug !== slug);
    savePlansConfig(cfg.plans);
    store.deletePlan(slug);
    return c.json({ ok: true, plans: cfg.plans });
  });

  // plan 专属凭据:存 key(credentials.json)并把 credRef 指过来;key 空串=清除
  app.post('/api/config/plans/:slug/auth', async (c) => {
    const slug = c.req.param('slug');
    const plan = cfg.plans.find((row) => row.slug === slug);
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);
    const body = await c.req.json().catch(() => null) as { key?: string } | null;
    const key = body?.key?.trim() ?? '';
    if (key) {
      writeCredential(slug, key);
      plan.credRef = slug;
    } else {
      deleteCredential(slug);
      plan.credRef = null;
    }
    savePlansConfig(cfg.plans);
    store.syncPlan(plan);
    return c.json({ ok: true, credRef: plan.credRef });
  });

  app.post('/api/llm/config', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      provider?: string; model?: string; baseUrl?: string;
    };
    if (body.provider !== undefined && body.provider !== '') {
      const known = LLM_PROVIDERS.some((spec) => spec.id === body.provider);
      if (!known) return c.json({ ok: false, error: `未知 provider:${body.provider}` }, 400);
      if (!llmKeyFor(body.provider)) {
        return c.json({ ok: false, error: `${body.provider} 还没有配置 key(auth set 或环境变量)` }, 400);
      }
    }
    saveLlmConfig({
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
    });
    cfg.llm = loadConfig().llm;
    return c.json({ ok: true, llm: cfg.llm ?? null });
  });

  app.post('/api/sessions/:id/resume', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    const result = launchResume(session, { resume: cfg.resume });
    if (!result.ok) return c.json({ ok: false, error: result.error, command: result.command ?? null }, 400);
    return c.json({ ok: true, command: result.command });
  });

  app.post('/api/sessions/:id/reveal', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const session = store.getSession(id);
    if (!session) return c.json({ ok: false, error: 'unknown session' }, 404);
    if (!session.sourceFile) return c.json({ ok: false, error: 'session has no source_file' }, 404);
    if (process.platform !== 'darwin') {
      return c.json({ ok: false, error: 'Finder reveal is macOS-only' }, 501);
    }
    const result = spawnSync('open', ['-R', session.sourceFile], { encoding: 'utf8' });
    if (result.status !== 0) {
      return c.json({ ok: false, error: result.stderr.trim() || 'open -R failed' }, 500);
    }
    return c.json({ ok: true, path: session.sourceFile });
  });

  app.post('/api/plans/:slug/refresh', async (c) => {
    const slug = c.req.param('slug');
    const result = await scheduler.refreshPlan(slug);
    return c.json(result);
  });

  app.post('/api/refresh', async (c) => {
    const plans = store.listPlans().filter((plan) => plan.enabled);
    const results = [];
    for (const plan of plans) {
      results.push(await scheduler.refreshPlan(plan.slug));
    }
    const failed = results.filter((result) => !result.ok);
    const error = failed.length > 0
      ? failed.map((result) => `${result.slug}: ${result.error ?? '刷新失败'}`).join('；')
      : undefined;
    return c.json({
      ok: failed.length === 0,
      results,
      ...(error ? { error } : {}),
    });
  });

  // 仅由用户主动点击触发。浏览器 Cookie/Keychain token 不写入磁盘。
  app.post('/api/browser-auth', async (c) => {
    const browser = KIMI_BROWSER;
    store.updatePlanExtra('kimi', { browser });
    const browserResult = await refreshKimiBrowserSession(browser, (message) => console.log(`[kimi] ${message}`), 'kimi');
    if (!browserResult.token) {
      return c.json(
        {
          ok: false,
          error: `未找到有效 kimi-auth 浏览器会话（${browser}）`,
          warnings: browserResult.warnings,
        },
        401,
      );
    }
    const refreshed = await scheduler.refreshPlan('kimi');
    return c.json(
      {
        ok: refreshed.ok,
        browser,
        source: browserResult.source,
        warnings: browserResult.warnings,
        refreshed,
      },
      refreshed.ok ? 200 : 502,
    );
  });

  app.put('/api/plans/:slug/browser', async (c) => {
    const slug = c.req.param('slug');
    const plan = store.getPlan(slug);
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);
    if (plan.adapter !== 'kimi' && plan.adapter !== 'factory') {
      return c.json({ ok: false, error: `${plan.name} 暂不支持浏览器会话` }, 400);
    }
    let body: { browser?: string } = {};
    try {
      body = (await c.req.json()) as { browser?: string };
    } catch {
      return c.json({ ok: false, error: 'body 必须是 JSON' }, 400);
    }
    if (!body.browser || !KIMI_BROWSERS.includes(body.browser as KimiBrowser)) {
      return c.json({ ok: false, error: '请选择受支持的浏览器' }, 400);
    }
    if (slug === 'kimi' && body.browser !== KIMI_BROWSER) {
      return c.json({ ok: false, error: 'Kimi 仅支持 Safari 浏览器会话' }, 400);
    }
    store.updatePlanExtra(slug, { browser: body.browser });
    return c.json({ ok: true, slug, browser: body.browser });
  });

  app.post('/api/plans/:slug/browser-auth', async (c) => {
    const slug = c.req.param('slug');
    const plan = store.getPlan(slug);
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);
    if (plan.adapter !== 'kimi' && plan.adapter !== 'factory') {
      return c.json({ ok: false, error: `${plan.name} 暂不支持浏览器会话` }, 400);
    }
    if (plan.adapter === 'factory') {
      return c.json({ ok: false, slug, error: 'Factory 浏览器会话请从 menubar 读取' }, 400);
    }
    let body: { browser?: string } = {};
    try {
      body = (await c.req.json()) as { browser?: string };
    } catch {
      return c.json({ ok: false, error: 'body 必须是 JSON' }, 400);
    }
    const browser = body.browser as KimiBrowser;
    if (!KIMI_BROWSERS.includes(browser)) {
      return c.json({ ok: false, error: '请选择受支持的浏览器' }, 400);
    }
    if (browser !== KIMI_BROWSER) {
      return c.json({ ok: false, slug, error: 'Kimi 仅支持 Safari 浏览器会话' }, 400);
    }
    store.updatePlanExtra(slug, { browser });
    const browserResult = await refreshKimiBrowserSession(
      browser,
      (message) => console.log(`[${slug}] ${message}`),
      slug,
    );
    if (!browserResult.token) {
      return c.json(
        { ok: false, slug, browser, error: `未找到有效 kimi-auth（${browser}）`, warnings: browserResult.warnings },
        401,
      );
    }
    const refreshed = await scheduler.refreshPlan(slug);
    return c.json(
      { ok: refreshed.ok, slug, browser, source: browserResult.source, warnings: browserResult.warnings, refreshed },
      refreshed.ok ? 200 : 502,
    );
  });

  // 原生 menubar app 使用 SweetCookieKit 读取 Kimi Safari/Chromium/Firefox 会话后，
  // 只把 kimi-auth 通过 localhost 交给 Bun。Cookie 不落盘。
  app.post('/api/browser-session', async (c) => {
    type BrowserSessionRequest = {
      browser?: string;
      planSlug?: string;
      cookies?: Array<{ domain?: string; name?: string; value?: string }>;
      workos?: {
        accessToken?: string | null;
        refreshToken?: string | null;
        organizationId?: string | null;
        cookies?: Array<{ domain?: string; name?: string; value?: string }>;
      };
    };
    let body: BrowserSessionRequest;
    try {
      body = (await c.req.json()) as BrowserSessionRequest;
    } catch {
      return c.json({ ok: false, error: 'body 必须是 JSON' }, 400);
    }
    const cookies = Array.isArray(body?.cookies) ? body.cookies : [];
    let kimiResult: unknown = null;
    const planSlug = body.planSlug ?? 'kimi';
    if (planSlug === 'kimi' && body.browser !== KIMI_BROWSER) {
      return c.json({ ok: false, planSlug, error: 'Kimi 仅支持 Safari 浏览器会话' }, 400);
    }
    const source = `${body?.browser ?? 'browser'} (native)`;
    const normalizedCookies = cookies.flatMap((cookie) =>
      typeof cookie.name === 'string' && typeof cookie.value === 'string'
        ? [{ ...cookie, name: cookie.name, value: cookie.value }]
        : []
    );
    let accepted = false;
    const importPlan = store.getPlan(planSlug);
    if (planSlug === 'factory' || importPlan?.adapter === 'factory') {
      const workosCookies = (body.workos?.cookies ?? []).flatMap((cookie) =>
        typeof cookie.name === 'string' && typeof cookie.value === 'string'
          ? [{ ...cookie, name: cookie.name, value: cookie.value }]
          : []
      );
      accepted = acceptFactoryBrowserCookies(
        normalizedCookies,
        source,
        body.workos,
        body.workos?.organizationId,
        workosCookies,
        planSlug,
      );
    } else if (planSlug === 'kimi') {
      // Safari can retain more than one kimi-auth record while a session is
      // rotated. Try them in native importer order instead of assuming the
      // first record is the live session.
      const candidates = normalizedCookies.filter((cookie) => cookie.name === 'kimi-auth');
      for (const candidate of candidates) {
        const candidateCookies = normalizedCookies
          .filter((cookie) => cookie.name !== 'kimi-auth')
          .concat(candidate);
        if (!acceptKimiBrowserCookies(candidateCookies, source, planSlug)) continue;
        accepted = true;
        kimiResult = await scheduler.refreshPlan(planSlug);
        if (
          typeof kimiResult === 'object' &&
          kimiResult != null &&
          'ok' in kimiResult &&
          (kimiResult as { ok?: unknown }).ok === true
        ) {
          break;
        }
      }
    } else {
      accepted = acceptKimiBrowserCookies(normalizedCookies, source, planSlug);
    }
    if (accepted) {
      store.updatePlanExtra(planSlug, { browser: body.browser ?? null });
      if (planSlug !== 'kimi') {
        kimiResult = await scheduler.refreshPlan(planSlug);
      }
    }
    const ok = typeof kimiResult === 'object'
      && kimiResult != null
      && 'ok' in kimiResult
      && (kimiResult as { ok?: unknown }).ok === true;
    return c.json(
      {
        ok,
        planSlug,
        browser: body?.browser ?? null,
        cookieNames: [...new Set(cookies.map((cookie) => cookie.name).filter(Boolean))],
        kimi: kimiResult,
      },
      ok ? 200 : 502,
    );
  });

  app.put('/api/plans/:slug/auth', async (c) => {
    const slug = c.req.param('slug');
    const plan = store.getPlan(slug);
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);

    let body: { mode?: string; apiKey?: string } | null = null;
    try {
      body = (await c.req.json()) as { mode?: string; apiKey?: string };
    } catch {
      return c.json({ ok: false, error: 'body 必须是 JSON' }, 400);
    }

    if (body.mode === 'manual' && typeof body.apiKey === 'string' && body.apiKey.trim()) {
      writeCredential(slug, body.apiKey.trim());
      store.updatePlanRuntime(slug, { cred_ref: slug });
      const result = await scheduler.refreshPlan(slug);
      return c.json({ ok: true, manual: true, refreshed: result });
    }

    if (body.mode === 'auto') {
      deleteCredential(slug);
      store.updatePlanRuntime(slug, { cred_ref: null });
      const result = await scheduler.refreshPlan(slug);
      return c.json({ ok: true, manual: false, refreshed: result });
    }

    return c.json({ ok: false, error: '支持 mode: manual(apiKey) | auto' }, 400);
  });

  app.put('/api/plans/:slug/enabled', async (c) => {
    const slug = c.req.param('slug');
    const plan = store.getPlan(slug);
    if (!plan) return c.json({ ok: false, error: 'unknown plan' }, 404);
    let body: { enabled?: boolean } | null = null;
    try {
      body = (await c.req.json()) as { enabled?: boolean };
    } catch {
      return c.json({ ok: false, error: 'body 必须是 JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled 必须是 boolean' }, 400);
    }
    store.updatePlanRuntime(slug, { enabled: body.enabled });
    return c.json({ ok: true, enabled: body.enabled });
  });

  // 静态前端（无构建）
  app.get('*', async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = resolve(WEB_DIR, '.' + pathname);
    if (
      !isAbsolute(target) ||
      (target !== WEB_DIR && !target.startsWith(WEB_DIR + '/'))
    ) {
      return c.text('forbidden', 403);
    }
    const file = Bun.file(target);
    if (await file.exists()) {
      // 本地 dashboard 的 HTML/JS/CSS 会随源码更新；无缓存头时浏览器会启发式缓存
      // 旧 app.js，导致界面改动“不生效”。no-cache = 每次回源校验（配合 ETag 304）。
      return new Response(file, { headers: { 'Cache-Control': 'no-cache' } });
    }
    return c.text('not found', 404);
  });

  // 只读 MCP server(streamable HTTP 子集):被监控的 agent 反过来查配额与谱系。
  // 工具面见 src/mcp.ts;Host 校验同样覆盖。必须注册在静态兜底之前。
  registerMcpRoutes(app, store, cfg);

  // 文件监听(参照 obelisk ADR-0009 的形态):根目录 recursive watch + 静默窗
  // 防抖 + 有界批。flush 不重造扫描——spawn 同一个 sessions --refresh 子进程,
  // 行级水位保证未变文件近零成本;与页面触发的单飞闸门互斥。
  // PLANOFPLAN_DISABLE_WATCHER=1 是运维逃生门:watcher 异常时不用回滚代码。
  if (options.live && process.env.PLANOFPLAN_DISABLE_WATCHER !== '1') {
    const watcher = startSessionWatcher((paths) => {
      sessionIndexLast.changedFiles = paths.length;
      startSessionIndex(30, 'watch');
    });
    if (watcher.roots.length > 0) {
      console.log(`[watcher] watching ${watcher.roots.length} session roots for live indexing`);
    }
  }

  return app;
}
