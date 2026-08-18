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
    slug: 'glm_legacy',
    name: 'GLM legacy',
    adapter: 'glm',
    enabled: true,
    pollIntervalSec: 60,
    credRef: null,
    extra: { region: 'cn' },
  },
  {
    slug: 'glm_current',
    name: 'GLM current',
    adapter: 'glm',
    enabled: true,
    pollIntervalSec: 60,
    credRef: null,
    extra: { region: 'cn' },
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
  const plans: PlanConfig[] =
    Array.isArray(user.plans) && user.plans.length > 0 ? user.plans : DEFAULT_PLANS;
  return {
    port: envPort() ?? user.port ?? 9288,
    plans,
  };
}

function envPort(): number | null {
  const raw = process.env.PLANOFPPLAN_PORT;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export { DEFAULT_PLANS };
