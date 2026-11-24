import type { Job } from 'bullmq';
import { handleGabrielReply, isGabrielPhone } from '../approvals/approvals.js';
import { antiLoop, getAttachment, getMessage, gmailAccounts, gmailEnabled, gmailFor, toInboundEvent } from '../channels/gmail/gmail.js';
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
import { answerOwner, ownerReplyTarget } from '../owner/assistant.js';
import { applyTakeover, handleWhatsappFromMe } from '../takeover.js';
import { rememberOwnPhone } from '../lib/owners.js';
import { mailAccounts, pollAccount } from '../channels/mail/imap.js';

const OPT_OUT = /^\s*(parar|pare|sair|stop|descadastrar|n[aã]o quero mais (receber )?mensagens?)\s*[.!]?\s*$/i;

export async function ingestWorker(job: Job) {
  switch (job.name) {
    case 'whatsapp': return ingestWhatsapp(job.data.instance, job.data.data, job.data.owner);
    case 'wa-connection': return connectionChanged(job.data.instance, job.data.state);
    case 'gmail-sync': return syncGmail(job.data.account);
    case 'gmail': return ingestGmail(job.data.id, job.data.account);
    case 'mail-poll': return pollMail();
  }
}

async function ingestWhatsapp(instance: string, data: any, owner?: string) {
  if (instanceRole(instance) === 'OFF') return;
  if (owner) await rememberOwnPhone(instance, owner).catch(() => undefined); // o "Voce" deste numero
  const p = parseEvolution(instance, data);
  if (p.kind === 'ignore' || p.kind === 'reaction') return;
  if (p.kind === 'fromMe') return handleWhatsappFromMe(instance, p, owner); // nunca responde mensagens proprias

  const ev = p.event;
  // comando do Sentinela vindo de um contato de alertas (ok 42, /status...)
  if (await handleSentinelCommand(ev.sender.phone ?? '', ev.content)) return;
  // resposta do Gabriel real a uma aprovacao (numero dele na allowlist)
  if (isGabrielPhone(ev.sender.phone ?? '') && (await handleGabrielReply(ev.content, ev.metadata.quotedMessageId))) return;
  // numero da IA (central): so conversa com o dono; o resto e ignorado
  if (instanceRole(instance) === 'CENTRAL') {
    if (isGabrielPhone(ev.sender.phone ?? '') && !ev.metadata.late) {
      const where = ownerReplyTarget('central');
      if (where) await answerOwner(ev.content || '(mandou um arquivo/áudio)', where);
    }
    return;
  }
  await persistAndQueue(ev);
}

async function persistAndQueue(ev: InboundEvent) {
  const raw = ev.metadata.raw;
  const saved = await saveInboundIfNew(ev); // unique em external_id
  if (!saved) return;
  const { thread, contact } = saved;

  if (OPT_OUT.test(ev.content) && !contact.opted_out) {
    await q(`UPDATE contacts SET opted_out = true, updated_at = now() WHERE id = $1`, [contact.id]);
    await notifyGabriel(`🔕 ${contact.name ?? contact.phone ?? contact.email} pediu para não receber mais mensagens (opt-out).`, thread.instance).catch(() => undefined);
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
      const b64 = await getAttachment(instance, raw.messageId, att.id).catch(() => undefined);
      const description = await describeMedia(item, b64);
      media.push({ ...item, description });
      parts.push(description);
    }
  }
  const content = [msg.content, ...parts].filter(Boolean).join('\n');
  await q(`UPDATE messages SET content = $2, media = $3, status = 'DONE' WHERE id = $1`, [messageId, content, JSON.stringify(media)]);
  if (!job.data.observeOnly) await enqueueRespond(threadId, channel);
}

// ------------------------------------------------------------------ E-mail IMAP (contas que nao sao Google)
async function pollMail() {
  for (const a of await mailAccounts()) {
    await pollAccount(
      a,
      (ev) => persistAndQueue(ev),
      async (threadKey, text, id) => {
        // a pessoa respondeu pelo proprio e-mail: guarda no historico e a IA fica quieta naquela conversa
        const thread = await one<Thread>(`SELECT * FROM threads WHERE channel = 'GMAIL' AND external_id = $1 AND instance = $2`, [threadKey, a.email]);
        if (thread) await applyTakeover(thread, text || undefined, id);
      },
    ).catch((e) => logger.warn({ err: String(e), account: a.email }, 'leitura do e-mail falhou'));
  }
}

// ------------------------------------------------------------------ Gmail (uma ou varias contas)
async function syncGmail(account?: string) {
  if (!gmailEnabled()) return;
  const accounts = (await gmailAccounts()).map((x) => x.email).filter((e) => !account || e === account.toLowerCase());
  for (const acc of accounts) await syncGmailAccount(acc).catch((e) => logger.warn({ err: String(e), acc }, 'sincronizacao do Gmail falhou'));
}

async function syncGmailAccount(account: string) {
  const state = await one<{ history_id: string }>(`SELECT history_id FROM gmail_sync_state WHERE account = $1`, [account]);
  if (!state) return; // o maintenance cria o estado ao ligar o watch
  const gm = await gmailFor(account);
  const add = (id: string) => ingestQueue.add('gmail', { id, account }, { jobId: `gm-${id}`, attempts: 3 });
  let pageToken: string | undefined;
  let lastHistoryId = state.history_id;
  try {
    do {
      const res = await gm.users.history.list({ userId: 'me', startHistoryId: state.history_id, historyTypes: ['messageAdded'], pageToken });
      for (const h of res.data.history ?? []) for (const added of h.messagesAdded ?? []) if (added.message?.id) await add(added.message.id);
      if (res.data.historyId) lastHistoryId = String(res.data.historyId);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (e: any) {
    if (e?.code !== 404) throw e;
    // historyId antigo demais: sincronizacao completa das ultimas 24 h
    const list = await gm.users.messages.list({ userId: 'me', q: 'newer_than:1d in:inbox' });
    for (const m of list.data.messages ?? []) if (m.id) await add(m.id);
    const profile = await gm.users.getProfile({ userId: 'me' });
    lastHistoryId = String(profile.data.historyId);
  }
  await q(`UPDATE gmail_sync_state SET history_id = $2 WHERE account = $1`, [account, lastHistoryId]);
}

async function ingestGmail(id: string, account?: string) {
  const acc = account ?? (await gmailAccounts())[0]?.email;
  if (!acc) return;
  const msg = await getMessage(acc, id);
  const f = antiLoop(msg, acc);
  if (f.skip) {
    if (f.humanSent && msg.threadId) {
      // resposta manual pela conta (sem o header interno): takeover da thread
      const thread = await one<Thread>(`SELECT * FROM threads WHERE channel = 'GMAIL' AND external_id = $1 AND instance = $2`, [msg.threadId, acc]);
      if (thread) await applyTakeover(thread, msg.snippet ?? undefined, `gm:${msg.id}`);
    }
    return;
  }
  await persistAndQueue(toInboundEvent(msg, acc));
}
