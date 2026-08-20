import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

describe('dashboard shell', () => {
  test('keeps the runtime hooks required by app.js', () => {
    for (const id of [
      'buildIdentity',
      'connectionState',
      'generatedAt',
      'refreshBtn',
      'startupToggle',
      'summary',
      'usageScanBtn',
      'usageDays',
      'usageReport',
      'sessionList',
      'sessionReader',
      'sessionSearch',
      'sessionProvider',
      'sessionProject',
      'grid',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('设置入口由 adapter 能力驱动，不维护 provider 白名单', () => {
    // manualKey 来自后端 adapter 能力（默认支持）；一旦回退成硬编码
    // adapter 列表，新 provider 会再次出现「没有 key 配置入口」的遗漏。
    expect(appJs).toContain('p.manualKey');
    expect(appJs).not.toContain("['glm', 'minimax', 'factory']");
  });
});
