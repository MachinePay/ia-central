import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from './env.js';
import { keys, redis } from './redis.js';
import { todayIn } from './util.js';

const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

export type ModelRole = 'router' | 'agent' | 'small' | 'summary' | 'vision';

const ROLE_ENV: Record<ModelRole, string> = {
  router: env.LLM_ROUTER_MODEL,
  agent: env.LLM_AGENT_MODEL,
  small: env.LLM_SMALL_MODEL,
  summary: env.LLM_SUMMARY_MODEL,
  vision: env.LLM_VISION_MODEL,
};

/** "openai:gpt-5" | "anthropic:claude-sonnet-5-5" */
export function modelFromSpec(spec: string) {
  const [provider, ...rest] = spec.split(':');
  const id = rest.join(':');
  if (provider === 'anthropic') return anthropic(id);
  return openai(id);
}

export function model(role: ModelRole) {
  return { spec: ROLE_ENV[role], model: modelFromSpec(ROLE_ENV[role]) };
}

export function fallbackModel() {
  if (!env.LLM_FALLBACK_MODEL) return undefined;
  if (env.LLM_FALLBACK_MODEL.startsWith('anthropic') && !env.ANTHROPIC_API_KEY) return undefined;
  return { spec: env.LLM_FALLBACK_MODEL, model: modelFromSpec(env.LLM_FALLBACK_MODEL) };
}

/** Roda com o modelo principal; se falhar (fora do ar, chave), tenta o de reserva. */
export async function withFallback<T extends object>(
  role: ModelRole,
  fn: (m: { spec: string; model: ReturnType<typeof modelFromSpec> }) => Promise<T>,
  canRetry: () => boolean = () => true, // ex.: nao repetir se uma tool com efeito ja rodou
): Promise<T & { modelSpec: string }> {
  const main = model(role);
  try {
    return Object.assign(await fn(main), { modelSpec: main.spec });
  } catch (e) {
    const fb = fallbackModel();
    if (!fb || fb.spec === main.spec || !canRetry()) throw e;
    return Object.assign(await fn(fb), { modelSpec: fb.spec });
  }
}

export const embeddingModel = () => openai.embedding(env.EMBEDDING_MODEL);
export const transcriptionModel = () => openai.transcription(env.TRANSCRIBE_MODEL);

// USD por 1M tokens (entrada, saida). Ajuste se mudar de modelo; desconhecido = estimativa conservadora.
const PRICES: Record<string, [number, number]> = {
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
  'gpt-5-nano': [0.05, 0.4],
  'claude-sonnet-5-5': [3, 15],
  'claude-haiku-5-5': [1, 5],
  'claude-opus-5-5': [5, 25],
};

export function costUsd(spec: string, inputTokens = 0, outputTokens = 0): number {
  const id = spec.split(':').slice(1).join(':');
  const [i, o] = PRICES[id] ?? [3, 15];
  return (inputTokens * i + outputTokens * o) / 1_000_000;
}

/** Soma o custo do dia; retorna o total. */
export async function addCost(usd: number): Promise<number> {
  const k = keys.cost(todayIn(env.TIMEZONE));
  const total = await redis.incrbyfloat(k, usd);
  await redis.expire(k, 3 * 86400);
  return Number(total);
}

export async function costToday(): Promise<number> {
  return Number((await redis.get(keys.cost(todayIn(env.TIMEZONE)))) ?? 0);
}
