import { Hono } from 'hono';
import { resolve, isAbsolute } from 'node:path';
import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import type { Scheduler } from './core.ts';
import { buildOverview } from './core.ts';
import { writeCredential, deleteCredential } from './auth.ts';
import { acceptKimiBrowserCookies, refreshKimiBrowserSession } from './adapters/kimi.ts';
import { KIMI_BROWSER, KIMI_BROWSERS, type KimiBrowser } from './browser-cookies.ts';
import { acceptFactoryBrowserCookies } from './factory-session.ts';
import { getBuildInfo } from './build-info.ts';

const WEB_DIR = resolve(import.meta.dir, '../web');

export function createServer(store: Store, scheduler: Scheduler, cfg: AppConfig): Hono {
  const app = new Hono();

  app.get('/api/overview', (c) => {
    return c.json(buildOverview(store, cfg.plans, Date.now()));
  });

  app.get('/api/build-info', (c) => {
    return c.json(getBuildInfo());
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
    if (planSlug === 'factory') {
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

  return app;
}
