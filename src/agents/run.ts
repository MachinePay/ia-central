import { generateText, stepCountIs } from 'ai';
import type { Specialist } from '../domain/types.js';
import { env, setting } from '../lib/env.js';
import { withFallback } from '../lib/llm.js';
import { isBusinessHours, nowLabel } from '../lib/util.js';
import { companiesText, contactProfile, toModelMessages, type ContextPack } from '../memory/context.js';
import { toolsFor, type ToolCtx } from '../tools/index.js';
import { fill, loadPrompt } from './prompts.js';

const PROMPT_FILE: Record<Specialist, string> = { JOAO: 'joao', CLARA: 'clara', GABRIEL: 'gabriel' };
const AGENT_TIMEOUT_MS = 60_000;
const MAX_STEPS = 6;

export type AgentResult = {
  text: string;
  modelSpec: string;
  inputTokens: number;
  outputTokens: number;
  ctx: ToolCtx;
};

export function systemPrompt(agent: Specialist, pack: ContextPack, internalNote: string, previous: string, introduce: boolean): string {
  const company = pack.companies.find((c) => c.slug === pack.thread.company_slug);
  const common = fill(loadPrompt('comum'), {
    TODAY: nowLabel(env.TIMEZONE),
    BUSINESS_HOURS: setting('BUSINESS_HOURS'),
    IN_HOURS: isBusinessHours(setting('BUSINESS_HOURS'), env.TIMEZONE) ? 'agora estamos dentro do horário' : 'agora estamos FORA do horário: o que depender de uma pessoa fica para o próximo dia útil, avise isso',
    CHANNEL: pack.thread.channel,
    PREVIOUS_AGENT: previous,
    COMPANIES: companiesText(pack.companies),
    COMPANY: company ? company.name : 'ainda não identificada (descubra com naturalidade se precisar)',
    CONTACT_PROFILE: contactProfile(pack.contact),
    FACTS_JSON: JSON.stringify(pack.thread.facts ?? {}),
    SUMMARY: pack.thread.summary ?? '(conversa nova)',
    OTHER_CHANNEL: pack.otherChannel ?? '(nenhum)',
    INTERNAL_NOTE: internalNote || '(nenhuma)',
    FIRST_MESSAGE_RULE: introduce
      ? '\n# PRIMEIRA MENSAGEM SUA NESTA CONVERSA\nApresente-se em uma linha (nome e área) e mostre que conhece o contexto com uma referência concreta ao que já foi dito. Não diga "vou te transferir".'
      : '',
  });
  return `${common}\n${loadPrompt(PROMPT_FILE[agent])}`;
}

export async function runAgent(agent: Specialist, pack: ContextPack, o: { internalNote: string; previous: string; introduce: boolean }): Promise<AgentResult> {
  const ctx: ToolCtx = {
    thread: pack.thread, contact: pack.contact, agent, companies: pack.companies,
    log: [], evidence: [], kbConsulted: false,
  };
  const system = systemPrompt(agent, pack, o.internalNote, o.previous, o.introduce);
  const messages = toModelMessages(pack.recent, pack.thread.channel);
  const r = await withFallback('agent', ({ model }) =>
    generateText({
      model,
      system,
      messages,
      tools: toolsFor(agent, ctx),
      stopWhen: [stepCountIs(MAX_STEPS), () => !!ctx.handoff],
      abortSignal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      maxRetries: 1,
      // atendimento precisa de resposta rapida: raciocinio curto nos modelos que suportam
      providerOptions: { openai: { reasoningEffort: env.LLM_REASONING_EFFORT } },
    }),
    () => ctx.log.length === 0,
  );
  return {
    text: r.text.trim(),
    modelSpec: r.modelSpec,
    inputTokens: r.totalUsage?.inputTokens ?? r.usage.inputTokens ?? 0,
    outputTokens: r.totalUsage?.outputTokens ?? r.usage.outputTokens ?? 0,
    ctx,
  };
}
