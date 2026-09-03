import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Store } from '../src/db.ts';
import { parseSkillContent, searchSkills, syncSkillsCatalog } from '../src/skills.ts';

describe('Skills indexer and search', () => {
  it('parses skill frontmatter cleanly', () => {
    const sample = `---
name: obsidian-vault-pipeline
description: |
  使用 Obsidian Vault Pipeline 自动化整理知识库。
  支持整理笔记、处理知识库。
allowed-tools:
  - Bash
  - Read
---

# Obsidian Vault Pipeline
- 用户说 "整理 Obsidian Vault" 触发
- 用户提到 "运行 Pipeline" 时处理
`;
    const parsed = parseSkillContent(sample, 'fallback');
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('obsidian-vault-pipeline');
    expect(parsed?.description).toContain('使用 Obsidian Vault Pipeline');
    expect(parsed?.allowedTools).toEqual(['Bash', 'Read']);
    expect(parsed?.triggers).toContain('整理 Obsidian Vault');
    expect(parsed?.triggers).toContain('运行 Pipeline');
  });

  it('indexes and searches skills with FTS5', () => {
    const db = new Database(':memory:');
    const store = new Store(db);

    const result = syncSkillsCatalog(store);
    expect(result.total).toBeGreaterThan(50);

    // 搜索特定技能
    const hits = searchSkills(store, 'obsidian', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name.toLowerCase()).toContain('obsidian');

    // 搜索调试技能
    const debugHits = searchSkills(store, 'debugging', 5);
    expect(debugHits.length).toBeGreaterThan(0);
    expect(debugHits.some((h) => h.name.includes('debug') || h.description.toLowerCase().includes('debug'))).toBe(true);
  });
});

