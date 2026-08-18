import type { PlanAdapter } from '../types.ts';
import { minimaxAdapter } from './minimax.ts';

export const registry: Record<string, PlanAdapter> = {
  minimax: minimaxAdapter,
};

export function getAdapter(slug: string): PlanAdapter | null {
  return registry[slug] ?? null;
}

/** 已注册 adapter 的 slug 列表 */
export function registeredAdapters(): string[] {
  return Object.keys(registry);
}
