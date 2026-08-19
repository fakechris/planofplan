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
  const [overview, buildInfo] = await Promise.all([
    request('/api/overview'),
    request('/api/build-info'),
  ]);
  latestBuildInfo = buildInfo;
  return overview;
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
        <button type="button" class="button-quiet" data-browser-auth>读取并刷新</button>
      </div>
      <p class="settings-copy">仅此 provider 使用该浏览器，会话 token 只保存在当前 daemon 内存。</p>
    </div>
  `;
}

function renderPlan(p, now) {
  const card = document.createElement('article');
  card.className = `card status-${p.status}`;
  const browser = p.browser ? BROWSER_NAMES[p.browser] || p.browser : null;
  const hasSettings = p.adapter === 'glm' || p.browserSupported;
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

async function render() {
  try {
    latestOverview = await load();
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
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    for (const p of latestOverview.plans) grid.appendChild(renderPlan(p, now));
  } catch (error) {
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

render();
tickClock();
setInterval(tickClock, 1000);
setInterval(render, 30_000);
