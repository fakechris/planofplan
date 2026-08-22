import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { collectSessionCatalog } from '../src/sessions.ts';

const root = mkdtempSync(join(tmpdir(), 'pop-smoke-'));
const dbPath = join(root, 'smoke.db');
const store = openDb(dbPath);
const claudeRoot = join(process.env.HOME!, '.claude/projects/-Users-chris-workspace-mac');
const opts = {
  since: Date.now() - 90 * 86400000,
  until: Date.now(),
  claudeRoots: [claudeRoot],
  codexRoot: join(root, 'x1'), grokRoot: join(root, 'x2'), dshRoot: join(root, 'x3'),
  kimiRoot: join(root, 'x4'), droidRoot: join(root, 'x5'), zcodeRoot: join(root, 'x6'),
};
let t0 = Date.now();
const scanned = await collectSessionCatalog(store, opts);
console.log(`首次: scanned=${scanned} msgs=${store.countSessionMessages()} sessions=${store.listSessionRows().length} ${Date.now() - t0}ms db=${(statSync(dbPath).size / 1e6).toFixed(1)}MB`);
t0 = Date.now();
const again = await collectSessionCatalog(store, opts);
console.log(`第二次(应全跳过): scanned=${again} ${Date.now() - t0}ms`);
for (const q of ['session', '会话目录', '修复']) {
  t0 = Date.now();
  const hits = store.searchSessionMessages(q);
  console.log(`搜索 ${JSON.stringify(q)}: ${hits.length} 个 session 命中, ${Date.now() - t0}ms`);
  if (hits[0]) console.log(`  片段: ${JSON.stringify(hits[0].snippet.slice(0, 80))}`);
}
rmSync(root, { recursive: true, force: true });
