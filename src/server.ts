import { Hono } from 'hono';
import { resolve, isAbsolute } from 'node:path';
import type { AppConfig } from './config.ts';
import type { Store } from './db.ts';
import type { Scheduler } from './core.ts';
import { buildOverview } from './core.ts';
import { writeCredential, deleteCredential } from './auth.ts';

const WEB_DIR = resolve(import.meta.dir, '../web');

export function createServer(store: Store, scheduler: Scheduler, cfg: AppConfig): Hono {
  const app = new Hono();

  app.get('/api/overview', (c) => {
    return c.json(buildOverview(store, cfg.plans, Date.now()));
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
      return new Response(file);
    }
    return c.text('not found', 404);
  });

  return app;
}
