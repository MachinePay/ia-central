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
import { TAKEOVER_SECONDS } from '../takeover.js';
import { fence, nowLabel } from '../lib/util.js';
import { statusText } from '../sentinela/commands.js';
import { costSummary, formatCosts } from '../sentinela/costs.js';
import { ack } from '../sentinela/incidents.js';
import { addItem, fmtWhen, itemLine, listItems, parseLocal, remindersText, removeItem, resolveInstance, updateItem } from './agenda.js';

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

function tools(log: string[], here: string) {
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
        await redis.set(keys.takeover(th.id), '1', 'EX', TAKEOVER_SECONDS); // voce falou: a IA daquela conversa fica quieta 30 min
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

    // ------------------------------------------------------------ agenda, tarefas e anotacoes
    agenda_criar: tool({
      description: `Marca um compromisso, cria uma tarefa ou guarda uma anotação na agenda de uma IA.
- compromisso: tem dia e hora (quando). Se a pessoa não disse dia/hora, não invente: crie como tarefa (fica pendente e entra no resumo diário).
- tarefa: algo a fazer; pode ter prazo (quando) ou não.
- anotacao: só guardar uma informação.
quando: data/hora LOCAL no formato AAAA-MM-DDTHH:MM (ou só AAAA-MM-DD se for o dia todo), calculada a partir de "agora".
avisar_antes_min: minutos antes para avisar (ex.: [1440, 60] = 1 dia e 1 hora antes; [30] = meia hora). Só passe se a pessoa pediu; o padrão é 1 dia e 1 hora antes.
ia: de quem é a agenda (nome da pessoa ou do número). Sem dizer, é a agenda de quem está falando.`,
      inputSchema: z.object({
        tipo: z.enum(['compromisso', 'tarefa', 'anotacao']),
        titulo: z.string().min(2).max(300),
        quando: z.string().optional(),
        detalhes: z.string().max(2000).optional(),
        avisar_antes_min: z.array(z.number().int().min(0).max(60 * 24 * 30)).optional(),
        ia: z.string().optional(),
      }),
      execute: async ({ tipo, titulo, quando, detalhes, avisar_antes_min, ia }) => {
        const inst = resolveInstance(ia, here);
        if (quando && !parseLocal(quando)) return { erro: 'Data inválida: use AAAA-MM-DDTHH:MM.' };
        const it = await addItem({ instance: inst, kind: tipo === 'compromisso' ? 'evento' : tipo === 'tarefa' ? 'tarefa' : 'nota', title: titulo, notes: detalhes, when: quando, reminders: avisar_antes_min, via: 'whatsapp' });
        const what = it.kind === 'evento' ? 'compromisso marcado' : it.kind === 'tarefa' ? (it.due_at ? 'tarefa com prazo criada' : 'tarefa pendente criada (sem data: entra no resumo diário)') : 'anotação guardada';
        return { ok: done(`${what}: #${it.id} ${it.title}${it.due_at ? ` · ${fmtWhen(it.due_at, it.all_day)}` : ''} · agenda de ${personaFor(inst).name}${it.kind !== 'nota' && it.due_at ? ` · aviso ${remindersText(it.remind_minutes)}` : ''}`) };
      },
    }),
    agenda_listar: tool({
      description: 'Lista compromissos, tarefas e anotações. Use para "o que tenho amanhã?", "minhas tarefas", "o que anotei sobre X". de/ate: AAAA-MM-DD (local).',
      inputSchema: z.object({ de: z.string().optional(), ate: z.string().optional(), tipo: z.enum(['compromisso', 'tarefa', 'anotacao']).optional(), ia: z.string().optional(), todas_as_ias: z.boolean().optional(), incluir_feitas: z.boolean().optional() }),
      execute: async ({ de, ate, tipo, ia, todas_as_ias, incluir_feitas }) => {
        const from = de ? parseLocal(`${de.slice(0, 10)}T00:00`)?.at : undefined;
        const to = ate ? parseLocal(`${ate.slice(0, 10)}T23:59`)?.at : undefined;
        const items = await listItems({ instance: todas_as_ias ? undefined : resolveInstance(ia, here), from, to, includeDone: incluir_feitas, kind: tipo === 'compromisso' ? 'evento' : tipo === 'tarefa' ? 'tarefa' : tipo === 'anotacao' ? 'nota' : undefined });
        if (!items.length) return { itens: 'nada encontrado' };
        return { itens: items.slice(0, 40).map((i) => `${itemLine(i)}${todas_as_ias ? ` (${personaFor(i.instance).name})` : ''}${i.notes ? ` — ${i.notes.slice(0, 120)}` : ''}`) };
      },
    }),
    agenda_alterar: tool({
      description: 'Muda um item da agenda pelo número (#id): data/hora (quando, AAAA-MM-DDTHH:MM; vazio tira a data), título, detalhes, avisos ou marca como feito.',
      inputSchema: z.object({ id: z.number().int(), quando: z.string().nullable().optional(), titulo: z.string().optional(), detalhes: z.string().optional(), avisar_antes_min: z.array(z.number().int().min(0)).optional(), feito: z.boolean().optional() }),
      execute: async ({ id, quando, titulo, detalhes, avisar_antes_min, feito }) => {
        if (quando && !parseLocal(quando)) return { erro: 'Data inválida: use AAAA-MM-DDTHH:MM.' };
        const it = await updateItem(id, { when: quando === undefined ? undefined : quando || null, title: titulo, notes: detalhes, reminders: avisar_antes_min, done: feito,
          ...(quando ? { kind: 'evento' as const } : {}) });
        if (!it) return { erro: 'Não achei esse item.' };
        return { ok: done(`atualizado: ${itemLine(it)}${it.due_at && !it.done_at ? ` · aviso ${remindersText(it.remind_minutes)}` : ''}`) };
      },
    }),
    agenda_apagar: tool({
      description: 'Apaga um item da agenda pelo número (#id). Só quando a pessoa pedir para apagar/cancelar.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => { await removeItem(id); return { ok: done(`item #${id} apagado`) }; },
    }),
  };
}

/** Responde o dono. Retorna o texto enviado. */
export async function answerOwner(text: string, where: Where): Promise<string | undefined> {
  const isCentral = where.instance === centralInstance();
  const here = isCentral ? ([...instanceRoles()].find(([n, r]) => r === 'GABRIEL' && n === 'gabriel')?.[0] ?? [...instanceRoles()].find(([, r]) => r === 'GABRIEL')?.[0] ?? where.instance) : where.instance;
  const historyKey = `${HISTORY_KEY}:${here}`;
  const history: ModelMessage[] = (await redis.lrange(historyKey, -16, -1)).map((h) => JSON.parse(h));
  const log: string[] = [];
  const owner = personaFor(here).name || 'Gabriel';
  try {
    const r = await withFallback('agent', ({ model }) =>
      generateText({
        model,
        system: fill(loadPrompt('central'), { OWNER: owner, TODAY: nowLabel(env.TIMEZONE) }),
        messages: [...history, { role: 'user', content: fence('mensagem_do_dono', text) }],
        tools: tools(log, here),
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
      .rpush(historyKey, JSON.stringify({ role: 'user', content: text }), JSON.stringify({ role: 'assistant', content: reply }))
      .ltrim(historyKey, -30, -1).expire(historyKey, 3 * 86400).exec();
    for (const bubble of reply.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).slice(0, 4)) await sendText(where.instance, where.to, bubble);
    return reply;
  } catch (e) {
    logger.error({ err: String(e) }, 'IA central falhou');
    await sendText(where.instance, where.to, 'nao consegui agora, tenta de novo em um minuto').catch(() => undefined);
    return undefined;
  }
}
