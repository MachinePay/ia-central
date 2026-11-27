import { handleGabrielReply, isGabrielPhone } from './approvals/approvals.js';
import { deleteForEveryone } from './channels/whatsapp/evolution.js';
import { normalizePhone } from './lib/phone.js';
import { ownPhone } from './lib/owners.js';
import { handleSentinelCommand } from './sentinela/commands.js';
import { answerOwner, ownerReplyTarget } from './owner/assistant.js';
import { findWaThread, saveOutbound, setThread, upsertContact, upsertThread } from './domain/repo.js';
import type { InboundEvent, Thread } from './domain/types.js';
import { q } from './lib/db.js';
import { instanceRole } from './lib/env.js';
import { logger } from './lib/logger.js';
import { cancelPendingRespond } from './lib/queues.js';
import { keys, redis } from './lib/redis.js';
import { getMediaBase64 } from './channels/whatsapp/evolution.js';
import type { MediaItem } from './domain/types.js';
import { describeMedia } from './media.js';

export const TAKEOVER_SECONDS = 30 * 60; // voce falou com o contato: a IA daquela conversa fica quieta 30 min
const OLD_FROM_ME_SECONDS = 5 * 60;

export async function isTakeover(threadId: string): Promise<boolean> {
  return (await redis.exists(keys.takeover(threadId))) === 1;
}

export async function applyTakeover(thread: Thread, text: string | undefined, externalId?: string) {
  if (text) {
    const saved = await saveOutbound(thread.id, text, 'HUMAN', 'SENT', {}, externalId); // entra no historico dos agentes
    if (!saved && externalId) return; // mensagem repetida (o WhatsApp reenviou): nao silencia a IA de novo
  }
  await redis.set(keys.takeover(thread.id), '1', 'EX', TAKEOVER_SECONDS);
  await cancelPendingRespond(thread.id);
  logger.info({ threadId: thread.id }, 'takeover humano: IA em silencio por 30 min');
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
export async function handleWhatsappFromMe(instance: string, p: { jid: string; text: string; id: string; botMarked: boolean; quotedId?: string; ts?: number; media?: { item: MediaItem; raw: { key: unknown; message: unknown; base64?: string } } }, ownerJid?: string) {
  if (p.botMarked || (await redis.exists(keys.sent(p.id)))) return; // foi o proprio bot
  // mensagem antiga reenviada pelo WhatsApp (sincronizacao ao reconectar): so entra no historico, com o horario real
  const at = p.ts ? new Date(p.ts * 1000) : undefined;
  const old = !!p.ts && Date.now() / 1000 - p.ts > OLD_FROM_ME_SECONDS;
  if (old && !p.text) return;
  // conversa "Voce" do Gabriel (consigo mesmo, no numero dele): fala com a IA central (orquestrador)
  // (vale para o "Voce" de qualquer numero: cada numero recebe os proprios avisos e responde comandos ali)
  // sem o dono no webhook, usa o telefone conhecido deste numero (senao o "Voce" do Leo caia no atendimento comum, sem ferramentas)
  const own = ownerJid ?? (await ownPhone(instance).catch(() => undefined));
  const selfChat = own ? normalizePhone(own) === normalizePhone(p.jid) : isGabrielPhone(p.jid);
  if (selfChat) {
    if (old) return; // pedido antigo reenviado: nao responde de novo
    if (!p.text && p.media) p = { ...p, text: await mediaToText(instance, p.media) };
    if (!p.text) return;
    if (await handleSentinelCommand(normalizePhone(p.jid), p.text)) return; // ok 42, /status, /custos...
    if (await handleGabrielReply(p.text, p.quotedId)) return; // resposta a uma aprovacao
    const where = { instance, to: normalizePhone(p.jid) }; // responde no proprio "Voce" deste numero
    await answerOwner(p.text, where);
    return;
  }
  let thread = await findWaThread(instance, p.jid);
  if (!thread && instanceRole(instance) === 'GABRIEL' && p.text && !p.text.startsWith('/')) {
    // numero pessoal: guarda tudo o que o Gabriel escreve, para a IA aprender o jeito dele (nao responde ninguem por isso)
    const ev = { channel: 'WHATSAPP', instance, externalMessageId: `wa:${instance}:${p.id}`, externalThreadId: p.jid, sender: { phone: normalizePhone(p.jid), jid: p.jid }, content: '', media: [], needsMedia: false, metadata: {}, receivedAt: new Date().toISOString() } as InboundEvent;
    const contact = await upsertContact(ev);
    if (contact.role === 'LEAD' && !contact.tags.length) await q(`UPDATE contacts SET role = 'PESSOAL' WHERE id = $1`, [contact.id]);
    thread = await upsertThread(ev, contact.id);
    await saveOutbound(thread.id, p.text, 'HUMAN', 'SENT', {}, `wa:${instance}:${p.id}`, at);
    return;
  }
  if (!thread) return;
  if (old) {
    await saveOutbound(thread.id, p.text, 'HUMAN', 'SENT', {}, `wa:${instance}:${p.id}`, at);
    return;
  }
  if (await handleBotCommand(thread, p.text)) {
    await deleteForEveryone(instance, p.jid, p.id); // o cliente nao ve o comando
    return;
  }
  await applyTakeover(thread, p.text || '[mensagem/mídia enviada pela equipe]', `wa:${instance}:${p.id}`);
}

/** Audio (ou imagem) mandado para a IA: vira texto (transcricao) para ela entender. */
/** Audio/imagem de um DONO para o Maestro: sem mascarar (numero de telefone ditado precisa chegar inteiro). */
export async function mediaToText(instance: string, media: { item: MediaItem; raw: { key: unknown; message: unknown; base64?: string } }): Promise<string> {
  const b64 = media.raw.base64 ?? (await getMediaBase64(instance, media.raw.key, media.raw.message).catch(() => undefined))?.base64;
  return describeMedia(media.item, b64, { mask: false }).catch(() => '');
}
