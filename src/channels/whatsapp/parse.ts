import { normalizePhone } from '../../lib/phone.js';
import type { InboundEvent, MediaItem } from '../../domain/types.js';
import { BOT_MARK } from './evolution.js';

const LATE_SECONDS = 15 * 60;

export type ParsedWa =
  | { kind: 'ignore'; reason: string }
  | { kind: 'fromMe'; jid: string; text: string; id: string; botMarked: boolean }
  | { kind: 'reaction' }
  | { kind: 'inbound'; event: InboundEvent };

/** JID com @lid: o telefone real vem em remoteJidAlt / senderPn (licao do sistema antigo). */
export function resolveJid(key: any): string {
  let jid: string = key?.remoteJid ?? '';
  if (jid.endsWith('@lid')) jid = key.remoteJidAlt || key.senderPn || key.participantAlt || jid;
  return jid;
}

export function extractText(m: any): string {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

export function parseEvolution(instance: string, data: any): ParsedWa {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d?.key) return { kind: 'ignore', reason: 'sem key' };
  const rawJid: string = d.key.remoteJid ?? '';
  if (rawJid.endsWith('@g.us') || rawJid === 'status@broadcast' || rawJid.endsWith('@newsletter') || rawJid.endsWith('@broadcast')) {
    return { kind: 'ignore', reason: 'grupo/status' };
  }
  const jid = resolveJid(d.key);
  const m = d.message ?? {};
  const text = extractText(m);

  if (d.key.fromMe) {
    return { kind: 'fromMe', jid, text, id: d.key.id, botMarked: text.startsWith(BOT_MARK) };
  }
  // mensagem de um dos nossos numeros (rascunho, aprovacao, alerta): nunca vira conversa de cliente
  if (text.startsWith(BOT_MARK)) return { kind: 'ignore', reason: 'mensagem de outro numero do sistema' };
  if (m.reactionMessage || m.protocolMessage || m.senderKeyDistributionMessage && !text) {
    return m.reactionMessage ? { kind: 'reaction' } : { kind: 'ignore', reason: 'protocolo' };
  }

  const media: MediaItem[] = [];
  let content = text;
  let needsMedia = false;
  if (m.audioMessage) {
    media.push({ kind: 'audio', description: '', mimeType: m.audioMessage.mimetype, seconds: +m.audioMessage.seconds || 0 });
    needsMedia = true;
  } else if (m.imageMessage) {
    media.push({ kind: 'image', description: '', mimeType: m.imageMessage.mimetype });
    needsMedia = true;
  } else if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage ?? m.documentWithCaptionMessage.message.documentMessage;
    const isPdf = /pdf/i.test(doc.mimetype ?? '') || /\.pdf$/i.test(doc.fileName ?? '');
    media.push({ kind: isPdf ? 'pdf' : 'other', description: '', mimeType: doc.mimetype, fileName: doc.fileName });
    needsMedia = isPdf;
    if (!isPdf) content = `${content}\n[Anexo "${doc.fileName ?? 'arquivo'}", ${doc.mimetype ?? 'tipo desconhecido'}, não processado]`.trim();
  } else if (m.stickerMessage) {
    return { kind: 'ignore', reason: 'figurinha' };
  } else if (m.locationMessage) {
    const l = m.locationMessage;
    content = `[Localização enviada: ${l.name ?? ''} ${l.address ?? ''} (${l.degreesLatitude}, ${l.degreesLongitude})]`.trim();
  } else if (m.contactMessage) {
    content = `[Contato compartilhado: ${m.contactMessage.displayName ?? ''}]`;
  } else if (m.videoMessage) {
    content = `${text}\n[Vídeo recebido, não processado]`.trim();
  }
  if (!content && !needsMedia) return { kind: 'ignore', reason: 'vazia' };

  const ctxInfo = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo ?? m.audioMessage?.contextInfo;
  const ts = +d.messageTimestamp || Math.floor(Date.now() / 1000);
  const event: InboundEvent = {
    channel: 'WHATSAPP',
    instance,
    externalMessageId: `wa:${instance}:${d.key.id}`,
    externalThreadId: jid,
    sender: { phone: normalizePhone(jid), name: d.pushName || undefined, jid: d.key.remoteJid },
    content,
    media,
    needsMedia,
    metadata: {
      quotedMessageId: ctxInfo?.stanzaId,
      quotedText: ctxInfo?.quotedMessage ? extractText(ctxInfo.quotedMessage) : undefined,
      late: Date.now() / 1000 - ts > LATE_SECONDS,
      raw: needsMedia ? { key: d.key, message: m, base64: m.base64 ?? d.base64 } : undefined,
    },
    receivedAt: new Date(ts * 1000).toISOString(),
  };
  return { kind: 'inbound', event };
}
