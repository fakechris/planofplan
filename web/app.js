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
  return `${hours}小时${minutes}分钟后`;
}

function fmtAgo(ms, now) {
  if (ms == null) return '';
  const diff = Math.max(0, now - ms);
  const m = Math.round(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

function levelClass(percentage) {
  if (percentage == null) return 'unknown';
  const remaining = 100 - percentage;
  return remaining > 50 ? 'ok' : remaining > 10 ? 'warn' : 'bad';
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
  return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ''}后切换`;
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
  const [overview, buildInfo, usage] = await Promise.all([
    request('/api/overview'),
    request('/api/build-info'),
    request(`/api/usage?days=${encodeURIComponent(days)}`),
  ]);
  return { overview, buildInfo, usage };
}

function fmtTokens(value) {
  const n = Number(value || 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtUsd(value) {
  return value == null ? '--' : `$${Number(value).toFixed(4)}`;
}

function usageSourceLabel(source, confidence) {
  if (source === 'official') return confidence === 'official' ? '官方 Analytics' : '官方';
  return '本地日志';
}

function usageRangeLabel(report) {
  if (!report?.since || !report?.until) return '所选范围';
  const format = (value) => new Date(value).toISOString().slice(0, 16).replace('T', ' ');
  return `${format(report.since)} – ${format(report.until)} UTC`;
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
        <div class="panel-title">Daily activity <span>${usageRangeLabel(report)} · 按 UTC 日期</span></div>
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
    if (!p.credentialHint) return '';
    return `<div class="credential-hint">${escapeHtml(p.credentialHint)}</div>`;
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

function renderPlan(p, now) {
  const card = document.createElement('article');
  card.className = `card status-${p.status}`;
  const browser = p.browser ? BROWSER_NAMES[p.browser] || p.browser : null;
  const hasSettings = ['glm', 'minimax', 'factory'].includes(p.adapter) || p.browserSupported;
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
        <span class="badge st-${p.status}"><i></i>${STATUS_TEXT[p.status] ?? p.status}</span>
        <span class="badge auth ${p.authStatus}">${authLabel(p.authStatus)}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="wins"></div>
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
      meta.textContent = `${w.percentage == null ? '--' : `${w.percentage}%`} · ${
        w.used != null && w.total != null ? `${w.used}/${w.total}` : w.used != null ? String(w.used) : '--'
      }`;
      const fill = node.querySelector('.fill');
      fill.className = `fill ${levelClass(w.percentage)}`;
      fill.style.width = `${w.percentage ?? 0}%`;
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
  return card;
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
    const grid = document.getElementById('grid');
    const nextGrid = document.createDocumentFragment();
    for (const p of latestOverview.plans) nextGrid.appendChild(renderPlan(p, now));
    grid.replaceChildren(nextGrid);
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
