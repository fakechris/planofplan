/* planofplan 前端：provider 级 quota command center（无构建，vanilla JS） */
'use strict';

const STATUS_TEXT = {
  ok: '正常运行',
  stale: '数据过期',
  error: '拉取失败',
  not_configured: '待配置',
  auth_error: '凭据失效',
  unavailable: '未接入',
};

const BROWSER_NAMES = {
  safari: 'Safari',
  chrome: 'Chrome',
  firefox: 'Firefox',
  brave: 'Brave',
  arc: 'Arc',
  chromium: 'Chromium',
  comet: 'Comet',
  dia: 'Dia',
};

let latestOverview = null;
let latestBuildInfo = null;
let latestUsage = null;
let latestSessions = null;
let openSessionId = null;
let sessionVisibleCount = 40;
let sessionIndexPollTimer = null;
let sessionView = 'list';

function fmtTime(ms, withSeconds = false) {
  if (ms == null) return '--';
  const d = new Date(ms);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(d);
}

function fmtCountdown(resetAt, now) {
  if (resetAt == null) return '恢复时间未知';
  const diff = resetAt - now;
  if (diff <= 0) return '已恢复';
  const totalMinutes = Math.max(1, Math.ceil(diff / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}分钟后`;
  if (hours < 24) return `${hours}小时${minutes}分钟后`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}天${restHours}小时后` : `${days}天后`;
}

function fmtAgo(ms, now) {
  if (ms == null) return '';
  const diff = Math.max(0, now - ms);
  const m = Math.round(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  const restHours = h % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时前` : `${days} 天前`;
}

function groupedNumber(n, digits) {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// /plans 拖拽排序：localStorage 保存用户拖过的顺序，applyOrder 在 render 时套用。
const ORDER_KEY = 'planofplan.planOrder.v1';

function loadPlanOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function savePlanOrder(slugs) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(slugs));
  } catch {
    /* localStorage 不可用（隐私模式）则静默丢弃 — UI 仍可拖动，只是不持久化 */
  }
}

function applyOrder(plans) {
  const order = loadPlanOrder();
  if (!order.length) return plans;
  const idx = new Map(order.map((slug, i) => [slug, i]));
  return [...plans].sort((a, b) => {
    const ai = idx.has(a.slug) ? idx.get(a.slug) : Number.POSITIVE_INFINITY;
    const bi = idx.has(b.slug) ? idx.get(b.slug) : Number.POSITIVE_INFINITY;
    return ai - bi;
  });
}

// 拖拽进行中：30s 自动 poll 替换 DOM 会打断拖拽，守卫 render() 跳过替换。
let dragInFlight = false;

function levelClass(percentage) {
  if (percentage == null) return 'unknown';
  if (percentage < 75) return 'ok';
  if (percentage < 90) return 'warn';
  return 'bad';
}

/** 时间进度百分比：窗口已过去的时间占比。 */
function timePacePercentage(w, now) {
  if (w.startedAt == null || w.resetAt == null) return null;
  const total = w.resetAt - w.startedAt;
  if (total <= 0) return null;
  const elapsed = now - w.startedAt;
  const pct = Math.round((elapsed / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

function authLabel(status) {
  return {
    manual: '手动 key',
    auto: '自动凭据',
    missing: '无凭据',
    invalid: '凭据失效',
    unknown: '未检测',
  }[status] ?? status;
}

function tierGlyph(tier) {
  return tier === 'peak' ? '☀' : '🌙';
}

function tierLabel(tier) {
  return tier === 'peak' ? '高峰' : '空闲';
}

function tierMultiplierText(multiplier) {
  if (multiplier == null) return '';
  const rounded = Math.round(multiplier * 100) / 100;
  return `${rounded}×`;
}

function tierCountdownText(nextChangeAt, now) {
  if (nextChangeAt == null) return '';
  const diff = nextChangeAt - now;
  if (diff <= 0) return '即将切换';
  const totalMinutes = Math.max(1, Math.ceil(diff / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分后切换`;
  if (hours < 24) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ''}后切换`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} 天 ${restHours} 小时后切换` : `${days} 天后切换`;
}

function renderTierPill(plan, now) {
  const tier = plan.tier;
  if (!tier || !tier.tier) return '';
  const countdown = tierCountdownText(tier.nextChangeAt, now);
  const tooltipParts = [
    tier.label,
    tier.timezone ? `（${tier.timezone}）` : '',
    tier.multiplier != null ? `  费率 ${tierMultiplierText(tier.multiplier)}` : '',
    countdown ? `\n${countdown}` : '',
  ].filter(Boolean);
  return `<span class="badge tier tier-${escapeHtml(tier.tier)}" title="${escapeHtml(tooltipParts.join(''))}">
    <i></i>${tierGlyph(tier.tier)} ${tierLabel(tier.tier)}${tier.multiplier != null ? ` ${tierMultiplierText(tier.multiplier)}` : ''}
  </span>`;
}

/** Claude Code 上次用 `claude-fable-5` 超过 24h 时显示醒目 badge（参考 glm 高峰/低谷 pill）。 */
const FABLE_IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function renderFableIdlePill(plan, now) {
  if (plan.adapter !== 'claude') return '';
  if (plan.fableLastUsedAt == null) return '';
  const idleMs = now - plan.fableLastUsedAt;
  if (idleMs < FABLE_IDLE_THRESHOLD_MS) return '';
  const label = idleMs < 48 * 60 * 60 * 1000
    ? `${Math.round(idleMs / (60 * 60 * 1000))}h`
    : `${Math.round(idleMs / (24 * 60 * 60 * 1000))}d`;
  return `<span class="badge fable-idle" title="fable-5 已 ${escapeHtml(label)} 未使用">
    <i></i>⚠ fable-5 空闲 ${escapeHtml(label)}
  </span>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  return data;
}

async function load() {
  const days = document.getElementById('usageDays')?.value || '30';
  const [overview, buildInfo, usage, sessions] = await Promise.all([
    request('/api/overview'),
    request('/api/build-info'),
    request(`/api/usage?days=${encodeURIComponent(days)}`),
    request(`/api/sessions?days=${encodeURIComponent(days)}`).catch(() => null),
  ]);
  return { overview, buildInfo, usage, sessions };
}

function sessionRepos(session, role) {
  return (session?.repos || []).filter((repo) => !role || repo.role === role);
}

function sessionProjectNames(session) {
  const touch = sessionRepos(session, 'touch').map((repo) => repo.name).filter(Boolean);
  if (touch.length > 0) return [...new Set(touch)];
  if (typeof session === 'string' || session == null) {
    if (!session) return ['(unknown)'];
    return [String(session).replace(/[/\\]+$/, '').split(/[/\\]/).pop() || session];
  }
  if (session.gitName) return [session.gitName];
  if (!session.cwd) return ['(unknown)'];
  return [session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || session.cwd];
}

function sessionProjectName(session) {
  return sessionProjectNames(session).join(', ');
}

function fillSessionFilters(list) {
  const providerSel = document.getElementById('sessionProvider');
  const projectSel = document.getElementById('sessionProject');
  if (!providerSel || !projectSel || !list) return;
  const provider = providerSel.value;
  const project = projectSel.value;
  providerSel.innerHTML = '<option value="">全部来源</option>' + (list.byProvider || []).map((row) => (
    `<option value="${escapeHtml(row.provider)}">${escapeHtml(row.provider)} (${row.count})</option>`
  )).join('');
  projectSel.innerHTML = '<option value="">全部项目</option>' + (list.byProject || []).map((row) => (
    `<option value="${escapeHtml(row.project)}">${escapeHtml(row.project)} (${row.count})</option>`
  )).join('');
  if ([...providerSel.options].some((option) => option.value === provider)) providerSel.value = provider;
  if ([...projectSel.options].some((option) => option.value === project)) projectSel.value = project;
}

function filteredSessions(list) {
  const provider = document.getElementById('sessionProvider')?.value || '';
  const project = document.getElementById('sessionProject')?.value || '';
  const query = (document.getElementById('sessionSearch')?.value || '').trim().toLowerCase();
  const hideUntitled = document.getElementById('sessionHideUntitled')?.checked;
  return (list?.sessions || []).filter((session) => {
    const title = session.title || '';
    const untitled = !title.trim();
    if (hideUntitled && untitled) return false;
    if (provider && session.provider !== provider) return false;
    if (project && !sessionProjectNames(session).includes(project)) return false;
    // 与已发往服务端的 q 一致时,列表已是「元数据 ∪ 消息正文 FTS」的并集,
    // 本地再按元数据过滤会把 FTS 命中的条目误杀
    if (query && query !== sessionServerQuery) {
      const hay = [
        session.provider, title, session.cwd || '', sessionProjectName(session),
        session.gitRoot || '', session.gitUrl || '', session.nativeId || '',
        ...(session.repos || []).flatMap((repo) => [repo.name, repo.url, repo.root, repo.role]),
      ].join(' ').toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      if (!tokens.every((token) => hay.includes(token))) return false;
    }
    return true;
  });
}

function renderSessions(list) {
  const listEl = document.getElementById('sessionList');
  const readerEl = document.getElementById('sessionReader');
  const foot = document.getElementById('sessionFoot');
  if (!listEl || !readerEl) return;
  fillSessionFilters(list);
  const indexing = list?.indexStatus === 'running';
  const indexedLabel = list?.indexedAt ? `上次索引 ${fmtAgo(list.indexedAt, Date.now())}` : '尚未索引';
  if (foot) {
    foot.textContent = indexing
      ? '正在索引本机对话目录… 不用盯着扫。编好后会出现在左边。'
      : `${indexedLabel} · 本机只读 ~/.claude / ~/.codex / ~/.grok / ~/.dsh 等目录 · daemon 启动时自动更新，不用定时手扫 · Token 数字请看 Token 页`;
  }
  if (!list || list.sessions.length === 0) {
    listEl.innerHTML = `
      <div class="usage-empty">
        <strong>${indexing ? '正在建立目录' : '还没有对话'}</strong>
        <span>${indexing ? '第一次大约几十秒，之后只扫有改动的文件。' : '确认 daemon 在跑。打开这页或重启 planofplan 会自动索引。'}</span>
      </div>
    `;
    return;
  }
  const sessions = filteredSessions(list);
  if (sessions.length === 0) {
    listEl.innerHTML = `
      <div class="usage-empty">
        <strong>没有匹配的对话</strong>
        <span>试试关掉「隐藏无标题」，或清空搜索。</span>
      </div>
    `;
    return;
  }
  const visible = sessions.slice(0, sessionVisibleCount);
  const open = sessions.find((session) => session.id === openSessionId)
    || (latestSessions?.sessions || []).find((session) => session.id === openSessionId);
  listEl.innerHTML = sessionView === 'projects'
    ? projectListHtml(visible, sessions.length)
    : sessionListHtml(visible, sessions.length);
  listEl.querySelectorAll('[data-session-id]').forEach((row) => {
    row.addEventListener('click', () => {
      openSessionId = row.getAttribute('data-session-id');
      renderSessions(latestSessions);
    });
  });
  listEl.querySelector('[data-more]')?.addEventListener('click', () => {
    sessionVisibleCount += 40;
    renderSessions(latestSessions);
  });
  listEl.querySelectorAll('[data-filter-project]').forEach((row) => {
    row.addEventListener('click', () => {
      const projectSel = document.getElementById('sessionProject');
      if (projectSel) projectSel.value = row.getAttribute('data-filter-project') || '';
      resetSessionFilters();
    });
  });
  if (open) {
    readerEl.innerHTML = sessionDetailHtml(open, sessions);
    readerEl.querySelector('[data-reveal]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = event.currentTarget.getAttribute('data-reveal');
      try {
        await request(`/api/sessions/${encodeURIComponent(id)}/reveal`, { method: 'POST' });
        showToast('已在 Finder 中显示日志');
      } catch (error) {
        showToast(error.message, true);
      }
    });
    readerEl.querySelectorAll('[data-related]').forEach((row) => {
      row.addEventListener('click', () => {
        openSessionId = row.getAttribute('data-related');
        renderSessions(latestSessions);
      });
    });
    void loadSessionTranscript(open.id);
    void loadSessionAttribution(open);
  } else {
    readerEl.innerHTML = `
      <div class="usage-empty">
        <strong>${sessionView === 'projects' ? '从左边选一个项目里的需求' : '从左边选一条对话'}</strong>
        <span>需求来自用户消息流抽取，项目来自 git 仓库。有 CLI 时可以 Resume。</span>
      </div>
    `;
  }
}

function sessionItemHtml(session) {
  const hit = session.messageHit;
  const hitHtml = hit
    ? `<span class="session-hit">${highlightHit(hit.snippet)} · ${hit.count} 处命中</span>`
    : '';
  return `
    <button type="button" class="session-item${session.id === openSessionId ? ' active' : ''}" data-session-id="${escapeHtml(session.id)}">
      <strong>${escapeHtml(session.requirement || session.title || '无标题')}</strong>
      <span>${escapeHtml(session.provider)} · ${escapeHtml(sessionProjectName(session))} · ${fmtAgo(session.updatedAt, Date.now())}${session.totalTokens ? ` · ${fmtTokens(session.totalTokens)}` : ''}</span>
      ${hitHtml}
    </button>
  `;
}

// snippet 里的 \u0001/\u0002 是服务端 snippet() 的命中标记,转义后再换成高亮标签
function highlightHit(snippet) {
  return escapeHtml(snippet || '').replaceAll('\u0001', '<b>').replaceAll('\u0002', '</b>');
}

function sessionListHtml(visible, total) {
  return visible.map(sessionItemHtml).join('') + (total > visible.length
    ? `<button type="button" class="session-more" data-more>还有 ${total - visible.length} 条，显示更多</button>`
    : '');
}

function projectListHtml(visible, total) {
  const groups = [];
  const byName = new Map();
  for (const session of visible) {
    for (const name of sessionProjectNames(session)) {
      let group = byName.get(name);
      if (!group) {
        group = { name, sessions: [] };
        byName.set(name, group);
        groups.push(group);
      }
      group.sessions.push(session);
    }
  }
  return groups.map((group) => `
    <div class="session-group">
      <button type="button" class="session-group-head" data-filter-project="${escapeHtml(group.name)}">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.sessions.length} 条需求</span>
      </button>
      ${group.sessions.map(sessionItemHtml).join('')}
    </div>
  `).join('') + (total > visible.length
    ? `<button type="button" class="session-more" data-more>还有 ${total - visible.length} 条，显示更多</button>`
    : '');
}

async function loadSessionTranscript(id) {
  const box = document.getElementById('sessionTranscript');
  if (!box) return;
  box.innerHTML = '<div class="muted">读取对话…</div>';
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(id)}/transcript`);
    box.innerHTML = transcriptHtml(data);
    box.querySelector('[data-resume]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await request(`/api/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' });
        showToast(data.resume?.kind === 'url' || data.resume?.kind === 'app' ? '已打开' : '已在 Terminal 中 resume');
      } catch (error) {
        showToast(error.message, true);
      }
    });
  } catch (error) {
    box.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
  }
}

function transcriptHtml(data) {
  const turns = (data.turns || []).map((turn) => {
    const label = turn.role === 'tool'
      ? `tool · ${turn.toolName || 'call'}`
      : turn.role === 'user' ? 'You' : 'Assistant';
    return `<div class="turn turn-${escapeHtml(turn.role)}"><span>${escapeHtml(label)}</span><p>${escapeHtml(turn.text || '')}</p></div>`;
  }).join('');
  const resume = data.resume?.available
    ? `<button class="button-primary" type="button" data-resume>${escapeHtml(data.resume.label || 'Resume')}</button>`
    : `<span class="muted">${escapeHtml(data.resume?.reason || '此来源不能 resume')}</span>`;
  return `
    <div class="session-actions">${resume}</div>
    <div class="transcript">${turns || '<div class="muted">没有可读的对话正文</div>'}</div>
    ${data.truncated ? '<div class="muted">正文已截断（大日志只读前若干轮）</div>' : ''}
  `;
}

// ── 归因链展示:文件 touch + commit ─────────────────────────────
// 与 transcript 同一时机加载,但独立请求、独立失败——失败/无数据时区块
// 保持空(session-attrs:empty 隐藏),不影响详情其余部分。

const ATTR_FOLD_LIMIT = 20;

function loadSessionAttribution(session) {
  const filesEl = document.getElementById('sessionFiles');
  const commitsEl = document.getElementById('sessionCommits');
  if (!filesEl || !commitsEl) return;
  // session id 形如 provider:nativeId,按第一个 : 切开
  const sep = session.id.indexOf(':');
  const provider = session.id.slice(0, sep);
  const nativeId = session.id.slice(sep + 1);
  const base = `/api/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(nativeId)}`;
  request(`${base}/touches`)
    .then((data) => {
      filesEl.innerHTML = filesBlockHtml(data.touches || [], session);
      bindAttrFold(filesEl);
    })
    .catch(() => { filesEl.innerHTML = ''; });
  request(`${base}/commits`)
    .then((data) => {
      commitsEl.innerHTML = commitsBlockHtml(data.commits || []);
      bindAttrFold(commitsEl);
    })
    .catch(() => { commitsEl.innerHTML = ''; });
}

function bindAttrFold(el) {
  const btn = el.querySelector('[data-attr-expand]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    el.querySelector('[data-attr-rest]')?.removeAttribute('hidden');
    btn.remove();
  });
}

// 路径显示:能相对项目根(cwd / gitRoot / work repo root)就显示相对部分;
// 太长中间截断;完整路径放 title
function displayPath(filePath, session) {
  const bases = [
    session.cwd,
    session.gitRoot,
    ...(session.repos || []).map((repo) => repo.root),
  ].filter(Boolean);
  for (const base of bases) {
    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  }
  if (filePath.length <= 72) return filePath;
  return `${filePath.slice(0, 40)}…${filePath.slice(-28)}`;
}

function attrFoldHtml(restHtml, restCount, label) {
  if (restCount === 0) return '';
  return `<div data-attr-rest hidden>${restHtml}</div>
    <button type="button" class="session-more" data-attr-expand>还有 ${restCount} ${label},展开</button>`;
}

function filesBlockHtml(touches, session) {
  if (touches.length === 0) return '';
  const byPath = new Map();
  for (const touch of touches) {
    let agg = byPath.get(touch.filePath);
    if (!agg) {
      agg = { ops: new Set(), count: 0, lastTs: 0 };
      byPath.set(touch.filePath, agg);
    }
    agg.ops.add(touch.op);
    agg.count += 1;
    if (touch.ts && touch.ts > agg.lastTs) agg.lastTs = touch.ts;
  }
  const rows = [...byPath.entries()]
    .sort((a, b) => b[1].lastTs - a[1].lastTs);
  const rowHtml = ([filePath, agg]) => `
    <div class="attr-row" title="${escapeHtml(filePath)}">
      <span class="attr-path">${escapeHtml(displayPath(filePath, session))}</span>
      <span class="attr-meta">${escapeHtml([...agg.ops].sort().join('/'))} · ${agg.count} 次${agg.lastTs ? ` · ${fmtAgo(agg.lastTs, Date.now())}` : ''}</span>
    </div>`;
  const shown = rows.slice(0, ATTR_FOLD_LIMIT).map(rowHtml).join('');
  const restRows = rows.slice(ATTR_FOLD_LIMIT);
  const rest = restRows.map(rowHtml).join('');
  return `<h3>文件</h3>${shown}${attrFoldHtml(rest, restRows.length, '个文件')}`;
}

// repo 可能是本地路径、git@host:org/repo.git 或 https://host/org/repo.git;
// 能归一化成 http(s) 的返回 commit 详情页 URL(GitLab 用 /-/commit/),否则 null
function commitUrl(repo, sha) {
  if (!repo || !sha) return null;
  let url = repo.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https?:\/\//.test(url)) return null;
  const path = /gitlab/i.test(url) ? '/-/commit/' : '/commit/';
  return `${url}${path}${encodeURIComponent(sha)}`;
}

function commitsBlockHtml(commits) {
  if (commits.length === 0) return '';
  const rows = [...commits].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const rowHtml = (commit) => {
    // ● 高置信(trailer 声明 / 文件交集),○ 纯时间窗 candidate
    const strong = commit.kind === 'declared' || commit.fileOverlap;
    // 本地未推送的 commit 渲染远端链接必然 404:pushed === false 时只显示纯文本 sha
    const url = commit.pushed === false ? null : commitUrl(commit.repo, commit.sha);
    const sha = escapeHtml(commit.sha.slice(0, 8));
    const shaHtml = url
      ? `<a class="attr-sha" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${sha}</a>`
      : `<span class="attr-sha${commit.pushed === false ? ' attr-dim' : ''}">${sha}</span>`;
    const titleSuffix = commit.pushed === false ? ' · 本地提交,未推送' : '';
    return `
    <div class="attr-row${strong ? '' : ' attr-dim'}" title="${escapeHtml(commit.sha)} · ${escapeHtml(commit.repo)}${titleSuffix}">
      <span class="attr-dot${strong ? ' attr-dot-strong' : ''}">${strong ? '●' : '○'}</span>
      ${shaHtml}
      <span class="attr-summary">${escapeHtml(commit.summary || '(no subject)')}</span>
      <span class="attr-meta">${commit.ts ? fmtAgo(commit.ts, Date.now()) : ''}</span>
    </div>`;
  };
  const shown = rows.slice(0, ATTR_FOLD_LIMIT).map(rowHtml).join('');
  const restRows = rows.slice(ATTR_FOLD_LIMIT);
  const rest = restRows.map(rowHtml).join('');
  return `<h3>提交 <span class="muted">● 声明/文件交集 · ○ 时间窗</span></h3>${shown}${attrFoldHtml(rest, restRows.length, '条提交')}`;
}

// ── 图谱页:work graph 全局可视化 ──────────────────────────────
// 三层列式(需求 | 对话 | commit)+ project 泳道。SVG 手写、DOM 构建
// (textContent 赋值,天然免转义)。容器滚动,不做 pan/zoom。

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRAPH_ROW_H = 26;
const GRAPH_LANE_HEAD = 30;
const GRAPH_LANE_GAP = 18;
const GRAPH_COL_X = { req: 8, session: 320, commit: 700 };
const GRAPH_COL_W = { req: 280, session: 340, commit: 350 };
const GRAPH_WIDTH = 1070;
const GRAPH_COMMITS_PER_SESSION = 8;
const GRAPH_NODE_GUARD = 800;

let graphShowCandidates = false;
let graphIncludeSubagents = false;

// subagent 过滤在服务端(buildWorkGraph includeSubagents),切换时需带参重取
async function refreshGraph() {
  if (graphIncludeSubagents) {
    try {
      const days = document.getElementById('usageDays')?.value || '30';
      renderGraph(await request(`/api/sessions?days=${encodeURIComponent(days)}&subagents=1`));
      return;
    } catch {
      /* 失败退回缓存数据 */
    }
  }
  renderGraph(latestSessions);
}

function clipLabel(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function renderGraph(list) {
  const el = document.getElementById('graphCanvas');
  if (!el) return;
  const stats = document.getElementById('graphStats');
  const graph = list?.graph;
  if (!graph || !(graph.nodes || []).length) {
    el.innerHTML = '<div class="usage-empty"><strong>还没有图数据</strong><span>先让 daemon 完成一轮 session 索引。</span></div>';
    if (stats) stats.textContent = '';
    return;
  }
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const reqBySession = new Map();
  const commitsBySession = new Map();
  const projectOfSession = new Map();
  const commitRepo = new Map();
  for (const e of graph.edges || []) {
    if (e.kind === 'has-requirement') {
      const req = nodesById.get(e.to);
      if (req) reqBySession.set(e.from, req);
    } else if (e.kind === 'landed-in') {
      const commit = nodesById.get(e.to);
      if (!commit) continue;
      const arr = commitsBySession.get(e.from) ?? [];
      arr.push({ node: commit, evidence: e.evidenceKind });
      commitsBySession.set(e.from, arr);
    } else if (e.kind === 'worked-in' || e.kind === 'touched') {
      if (!projectOfSession.has(e.from)) projectOfSession.set(e.from, e.to.replace(/^project:/, ''));
    } else if (e.kind === 'in-project' && e.from.startsWith('commit:')) {
      commitRepo.set(e.from, e.to.replace(/^project:/, ''));
    }
  }

  // project 过滤下拉(重绘时保留选择)
  const sel = document.getElementById('graphProject');
  const prevSel = sel?.value || 'all';
  if (sel) {
    sel.innerHTML = '<option value="all">全部项目</option>'
      + (graph.projects || []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === prevSel) ? prevSel : 'all';
  }
  const projectFilter = sel?.value || 'all';

  // 泳道分组:session 按 project 归道,未归属垫底
  const laneMap = new Map();
  for (const s of graph.nodes.filter((n) => n.kind === 'session')) {
    const pid = projectOfSession.get(s.id) || null;
    if (projectFilter !== 'all' && pid !== projectFilter) continue;
    if (!laneMap.has(pid)) laneMap.set(pid, []);
    laneMap.get(pid).push(s);
  }
  const projectById = new Map((graph.projects || []).map((p) => [p.id, p]));
  const laneEntries = [...laneMap.entries()].sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    const ac = projectById.get(a[0])?.sessionCount ?? 0;
    const bc = projectById.get(b[0])?.sessionCount ?? 0;
    return bc - ac || a[0].localeCompare(b[0]);
  });

  // 节点数量保护:>800 时强制只画高置信 commit
  const hiConf = (c) => c.evidence === 'declared' || c.node.fileOverlap;
  const countFor = (candidates) => laneEntries.reduce((n, [, sessions]) => (
    n + sessions.length * 2 + sessions.reduce((m, s) => {
      const all = commitsBySession.get(s.id) || [];
      return m + Math.min((candidates ? all : all.filter(hiConf)).length, GRAPH_COMMITS_PER_SESSION);
    }, 0)
  ), 0);
  let effectiveCandidates = graphShowCandidates;
  let guardNote = '';
  if (effectiveCandidates && countFor(true) > GRAPH_NODE_GUARD) {
    effectiveCandidates = false;
    guardNote = '节点过多,已收敛到高置信';
  }
  const cb = document.getElementById('graphCandidates');
  if (cb) cb.disabled = !!guardNote;

  // 布局:session 行高 = 其 commit 数(封顶 8)撑开,需求与 session 同水平线
  const pos = new Map();
  const laneHeaders = [];
  const moreLabels = [];
  let y = 10;
  let commitShown = 0;
  let commitTotal = 0;
  for (const [pid, sessions] of laneEntries) {
    const name = pid ? (projectById.get(pid)?.name || pid) : '未归属';
    laneHeaders.push({ name, y });
    y += GRAPH_LANE_HEAD;
    for (const s of sessions) {
      const all = commitsBySession.get(s.id) || [];
      commitTotal += all.length;
      const commits = effectiveCandidates ? all : all.filter(hiConf);
      const shown = commits.slice(0, GRAPH_COMMITS_PER_SESSION);
      commitShown += shown.length;
      const rowH = Math.max(1, shown.length) * GRAPH_ROW_H;
      const cy = y + rowH / 2;
      pos.set(s.id, {
        x: GRAPH_COL_X.session, y: cy, w: GRAPH_COL_W.session, kind: 'session',
        label: `${s.provider} · ${clipLabel(s.label, 26)}`, title: s.label,
      });
      const req = reqBySession.get(s.id);
      if (req) {
        pos.set(req.id, {
          x: GRAPH_COL_X.req, y: cy, w: GRAPH_COL_W.req, kind: 'requirement',
          label: clipLabel(req.label, 26), title: req.label,
        });
      }
      shown.forEach((c, i) => {
        pos.set(c.node.id, {
          x: GRAPH_COL_X.commit, y: y + i * GRAPH_ROW_H + GRAPH_ROW_H / 2, w: GRAPH_COL_W.commit,
          kind: 'commit', label: `${c.node.id.slice(7, 15)} ${clipLabel(c.node.label, 30)}`,
          title: c.node.label, fileOverlap: !!c.node.fileOverlap,
        });
      });
      if (commits.length > shown.length) {
        moreLabels.push({
          x: GRAPH_COL_X.commit,
          y: y + shown.length * GRAPH_ROW_H + GRAPH_ROW_H / 2,
          text: `+${commits.length - shown.length} 条`,
        });
      }
      y += rowH;
    }
    y += GRAPH_LANE_GAP;
  }
  const drawnSessions = [...pos.values()].filter((p) => p.kind === 'session').length;
  if (stats) {
    stats.textContent = `${laneEntries.length} 个项目 · ${drawnSessions} 对话 · commit ${commitShown}/${commitTotal}${guardNote ? ` · ${guardNote}` : ''}`;
  }

  // 绘制(先边后节点,边压在节点下)
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(GRAPH_WIDTH));
  svg.setAttribute('height', String(Math.max(y, 120)));
  svg.setAttribute('class', 'graph-svg');

  for (const header of laneHeaders) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '8');
    text.setAttribute('y', String(header.y + 16));
    text.setAttribute('class', 'glane-title');
    text.textContent = header.name;
    svg.appendChild(text);
    const rule = document.createElementNS(SVG_NS, 'line');
    rule.setAttribute('x1', '8');
    rule.setAttribute('x2', String(GRAPH_WIDTH - 8));
    rule.setAttribute('y1', String(header.y + 22));
    rule.setAttribute('y2', String(header.y + 22));
    rule.setAttribute('class', 'glane-rule');
    svg.appendChild(rule);
  }

  const adj = new Map();
  const link = (a, b, edgeId) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b).add(edgeId);
    adj.get(b).add(a).add(edgeId);
  };
  for (const e of graph.edges || []) {
    if (e.kind !== 'has-requirement' && e.kind !== 'landed-in') continue;
    const from = pos.get(e.from);
    const to = pos.get(e.to);
    if (!from || !to) continue; // 被过滤/折叠的端点不画
    const edgeId = `e:${e.from}→${e.to}`;
    const weak = e.kind === 'landed-in' && e.evidenceKind !== 'declared' && !to.fileOverlap;
    const path = document.createElementNS(SVG_NS, 'path');
    const x1 = from.x + from.w;
    const x2 = to.x;
    const mx = x1 + (x2 - x1) / 2;
    path.setAttribute('d', `M ${x1} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${x2} ${to.y}`);
    path.setAttribute('class', `gedge${weak ? ' gedge-weak' : ''}`);
    path.setAttribute('data-id', edgeId);
    svg.appendChild(path);
    link(e.from, e.to, edgeId);
  }

  for (const [id, p] of pos) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `gnode g-${p.kind}`);
    g.setAttribute('data-id', id);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(p.x));
    rect.setAttribute('y', String(p.y - 11));
    rect.setAttribute('width', String(p.w));
    rect.setAttribute('height', '22');
    rect.setAttribute('rx', '6');
    g.appendChild(rect);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(p.x + 8));
    text.setAttribute('y', String(p.y + 4));
    text.textContent = p.label;
    g.appendChild(text);
    const tip = document.createElementNS(SVG_NS, 'title');
    tip.textContent = p.title || p.label;
    g.appendChild(tip);
    svg.appendChild(g);
  }
  for (const more of moreLabels) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(more.x + 8));
    text.setAttribute('y', String(more.y + 4));
    text.setAttribute('class', 'g-more');
    text.textContent = more.text;
    svg.appendChild(text);
  }

  // hover 高亮整条链;点击:session → 对话页详情,commit → repo 的 commit 页
  svg.addEventListener('mouseover', (event) => {
    const g = event.target.closest?.('.gnode');
    if (!g) return;
    const id = g.getAttribute('data-id');
    const keep = new Set([id, ...(adj.get(id) || [])]);
    svg.querySelectorAll('.gnode, .gedge').forEach((n) => {
      n.classList.toggle('g-dim', !keep.has(n.getAttribute('data-id')));
    });
  });
  svg.addEventListener('mouseout', () => {
    svg.querySelectorAll('.g-dim').forEach((n) => n.classList.remove('g-dim'));
  });
  svg.addEventListener('click', (event) => {
    const g = event.target.closest?.('.gnode');
    if (!g) return;
    const id = g.getAttribute('data-id') || '';
    const p = pos.get(id);
    if (p?.kind === 'session') {
      openSessionId = id;
      showTab('sessions');
      renderSessions(latestSessions);
    } else if (p?.kind === 'commit') {
      const url = commitUrl(commitRepo.get(id), id.slice(7));
      if (url) window.open(url, '_blank', 'noopener');
    }
  });

  el.replaceChildren(svg);
}

function sessionDetailHtml(session, pool) {
  const mine = new Set(sessionProjectNames(session));
  const related = (pool || []).filter((row) => (
    row.id !== session.id && sessionProjectNames(row).some((name) => mine.has(name))
  )).slice(0, 8);
  const relatedHtml = related.length
    ? `<div class="session-related">
        <h3>同项目其它需求</h3>
        ${related.map((row) => `
          <button type="button" data-related="${escapeHtml(row.id)}">
            ${escapeHtml(row.title || '无标题')}
            <span>${escapeHtml(row.provider)} · ${fmtAgo(row.updatedAt, Date.now())}</span>
          </button>
        `).join('')}
      </div>`
    : '';
  return `
    <div class="session-detail-grid">
      <dt>需求</dt><dd>${escapeHtml(session.requirement || session.title || '（未抽出）')}</dd>
      <dt>需求项目</dt><dd>${escapeHtml(sessionRepos(session, 'touch').map((repo) => repo.name).join(', ') || '（未触碰仓库）')}</dd>
      <dt>工作 git</dt><dd>${escapeHtml(sessionRepos(session, 'work').map((repo) => repo.name).join(', ') || session.gitName || '--')}</dd>
      <dt>提交 git</dt><dd>${escapeHtml(sessionRepos(session, 'commit').map((repo) => `${repo.name} (${repo.evidenceKind})`).join(', ') || '--')}</dd>
      <dt>Id</dt><dd>${escapeHtml(session.id)}</dd>
      <dt>cwd</dt><dd>${escapeHtml(session.cwd || '--')}</dd>
      <dt>git</dt><dd>${escapeHtml(session.gitRoot || '--')}</dd>
      <dt>日志</dt><dd>${escapeHtml(session.sourceFile || '--')}</dd>
      <dt>开始</dt><dd>${session.startedAt ? fmtTime(session.startedAt, true) : '--'}</dd>
    </div>
    <div class="session-actions">
      ${session.sourceFile ? `<button class="secondary-btn" type="button" data-reveal="${escapeHtml(session.id)}">在 Finder 中显示</button>` : ''}
    </div>
    <div id="sessionFiles" class="session-attrs"></div>
    <div id="sessionCommits" class="session-attrs"></div>
    ${relatedHtml}
    <div id="sessionTranscript" class="session-transcript"></div>
  `;
}

function fmtTokens(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return Math.round(n).toLocaleString('en-US');
  if (n < 1_000_000) return `${groupedNumber(n / 1000, n >= 10_000 ? 0 : 1)}K`;
  if (n < 1_000_000_000) return `${groupedNumber(n / 1_000_000, n >= 10_000_000 ? 1 : 2)}M`;
  return `${groupedNumber(n / 1_000_000_000, 2)}B`;
}

function fmtUsd(value) {
  if (value == null) return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  // USD 截到两位小数，避免 0.39999… 之类浮点尾巴
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usageSourceLabel(source, confidence) {
  if (source === 'official') return confidence === 'official' ? '官方 Analytics' : '官方';
  return '本地日志';
}

function usageRangeLabel(report) {
  if (!report?.since || !report?.until) return '所选范围';
  const pad = (n) => String(n).padStart(2, '0');
  const format = (value) => {
    const d = new Date(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return `${format(report.since)} – ${format(report.until)}`;
}

function renderUsage(report) {
  const el = document.getElementById('usageReport');
  if (!el) return;
  const scanNote = report?.scanStatus?.state === 'running'
    ? '本地日志扫描中，当前显示上次已保存的数据。'
    : report?.scanStatus?.state === 'error'
      ? `本地日志扫描失败：${escapeHtml(report.scanStatus.error || '未知错误')}`
      : '配额百分比与 token 消耗分开统计。本地成本是模型价格表估算，官方数据保留官方来源标记。';
  if (!report || report.recordCount === 0) {
    el.innerHTML = `
      <div class="usage-empty">
        <strong>还没有 token usage</strong>
        <span>${scanNote} 点击“扫描本地日志”读取 Codex、Claude、ZCode、Kimi CLI、Grok CLI 和 DSH；官方 Analytics 需要对应的 Admin/API key。</span>
      </div>
    `;
    return;
  }
  const totals = report.totals;
  const sourceHtml = report.sources.map((source) => `
    <span class="source-chip source-${escapeHtml(source.source)}">
      ${escapeHtml(usageSourceLabel(source.source, source.confidence))}
      <b>${fmtTokens(source.totalTokens)}</b>
      <small>${source.fetchedAt ? fmtAgo(source.fetchedAt, Date.now()) : ''}</small>
    </span>
  `).join('');
  const models = report.models.map((model) => `
    <tr>
      <td>${escapeHtml(model.provider)}</td>
      <td class="model-cell">${escapeHtml(model.model)}</td>
      <td>${fmtTokens(model.inputTokens)}</td>
      <td>${fmtTokens(model.cachedInputTokens)}</td>
      <td>${fmtTokens(model.cacheCreationInputTokens)}</td>
      <td>${fmtTokens(model.outputTokens)}</td>
      <td>${fmtTokens(model.reasoningOutputTokens)}</td>
      <td>${fmtTokens(model.totalTokens)}</td>
      <td>${fmtUsd(model.estimatedCostUsd)}</td>
      <td><span class="source-label">${escapeHtml(usageSourceLabel(model.source, model.confidence))}</span></td>
    </tr>
  `).join('');
  const dailyMax = Math.max(1, ...report.daily.map((day) => day.totalTokens));
  const dailyHtml = report.daily.map((day) => `
    <div class="daily-row">
      <span>${escapeHtml(day.day || '--')}</span>
      <div class="daily-track"><i style="width:${Math.max(2, day.totalTokens / dailyMax * 100)}%"></i></div>
      <b>${fmtTokens(day.totalTokens)}</b>
    </div>
  `).join('');
  el.innerHTML = `
    <div class="usage-topline">
      <div class="usage-metric"><span>总 token</span><strong>${fmtTokens(totals.totalTokens)}</strong></div>
      <div class="usage-metric"><span>Input</span><strong>${fmtTokens(totals.inputTokens)}</strong></div>
      <div class="usage-metric"><span>Output</span><strong>${fmtTokens(totals.outputTokens)}</strong></div>
      <div class="usage-metric"><span>估算成本</span><strong>${fmtUsd(totals.estimatedCostUsd)}</strong></div>
      <div class="usage-sources">${sourceHtml}</div>
    </div>
    <div class="usage-grid">
      <div class="usage-panel">
        <div class="panel-title">Daily activity <span>${usageRangeLabel(report)} · 按本地日期</span></div>
        <div class="daily-list">${dailyHtml || '<span class="muted">暂无日数据</span>'}</div>
      </div>
      <div class="usage-panel usage-table-panel">
        <div class="panel-title">Model breakdown <span>${report.models.length} 个模型 · 全部显示</span></div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Provider</th><th>Model</th><th>Input</th><th>Cache read</th><th>Cache create</th><th>Output</th><th>Reasoning</th><th>Total</th><th>Cost</th><th>Source</th></tr></thead>
            <tbody>${models}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="usage-note">${scanNote} 范围：${usageRangeLabel(report)}；左侧配额窗口单独计算。</div>
  `;
}

function renderSummary(ov) {
  const now = Date.now();
  const el = document.getElementById('summary');
  const plans = ov.plans;
  const okCount = plans.filter((p) => p.status === 'ok').length;
  const issueCount = plans.filter((p) => p.status !== 'ok').length;
  const windows = plans.flatMap((plan) => plan.windows
    .filter((w) => w.percentage != null)
    .map((w) => ({ plan, w })))
    .sort((a, b) => (100 - a.w.percentage) - (100 - b.w.percentage));
  const tight = windows[0];
  const nextReset = plans.flatMap((plan) => plan.windows
    .filter((w) => w.resetAt != null && w.resetAt > now)
    .map((w) => ({ plan, w })))
    .sort((a, b) => a.w.resetAt - b.w.resetAt)[0];

  el.innerHTML = `
    <div class="summary-item">
      <span class="summary-label">可用 plans</span>
      <strong>${okCount}<small> / ${plans.length}</small></strong>
      <span class="summary-detail">当前可正常读取</span>
    </div>
    <div class="summary-item ${issueCount ? 'has-issue' : ''}">
      <span class="summary-label">需要关注</span>
      <strong>${issueCount}</strong>
      <span class="summary-detail">${issueCount ? '凭据或数据状态异常' : '所有 provider 状态稳定'}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">最紧张额度</span>
      <strong>${tight ? `${Math.max(0, 100 - tight.w.percentage).toFixed(0)}%` : '--'}</strong>
      <span class="summary-detail">${tight ? `${escapeHtml(tight.plan.name)} · ${escapeHtml(tight.w.label)} 剩余` : '等待额度数据'}</span>
    </div>
    <div class="summary-item summary-next">
      <span class="summary-label">下一个恢复</span>
      <strong class="summary-countdown" ${nextReset ? `data-reset-at="${nextReset.w.resetAt}"` : ''}>${nextReset ? fmtCountdown(nextReset.w.resetAt, now) : '--'}</strong>
      <span class="summary-detail">${nextReset ? `${escapeHtml(nextReset.plan.name)} · ${fmtTime(nextReset.w.resetAt)}` : '暂无可用 reset 时间'}</span>
    </div>
  `;
}

function renderCredentialSettings(card, p) {
  if (p.adapter === 'factory') {
    return `
      <div class="settings-section">
        <div class="settings-title">Factory API key</div>
        <p class="settings-copy">优先使用 FACTORY_API_KEY 或 <code>~/.factory/.env</code>。也可在 Factory API keys 页面创建 key。</p>
        <form class="key-form" data-auth-form>
          <input type="password" name="apiKey" autocomplete="new-password" placeholder="粘贴 Factory API key" aria-label="Factory API key" />
          <button type="submit" class="button-primary">保存并验证</button>
          <button type="button" class="button-quiet" data-auth-auto>使用自动凭据</button>
        </form>
        <div class="settings-links"><a href="https://app.factory.ai/settings/api-keys" target="_blank" rel="noreferrer">打开 Factory API keys ↗</a></div>
      </div>
    `;
  }
  if (p.adapter === 'minimax') {
    return `
      <div class="settings-section">
        <div class="settings-title">MiniMax API key</div>
        <p class="settings-copy">支持环境变量 <code>MINIMAX_CODING_API_KEY</code>（coding plan 的 <code>sk-cp-*</code> key），但环境变量只对启动 menubar app 的那个 shell 生效，重启 app 后可能丢失；保存在这里则永久生效。</p>
        <form class="key-form" data-auth-form>
          <input type="password" name="apiKey" autocomplete="new-password" placeholder="粘贴 sk-cp-* API key" aria-label="MiniMax API key" />
          <button type="submit" class="button-primary">保存并验证</button>
          <button type="button" class="button-quiet" data-auth-auto>使用环境变量</button>
        </form>
      </div>
    `;
  }
  if (p.adapter !== 'glm') {
    if (!p.manualKey) {
      return p.credentialHint ? `<div class="credential-hint">${escapeHtml(p.credentialHint)}</div>` : '';
    }
    // 通用手动 key 入口：后端 PUT /api/plans/:slug/auth 对所有 adapter 生效，
    // 文案直接用 adapter 的 credentialHint，新增 provider 不需要改这里。
    return `
      <div class="settings-section">
        <div class="settings-title">${escapeHtml(p.name)} API key / token</div>
        <p class="settings-copy">${p.credentialHint ? escapeHtml(p.credentialHint) : '粘贴凭据后保存并验证；也可回到自动检测。'}</p>
        <form class="key-form" data-auth-form>
          <input type="password" name="apiKey" autocomplete="new-password" placeholder="粘贴 API key / token" aria-label="${escapeHtml(p.name)} API key" />
          <button type="submit" class="button-primary">保存并验证</button>
          <button type="button" class="button-quiet" data-auth-auto>使用自动凭据</button>
        </form>
      </div>
    `;
  }
  return `
    <div class="settings-section">
      <div class="settings-title">GLM API key</div>
      <p class="settings-copy">GLM quota 使用 API key，不读取 Safari 登录态。支持环境变量 <code>Z_AI_API_KEY</code> 或 <code>ZAI_API_KEY</code>。</p>
      <form class="key-form" data-auth-form>
        <input type="password" name="apiKey" autocomplete="new-password" placeholder="粘贴 Z.ai API key" aria-label="GLM API key" />
        <button type="submit" class="button-primary">保存并验证</button>
        <button type="button" class="button-quiet" data-auth-auto>使用环境变量</button>
      </form>
      <div class="settings-links"><a href="https://z.ai/manage-apikey" target="_blank" rel="noreferrer">打开 z.ai API keys ↗</a></div>
    </div>
  `;
}

function renderBrowserSettings(card, p) {
  if (!p.browserSupported) return '';
  const selected = p.browser || 'safari';
  const options = Object.entries(BROWSER_NAMES)
    .map(([id, name]) => `<option value="${id}" ${selected === id ? 'selected' : ''}>${name}</option>`)
    .join('');
  return `
    <div class="settings-section browser-settings">
      <div class="settings-title">浏览器会话</div>
      <div class="browser-row">
        <label>读取 ${escapeHtml(p.name)} 的登录态
          <select data-browser-select aria-label="${escapeHtml(p.name)} 浏览器">${options}</select>
        </label>
        ${p.adapter === 'factory'
          ? '<span class="muted browser-native-note">由 menubar 自动读取</span>'
          : '<button type="button" class="button-quiet" data-browser-auth>读取并刷新</button>'}
      </div>
      <p class="settings-copy">${p.adapter === 'factory' ? 'Factory 浏览器会话由原生 menubar 读取，token 只保存在当前 daemon 内存。' : '仅此 provider 使用该浏览器，会话 token 只保存在当前 daemon 内存。'}</p>
    </div>
  `;
}

/** dsh-track 深链跳转（docs/deep-link-handoff.md）：plan 卡片展示最近活跃会话，
 * 点击打开 http://<DSH_WEB_URL>/s/<sessionId>。url 由 daemon 按 DSH_WEB_URL 生成。 */
function renderSessionJumps(p, now) {
  const byPlan = latestUsage?.byPlan?.find((row) => row.plan === p.slug);
  const sessions = (byPlan?.recentSessions ?? []).filter((s) => s.url);
  if (sessions.length === 0) return '';
  const links = sessions.map((s) =>
    `<a class="session-jump" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer"
        title="${escapeHtml(s.project ?? s.sessionId)}">↗ ${escapeHtml(fmtAgo(s.timestamp, now))}</a>`)
    .join('');
  return `<div class="session-jumps"><span class="muted">最近会话</span>${links}</div>`;
}

function renderPlan(p, now) {
  const card = document.createElement('article');
  card.className = `card status-${p.status}`;
  const browser = p.browser ? BROWSER_NAMES[p.browser] || p.browser : null;
  const hasSettings = Boolean(p.manualKey) || Boolean(p.browserSupported);
  card.innerHTML = `
    <div class="card-head">
      <div class="provider-title">
        <span class="provider-pip"></span>
        <div>
          <div class="card-name">${escapeHtml(p.name)}</div>
          <div class="card-sub">${escapeHtml(p.slug)} · ${escapeHtml(p.adapter)}${browser ? ` · ${escapeHtml(browser)}` : ''}</div>
        </div>
      </div>
      ${hasSettings ? '<button type="button" class="settings-trigger" data-open-settings>设置</button>' : ''}
      <div class="badges">
        ${renderTierPill(p, now)}
        ${renderFableIdlePill(p, now)}
        <span class="badge st-${p.status}"><i></i>${STATUS_TEXT[p.status] ?? p.status}</span>
        <span class="badge auth ${p.authStatus}">${authLabel(p.authStatus)}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="wins"></div>
      ${renderSessionJumps(p, now)}
      <div class="card-foot">
        <span class="muted">${p.lastFetchedAt ? `更新于 ${fmtAgo(p.lastFetchedAt, now)} · ${fmtTime(p.lastFetchedAt, true)}` : '暂无成功数据'}</span>
        <button type="button" class="inline-action" data-refresh>刷新 provider</button>
      </div>
      <dialog class="settings-dialog" data-settings-dialog>
        <div class="dialog-head">
          <div>
            <div class="dialog-kicker">PROVIDER SETTINGS</div>
            <div class="dialog-title">${escapeHtml(p.name)}</div>
          </div>
          <button type="button" class="dialog-close" data-close-settings aria-label="关闭设置">×</button>
        </div>
        <div class="settings">
        ${renderBrowserSettings(card, p)}
        ${renderCredentialSettings(card, p)}
        </div>
      </dialog>
      ${p.lastError ? `<div class="error-line">${escapeHtml(p.lastError)}</div>` : ''}
    </div>
  `;

  const wins = card.querySelector('.wins');
  if (p.windows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<span class="empty-mark">!</span><span>${escapeHtml(
      p.status === 'not_configured' ? (p.credentialHint || '请在下方完成凭据配置') : (p.lastError || '暂无数据'),
    )}</span>`;
    wins.appendChild(empty);
  } else {
    const tpl = document.getElementById('winTpl');
    for (const w of p.windows) {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.win-label').textContent = w.label;
      const meta = node.querySelector('.win-meta');
      const unlimited = w.note === '不限量' && w.percentage == null;
      const pct = unlimited ? '∞' : w.percentage == null ? '--' : `${w.percentage}%`;
      const frac = unlimited ? ''
        : w.used != null && w.total != null
          ? `${groupedNumber(w.used, 0)}/${groupedNumber(w.total, 0)}`
          : w.used != null ? groupedNumber(w.used, 0) : '';
      meta.innerHTML = `${Number.isFinite(w.percentage) || unlimited ? `<b>${pct}</b>` : pct}${frac ? ` · ${frac}` : ''}`;
      const fill = node.querySelector('.fill');
      fill.className = `fill ${levelClass(w.percentage)}`;
      fill.style.width = `${w.percentage ?? 0}%`;
      // 时间进度参考线：按窗口时长估算当前时间应到的位置。
      const marker = node.querySelector('.pace-marker');
      if (marker) {
        const pace = timePacePercentage(w, now);
        if (pace != null) {
          marker.style.left = `${pace}%`;
          marker.hidden = false;
          marker.title = `时间进度 ${pace}%`;
        } else {
          marker.hidden = true;
        }
      }
      const reset = node.querySelector('.win-reset');
      reset.textContent = w.resetAt == null ? '恢复时间未知' : `恢复 ${fmtTime(w.resetAt)}`;
      const countdown = node.querySelector('.win-countdown');
      if (w.resetAt != null) {
        countdown.dataset.resetAt = w.resetAt;
        countdown.textContent = fmtCountdown(w.resetAt, now);
      } else {
        countdown.removeAttribute('data-reset-at');
      }
      node.querySelector('.win-note').textContent = w.note || '';
      wins.appendChild(node);
    }
  }
  bindPlanActions(card, p);
  bindDragReorder(card, p);
  return card;
}

/** 拖拽重排：HTML5 DnD，松开后写 localStorage。 */
function bindDragReorder(card, p) {
  card.dataset.slug = p.slug;
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    dragInFlight = true;
    event.dataTransfer.setData('text/plain', p.slug);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    dragInFlight = false;
    card.classList.remove('dragging');
    document.querySelectorAll('.card.drop-before, .card.drop-after')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  });
  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const before = (event.clientY - rect.top) < rect.height / 2;
    card.classList.toggle('drop-before', before);
    card.classList.toggle('drop-after', !before);
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    const fromSlug = event.dataTransfer.getData('text/plain');
    if (!fromSlug || fromSlug === p.slug) return;
    const grid = card.parentElement;
    if (!grid) return;
    const rect = card.getBoundingClientRect();
    const before = (event.clientY - rect.top) < rect.height / 2;
    const fromEl = grid.querySelector(`[data-slug="${CSS.escape(fromSlug)}"]`);
    if (!fromEl) return;
    grid.insertBefore(fromEl, before ? card : card.nextSibling);
    savePlanOrder([...grid.children].map((c) => c.dataset.slug).filter(Boolean));
  });
}

function bindPlanActions(card, p) {
  const setBusy = (element, busy, label) => {
    if (!element) return;
    if (busy) {
      element.dataset.originalLabel = element.textContent;
      element.textContent = label;
      element.disabled = true;
    } else {
      element.textContent = element.dataset.originalLabel || element.textContent;
      element.disabled = false;
    }
  };
  const select = card.querySelector('[data-browser-select]');
  const browserAuth = card.querySelector('[data-browser-auth]');
  const settingsDialog = card.querySelector('[data-settings-dialog]');
  card.querySelector('[data-open-settings]')?.addEventListener('click', () => settingsDialog?.showModal());
  card.querySelector('[data-close-settings]')?.addEventListener('click', () => settingsDialog?.close());
  settingsDialog?.addEventListener('click', (event) => {
    if (event.target === settingsDialog) settingsDialog.close();
  });
  if (select) {
    select.addEventListener('change', async () => {
      try {
        await request(`/api/plans/${encodeURIComponent(p.slug)}/browser`, {
          method: 'PUT',
          body: JSON.stringify({ browser: select.value }),
        });
        showToast(`${p.name} 已切换到 ${BROWSER_NAMES[select.value] || select.value}`);
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }
  if (browserAuth) {
    browserAuth.addEventListener('click', async () => {
      setBusy(browserAuth, true, '读取中…');
      try {
        await request(`/api/plans/${encodeURIComponent(p.slug)}/browser-auth`, {
          method: 'POST',
          body: JSON.stringify({ browser: select.value }),
        });
        showToast(`${p.name} 已读取并刷新`);
        await render();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        setBusy(browserAuth, false);
      }
    });
  }
  const form = card.querySelector('[data-auth-form]');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('[type=submit]');
      const apiKey = form.elements.apiKey.value.trim();
      if (!apiKey) {
        showToast('请先粘贴 API key', true);
        return;
      }
      setBusy(button, true, '验证中…');
      try {
        await request(`/api/plans/${encodeURIComponent(p.slug)}/auth`, {
          method: 'PUT',
          body: JSON.stringify({ mode: 'manual', apiKey }),
        });
        form.reset();
        showToast(`${p.name} API key 已保存`);
        await render();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        setBusy(button, false);
      }
    });
    form.querySelector('[data-auth-auto]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setBusy(button, true, '切换中…');
      try {
        await request(`/api/plans/${encodeURIComponent(p.slug)}/auth`, {
          method: 'PUT',
          body: JSON.stringify({ mode: 'auto' }),
        });
        showToast(`${p.name} 将使用环境变量`);
        await render();
      } catch (error) {
        showToast(error.message, true);
      } finally {
        setBusy(button, false);
      }
    });
  }
  card.querySelector('[data-refresh]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, '刷新中…');
    try {
      await request(`/api/plans/${encodeURIComponent(p.slug)}/refresh`, { method: 'POST' });
      showToast(`${p.name} 已刷新`);
      await render();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  });
}

function showToast(message, error = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast visible ${error ? 'toast-error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function tickClock() {
  const clock = document.getElementById('heroClock');
  if (clock) clock.textContent = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  if (latestOverview) {
    document.querySelectorAll('[data-reset-at]').forEach((el) => {
      el.textContent = fmtCountdown(Number(el.dataset.resetAt), Date.now());
    });
  }
}

let renderGeneration = 0;

async function render() {
  const generation = ++renderGeneration;
  try {
    const result = await load();
    if (generation !== renderGeneration) return;
    latestOverview = result.overview;
    latestBuildInfo = result.buildInfo;
    latestUsage = result.usage;
    latestSessions = result.sessions;
    const now = Date.now();
    document.getElementById('connectionState').className = 'connection connected';
    document.getElementById('connectionState').innerHTML = '<i></i> live';
    document.getElementById('generatedAt').textContent = `上次同步 ${fmtTime(latestOverview.generatedAt, true)}`;
    const build = document.getElementById('buildIdentity');
    build.textContent = latestBuildInfo ? `build ${latestBuildInfo.shortCommitSha}` : '';
    build.title = latestBuildInfo
      ? `${latestBuildInfo.commitSha} · ${latestBuildInfo.buildTimestamp}`
      : '当前运行构建';
    renderSummary(latestOverview);
    renderUsage(latestUsage);
    renderSessions(latestSessions);
    if (currentTab() === 'graph') void refreshGraph();
    maybePollSessionIndex(latestSessions);
    if (dragInFlight) return;
    const grid = document.getElementById('grid');
    const nextGrid = document.createDocumentFragment();
    for (const p of applyOrder(latestOverview.plans)) nextGrid.appendChild(renderPlan(p, now));
    grid.replaceChildren(nextGrid);
    syncResetOrderVisibility();
  } catch (error) {
    if (generation !== renderGeneration) return;
    document.getElementById('connectionState').className = 'connection disconnected';
    document.getElementById('connectionState').innerHTML = '<i></i> offline';
    document.getElementById('generatedAt').textContent = '无法连接本地 daemon';
    document.getElementById('buildIdentity').textContent = '';
    showToast(error.message, true);
  }
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  try {
    await request('/api/refresh', { method: 'POST' });
    await render();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
  }
});

let launchOnStartupEnabled = null; // null = 不可用/未知，按钮保持隐藏

/** 根据 localStorage 是否有用户自定义顺序，显示「恢复默认顺序」入口。 */
function syncResetOrderVisibility() {
  const btn = document.getElementById('resetOrder');
  if (!btn) return;
  btn.hidden = loadPlanOrder().length === 0;
}

document.getElementById('resetOrder')?.addEventListener('click', () => {
  try {
    localStorage.removeItem(ORDER_KEY);
  } catch { /* 静默 */ }
  if (typeof render === 'function') void render();
  syncResetOrderVisibility();
});

function renderStartupToggle(enabled) {
  launchOnStartupEnabled = enabled;
  const btn = document.getElementById('startupToggle');
  btn.innerHTML = '<i></i>开机自启';
  btn.hidden = false;
  btn.setAttribute('aria-pressed', String(enabled));
  btn.classList.toggle('on', enabled);
}

async function loadStartupSettings() {
  try {
    const settings = await request('/api/settings');
    if (settings.launchOnStartup?.available) {
      renderStartupToggle(Boolean(settings.launchOnStartup.enabled));
    }
  } catch {
    // 离线时保持现有状态，30s 轮询重连后自然恢复
  }
}

document.getElementById('startupToggle')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  if (btn.disabled || launchOnStartupEnabled == null) return;
  const next = !launchOnStartupEnabled;
  btn.disabled = true;
  try {
    const result = await request('/api/settings/launch-on-startup', {
      method: 'PUT',
      body: JSON.stringify({ enabled: next }),
    });
    renderStartupToggle(result.enabled);
    showToast(next
      ? '开机自启已开启：daemon 正在切换到 launchd 守护，页面会短暂重连'
      : '开机自启已关闭：注销/重启后不再自动启动，当前服务继续运行');
    if (next) {
      // 开启会让 daemon 在 launchd 下重启接管，连接短暂中断，稍后重连刷新
      setTimeout(() => { void render(); void loadStartupSettings(); }, 2500);
      setTimeout(() => { void render(); void loadStartupSettings(); }, 7000);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    btn.disabled = false;
  }
});

render();
loadStartupSettings();
tickClock();
setInterval(tickClock, 1000);
setInterval(render, 30_000);

document.getElementById('usageDays')?.addEventListener('change', () => { void render(); });
function resetSessionFilters() {
  sessionVisibleCount = 40;
  if (latestSessions) renderSessions(latestSessions);
}
document.getElementById('sessionProvider')?.addEventListener('change', resetSessionFilters);
document.getElementById('sessionProject')?.addEventListener('change', resetSessionFilters);
document.getElementById('sessionHideUntitled')?.addEventListener('change', resetSessionFilters);
// 搜索框:输入即本地过滤元数据,停顿 300ms 后带 q 问服务端(并集消息正文 FTS)
let sessionSearchTimer = null;
let sessionServerQuery = '';
document.getElementById('sessionSearch')?.addEventListener('input', () => {
  resetSessionFilters();
  if (sessionSearchTimer != null) clearTimeout(sessionSearchTimer);
  sessionSearchTimer = setTimeout(refetchSessionsForSearch, 300);
});
async function refetchSessionsForSearch() {
  const q = (document.getElementById('sessionSearch')?.value || '').trim();
  if (q === sessionServerQuery) return;
  try {
    const days = document.getElementById('usageDays')?.value || '30';
    latestSessions = await request(`/api/sessions?days=${encodeURIComponent(days)}&q=${encodeURIComponent(q)}`);
    sessionServerQuery = q.toLowerCase();
    renderSessions(latestSessions);
  } catch {
    /* daemon restarting */
  }
}
document.querySelectorAll('[data-session-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    sessionView = btn.getAttribute('data-session-view') || 'list';
    document.querySelectorAll('[data-session-view]').forEach((other) => {
      other.setAttribute('aria-pressed', String(other === btn));
    });
    resetSessionFilters();
  });
});

function currentTab() {
  const hash = (location.hash || '#plans').replace('#', '');
  return ['plans', 'sessions', 'graph', 'usage'].includes(hash) ? hash : 'plans';
}

function showTab(name) {
  if (!['plans', 'sessions', 'graph', 'usage'].includes(name)) name = 'plans';
  const hash = `#${name}`;
  if (location.hash !== hash) location.hash = hash;
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.getAttribute('data-tab') === name));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.getAttribute('data-panel') !== name;
  });
  if (name === 'graph') void refreshGraph();
}

document.getElementById('graphCandidates')?.addEventListener('change', (event) => {
  graphShowCandidates = event.target.checked;
  renderGraph(latestSessions);
});
document.getElementById('graphProject')?.addEventListener('change', () => renderGraph(latestSessions));
document.getElementById('graphSubagents')?.addEventListener('change', (event) => {
  graphIncludeSubagents = event.target.checked;
  void refreshGraph();
});

document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.getAttribute('data-tab')));
});
window.addEventListener('hashchange', () => showTab(currentTab()));
showTab(currentTab());

function maybePollSessionIndex(list) {
  if (list?.indexStatus !== 'running') return;
  if (sessionIndexPollTimer != null) return;
  sessionIndexPollTimer = setTimeout(async () => {
    sessionIndexPollTimer = null;
    try {
      const days = document.getElementById('usageDays')?.value || '30';
      const q = (document.getElementById('sessionSearch')?.value || '').trim();
      latestSessions = await request(`/api/sessions?days=${encodeURIComponent(days)}&q=${encodeURIComponent(q)}`);
      renderSessions(latestSessions);
      maybePollSessionIndex(latestSessions);
    } catch {
      /* daemon restarting */
    }
  }, 1500);
}

let usageScanPollTimer = null;

function stopUsageScanPolling() {
  if (usageScanPollTimer != null) {
    clearTimeout(usageScanPollTimer);
    usageScanPollTimer = null;
  }
}

function finishUsageScan(state) {
  stopUsageScanPolling();
  const btn = document.getElementById('usageScanBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '扫描本地日志';
  }
  if (state === 'error') showToast('本地日志扫描失败，请查看 Usage 提示。', true);
  else showToast('本地日志扫描完成，Usage & Spend 已更新。');
}

async function pollUsageScan(days) {
  try {
    const report = await request(`/api/usage?days=${encodeURIComponent(days)}`);
    latestUsage = report;
    renderUsage(report);
    if (report.scanStatus?.state === 'running') {
      usageScanPollTimer = setTimeout(() => { void pollUsageScan(days); }, 1500);
      return;
    }
    await render();
    finishUsageScan(report.scanStatus?.state);
  } catch (error) {
    finishUsageScan('error');
    showToast(error.message, true);
  }
}

document.getElementById('usageScanBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('usageScanBtn');
  const days = document.getElementById('usageDays')?.value || '30';
  stopUsageScanPolling();
  btn.disabled = true;
  btn.textContent = '扫描中…';
  try {
    const report = await request(`/api/usage?days=${encodeURIComponent(days)}&refresh=1`);
    latestUsage = report;
    renderUsage(report);
    if (report.scanStatus?.state === 'running') {
      usageScanPollTimer = setTimeout(() => { void pollUsageScan(days); }, 1500);
    } else {
      await render();
      finishUsageScan(report.scanStatus?.state);
    }
  } catch (error) {
    finishUsageScan('error');
    showToast(error.message, true);
  }
});
