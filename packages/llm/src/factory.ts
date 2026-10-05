import type { LlmClient } from '@deskpet/contracts';
import type { OutputModel } from '@deskpet/output';
import { GeminiLlmClient, type GeminiThinkingLevel } from './GeminiLlmClient.js';
import { CallWindow, GuardedLlmClient, GuardedOutputModel } from './guard.js';
import { LangChainOutputModel } from './LangChainOutputModel.js';
import { LlmOutputModel } from './LlmOutputModel.js';
import { OpenAiLlmClient } from './OpenAiLlmClient.js';

/**
 * .env로 LLM 공급자를 고른다. 기본은 꺼짐. 공급자를 바꿔도 Harness·출력 코드는 바뀌지 않는다.
 *   LLM_PROVIDER=off|gemini|openai|remote   (remote: 팀 원격 fallback API — 아직 없음, C-12)
 *   gemini : GEMINI_API_KEY, GEMINI_MODEL(기본 gemini-3.1-flash-lite), GEMINI_THINKING_LEVEL(선택 minimal|low|medium|high)
 *   openai : OPENAI_API_KEY, OPENAI_MODEL(필수), OPENAI_BASE_URL(선택)
 *   LLM_OUTPUT_CHAIN=direct|langchain  (기본 direct = LlmClient 위 출력 모델. langchain은 openai에서만)
 *   LLM_MAX_CALLS_PER_MINUTE(기본 20), LLM_MAX_OUTPUT_TOKENS(기본 400), LLM_OUTPUT_TIMEOUT_MS(기본 8000)
 * 키 값은 상태 메시지에 넣지 않는다.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export interface LlmSetup {
  provider: 'off' | 'gemini' | 'openai' | 'remote';
  enabled: boolean;
  reason?: string;
  model?: string;
  outputChain?: 'direct' | 'langchain';
  /** 출력 모델 호출 시간 상한(ms). LLM_OUTPUT_TIMEOUT_MS, 기본 8000 */
  outputTimeoutMs?: number;
  guideClient?: LlmClient;
  outputModel?: OutputModel;
}

export function createLlmFromEnv(env: Record<string, string | undefined>): LlmSetup {
  const provider = (env['LLM_PROVIDER'] || 'off').trim().toLowerCase();
  if (provider === 'off') return { provider: 'off', enabled: false, reason: 'LLM_PROVIDER=off' };
  if (provider === 'remote') return { provider: 'remote', enabled: false, reason: 'remote fallback adapter not implemented yet (C-12)' };
  if (provider !== 'gemini' && provider !== 'openai') return { provider: 'off', enabled: false, reason: `unknown LLM_PROVIDER=${provider}` };

  const maxTokens = positiveInt(env['LLM_MAX_OUTPUT_TOKENS'], 400);
  const window = new CallWindow(positiveInt(env['LLM_MAX_CALLS_PER_MINUTE'], 20));
  const chain = (env['LLM_OUTPUT_CHAIN'] || 'direct').trim().toLowerCase() === 'langchain' ? 'langchain' : 'direct';

  let base: LlmClient;
  let model: string;
  let langchainModel: (() => LangChainOutputModel) | undefined;
  if (provider === 'gemini') {
    const apiKey = env['GEMINI_API_KEY'];
    model = env['GEMINI_MODEL']?.trim() || DEFAULT_GEMINI_MODEL;
    if (!apiKey) return { provider, enabled: false, reason: 'GEMINI_API_KEY is empty' };
    const level = env['GEMINI_THINKING_LEVEL']?.trim().toLowerCase();
    if (level && !['minimal', 'low', 'medium', 'high'].includes(level)) return { provider, enabled: false, reason: `unknown GEMINI_THINKING_LEVEL=${level}` };
    base = new GeminiLlmClient({ apiKey, model, ...(level ? { thinkingLevel: level as GeminiThinkingLevel } : {}) });
  } else {
    const apiKey = env['OPENAI_API_KEY'];
    const m = env['OPENAI_MODEL']?.trim();
    if (!apiKey) return { provider, enabled: false, reason: 'OPENAI_API_KEY is empty' };
    if (!m) return { provider, enabled: false, reason: 'OPENAI_MODEL is empty' };
    model = m;
    const baseURL = env['OPENAI_BASE_URL']?.trim() || undefined;
    base = new OpenAiLlmClient({ apiKey, model, ...(baseURL ? { baseURL } : {}) });
    langchainModel = () => LangChainOutputModel.openai({ apiKey, model, maxOutputTokens: maxTokens, ...(baseURL ? { baseURL } : {}) });
  }
  if (chain === 'langchain' && !langchainModel) return { provider, enabled: false, reason: 'LLM_OUTPUT_CHAIN=langchain is only wired for openai' };

  const guideClient = new GuardedLlmClient(base, window, maxTokens);
  const inner = chain === 'langchain' ? langchainModel!() : new LlmOutputModel(new GuardedLlmClient(base, new CallWindow(Number.MAX_SAFE_INTEGER), maxTokens));
  return { provider, enabled: true, model, outputChain: chain, outputTimeoutMs: positiveInt(env['LLM_OUTPUT_TIMEOUT_MS'], 8_000), guideClient, outputModel: new GuardedOutputModel(inner, window) };
}

function positiveInt(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
}
