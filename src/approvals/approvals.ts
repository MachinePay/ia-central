import { generateText } from 'ai';
import { deliver, notifyGabriel } from '../delivery.js';
import { getContact, getThread, setThread } from '../domain/repo.js';
import type { Agent } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { env } from '../lib/env.js';
import { model } from '../lib/llm.js';
import { publish } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { normalizePhone, phoneVariants } from '../lib/phone.js';
import { clip } from '../lib/util.js';

export type ApprovalAction = 'DISCOUNT' | 'CUSTOM_TERM' | 'CONTRACT' | 'DEADLINE' | 'REFUND' | 'PAYMENT_LINK';

type Approval = {
  id: string; code: string; thread_id: string; requested_by: Agent; action: ApprovalAction;
  payload: Record<string, unknown>; draft_reply: string; status: string; notify_msg_id: string | null; created_at: Date;
};

const ACTION_LABEL: Record<ApprovalAction, string> = {
  DISCOUNT: 'Desconto acima da tabela',
  CUSTOM_TERM: 'Condição/prazo de pagamento fora do padrão',
  CONTRACT: 'Contrato ou aceite de cláusula',
  DEADLINE: 'Prazo de desenvolvimento customizado',
  REFUND: 'Reembolso, cancelamento ou troca',
  PAYMENT_LINK: 'Fechamento de pedido / link de pagamento',
};

export const NEUTRAL_REPLY = 'Vou confirmar essa condição e te retorno ainda hoje.';

export async function requestApproval(o: {
  threadId: string; agent: Agent; action: ApprovalAction; payload: Record<string, unknown>; draftReply: string; context: string;
}) {
  const a = (await one<Approval>(
    `INSERT INTO pending_approvals (thread_id, requested_by, action, payload, draft_reply) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [o.threadId, o.agent, o.action, JSON.stringify(o.payload), o.draftReply],
  ))!;
  await setThread(o.threadId, { status: 'WAITING_APPROVAL' });
  const thread = (await getThread(o.threadId))!;
  const contact = (await getContact(thread.contact_id))!;
  const who = [contact.name ?? contact.phone ?? contact.email, contact.company && `(${contact.company})`, `· ${contact.role} em ${contact.crm_stage}`]
    .filter(Boolean).join(' ');
  const text = [
    `[Aprovação #${a.code}] ${o.agent} · ${thread.channel === 'WHATSAPP' ? 'WhatsApp' : 'Gmail'}`,
    `Cliente: ${who}`,
    `Pedido: ${ACTION_LABEL[o.action]} — ${clip(JSON.stringify(o.payload), 300)}`,
    `Contexto: ${clip(o.context, 400)}`,
    `Rascunho: "${clip(o.draftReply, 600)}"`,
    `Responda citando esta mensagem: 1 aprovar · 2 recusar · ou escreva sua versão`,
  ].join('\n');
  const msgId = await notifyGabriel(text).catch((e) => logger.error(e, 'falha ao avisar aprovacao'));
  if (msgId) await q(`UPDATE pending_approvals SET notify_msg_id = $2 WHERE id = $1`, [a.id, msgId]);
  await publish('approval.created', { id: a.id, code: a.code, threadId: o.threadId });
  return { status: 'APPROVAL_REQUESTED', code: a.code, tell_client: NEUTRAL_REPLY };
}

export function isGabrielPhone(phone: string): boolean {
  return !!env.GABRIEL_PERSONAL_PHONE && phoneVariants(env.GABRIEL_PERSONAL_PHONE).includes(normalizePhone(phone));
}

/**
 * Resposta do Gabriel real a uma aprovacao. Acha a aprovacao pela mensagem citada, pelo codigo (#A-0001)
 * ou, se so houver uma pendente, a mais recente. Retorna false se nao era sobre aprovacao.
 */
export async function handleGabrielReply(text: string, quotedWaId?: string): Promise<boolean> {
  const codeMatch = text.match(/#?\b(A-\d{4,})\b/i);
  let a: Approval | undefined;
  if (quotedWaId) a = await one<Approval>(`SELECT * FROM pending_approvals WHERE notify_msg_id = $1`, [quotedWaId]);
  if (!a && codeMatch) a = await one<Approval>(`SELECT * FROM pending_approvals WHERE code = $1`, [codeMatch[1].toUpperCase()]);
  if (!a) {
    const pend = await q<Approval>(`SELECT * FROM pending_approvals WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 2`);
    if (pend.length === 1 && /^\s*[12]\s*$/.test(text)) a = pend[0];
  }
  if (!a) return false;
  if (a.status !== 'PENDING') {
    await notifyGabriel(`A aprovação #${a.code} já foi decidida (${a.status}).`);
    return true;
  }
  const body = text.replace(/#?\bA-\d{4,}\b/i, '').trim();
  const decision = /^1$/.test(body) ? 'APPROVE' : /^2$/.test(body) ? 'REJECT' : 'EDIT';
  const status = await applyDecision(a, decision, body, 'WhatsApp');
  await notifyGabriel(`✅ #${a.code} ${status === 'APPROVED' ? 'aprovada' : status === 'REJECTED' ? 'recusada' : 'enviada com o seu texto'}.`);
  return true;
}

/** Decisao vinda do painel. */
export async function decideApproval(id: string, decision: 'APPROVE' | 'REJECT' | 'EDIT', text?: string): Promise<string> {
  const a = await one<Approval>(`SELECT * FROM pending_approvals WHERE id = $1`, [id]);
  if (!a) throw new Error('Aprovação não encontrada');
  if (a.status !== 'PENDING') throw new Error(`Essa aprovação já foi decidida (${a.status})`);
  if (decision === 'EDIT' && !text?.trim()) throw new Error('Escreva o texto que vai para o cliente');
  return applyDecision(a, decision, text?.trim() ?? '', 'painel');
}

async function applyDecision(a: Approval, decision: 'APPROVE' | 'REJECT' | 'EDIT', body: string, via: string): Promise<string> {
  const thread = (await getThread(a.thread_id))!;
  let status: string;
  let reply: string;
  if (decision === 'APPROVE') {
    status = 'APPROVED';
    reply = a.draft_reply;
  } else if (decision === 'REJECT') {
    status = 'REJECTED';
    reply = await politeAlternative(a);
  } else {
    status = 'EDITED';
    reply = body;
  }
  await q(`UPDATE pending_approvals SET status = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [a.id, status, `${via}: ${body}`]);
  await publish('approval.decided', { id: a.id, status });
  const facts = (thread.facts ?? {}) as any;
  facts.decisoes = [...(facts.decisoes ?? []), {
    o_que: `${ACTION_LABEL[a.action]}: ${status === 'REJECTED' ? 'recusado' : 'aprovado'} ${clip(JSON.stringify(a.payload), 120)}`,
    quando: new Date().toISOString().slice(0, 10), por: 'GABRIEL (real)',
  }];
  await setThread(thread.id, { status: 'OPEN', facts });
  await deliver({ thread: { ...thread, status: 'OPEN' }, agent: a.requested_by, text: reply, force: true });
  return status;
}

async function politeAlternative(a: Approval): Promise<string> {
  try {
    const { text } = await generateText({
      model: model('small').model,
      system: 'Você escreve, em português do Brasil, uma resposta curta e educada ao cliente dizendo que a condição pedida não pôde ser aprovada, sem citar valores novos, e oferecendo seguir com as condições padrão ou conversar sobre alternativas. Máximo 3 frases.',
      prompt: `Pedido recusado: ${ACTION_LABEL[a.action]} ${JSON.stringify(a.payload)}\nRascunho que seria enviado: ${a.draft_reply}`,
      maxRetries: 1,
    });
    return text.trim();
  } catch {
    return 'Conferi aqui e não consegui aprovar essa condição. Posso seguir com as condições padrão ou ver outra alternativa com você?';
  }
}

/** Lembrete em 4 h, expira em 24 h com mensagem de acompanhamento ao cliente. */
export async function sweepApprovals() {
  const remind = await q<Approval>(
    `UPDATE pending_approvals SET reminded_at = now() WHERE status = 'PENDING' AND reminded_at IS NULL
       AND created_at < now() - interval '4 hours' RETURNING *`,
  );
  for (const a of remind) await notifyGabriel(`⏰ Lembrete: aprovação #${a.code} ainda pendente (${ACTION_LABEL[a.action]}).`).catch(() => undefined);
  const expired = await q<Approval>(
    `UPDATE pending_approvals SET status = 'EXPIRED', decided_at = now() WHERE status = 'PENDING'
       AND created_at < now() - interval '24 hours' RETURNING *`,
  );
  for (const a of expired) {
    const thread = await getThread(a.thread_id);
    if (!thread) continue;
    await setThread(thread.id, { status: 'OPEN' });
    await deliver({ thread, agent: a.requested_by, force: true,
      text: 'Ainda estou confirmando aquela condição com a equipe. Assim que tiver a resposta, te aviso por aqui.' });
  }
}
