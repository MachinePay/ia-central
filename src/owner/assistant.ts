import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { fill, loadPrompt } from '../agents/prompts.js';
import { decideApproval } from '../approvals/approvals.js';
import { sendText } from '../channels/whatsapp/evolution.js';
import { stripEmojis } from '../channels/whatsapp/format.js';
import { deliver } from '../delivery.js';
import { getThread } from '../domain/repo.js';
import { one, q } from '../lib/db.js';
import { centralInstance, env, instanceRoles, personaFor } from '../lib/env.js';
import { addCost, costToday, costUsd, withFallback } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { keys, redis } from '../lib/redis.js';
import { fence, nowLabel } from '../lib/util.js';
import { statusText } from '../sentinela/commands.js';
import { costSummary, formatCosts } from '../sentinela/costs.js';
import { ack } from '../sentinela/incidents.js';

/**
 * IA central: o orquestrador. Conversa so com o dono, pelo numero da IA (papel CENTRAL)
 * ou pela conversa "Voce" do numero pessoal dele. Le tudo e executa o que ele mandar.
 */

const HISTORY_KEY = 'owner-chat:history';

type Where = { instance: string; to: string };

/** Onde responder: no numero da IA (central) ou na propria conversa "Voce". */
export function ownerReplyTarget(cameFrom: 'central' | 'self', selfInstance?: string): Where | undefined {
  const phone = normalizePhone(env.GABRIEL_PERSONAL_PHONE);
  if (!phone) return undefined;
  if (cameFrom === 'central') { const c = centralInstance(); return c ? { instance: c, to: phone } : undefined; }
  return selfInstance ? { instance: selfInstance, to: phone } : undefined;
}

async function findThread(search: string) {
  const digits = search.replace(/\D/g, '');
  return q<{ id: string; instance: string; contact: string; phone: string | null; contact_id: string }>(
    `SELECT t.id, t.instance, coalesce(c.name, c.phone, c.email) AS contact, c.phone, c.id AS contact_id FROM threads t JOIN contacts c ON c.id = t.contact_id
      WHERE c.name ILIKE $1 OR ($2 <> '' AND c.phone LIKE '%' || $2 || '%') OR c.email ILIKE $1
      ORDER BY coalesce(t.last_inbound_at, t.updated_at) DESC LIMIT 5`,
    [`%${search}%`, digits.length >= 4 ? digits : ''],
  );
}

function tools(log: string[]) {
  const done = (s: string) => { log.push(s); return s; };
  return {
    visao_geral: tool({
      description: 'Como está tudo agora: aprovações pendentes, incidentes, conversas sem resposta, números de WhatsApp e gasto do dia.',
      inputSchema: z.object({}),
      execute: async () => {
        const [approvals, unanswered, numbers] = await Promise.all([
          q(`SELECT code, action, requested_by FROM pending_approvals WHERE status = 'PENDING' ORDER BY created_at`),
          q(`SELECT coalesce(c.name, c.phone) AS contato, t.instance AS numero, t.last_inbound_at FROM threads t JOIN contacts c ON c.id = t.contact_id
              WHERE t.last_inbound_at > now() - interval '2 days' AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at) AND c.role <> 'PESSOAL'
              ORDER BY t.last_inbound_at LIMIT 10`),
          Promise.resolve([...instanceRoles()].map(([n, r]) => `${n} (${r}, ${personaFor(n).name})`)),
        ]);
        return { aprovacoes: approvals, sem_resposta: unanswered, sentinela: await statusText(), numeros: numbers, gasto_ia_hoje_usd: (await costToday()).toFixed(2) };
      },
    }),
    conversas: tool({
      description: 'Lista conversas recentes. filtro: sem_resposta, com_aprovacao ou recentes. numero: nome da instância (opcional).',
      inputSchema: z.object({ filtro: z.enum(['sem_resposta', 'com_aprovacao', 'recentes']), numero: z.string().optional() }),
      execute: async ({ filtro, numero }) => q(
        `SELECT coalesce(c.name, c.phone) AS contato, t.instance AS numero, t.active_agent AS agente, left(lm.content, 100) AS ultima, lm.direction AS de
           FROM threads t JOIN contacts c ON c.id = t.contact_id
           LEFT JOIN LATERAL (SELECT content, direction FROM messages m WHERE m.thread_id = t.id ORDER BY created_at DESC LIMIT 1) lm ON true
          WHERE ($2::text IS NULL OR t.instance = $2)
            AND ($1 <> 'sem_resposta' OR (t.last_inbound_at IS NOT NULL AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)))
            AND ($1 <> 'com_aprovacao' OR EXISTS (SELECT 1 FROM pending_approvals a WHERE a.thread_id = t.id AND a.status = 'PENDING'))
          ORDER BY coalesce(t.last_inbound_at, t.updated_at) DESC LIMIT 10`,
        [filtro, numero ?? null],
      ),
    }),
    ler_conversa: tool({
      description: 'Lê a conversa com um contato (busca por nome ou telefone): resumo, como o dono trata a pessoa e as últimas mensagens.',
      inputSchema: z.object({ busca: z.string().min(2) }),
      execute: async ({ busca }) => {
        const found = await findThread(busca);
        if (!found.length) return { erro: 'Não achei esse contato.' };
        if (found.length > 1 && !found.every((f) => f.contact_id === found[0].contact_id)) return { varios: found.map((f) => `${f.contact} (${f.phone ?? ''}, número ${f.instance})`) };
        const t = found[0];
        const th = await getThread(t.id);
        const msgs = await q<{ direction: string; sender: string | null; content: string; created_at: Date }>(
          `SELECT direction, sender, content, created_at FROM messages WHERE thread_id = $1 AND status NOT IN ('DRAFT_DISCARDED') ORDER BY created_at DESC LIMIT 15`, [t.id],
        );
        return {
          contato: t.contact, numero: t.instance, resumo: th?.summary,
          mensagens: msgs.reverse().map((m) => `${new Date(m.created_at).toLocaleString('pt-BR', { timeZone: env.TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${m.direction === 'INBOUND' ? 'CONTATO' : m.sender === 'HUMAN' ? 'VOCÊ' : `IA (${m.sender})`}: ${m.content.replace(/^⁣/, '').slice(0, 300)}`),
        };
      },
    }),
    decidir_aprovacao: tool({
      description: 'Aprova, recusa ou envia um texto próprio para uma aprovação pendente (código tipo A-0003).',
      inputSchema: z.object({ codigo: z.string(), decisao: z.enum(['aprovar', 'recusar', 'editar']), texto: z.string().optional() }),
      execute: async ({ codigo, decisao, texto }) => {
        const a = await one<{ id: string }>(`SELECT id FROM pending_approvals WHERE code = $1`, [codigo.toUpperCase().replace(/^#/, '')]);
        if (!a) return { erro: 'Não achei essa aprovação.' };
        try {
          const st = await decideApproval(a.id, decisao === 'aprovar' ? 'APPROVE' : decisao === 'recusar' ? 'REJECT' : 'EDIT', texto);
          return { ok: done(`aprovação ${codigo}: ${st}`) };
        } catch (e: any) { return { erro: e.message }; }
      },
    }),
    responder_contato: tool({
      description: 'Manda para um contato EXATAMENTE o texto que o dono ditou, pelo número da conversa dele. Só use se o dono ditou o texto.',
      inputSchema: z.object({ busca: z.string().min(2), texto: z.string().min(1).max(2000) }),
      execute: async ({ busca, texto }) => {
        const found = await findThread(busca);
        if (found.length !== 1) return found.length ? { varios: found.map((f) => `${f.contact} (${f.phone ?? ''}, número ${f.instance})`) } : { erro: 'Não achei esse contato.' };
        const th = (await getThread(found[0].id))!;
        await redis.set(keys.takeover(th.id), '1', 'EX', 7200); // voce falou: a IA daquela conversa fica quieta 2 h
        await deliver({ thread: th, agent: 'HUMAN', text: texto, force: true });
        return { ok: done(`mandado para ${found[0].contact} pelo número ${th.instance}`) };
      },
    }),
    ligar_ia_contato: tool({
      description: 'Liga ou desliga a IA para um contato (em todos os números em que ele conversa, ou só no número informado). responder_sozinha=true faz a resposta sair sem rascunho.',
      inputSchema: z.object({ busca: z.string().min(2), ligar: z.boolean(), responder_sozinha: z.boolean().optional(), numero: z.string().optional() }),
      execute: async ({ busca, ligar, responder_sozinha, numero }) => {
        let found = await findThread(busca);
        if (numero) found = found.filter((f) => f.instance === numero);
        if (!found.length) return { erro: 'Não achei esse contato.' };
        if (!found.every((f) => f.contact_id === found[0].contact_id)) return { varios: found.map((f) => `${f.contact} (número ${f.instance})`) };
        await q(`UPDATE threads SET ai_enabled = $2, ai_auto = $3 WHERE id = ANY($1::uuid[])`, [found.map((f) => f.id), ligar, ligar && !!responder_sozinha]);
        return { ok: done(`${found[0].contact}: IA ${ligar ? (responder_sozinha ? 'ligada, respondendo sozinha' : 'ligada, em rascunho') : 'desligada'} (${found.map((f) => f.instance).join(', ')})`) };
      },
    }),
    reconhecer_incidente: tool({
      description: 'Marca um incidente do Sentinela como reconhecido (número do incidente, ex.: 42).',
      inputSchema: z.object({ numero: z.number().int() }),
      execute: async ({ numero }) => ((await ack(numero, 'Gabriel (central)')) ? { ok: done(`incidente #I-${numero} reconhecido`) } : { erro: 'Não achei esse incidente aberto.' }),
    }),
    custos: tool({
      description: 'Gasto do mês, projeção e por provedor.',
      inputSchema: z.object({}),
      execute: async () => formatCosts(await costSummary()),
    }),
  };
}

/** Responde o dono. Retorna o texto enviado. */
export async function answerOwner(text: string, where: Where): Promise<string | undefined> {
  const history: ModelMessage[] = (await redis.lrange(HISTORY_KEY, -16, -1)).map((h) => JSON.parse(h));
  const log: string[] = [];
  const owner = personaFor('gabriel').name || 'Gabriel';
  try {
    const r = await withFallback('agent', ({ model }) =>
      generateText({
        model,
        system: fill(loadPrompt('central'), { OWNER: owner, TODAY: nowLabel(env.TIMEZONE) }),
        messages: [...history, { role: 'user', content: fence('mensagem_do_dono', text) }],
        tools: tools(log),
        stopWhen: stepCountIs(6),
        abortSignal: AbortSignal.timeout(60_000),
        maxRetries: 1,
        providerOptions: { openai: { reasoningEffort: env.LLM_REASONING_EFFORT } },
      }),
      () => log.length === 0,
    );
    await addCost(costUsd(r.modelSpec, r.totalUsage?.inputTokens ?? 0, r.totalUsage?.outputTokens ?? 0));
    const reply = stripEmojis(r.text.trim()) || (log.length ? log.join('\n') : 'feito');
    await redis.multi()
      .rpush(HISTORY_KEY, JSON.stringify({ role: 'user', content: text }), JSON.stringify({ role: 'assistant', content: reply }))
      .ltrim(HISTORY_KEY, -30, -1).expire(HISTORY_KEY, 3 * 86400).exec();
    for (const bubble of reply.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).slice(0, 4)) await sendText(where.instance, where.to, bubble);
    return reply;
  } catch (e) {
    logger.error({ err: String(e) }, 'IA central falhou');
    await sendText(where.instance, where.to, 'nao consegui agora, tenta de novo em um minuto').catch(() => undefined);
    return undefined;
  }
}
