/* planofplan 前端：总览 dashboard（无构建，vanilla JS） */
'use strict';

const STATUS_TEXT = {
  ok: '正常',
  stale: '数据过期',
  error: '拉取失败',
  not_configured: '待配置',
  auth_error: '凭据失效',
  unavailable: '未接入',
};

function fmtTime(ms) {
  if (ms == null) return '--';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtCountdown(resetAt, now) {
  if (resetAt == null) return '';
  const diff = resetAt - now;
  if (diff <= 0) return '已重置';
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s} 秒后重置`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟后重置`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分后重置`;
  return `${Math.floor(h / 24)} 天后重置`;
}

function fmtAgo(ms, now) {
  if (ms == null) return '';
  const diff = Math.max(0, now - ms);
  const m = Math.round(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

/** 按剩余比例染色（CodexBar 语义）：>50% 剩 绿，10-50% 黄，<10% 红 */
function levelClass(percentage) {
  if (percentage == null) return 'unknown';
  const remaining = 100 - percentage;
  return remaining > 50 ? 'ok' : remaining > 10 ? 'warn' : 'bad';
}

async function load() {
  const res = await fetch('/api/overview');
  return res.json();
}

function renderSummary(ov) {
  const now = Date.now();
  const el = document.getElementById('summary');
  const plans = ov.plans;
  const okCount = plans.filter((p) => p.status === 'ok').length;
  const problemCount = plans.filter((p) => ['auth_error', 'error', 'not_configured', 'stale','unavailable'].includes(p.status)).length;

  // 所有窗口，按剩余比例升序（越紧俏越靠前）
  const allWindows = [];
  for (const p of plans) {
    if (p.status !== 'ok') continue;
    for (const w of p.windows) {
      if (w.percentage == null) continue;
      allWindows.push({ plan: p, w });
    }
  }
  allWindows.sort((a, b) => 100 - a.w.percentage - (100 - b.w.percentage)); // 剩余少的在前
  const tight = allWindows.slice(0, 3);

  const resets = [];
  for (const p of plans) {
    for (const w of p.windows) {
      if (w.resetAt != null && w.resetAt - now > 0 && w.resetAt - now < 3600_000) {
        resets.push({ plan: p, w });
      }
    }
  }
  resets.sort((a, b) => a.w.resetAt - b.w.resetAt);

  let html = `<div class="summary-item"><span class="kv">可用 plan</span><span class="v">${okCount}/${plans.length}</span></div>`;
  html += `<div class="summary-item"><span class="kv">异常/未配置</span><span class="v ${problemCount ? 'bad-t' : ''}">${problemCount}</span></div>`;

  if (tight.length) {
    const tightHtml = tight
      .map((t) => `${t.plan.name} ${t.w.label} <b>${(100 - t.w.percentage).toFixed(0)}%</b>剩`)
      .join(' · ');
    html += `<div class="summary-item wide"><span class="kv">最紧俏</span><span class="v">${tightHtml}</span></div>`;
  }
  if (resets.length) {
    const resetsHtml = resets
      .slice(0, 5)
      .map((r) => `${r.plan.name} ${r.w.label} <b>${fmtCountdown(r.w.resetAt, now).replace('后重置','')}</b>`)
      .join(' · ');
    html += `<div class="summary-item wide"><span class="kv">即将重置</span><span class="v">${resetsHtml}</span></div>`;
  }
  if (!plans.length) {
    html += `<div class="summary-item wide"><span class="v">暂无 plan，请检查 config.json</span></div>`;
  }
  el.innerHTML = html;
}

function renderPlan(p, now) {
  const card = document.createElement('article');
  card.className = 'card';

  const badge = STATUS_TEXT[p.status] ?? p.status;
  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="card-name">${escapeHtml(p.name)}</div>
        <div class="card-sub">${p.slug} · ${p.adapter}</div>
      </div>
      <div class="badges">
        <span class="badge st-${p.status}" data-status="${p.status}">${badge}</span>
        <span class="badge auth ${p.authStatus}">${p.authStatus === 'manual' ? '手动key' : p.authStatus === 'auto' ? '自动' : p.authStatus === 'missing' ? '无凭据' : p.authStatus === 'invalid' ? '失效' : '--'}</span>
      </div>
    </div>
    <div class="card-body">
      <div class="wins"></div>
      <div class="card-foot">
        <span class="muted">${p.lastFetchedAt ? '更新于 ' + fmtAgo(p.lastFetchedAt, now) + ' · ' + fmtTime(p.lastFetchedAt) : '暂无数据'}</span>
        <span class="muted err">${escapeHtml(p.lastError ?? '')}</span>
      </div>
    </div>
  `;

  const wins = card.querySelector('.wins');
  if (p.windows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (p.status === 'not_configured') {
      empty.textContent = `设置对应凭据（见 README），或运行: planofplan auth set ${p.slug} --key <key>`;
    } else {
      empty.textContent = p.lastError ?? '暂无数据';
    }
    wins.appendChild(empty);
  } else {
    const tpl = document.getElementById('winTpl');
    for (const w of p.windows) {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.win-label').textContent = w.label;
      const meta = node.querySelector('.win-meta');
      meta.textContent = `${w.percentage == null ? '--' : w.percentage + '%'} · ${w.used != null && w.total != null ? w.used + '/' + w.total : w.used != null ? String(w.used) : '--'}${w.note ? ' · ' + w.note : ''}`;
      const fill = node.querySelector('.fill');
      fill.className = 'fill ' + levelClass(w.percentage);
      fill.style.width = `${w.percentage ?? 0}%`;
      node.querySelector('.win-reset').textContent = fmtCountdown(w.resetAt, now);
      wins.appendChild(node);
    }
  }
  return card;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function render() {
  let ov;
  try {
    ov = await load();
  } catch (e) {
    document.getElementById('generatedAt').textContent = '无法连接服务，请确认 planofplan 已启动';
    return;
  }
  const now = Date.now();
  document.getElementById('generatedAt').textContent = '更新于 ' + fmtTime(ov.generatedAt);
  document.getElementById('refreshBtn').disabled = false;
  renderSummary(ov);
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for (const p of ov.plans) {
    grid.appendChild(renderPlan(p, now));
  }
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  await render();
  btn.disabled = false;
});

render();
setInterval(render, 30_000);
