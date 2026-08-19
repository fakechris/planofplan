import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

describe('dashboard shell', () => {
  test('keeps the runtime hooks required by app.js', () => {
    for (const id of [
      'buildIdentity',
      'connectionState',
      'generatedAt',
      'refreshBtn',
      'summary',
      'usageScanBtn',
      'usageDays',
      'usageReport',
      'grid',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
