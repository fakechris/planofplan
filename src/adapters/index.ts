import type { PlanAdapter } from '../types.ts';
import { minimaxAdapter } from './minimax.ts';
import { glmAdapter } from './glm.ts';
import { codexAdapter } from './codex.ts';
import { kimiAdapter } from './kimi.ts';
import { grokAdapter } from './grok.ts';
import { cursorAdapter } from './cursor.ts';
import { claudeAdapter } from './claude.ts';
import { factoryAdapter } from './factory.ts';

export const registry: Record<string, PlanAdapter> = {
  minimax: minimaxAdapter,
  glm: glmAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  grok: grokAdapter,
  cursor: cursorAdapter,
  claude: claudeAdapter,
  factory: factoryAdapter,
};

export function getAdapter(slug: string): PlanAdapter | null {
  return registry[slug] ?? null;
}

/** 已注册 adapter 的 slug 列表 */
export function registeredAdapters(): string[] {
  return Object.keys(registry);
}
