import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { PlanConfig, ResumeConfig } from './types.ts';

export interface AppConfig {
  port: number;
  plans: PlanConfig[];
  resume?: ResumeConfig;
  /** planofplan 自用的 LLM(handoff 摘要等);provider 必须是已配置 key 的。 */
  llm?: LlmConfig;
}

/** LLM 选择:provider = 已配置凭据的 provider;model 自由填;baseUrl 可覆写端点。 */
export interface LlmConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
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
    extra: { peakPricing: 'true' },
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
  {
    slug: 'factory',
    name: 'Factory Droid',
    adapter: 'factory',
    enabled: true,
    pollIntervalSec: 300,
    credRef: null,
    extra: { browser: 'safari' },
  },
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    adapter: 'deepseek',
    enabled: true,
    pollIntervalSec: 300,
    credRef: null,
    extra: { peakPricing: 'true' },
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

/** DSH is the web GUI on 3080, not TUI. ZCode is the GUI app. Claude wrapper is optional. */
export const DEFAULT_RESUME: ResumeConfig = {
  dsh: { kind: 'url', url: 'http://127.0.0.1:3080/' },
  zcode: { kind: 'app', app: 'ZCode' },
};

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
    resume: { ...DEFAULT_RESUME, ...(user.resume ?? {}) },
    llm: user.llm && typeof user.llm === 'object' ? user.llm : undefined,
  };
}

/** 持久化 llm 配置段(与 config.json 现有内容合并,不动其它键)。 */
export function saveLlmConfig(partial: LlmConfig): void {
  const file = configPath();
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      doc = {};
    }
  }
  const prev = doc.llm && typeof doc.llm === 'object' ? doc.llm as Record<string, unknown> : {};
  const next: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length === 0) delete doc.llm;
  else doc.llm = next;
  mkdirSync(ensureHome(), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * 持久化 plans 配置(整体替换 config.json 的 plans 段;用户显式配置后
 * 不再回退 DEFAULT_PLANS)。设置页写这里,daemon 重启后仍生效。
 */
export function savePlansConfig(plans: PlanConfig[]): void {
  const file = configPath();
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      doc = {};
    }
  }
  if (plans.length === 0) delete doc.plans;
  else doc.plans = plans;
  mkdirSync(ensureHome(), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
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
