import type { Job } from 'bullmq';
import { buildMime, mdToHtml, mdToText, sendOrDraft } from '../channels/gmail/gmail.js';
import { sendPresence, sendText } from '../channels/whatsapp/evolution.js';
import { toBubbles, typingMs } from '../channels/whatsapp/format.js';
import { getContact, getThread } from '../domain/repo.js';
import type { Agent, Message } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { keys, redis } from '../lib/redis.js';
import { personaFor } from '../lib/env.js';
import { sleep } from '../lib/util.js';

const DISPLAY: Record<Agent, string> = {
  LEO: 'SelfMachine', JOAO: 'João · Comercial SelfMachine', CLARA: 'Clara · Suporte SelfMachine',
  GABRIEL: 'Gabriel · SelfMachine', HUMAN: 'SelfMachine',
};

export async function outboundWorker(job: Job) {
  const { messageId, outboundKey, mode } = job.data as { messageId: string; outboundKey: string; mode: 'send' | 'draft' };
  // idempotencia de envio: a mesma resposta nunca sai duas vezes (nem em retentativa)
  if (!(await redis.set(keys.sentKey(outboundKey), job.id ?? '1', 'EX', 86400, 'NX'))) {
    const owner = await redis.get(keys.sentKey(outboundKey));
    if (owner !== (job.id ?? '1')) return;
  }
  const msg = await one<Message>(`SELECT * FROM messages WHERE id = $1`, [messageId]);
  if (!msg || msg.status === 'SENT') return;
  const thread = (await getThread(msg.thread_id))!;
  const contact = (await getContact(thread.contact_id))!;
  const agent = (msg.sender ?? 'LEO') as Agent;

  if (thread.channel === 'WHATSAPP') {
    const number = thread.external_id; // JID bruto (funciona com @lid e com o nono digito como o WhatsApp conhece)
    const bubbles = toBubbles(msg.content);
    const sent: string[] = JSON.parse(String((await redis.get(`bubbles:${messageId}`)) ?? '[]'));
    for (const [i, b] of bubbles.entries()) {
      if (sent[i]) continue; // retentativa: nao repete bolhas ja enviadas
      const typing = typingMs(b);
      if (i > 0) await sleep(400 + Math.random() * 900); // pausa curta entre uma bolha e outra
      await sendPresence(thread.instance, number, typing);
      await sleep(typing);
      const id = await sendText(thread.instance, number, b, i === 0 ? msg.metadata?.quotedId : undefined);
      sent[i] = id ?? 'ok';
      await redis.set(`bubbles:${messageId}`, JSON.stringify(sent), 'EX', 86400);
    }
    await q(`UPDATE messages SET status = 'SENT', external_id = coalesce(external_id, $2) WHERE id = $1`, [messageId, `wa:${thread.instance}:${sent[0]}`]);
  } else {
    const original = await one<Message>(
      `SELECT * FROM messages WHERE thread_id = $1 AND direction = 'INBOUND' ORDER BY created_at DESC LIMIT 1`, [thread.id],
    );
    const meta = original?.metadata ?? {};
    const subject = String(meta.subject ?? thread.subject ?? 'SelfMachine');
    const body = msg.content;
    const raw = buildMime({
      from: thread.instance, fromName: personaFor(thread.instance).name || DISPLAY[agent], to: contact.email!, agent,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      inReplyTo: meta.messageIdHeader,
      references: [...(meta.references ?? []), meta.messageIdHeader].filter(Boolean).join(' '),
      text: mdToText(body), html: mdToHtml(body),
    });
    const id = await sendOrDraft(thread.instance, mode, raw, thread.external_id);
    await q(`UPDATE messages SET status = $2, external_id = coalesce(external_id, $3) WHERE id = $1`,
      [messageId, mode === 'send' ? 'SENT' : 'DRAFT', id ? `gm:${id}` : null]);
  }
  if (mode === 'send') await q(`UPDATE threads SET last_outbound_at = now(), last_bot_at = now() WHERE id = $1`, [thread.id]);
}
