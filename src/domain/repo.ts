import { one, q } from '../lib/db.js';
import { normalizePhone, phoneVariants } from '../lib/phone.js';
import type { Agent, Contact, InboundEvent, Message, Thread } from './types.js';

export async function upsertContact(ev: InboundEvent): Promise<Contact> {
  if (ev.channel === 'WHATSAPP') {
    const phone = normalizePhone(ev.sender.phone ?? '');
    const jid = ev.sender.jid ?? null;
    const found = await one<Contact>(
      `SELECT * FROM contacts WHERE phone = ANY($1) OR ($2::text IS NOT NULL AND wa_jid = $2) ORDER BY created_at LIMIT 1`,
      [phoneVariants(phone), jid],
    );
    if (found) {
      return (await one<Contact>(
        `UPDATE contacts SET name = coalesce(name, $2), wa_jid = coalesce($3, wa_jid), phone = coalesce(phone, $4), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [found.id, ev.sender.name || null, jid, phone || null],
      ))!;
    }
    return (await one<Contact>(
      `INSERT INTO contacts (name, phone, wa_jid) VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET updated_at = now() RETURNING *`,
      [ev.sender.name || null, phone || null, jid],
    ))!;
  }
  const email = (ev.sender.email ?? '').toLowerCase();
  return (await one<Contact>(
    `INSERT INTO contacts (name, email) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET name = coalesce(contacts.name, EXCLUDED.name), updated_at = now() RETURNING *`,
    [ev.sender.name || null, email],
  ))!;
}

export async function upsertThread(ev: InboundEvent, contactId: string): Promise<Thread> {
  return (await one<Thread>(
    `INSERT INTO threads (contact_id, channel, instance, external_id, subject)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel, instance, external_id) DO UPDATE SET updated_at = now(),
       subject = coalesce(threads.subject, EXCLUDED.subject)
     RETURNING *`,
    [contactId, ev.channel, ev.instance, ev.externalThreadId, ev.metadata.subject ?? null],
  ))!;
}

/** Insere a mensagem do cliente; retorna undefined se ja existia (webhook duplicado). */
export async function saveInboundIfNew(ev: InboundEvent): Promise<{ message: Message; thread: Thread; contact: Contact } | undefined> {
  const exists = await one(`SELECT 1 FROM messages WHERE external_id = $1`, [ev.externalMessageId]);
  if (exists) return undefined;
  const contact = await upsertContact(ev);
  const thread = await upsertThread(ev, contact.id);
  const message = await one<Message>(
    `INSERT INTO messages (thread_id, external_id, direction, status, content, media, metadata, created_at)
     VALUES ($1, $2, 'INBOUND', $3, $4, $5, $6, $7)
     ON CONFLICT (external_id) DO NOTHING RETURNING *`,
    [
      thread.id, ev.externalMessageId, ev.needsMedia ? 'PENDING_MEDIA' : 'DONE', ev.content,
      JSON.stringify(ev.media), JSON.stringify({ ...ev.metadata, raw: undefined }), ev.receivedAt,
    ],
  );
  if (!message) return undefined;
  await q(`UPDATE threads SET last_inbound_at = $2, msgs_since_summary = msgs_since_summary + 1 WHERE id = $1`, [thread.id, ev.receivedAt]);
  return { message, thread, contact };
}

export async function saveOutbound(threadId: string, content: string, sender: Agent, status: string, metadata: Record<string, unknown> = {}, externalId?: string) {
  const m = await one<Message>(
    `INSERT INTO messages (thread_id, external_id, direction, sender, status, content, metadata)
     VALUES ($1, $2, 'OUTBOUND', $3, $4, $5, $6) ON CONFLICT (external_id) DO NOTHING RETURNING *`,
    [threadId, externalId ?? null, sender, status, content, JSON.stringify(metadata)],
  );
  if (status === 'SENT' || sender === 'HUMAN') {
    await q(
      `UPDATE threads SET last_outbound_at = now(), msgs_since_summary = msgs_since_summary + 1,
         last_bot_at = CASE WHEN $2 <> 'HUMAN' THEN now() ELSE last_bot_at END WHERE id = $1`,
      [threadId, sender],
    );
  }
  return m;
}

export const getThread = (id: string) => one<Thread>(`SELECT * FROM threads WHERE id = $1`, [id]);
export const getContact = (id: string) => one<Contact>(`SELECT * FROM contacts WHERE id = $1`, [id]);

export async function findWaThread(instance: string, jid: string): Promise<Thread | undefined> {
  return one<Thread>(`SELECT * FROM threads WHERE channel = 'WHATSAPP' AND instance = $1 AND external_id = $2`, [instance, jid]);
}

export async function recentMessages(threadId: string, limit = 12): Promise<Message[]> {
  const rows = await q<Message>(
    `SELECT * FROM messages WHERE thread_id = $1 AND status NOT IN ('DRAFT_DISCARDED') ORDER BY created_at DESC LIMIT $2`,
    [threadId, limit],
  );
  return rows.reverse();
}

export async function lastInboundId(threadId: string): Promise<string | undefined> {
  return (await one<{ id: string }>(
    `SELECT id FROM messages WHERE thread_id = $1 AND direction = 'INBOUND' ORDER BY created_at DESC LIMIT 1`,
    [threadId],
  ))?.id;
}

/** Mensagens do cliente desde a ultima resposta (o "bloco novo"). */
export async function unansweredBlock(threadId: string): Promise<Message[]> {
  return q<Message>(
    `SELECT * FROM messages WHERE thread_id = $1 AND direction = 'INBOUND'
       AND created_at > coalesce((SELECT max(created_at) FROM messages WHERE thread_id = $1 AND direction = 'OUTBOUND'
                                   AND status IN ('SENT', 'QUEUED', 'DRAFT')), 'epoch')
     ORDER BY created_at`,
    [threadId],
  );
}

export async function setThread(threadId: string, patch: Partial<Record<keyof Thread, unknown>>) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const vals = cols.map((c) => {
    const v = (patch as any)[c];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  await q(`UPDATE threads SET ${sets}, updated_at = now() WHERE id = $1`, [threadId, ...vals]);
}

/** Outra thread do mesmo contato (ex.: o e-mail com a proposta quando ele pergunta no WhatsApp). */
export async function otherChannelSummary(contactId: string, threadId: string): Promise<string | undefined> {
  const r = await one<{ channel: string; summary: string }>(
    `SELECT channel, summary FROM threads WHERE contact_id = $1 AND id <> $2 AND summary IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`,
    [contactId, threadId],
  );
  return r ? `[${r.channel}] ${r.summary}` : undefined;
}
