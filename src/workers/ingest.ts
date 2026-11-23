import type { Job } from 'bullmq';
import { handleGabrielReply, isGabrielPhone } from '../approvals/approvals.js';
import { antiLoop, getAttachment, getMessage, gmail, gmailEnabled, toInboundEvent } from '../channels/gmail/gmail.js';
import { getMediaBase64 } from '../channels/whatsapp/evolution.js';
import { parseEvolution } from '../channels/whatsapp/parse.js';
import { notifyGabriel } from '../delivery.js';
import { saveInboundIfNew } from '../domain/repo.js';
import type { InboundEvent, MediaItem, Thread } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { approvalInstance, env, instanceRole } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { enqueueRespond, ingestQueue, mediaQueue } from '../lib/queues.js';
import { describeMedia } from '../media.js';
import { handleSentinelCommand } from '../sentinela/commands.js';
import { applyTakeover, handleWhatsappFromMe } from '../takeover.js';

const OPT_OUT = /^\s*(parar|pare|sair|stop|descadastrar|n[aã]o quero mais (receber )?mensagens?)\s*[.!]?\s*$/i;

export async function ingestWorker(job: Job) {
  switch (job.name) {
    case 'whatsapp': return ingestWhatsapp(job.data.instance, job.data.data);
    case 'wa-connection': return connectionChanged(job.data.instance, job.data.state);
    case 'gmail-sync': return syncGmail();
    case 'gmail': return ingestGmail(job.data.id);
  }
}

async function ingestWhatsapp(instance: string, data: any) {
  if (instanceRole(instance) === 'OFF') return;
  const p = parseEvolution(instance, data);
  if (p.kind === 'ignore' || p.kind === 'reaction') return;
  if (p.kind === 'fromMe') return handleWhatsappFromMe(instance, p); // nunca responde mensagens proprias

  const ev = p.event;
  // comando do Sentinela vindo de um contato de alertas (ok 42, /status...)
  if (await handleSentinelCommand(ev.sender.phone ?? '', ev.content)) return;
  // resposta do Gabriel real a uma aprovacao (numero dele na allowlist)
  if (isGabrielPhone(ev.sender.phone ?? '') && (await handleGabrielReply(ev.content, ev.metadata.quotedMessageId))) return;
  await persistAndQueue(ev);
}

async function persistAndQueue(ev: InboundEvent) {
  const raw = ev.metadata.raw;
  const saved = await saveInboundIfNew(ev); // unique em external_id
  if (!saved) return;
  const { thread, contact } = saved;

  if (OPT_OUT.test(ev.content) && !contact.opted_out) {
    await q(`UPDATE contacts SET opted_out = true, updated_at = now() WHERE id = $1`, [contact.id]);
    await notifyGabriel(`🔕 ${contact.name ?? contact.phone ?? contact.email} pediu para não receber mais mensagens (opt-out).`).catch(() => undefined);
    return;
  }
  if (ev.metadata.late) return; // reenvio atrasado: so registra, nao responde horas depois
  if (ev.channel === 'WHATSAPP' && instanceRole(ev.instance) === 'OBSERVAR') {
    // so aprendendo: guarda a conversa (audio vira texto para o aprendiz), mas nunca gera resposta
    if (ev.needsMedia) await mediaQueue.add('media', { messageId: saved.message.id, threadId: thread.id, channel: ev.channel, instance: ev.instance, raw, observeOnly: true }, { attempts: 2 });
    return;
  }
  if (ev.needsMedia) {
    await mediaQueue.add('media', { messageId: saved.message.id, threadId: thread.id, channel: ev.channel, instance: ev.instance, raw },
      { attempts: 2, backoff: { type: 'fixed', delay: 5000 } });
    return;
  }
  await enqueueRespond(thread.id, ev.channel);
}

async function connectionChanged(instance: string, state: string) {
  if (state === 'close' || state === 'refused') {
    const other = approvalInstance();
    if (other && other !== instance) {
      await notifyGabriel(`⚠️ A sessão do WhatsApp "${instance}" caiu (${state}). Reconecte pela Evolution.`).catch(() => undefined);
    }
  }
}

// ------------------------------------------------------------------ midia
export async function mediaWorker(job: Job) {
  const { messageId, threadId, channel, instance, raw } = job.data;
  const msg = await one<{ content: string; media: MediaItem[] }>(`SELECT content, media FROM messages WHERE id = $1`, [messageId]);
  if (!msg) return;
  const parts: string[] = [];
  const media: MediaItem[] = [];
  if (channel === 'WHATSAPP') {
    const item = msg.media[0];
    let b64: string | undefined = raw?.base64;
    if (!b64) b64 = (await getMediaBase64(instance, raw?.key, raw?.message))?.base64;
    const description = await describeMedia(item, b64);
    media.push({ ...item, description });
    parts.push(description);
  } else {
    for (const [i, att] of (raw?.attachments ?? []).entries()) {
      const item = msg.media[i];
      if (!item || item.kind === 'other') { if (item) media.push(item); continue; }
      const b64 = await getAttachment(raw.messageId, att.id).catch(() => undefined);
      const description = await describeMedia(item, b64);
      media.push({ ...item, description });
      parts.push(description);
    }
  }
  const content = [msg.content, ...parts].filter(Boolean).join('\n');
  await q(`UPDATE messages SET content = $2, media = $3, status = 'DONE' WHERE id = $1`, [messageId, content, JSON.stringify(media)]);
  if (!job.data.observeOnly) await enqueueRespond(threadId, channel);
}

// ------------------------------------------------------------------ Gmail
async function syncGmail() {
  if (!gmailEnabled()) return;
  const state = await one<{ history_id: string }>(`SELECT history_id FROM gmail_sync_state WHERE account = $1`, [env.GMAIL_ACCOUNT]);
  if (!state) return; // o maintenance cria o estado ao ligar o watch
  let pageToken: string | undefined;
  let lastHistoryId = state.history_id;
  try {
    do {
      const res = await gmail().users.history.list({
        userId: 'me', startHistoryId: state.history_id, historyTypes: ['messageAdded'], pageToken,
      });
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) await ingestQueue.add('gmail', { id: added.message.id }, { jobId: `gm:${added.message.id}`, attempts: 3 });
        }
      }
      if (res.data.historyId) lastHistoryId = String(res.data.historyId);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (e: any) {
    if (e?.code !== 404) throw e;
    // historyId antigo demais: sincronizacao completa das ultimas 24 h
    const list = await gmail().users.messages.list({ userId: 'me', q: 'newer_than:1d in:inbox' });
    for (const m of list.data.messages ?? []) await ingestQueue.add('gmail', { id: m.id }, { jobId: `gm:${m.id}`, attempts: 3 });
    const profile = await gmail().users.getProfile({ userId: 'me' });
    lastHistoryId = String(profile.data.historyId);
  }
  await q(`UPDATE gmail_sync_state SET history_id = $2 WHERE account = $1`, [env.GMAIL_ACCOUNT, lastHistoryId]);
}

async function ingestGmail(id: string) {
  const msg = await getMessage(id);
  const f = antiLoop(msg);
  if (f.skip) {
    if (f.humanSent && msg.threadId) {
      // resposta manual pela conta (sem o header interno): takeover da thread
      const thread = await one<Thread>(`SELECT * FROM threads WHERE channel = 'GMAIL' AND external_id = $1`, [msg.threadId]);
      if (thread) await applyTakeover(thread, msg.snippet ?? undefined, `gm:${msg.id}`);
    }
    return;
  }
  await persistAndQueue(toInboundEvent(msg));
}
