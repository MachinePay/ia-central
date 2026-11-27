import { generateObject } from 'ai';
import { isClosingMessage } from '../lib/closing.js';
import { z } from 'zod';
import { fill, loadPrompt } from '../agents/prompts.js';
import type { Agent, Specialist } from '../domain/types.js';
import { instanceRole, numberOf, numberRule } from '../lib/env.js';
import { addCost, costUsd, withFallback } from '../lib/llm.js';
import { keys, redis } from '../lib/redis.js';
import { fence } from '../lib/util.js';
import { companiesText, contactProfile, historyText, type ContextPack } from '../memory/context.js';
import { isTakeover } from '../takeover.js';

export type RouteDecision =
  | { action: 'SILENT'; reason: string; escalate?: boolean }
  | { action: 'TRIAGE'; question: string; level: 3; router?: unknown }
  | { action: 'AGENT'; agent: Specialist; level: 1 | 2 | 3; reason: string; internalNote: string; router?: RouterOut; notifyGabriel?: boolean };

const RouterOutput = z.object({
  target_agent: z.enum(['JOAO', 'CLARA', 'GABRIEL', 'LEO']),
  confidence: z.number().min(0).max(1),
  intent_summary: z.string().max(200),
  urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'ANGRY']),
  internal_note: z.string().max(400),
  handoff_needed: z.boolean(),
  company_slug: z.string().nullable(),
});
export type RouterOut = z.infer<typeof RouterOutput>;

const RATE_PER_HOUR = 20;
const isSpecialist = (a: Agent): a is Specialist => a === 'JOAO' || a === 'CLARA' || a === 'GABRIEL';

// ------------------------------------------------------------------ nivel 1: deterministico (sem LLM)
export async function preRoute(p: ContextPack): Promise<RouteDecision | { action: 'CHECK_CONTINUITY' } | null> {
  const { thread, contact } = p;
  // e-mail ligado a um numero segue as regras daquela pessoa; conta de e-mail solta segue o atendimento normal
  const num = numberOf(thread.instance);
  const ofNumber = thread.channel === 'WHATSAPP' || num !== thread.instance;
  if (ofNumber && instanceRole(num) === 'OBSERVAR') return { action: 'SILENT', reason: 'numero so aprendendo' };
  if (await isTakeover(thread.id)) return { action: 'SILENT', reason: 'takeover humano' };
  if (thread.status === 'PAUSED') return { action: 'SILENT', reason: 'thread pausada' };
  if (contact.opted_out) return { action: 'SILENT', reason: 'opt-out' };
  if (!p.block.length) return { action: 'SILENT', reason: 'nada novo para responder' };
  if (p.block.every((m) => isClosingMessage(m.content, (m.media ?? []).length > 0))) return { action: 'SILENT', reason: 'mensagem de encerramento (valeu, obrigado, ok)' };

  const rate = await redis.incr(keys.rate(contact.id));
  if (rate === 1) await redis.expire(keys.rate(contact.id), 3600);
  if (rate > RATE_PER_HOUR) return { action: 'SILENT', reason: 'limite de respostas por hora', escalate: rate === RATE_PER_HOUR + 1 };

  // regra do numero: "so os marcados" = a IA so responde conversas com a caixinha marcada (configurado na tela IAs)
  if (ofNumber) {
    const allowed = !!thread.ai_enabled;
    if (numberRule(num).reply === 'selected' && !allowed) return { action: 'SILENT', reason: 'contato nao marcado para a IA deste numero' };
    // numero de pessoa (Gabriel, Leo...): quem responde e sempre a propria pessoa
    if (instanceRole(num) === 'GABRIEL') return { action: 'AGENT', agent: 'GABRIEL', level: 1, reason: 'numero de pessoa', internalNote: '' };
  }

  if (/\b(falar com o gabriel|quero o gabriel|chama o gabriel)\b/i.test(p.blockText)) return { action: 'AGENT', agent: 'GABRIEL', level: 1, reason: 'pedido explícito', internalNote: 'Cliente pediu o Gabriel: use notify_real_gabriel.' };
  if (contact.tags.includes('VIP')) return { action: 'AGENT', agent: 'GABRIEL', level: 1, reason: 'VIP', internalNote: '' };
  if (contact.role === 'FORNECEDOR') return { action: 'AGENT', agent: 'GABRIEL', level: 1, reason: 'fornecedor', internalNote: '' };
  if (thread.pending_handoff) {
    return { action: 'AGENT', agent: thread.pending_handoff.to, level: 1, reason: `handoff: ${thread.pending_handoff.reason}`, internalNote: thread.pending_handoff.summary };
  }
  const minutes = thread.last_bot_at ? (Date.now() - new Date(thread.last_bot_at).getTime()) / 60_000 : Infinity;
  if (isSpecialist(thread.active_agent) && minutes < 120) return { action: 'CHECK_CONTINUITY' };
  return null;
}

// ------------------------------------------------------------------ nivel 2: continuidade
async function continuity(p: ContextPack): Promise<boolean> {
  const lastBot = [...p.recent].reverse().find((m) => m.direction === 'OUTBOUND' && m.sender !== 'HUMAN');
  try {
    const r = await withFallback('small', ({ model }) =>
      generateObject({
        model,
        schema: z.object({ continues: z.boolean() }),
        system: loadPrompt('continuidade'),
        prompt: [
          `Agente atual: ${p.thread.active_agent}`,
          fence('resumo', p.thread.summary ?? ''),
          fence('ultima_resposta_do_agente', lastBot?.content ?? ''),
          fence('mensagem_cliente', p.blockText),
        ].join('\n'),
        maxRetries: 1,
        providerOptions: { openai: { reasoningEffort: 'minimal' } }, // tarefa simples: resposta rapida
      }),
    );
    await addCost(costUsd(r.modelSpec, r.usage.inputTokens, r.usage.outputTokens));
    return r.object.continues;
  } catch {
    return true; // na duvida, mantem quem ja estava atendendo
  }
}

// ------------------------------------------------------------------ nivel 3: Leo
async function leo(p: ContextPack): Promise<RouterOut | undefined> {
  try {
    const r = await withFallback('router', ({ model }) =>
      generateObject({
        model,
        schema: RouterOutput,
        system: fill(loadPrompt('leo'), { COMPANIES: companiesText(p.companies), ACTIVE_AGENT: p.thread.active_agent }),
        prompt: [
          fence('perfil', contactProfile(p.contact)),
          fence('resumo', p.thread.summary ?? ''),
          fence('historico_recente', historyText(p.recent)),
          fence('mensagem_cliente', p.blockText),
        ].join('\n'),
        maxRetries: 1,
        providerOptions: { openai: { reasoningEffort: 'minimal' } }, // tarefa simples: resposta rapida
        abortSignal: AbortSignal.timeout(20_000),
      }),
    );
    await addCost(costUsd(r.modelSpec, r.usage.inputTokens, r.usage.outputTokens));
    return r.object;
  } catch {
    return undefined;
  }
}

const defaultAgent = (p: ContextPack): Specialist =>
  isSpecialist(p.thread.active_agent) ? p.thread.active_agent : p.contact.role === 'CLIENTE' || p.contact.crm_stage === 'CUSTOMER' ? 'CLARA' : 'JOAO';

export async function route(p: ContextPack): Promise<RouteDecision> {
  const pre = await preRoute(p);
  if (pre && pre.action !== 'CHECK_CONTINUITY') return pre;
  if (pre?.action === 'CHECK_CONTINUITY' && (await continuity(p))) {
    return { action: 'AGENT', agent: p.thread.active_agent as Specialist, level: 2, reason: 'continuidade', internalNote: '' };
  }
  const out = await leo(p);
  if (!out) return { action: 'AGENT', agent: defaultAgent(p), level: 3, reason: 'Léo falhou: mantém/padrão', internalNote: '' };
  // confianca baixa: o Leo faz UMA pergunta curta de triagem (escrita por ele) em vez de transferir.
  // Se ele apontou um especialista mas nao escreveu pergunta, o especialista atende confirmando o entendimento.
  if (out.target_agent === 'LEO' || out.confidence < 0.6) {
    if (out.target_agent !== 'LEO' && out.confidence >= 0.4) {
      return {
        action: 'AGENT', agent: out.target_agent, level: 3, reason: out.intent_summary, router: out,
        internalNote: `${out.internal_note} (Roteamento com pouca certeza: confirme com o cliente se entendeu certo antes de aprofundar.)`,
      };
    }
    const question = out.target_agent === 'LEO' && out.internal_note ? out.internal_note : 'Me conta um pouquinho mais: é sobre um equipamento que você já tem ou sobre conhecer nossas soluções?';
    return { action: 'TRIAGE', question, level: 3, router: out };
  }
  return {
    action: 'AGENT', agent: out.target_agent, level: 3, reason: out.intent_summary, internalNote: out.internal_note, router: out,
    notifyGabriel: out.urgency === 'HIGH' && out.sentiment === 'ANGRY',
  };
}

/** Maximo de 2 trocas de agente por thread em 30 min; na terceira, vai para o Gabriel real. */
export function switchLimitReached(switches: Array<{ at: string }>): boolean {
  const recent = switches.filter((s) => Date.now() - new Date(s.at).getTime() < 30 * 60_000);
  return recent.length >= 2;
}
