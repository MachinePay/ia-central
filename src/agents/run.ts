import { generateText, stepCountIs } from 'ai';
import type { Specialist } from '../domain/types.js';
import { env, personaFor, setting } from '../lib/env.js';
import { withFallback } from '../lib/llm.js';
import { isBusinessHours, nowLabel } from '../lib/util.js';
import { companiesText, contactProfile, toModelMessages, type ContextPack } from '../memory/context.js';
import { knowledgeFor, ownMessagesTo, styleFor } from '../memory/style.js';
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

/** "hoje", "ontem", "ha 3 dias" */
function ago(d: Date | string | null | undefined): string {
  if (!d) return 'em data desconhecida';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  return days <= 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days} dias`;
}

const WHATSAPP_RULES = `- Escreva como no WhatsApp: de 1 a 4 mensagens curtas, separadas por uma linha em branco. Cada mensagem é uma bolha que o cliente vê chegar separada (1 a 2 frases cada).
- Uma resposta simples cabe numa bolha só. Não force várias.
- Pode usar letra minúscula no começo e as abreviações que você costuma usar (veja os exemplos acima).
- Sem markdown: nada de **, #, listas ou links formatados.`;

const EMAIL_RULES = `- E-mail curto e direto, parágrafos de 1 a 3 frases, cumprimento simples no começo e seu nome no final (só o nome).
- Sem textão, sem "venho por meio desta", sem listas longas.`;

export async function systemPrompt(agent: Specialist, pack: ContextPack, internalNote: string): Promise<{ text: string; evidence: string[] }> {
  const company = pack.companies.find((c) => c.slug === pack.thread.company_slug);
  const persona = personaFor(pack.thread.instance);
  const [style, knowledge] = await Promise.all([
    styleFor(pack.thread.instance, pack.thread.company_slug).catch(() => ''),
    knowledgeFor(pack.blockText, pack.thread.company_slug, pack.thread.instance).catch(() => ({ text: '', evidence: [] })),
  ]);
  const common = fill(loadPrompt('comum'), {
    PERSONA_NAME: persona.name,
    PERSONA_ABOUT: persona.about || 'atendimento',
    CHANNEL_NAME: pack.thread.channel === 'GMAIL' ? 'e-mail' : 'WhatsApp',
    TODAY: nowLabel(env.TIMEZONE),
    BUSINESS_HOURS: setting('BUSINESS_HOURS'),
    IN_HOURS: isBusinessHours(setting('BUSINESS_HOURS'), env.TIMEZONE) ? 'agora é horário de atendimento' : 'agora é FORA do horário: o que depender de outra pessoa fica para o próximo dia útil, avise isso com naturalidade',
    STYLE: style || '(ainda sem exemplos deste número: escreva de forma simpática, curta e natural, como alguém no celular)',
    CHANNEL_RULES: pack.thread.channel === 'GMAIL' ? EMAIL_RULES : WHATSAPP_RULES,
    KNOWLEDGE: knowledge.text || '(nada específico sobre este assunto ainda)',
    COMPANIES: companiesText(pack.companies),
    COMPANY: company ? company.name : 'ainda não identificada (descubra com naturalidade se precisar)',
    CONTACT_PROFILE: contactProfile(pack.contact),
    CONTACT_TREATMENT: pack.contact.treatment || '(ainda não aprendido: é a primeira vez ou vocês conversaram pouco)',
    FACTS_JSON: JSON.stringify(pack.thread.facts ?? {}),
    SUMMARY: pack.thread.summary ? `(resumo feito ${ago(pack.thread.summary_at)}; o que está aqui é passado, não é novidade de hoje)
${pack.thread.summary}` : '(conversa nova)',
    OTHER_CHANNEL: pack.otherChannel ?? '(nenhum)',
    INTERNAL_NOTE: internalNote || '(nenhuma)',
  });
  // contato pessoal (amigo, familia, namorada): conversa, nao atendimento; ancora nas mensagens reais para essa pessoa
  if (pack.contact.role === 'PESSOAL') {
    const own = await ownMessagesTo(pack.thread.id).catch(() => [] as string[]);
    const personal = fill(loadPrompt('pessoal'), {
      OWN_MESSAGES: own.length ? own.map((l) => `- ${l.slice(0, 200)}`).join('\n') : '(ainda nenhuma: escreva curto e simples)',
    });
    return { text: `${common}\n${personal}`, evidence: knowledge.evidence };
  }
  return { text: `${common}\n${loadPrompt(PROMPT_FILE[agent])}`, evidence: knowledge.evidence };
}

export async function runAgent(agent: Specialist, pack: ContextPack, o: { internalNote: string; previous: string; introduce: boolean }): Promise<AgentResult> {
  const ctx: ToolCtx = {
    thread: pack.thread, contact: pack.contact, agent, companies: pack.companies,
    log: [], evidence: [], kbConsulted: false,
  };
  const system = await systemPrompt(agent, pack, o.internalNote);
  // o que veio da base tambem conta como fonte para o verificador de saida
  ctx.evidence.push(...system.evidence);
  if (system.evidence.length) ctx.kbConsulted = true;
  const messages = toModelMessages(pack.recent, pack.thread.channel);
  const r = await withFallback('agent', ({ model }) =>
    generateText({
      model,
      system: system.text,
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
