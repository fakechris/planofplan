import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import type { PlanConfig } from './types.ts';

export interface AppConfig {
  port: number;
  plans: PlanConfig[];
}

const DEFAULT_PLANS: PlanConfig[] = [
  {
    slug: 'minimax',
    name: 'MiniMax legacy',
    adapter: 'minimax',
    enabled: true,
    pollIntervalSec: 60,
    credRef: null,
    extra: { region: 'cn' },
  },
  {
    slug: 'glm',
    name: 'GLM Coding Plan',
    adapter: 'glm',
    enabled: true,
    pollIntervalSec: 60,
    credRef: null,
    extra: {},
  },
  {
    slug: 'codex',
    name: 'OpenAI Codex',
    adapter: 'codex',
    enabled: true,
    pollIntervalSec: 60,
    credRef: null,
    extra: {},
  },
  {
    slug: 'kimi',
    name: 'Kimi Code',
    adapter: 'kimi',
    enabled: true,
    pollIntervalSec: 60,
    credRef: null,
    extra: { browser: 'safari' },
  },
  {
    slug: 'grok',
    name: 'Grok',
    adapter: 'grok',
    enabled: true,
    pollIntervalSec: 300,
    credRef: null,
    extra: {},
  },
  {
    slug: 'cursor',
    name: 'Cursor legacy',
    adapter: 'cursor',
    enabled: true,
    pollIntervalSec: 300,
    credRef: null,
    extra: {},
  },
  {
    slug: 'claude',
    name: 'Claude Code',
    adapter: 'claude',
    enabled: true,
    pollIntervalSec: 900,
    credRef: null,
    extra: {},
  },
];

export function homeDir(): string {
  return process.env.PLANOFPPLAN_HOME ?? join(homedir(), '.planofplan');
}

export function ensureHome(): string {
  const dir = homeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    chmodSync(dir, 0o700);
  }
  return dir;
}

export function configPath(): string {
  return join(ensureHome(), 'config.json');
}

export function loadConfig(): AppConfig {
  const file = configPath();
  let user: Partial<AppConfig> = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    } catch {
      user = {};
    }
  }
  const plans: PlanConfig[] = normalizePlanSet(
    Array.isArray(user.plans) && user.plans.length > 0 ? user.plans : DEFAULT_PLANS,
  );
  return {
    port: envPort() ?? user.port ?? 9288,
    plans,
  };
}

/** 将历史上的 GLM legacy/current 双 plan 收敛为一个 provider。 */
export function normalizePlanSet(input: PlanConfig[]): PlanConfig[] {
  const glm = input.filter((plan) => plan.adapter === 'glm');
  if (glm.length === 0) {
    return input;
  }
  if (glm.length === 1 && glm[0]!.slug === 'glm') {
    return input.map((plan) => ({
      ...plan,
      extra: withoutGlmRegion(plan.extra),
    }));
  }

  const selected = glm.find((plan) => plan.slug === 'glm_current')
    ?? glm.find((plan) => plan.slug === 'glm_legacy')
    ?? glm[0]!;
  const { region: _region, ...extra } = selected.extra ?? {};
  const canonical: PlanConfig = {
    ...selected,
    slug: 'glm',
    name: 'GLM Coding Plan',
    extra,
  };
  const firstGlmIndex = input.findIndex((plan) => plan.adapter === 'glm');
  return input
    .filter((plan) => plan.adapter !== 'glm')
    .toSpliced(firstGlmIndex, 0, canonical);
}

function withoutGlmRegion(extra: Record<string, string>): Record<string, string> {
  const { region: _region, ...rest } = extra ?? {};
  return rest;
}

function envPort(): number | null {
  const raw = process.env.PLANOFPPLAN_PORT;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export { DEFAULT_PLANS };
