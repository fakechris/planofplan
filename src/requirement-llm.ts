import type { Store } from './db.ts';
import { llmChat } from './llm.ts';
import type { LlmConfig } from './config.ts';

// ── 需求 LLM 精炼层 ─────────────────────────────────────────────────
// 参照系:agentsview recall/extract 的"逐消息蒸馏 + 严格锚定"(命令/路径/
// 标识符原文引用、数量随内容不填充、条目独立成句),以及 obelisk memories
// 的纪律——合成缓存不替代原始证据、绝不覆盖原话。
//
// 形态:requirements.refined_text 可选列,display 侧"有精炼用精炼,无则
// 原话"。增量(refined_at 兼作已尝试标记,空结果不重试)、限量(每轮
// collect 最多 N 条,避免 LLM 蜂拥)、显式 opt-in(env 开关,成本可控)。

const REFINEMENT_SYSTEM = `你从 coding agent 会话的用户消息里提炼"需求陈述",用于项目图谱的节点标签。

规则:
- 输出恰好一句中文陈述,不超过 80 个字符,不要任何前后缀、引号或解释。
- 保留精确的文件路径、命令、库名、标识符,原文引用,不要意译掉。
- 只陈述用户想要什么(任务/目标/约束),不要包含实现过程。
- 跨多条消息时,提炼成一句话概括主要需求;若有多个不相关需求,取最主要的一个。
- 如果这些消息只是闲聊、寒暄、确认或无法提炼出比原文更清晰的陈述,只输出一个空行。
- 不虚构任何原文中没有的信息。`;

/** 单条需求的输入:该 session 的用户消息(截断、限量,聚焦开头)。 */
function buildUserPrompt(texts: string[]): string {
  const clipped = texts.slice(0, 8).map((t) => t.replace(/\s+/g, ' ').slice(0, 300));
  return `会话的用户消息(按时间序):\n${clipped.map((t) => `- ${t}`).join('\n')}\n\n请输出这一句需求陈述(或空行):`;
}

export interface RefineResult {
  attempted: number;
  refined: number;
  skipped?: string;
}

export function requirementLlmEnabled(env: NodeJS.ProcessEnv = process.env, cfg?: { refine?: boolean }): boolean {
  return env.PLANOFPLAN_REQUIREMENT_LLM === '1' || cfg?.refine === true;
}

/**
 * 精炼一轮(有界):每轮最多 limit 条。llmChat 的 fetch 可注入(测试)。
 * 任何失败都只影响当轮,refined_at 不写(下次还会重试)。
 */
export async function refineRequirements(
  store: Store,
  cfg: LlmConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: unknown;
    timeoutMs?: number;
    limit?: number;
    sinceMs?: number;
  } = {},
): Promise<RefineResult> {
  const env = options.env ?? process.env;
  if (!requirementLlmEnabled(env, cfg) || !cfg.provider) {
    return { attempted: 0, refined: 0, skipped: !requirementLlmEnabled(env, cfg) ? '精炼未开启(config llm.refine 或 env)' : '未配置 LLM' };
  }
  const limit = options.limit ?? 8;
  const sinceMs = options.sinceMs ?? Date.now() - 60 * 86_400_000;
  const candidates = store.requirementsAwaitingRefinement(limit, sinceMs);
  if (candidates.length === 0) return { attempted: 0, refined: 0 };

  const textsBySession = store.listSessionUserTexts();
  let refined = 0;
  for (const candidate of candidates) {
    const texts = textsBySession.get(candidate.sessionId) ?? [candidate.text];
    try {
      const result = await llmChat({
        cfg,
        env,
        system: REFINEMENT_SYSTEM,
        user: buildUserPrompt(texts),
        fetchImpl: options.fetchImpl as never,
        timeoutMs: options.timeoutMs ?? 20_000,
      });
      const refinedText = (result.content ?? '').trim().slice(0, 120);
      store.setRequirementRefined(candidate.id, refinedText || null);
      if (refinedText) refined += 1;
    } catch {
      /* 单条失败不拖垮整轮,也不标记(下次重试) */
    }
  }
  return { attempted: candidates.length, refined };
}
