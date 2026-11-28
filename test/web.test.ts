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
      'sessionViewList',
      'sessionViewProjects',
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

  test('INV-2320: 需求页/计划页的筛选下推服务端,下拉框吃服务端 facet,不在截断后的行上筛选', () => {
    // 接口默认只返回前 500/300 条:下拉框选项必须来自按整个时间窗口算的服务端 facet,
    // 筛选必须交给服务端(先筛选后分页)。回到「用返回行汇总 + 前端筛选」就会丢项目。
    expect(appJs).toContain('fill(projectSel, toFacets(data.byProject)');
    expect(appJs).toContain('fill(repoSel, toFacets(data.byRepo)');
    expect(appJs).toContain('fill(kindSel, toFacets(data.byKind)');
    expect(appJs).toContain("addEventListener('change', () => { void refreshRequirements(); });");
    expect(appJs).toContain("addEventListener('change', () => { void refreshPlans(); });");
    expect(appJs).not.toContain("addEventListener('change', renderRequirements)");
    expect(appJs).not.toContain("addEventListener('change', renderPlans)");
    expect(appJs).not.toContain('(item.repoNames || []).includes(project)');
    expect(appJs).not.toContain('planRepoName(plan) === repo');
    // 保留上限:两页都不改成全量加载;过期响应丢弃
    expect(appJs).not.toMatch(/api\/(requirements|planfiles)\?[^`]*limit=0/);
    expect(appJs).toContain('if (seq !== requirementsRequestSeq) return;');
    expect(appJs).toContain('if (seq !== plansRequestSeq) return;');
  });
});
