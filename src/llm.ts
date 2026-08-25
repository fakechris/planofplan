/**
 * planofplan 自用的 LLM 通道(handoff 摘要等合成层)。
 *
 * key 复用额度采集的凭据抽屉:credentials.json(readCredential)优先,
 * 环境变量兜底——不新增任何密钥配置。provider 注册表只收 OpenAI
 * 兼容 chat/completions 端点;model 由用户自由填写(建议值在
 * defaultModel)。fetch 可注入,测试不打真网。
 *
 * 纪律:LLM 只做合成(输出标 synthesized),永不替代证据块——
 * 对账体系(self_reported < file_persisted < verified)不接受模型改写。
 */
import { readCredential } from './auth.ts';
import type { LlmConfig } from './config.ts';
import type { HandoffPackage } from './handoff.ts';

export interface LlmProviderSpec {
  id: string;
  label: string;
  /** OpenAI 兼容端点的 base(拼 /chat/completions)。 */
  baseUrl: string;
  defaultModel: string;
  /** 环境变量兜底(优先级序)。 */
  envKeys: string[];
}

export const LLM_PROVIDERS: LlmProviderSpec[] = [
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2',
    envKeys: ['MINIMAX_CODING_API_KEY', 'MINIMAX_API_KEY'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    envKeys: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'glm',
    label: 'GLM(z.ai/BigModel)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.7',
    envKeys: ['Z_AI_API_KEY', 'ZAI_API_KEY', 'BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  },
];

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** key 解析:credentials.json 优先,env 兜底;reader 可注入。 */
export function llmKeyFor(providerId: string, env: NodeJS.ProcessEnv = process.env, reader = readCredential): string | null {
  const spec = LLM_PROVIDERS.find((entry) => entry.id === providerId);
  if (!spec) return null;
  const stored = reader(providerId);
  if (stored?.value) return stored.value;
  for (const key of spec.envKeys) {
    const value = env[key];
    if (value) return value;
  }
  return null;
}

/** 可用 provider 列表(带 hasKey),供前端下拉。 */
export function llmProviderStatus(env: NodeJS.ProcessEnv = process.env, reader = readCredential): Array<LlmProviderSpec & { hasKey: boolean }> {
  return LLM_PROVIDERS.map((spec) => ({ ...spec, hasKey: llmKeyFor(spec.id, env, reader) != null }));
}

export interface LlmChatResult {
  content: string | null;
  error: string | null;
}

/** 剥离推理模型的 <think> 块(MiniMax-M2 等把推理过程写进 content)。 */
function stripThinkBlocks(content: string): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // 未闭合的截断 think(超长输出被 max_tokens 切断):丢弃 think 起点之前的内容
  const open = out.indexOf('<think>');
  if (open >= 0) out = out.slice(0, open).trim();
  return out;
}

/** OpenAI 兼容 chat 一次调用;失败返回 error,不抛。 */
export async function llmChat(args: {
  cfg: LlmConfig;
  env?: NodeJS.ProcessEnv;
  reader?: typeof readCredential;
  system: string;
  user: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<LlmChatResult> {
  const provider = args.cfg.provider;
  if (!provider) return { content: null, error: '未配置 LLM provider' };
  const spec = LLM_PROVIDERS.find((entry) => entry.id === provider);
  if (!spec) return { content: null, error: `未知 provider:${provider}` };
  const key = llmKeyFor(provider, args.env ?? process.env, args.reader);
  if (!key) return { content: null, error: `${provider} 没有可用 key(credentials.json 或环境变量)` };
  const model = args.cfg.model?.trim() || spec.defaultModel;
  const base = (args.cfg.baseUrl?.trim() || spec.baseUrl).replace(/\/+$/, '');
  const doFetch = args.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 40_000);
  try {
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        max_tokens: 700,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { content: null, error: `${provider} ${res.status}:${text.slice(0, 160)}` };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? null;
    const content = raw ? stripThinkBlocks(raw) : null;
    if (!content) return { content: null, error: `${provider} 返回空内容` };
    return { content, error: null };
  } catch (error) {
    return { content: null, error: `LLM 调用失败:${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

const SYNTH_SYSTEM = [
  '你是交接助手。输入是一个从本地观测系统导出的交接证据包(markdown),',
  '内容包含:目标(需求原文)、计划状态(阶段/勾选)、agent 自报进展(Todo/总结,可能不准)、',
  '产出 commit、涉及文件、相关会话。',
  '请写一段 ≤300 字的「现状综合」,给接手的工程师/agent 看:',
  '1) 这个工作在做什么、进行到哪一步;2) 已经确定了什么;',
  '3) 明显的缺口/风险(注意自报与 commit 可能不一致);4) 建议的下一步(最多 3 条)。',
  '只依据输入证据,不要编造;不确定的地方明确说「证据里没有」。输出纯文本,不要标题。',
].join('');

/** 合成交接摘要头;失败/未配置返回 null(调用方退化为纯证据包)。 */
export async function synthesizeHandoffSummary(
  pkg: HandoffPackage,
  cfg: LlmConfig,
  options: { env?: NodeJS.ProcessEnv; reader?: typeof readCredential; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!cfg.provider) return null;
  const result = await llmChat({
    cfg,
    env: options.env,
    reader: options.reader,
    system: SYNTH_SYSTEM,
    user: pkg.markdown.slice(0, 12_000),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return result.content;
}

/** 把摘要头插到证据块之前(## 目标 前),标 synthesized。 */
export function withSummary(pkg: HandoffPackage, summary: string): HandoffPackage {
  const marker = '\n## 目标\n';
  const at = pkg.markdown.indexOf(marker);
  if (at < 0) return pkg;
  const section = `\n## 现状综合(AI 摘要 · synthesized,非证据)\n\n${summary.trim()}\n`;
  return { ...pkg, markdown: pkg.markdown.slice(0, at) + section + pkg.markdown.slice(at) };
}
