import { handleGabrielReply, isGabrielPhone } from './approvals/approvals.js';
import { deleteForEveryone } from './channels/whatsapp/evolution.js';
import { normalizePhone } from './lib/phone.js';
import { handleSentinelCommand } from './sentinela/commands.js';
import { answerOwner, ownerReplyTarget } from './owner/assistant.js';
import { findWaThread, saveOutbound, setThread, upsertContact, upsertThread } from './domain/repo.js';
import type { InboundEvent, Thread } from './domain/types.js';
import { q } from './lib/db.js';
import { instanceRole } from './lib/env.js';
import { logger } from './lib/logger.js';
import { cancelPendingRespond } from './lib/queues.js';
import { keys, redis } from './lib/redis.js';

const TAKEOVER_SECONDS = 2 * 3600;

export async function isTakeover(threadId: string): Promise<boolean> {
  return (await redis.exists(keys.takeover(threadId))) === 1;
}

export async function applyTakeover(thread: Thread, text: string | undefined, externalId?: string) {
  await redis.set(keys.takeover(thread.id), '1', 'EX', TAKEOVER_SECONDS);
  if (text) await saveOutbound(thread.id, text, 'HUMAN', 'SENT', {}, externalId); // entra no historico dos agentes
  await cancelPendingRespond(thread.id);
  logger.info({ threadId: thread.id }, 'takeover humano: bots em silencio por 2 h');
}

/** Retorna true se era um comando /bot (ja tratado). */
export async function handleBotCommand(thread: Thread, text: string): Promise<boolean> {
  const m = text.trim().toLowerCase().match(/^\/bot\s+(on|off|joao|joão|clara|gabriel)\s*$/);
  if (!m) return false;
  const cmd = m[1];
  if (cmd === 'off') {
    await redis.set(keys.takeover(thread.id), '1'); // sem TTL
    await cancelPendingRespond(thread.id);
  } else {
    await redis.del(keys.takeover(thread.id));
    if (cmd !== 'on') {
      const agent = cmd === 'clara' ? 'CLARA' : cmd === 'gabriel' ? 'GABRIEL' : 'JOAO';
      await setThread(thread.id, { active_agent: agent, pending_handoff: null, status: 'OPEN' });
    } else {
      await setThread(thread.id, { status: 'OPEN' });
    }
  }
  return true;
}

/** Mensagem fromMe que nao foi o bot: o Gabriel (ou a equipe) digitou no celular. */
export async function handleWhatsappFromMe(instance: string, p: { jid: string; text: string; id: string; botMarked: boolean; quotedId?: string }, ownerJid?: string) {
  if (p.botMarked || (await redis.exists(keys.sent(p.id)))) return; // foi o proprio bot
  // conversa "Voce" do Gabriel (consigo mesmo, no numero dele): fala com a IA central (orquestrador)
  const selfChat = isGabrielPhone(p.jid) && (!ownerJid || normalizePhone(ownerJid) === normalizePhone(p.jid));
  if (selfChat) {
    if (!p.text) return;
    if (await handleSentinelCommand(normalizePhone(p.jid), p.text)) return; // ok 42, /status, /custos...
    if (await handleGabrielReply(p.text, p.quotedId)) return; // resposta a uma aprovacao
    const where = ownerReplyTarget('self', instance);
    if (where) await answerOwner(p.text, where);
    return;
  }
  let thread = await findWaThread(instance, p.jid);
  if (!thread && instanceRole(instance) === 'GABRIEL' && p.text && !p.text.startsWith('/')) {
    // numero pessoal: guarda tudo o que o Gabriel escreve, para a IA aprender o jeito dele (nao responde ninguem por isso)
    const ev = { channel: 'WHATSAPP', instance, externalMessageId: `wa:${instance}:${p.id}`, externalThreadId: p.jid, sender: { phone: normalizePhone(p.jid), jid: p.jid }, content: '', media: [], needsMedia: false, metadata: {}, receivedAt: new Date().toISOString() } as InboundEvent;
    const contact = await upsertContact(ev);
    if (contact.role === 'LEAD' && !contact.tags.length) await q(`UPDATE contacts SET role = 'PESSOAL' WHERE id = $1`, [contact.id]);
    thread = await upsertThread(ev, contact.id);
    await saveOutbound(thread.id, p.text, 'HUMAN', 'SENT', {}, `wa:${instance}:${p.id}`);
    return;
  }
  if (!thread) return;
  if (await handleBotCommand(thread, p.text)) {
    await deleteForEveryone(instance, p.jid, p.id); // o cliente nao ve o comando
    return;
  }
  await applyTakeover(thread, p.text || '[mensagem/mídia enviada pela equipe]', `wa:${instance}:${p.id}`);
}
