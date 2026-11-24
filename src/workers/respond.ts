import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { NEUTRAL_REPLY } from '../approvals/approvals.js';
import { runAgent, type AgentResult } from '../agents/run.js';
import { deliver, notifyGabriel } from '../delivery.js';
import { getThread, lastInboundId, setThread } from '../domain/repo.js';
import type { Agent, Specialist, Thread } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { emojisAllowed, env, setting } from '../lib/env.js';
import { cleanHumanText, stripEmojis } from '../channels/whatsapp/format.js';
import { addCost, costToday, costUsd } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { enqueueRespond, summarizeQueue } from '../lib/queues.js';
import { acquireLock, keys, redis, releaseLock } from '../lib/redis.js';
import { ASKS_BOT, checkOutput, isSmallTalk } from '../guardrails/output.js';
import { INTIMATE_RE } from '../memory/persona.js';
import { buildContext } from '../memory/context.js';
import { ownerVocabulary } from '../memory/style.js';
import { summarizeThread } from '../memory/summarize.js';
import { route, switchLimitReached, type RouteDecision } from '../routing/route.js';

const LOCK_MS = 90_000;
const SUMMARY_EVERY = 10;

type RunLog = {
  agent: Agent; model: string; route: unknown; toolCalls: unknown[]; inTok: number; outTok: number;
  latency: number; outcome: string; reply?: string; error?: string;
};

async function saveRun(threadId: string, r: RunLog) {
  const cost = costUsd(r.model, r.inTok, r.outTok);
  if (r.inTok || r.outTok) await addCost(cost);
  await q(
    `INSERT INTO agent_runs (thread_id, agent, model, route, tool_calls, input_tokens, output_tokens, cost_usd, latency_ms, outcome, reply, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [threadId, r.agent, r.model, JSON.stringify(r.route ?? null), JSON.stringify(r.toolCalls), r.inTok, r.outTok, cost, r.latency, r.outcome, r.reply ?? null, r.error ?? null],
  );
}

export async function respondWorker(job: Job) {
  const { threadId, channel } = job.data as { threadId: string; channel: Thread['channel'] };
  const token = randomUUID();
  if (!(await acquireLock(keys.lock(threadId), token, LOCK_MS))) {
    await enqueueRespond(threadId, channel); // outra execucao em curso: tenta depois
    return;
  }
  await redis.del(keys.pendingSince(threadId));
  const started = Date.now();
  try {
    await respond(threadId, started);
  } catch (e) {
    logger.error({ err: e, threadId }, 'falha na execucao do agente');
    await saveRun(threadId, { agent: 'LEO', model: '-', route: null, toolCalls: [], inTok: 0, outTok: 0, latency: Date.now() - started, outcome: 'ERROR', error: String(e).slice(0, 1000) });
    throw e;
  } finally {
    await releaseLock(keys.lock(threadId), token);
  }
}

async function respond(threadId: string, started: number) {
  let thread = await getThread(threadId);
  if (!thread) return;
  const lastSeen = await lastInboundId(threadId);
  const pack = await buildContext(thread);
  const decision = await route(pack);

  if (decision.action === 'SILENT') {
    if (decision.escalate) await notifyGabriel(`⚠️ Limite de respostas/hora atingido com ${pack.contact.name ?? pack.contact.phone ?? pack.contact.email}. Bots em silêncio nessa conversa.`, thread.instance).catch(() => undefined);
    if (decision.reason !== 'nada novo para responder') {
      await saveRun(threadId, { agent: thread.active_agent, model: '-', route: decision, toolCalls: [], inTok: 0, outTok: 0, latency: 0, outcome: 'SILENT' });
    }
    return;
  }

  // teto de custo diario
  const spent = await costToday();
  if (spent >= Number(setting('DAILY_COST_LIMIT_USD'))) {
    if (await redis.set('cost-alert:limit', '1', 'EX', 86400, 'NX')) await notifyGabriel(`💸 Limite diário de custo de IA atingido (US$ ${spent.toFixed(2)}). Bots pausados até amanhã.`).catch(() => undefined);
    await saveRun(threadId, { agent: thread.active_agent, model: '-', route: decision, toolCalls: [], inTok: 0, outTok: 0, latency: 0, outcome: 'SILENT', error: 'limite de custo' });
    return;
  }
  if (spent >= Number(setting('DAILY_COST_LIMIT_USD')) * 0.8 && (await redis.set('cost-alert:80', '1', 'EX', 86400, 'NX'))) {
    await notifyGabriel(`💸 Gasto de IA hoje em 80% do limite (US$ ${spent.toFixed(2)} de ${Number(setting('DAILY_COST_LIMIT_USD'))}).`).catch(() => undefined);
  }

  // Gmail anti-loop: mais de 3 respostas do bot em 1 h sem humano -> pausa
  if (thread.channel === 'GMAIL') {
    const n = await one<{ n: number }>(`SELECT count(*)::int n FROM messages WHERE thread_id = $1 AND direction = 'OUTBOUND' AND sender <> 'HUMAN' AND created_at > now() - interval '1 hour'`, [threadId]);
    if ((n?.n ?? 0) >= 3) {
      await setThread(threadId, { status: 'PAUSED' });
      await notifyGabriel(`⏸️ Thread de e-mail com ${pack.contact.email} pausada (muitas respostas do bot em 1 h). Revise.`, thread.instance).catch(() => undefined);
      return;
    }
  }

  let reply: string;
  let agent: Agent;
  let result: AgentResult | undefined;
  let routeLog: unknown = decision;

  if (decision.action === 'TRIAGE') {
    agent = 'LEO';
    reply = decision.question;
  } else {
    agent = decision.agent;
    if (decision.router?.company_slug && decision.router.company_slug !== thread.company_slug && pack.companies.some((c) => c.slug === decision.router!.company_slug)) {
      await setThread(threadId, { company_slug: decision.router.company_slug });
      thread = { ...thread, company_slug: decision.router.company_slug };
      pack.thread = thread;
    }
    if (agent !== thread.active_agent && thread.active_agent !== 'LEO') {
      if (switchLimitReached(thread.agent_switches)) {
        await setThread(threadId, { status: 'PAUSED' });
        await notifyGabriel(`🔁 Conversa com ${pack.contact.name ?? pack.contact.phone ?? pack.contact.email} trocou de agente 3 vezes em 30 min. Pausei os bots: assume você? (/bot on para devolver)`, thread.instance).catch(() => undefined);
        await saveRun(threadId, { agent, model: '-', route: decision, toolCalls: [], inTok: 0, outTok: 0, latency: 0, outcome: 'ESCALATED' });
        return;
      }
      thread.agent_switches = [...thread.agent_switches, { at: new Date().toISOString(), to: agent }].slice(-10);
    }
    if (decision.notifyGabriel) {
      await notifyGabriel(`🚨 Cliente irritado com urgência alta: ${pack.contact.name ?? pack.contact.phone ?? pack.contact.email} — ${decision.reason}`).catch(() => undefined);
    }
    const out = await runWithHandoff(agent, thread, pack, decision);
    result = out.result;
    agent = out.agent;
    thread = out.thread;
    routeLog = { ...decision, handoffs: out.hops };
    reply = result.text || (result.ctx.approvalRequested ? NEUTRAL_REPLY : '');
  }

  if (!reply) {
    await saveRun(threadId, runLog(agent, result, routeLog, started, 'DISCARDED', '', 'resposta vazia'));
    return;
  }

  const check = await checkOutput({
    text: reply, channel: thread.channel, agent, evidence: result?.ctx.evidence ?? [],
    facts: thread.facts, kbConsulted: result?.ctx.kbConsulted ?? false,
    intimateAllowed: INTIMATE_RE.test(pack.contact.treatment ?? '') || pack.recent.some((m) => m.sender === 'HUMAN' && INTIMATE_RE.test(m.content)),
    didAction: (result?.ctx.log ?? []).some((l) => /^(girakids_(orcamento|aprovar_orcamento)|primeplush_(orcamento|fechar_pedido))$/.test(l.tool) && !(l.output as any)?.erro && !(l.output as any)?.error),
    clientAskedBot: ASKS_BOT.test(pack.blockText), shortClient: pack.block.every((m) => isSmallTalk(m.content)),
    personal: pack.contact.role === 'PESSOAL',
    vocab: pack.contact.role === 'PESSOAL' ? await ownerVocabulary(thread.instance).catch(() => undefined) : undefined,
  });
  if (check.blocked) {
    await notifyGabriel(`🛑 Resposta bloqueada pelo verificador (${agent}) para ${pack.contact.name ?? pack.contact.phone ?? pack.contact.email}: ${check.issues.join('; ')}\n\nRascunho: ${reply}`, thread.instance).catch(() => undefined);
    await saveRun(threadId, runLog(agent, result, { ...(routeLog as object), guard: check.issues }, started, 'ESCALATED', reply));
    return;
  }

  // chegou mensagem nova enquanto o LLM pensava? descarta e refaz com tudo junto
  if ((await lastInboundId(threadId)) !== lastSeen) {
    await saveRun(threadId, runLog(agent, result, routeLog, started, 'DISCARDED', check.text, 'mensagem nova durante a geracao'));
    await enqueueRespond(threadId, thread.channel, { now: true });
    return;
  }

  // sem emoji (padrao): tirado no codigo, nao depende do modelo obedecer
  if (!emojisAllowed()) check.text = stripEmojis(check.text) || check.text;
  check.text = cleanHumanText(check.text) || check.text;
  const lastMsg = pack.block[pack.block.length - 1];
  const status = await deliver({
    thread, agent, text: check.text, lastInboundId: lastSeen,
    quotedId: lastMsg?.metadata?.quotedMessageId ? lastMsg.external_id?.split(':').pop() : undefined,
  });
  await setThread(threadId, {
    active_agent: agent === 'LEO' ? thread.active_agent : agent,
    pending_handoff: null,
    agent_switches: thread.agent_switches,
    last_bot_at: new Date(),
  });
  await saveRun(threadId, runLog(agent, result, { ...(routeLog as object), guard: check.issues }, started, result?.ctx.approvalRequested ? 'APPROVAL' : status === 'DRAFT' ? 'DRAFT' : 'SENT', check.text));

  const fresh = await getThread(threadId);
  if (fresh && fresh.msgs_since_summary >= SUMMARY_EVERY) {
    await summarizeQueue.add('summarize', { threadId }, { deduplication: { id: `sum:${threadId}` }, removeOnComplete: true });
  }
}

/** Roda o agente; se ele pedir handoff, o destino assume na mesma execucao (no maximo 2 saltos). */
async function runWithHandoff(first: Specialist, thread: Thread, pack: Awaited<ReturnType<typeof buildContext>>, d: Extract<RouteDecision, { action: 'AGENT' }>) {
  let agent: Specialist = first;
  let internalNote = d.internalNote;
  let previous: Agent = thread.active_agent;
  const hops: Array<{ from: string; to: string; reason: string }> = [];
  for (let i = 0; ; i++) {
    const introduce = agent !== thread.active_agent || !pack.recent.some((m) => m.sender === agent);
    const result = await runAgent(agent, pack, { internalNote, previous, introduce });
    const h = result.ctx.handoff;
    if (!h || i >= 2) return { result, agent, thread, hops };
    hops.push({ from: agent, to: h.to, reason: h.reason });
    await summarizeThread(thread.id).catch(() => undefined); // resumo atualizado antes de passar
    const updated = (await getThread(thread.id))!;
    thread = { ...updated, active_agent: agent, agent_switches: [...thread.agent_switches, { at: new Date().toISOString(), to: h.to }] };
    pack.thread = thread;
    previous = agent;
    agent = h.to;
    internalNote = `${h.reason}. ${h.summary}`;
  }
}

function runLog(agent: Agent, r: AgentResult | undefined, route: unknown, started: number, outcome: string, reply?: string, error?: string): RunLog {
  return {
    agent, model: r?.modelSpec ?? '-', route, toolCalls: r?.ctx.log ?? [], inTok: r?.inputTokens ?? 0, outTok: r?.outputTokens ?? 0,
    latency: Date.now() - started, outcome, reply, error,
  };
}
