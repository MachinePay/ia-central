import { q } from './db.js';
import { isClosingMessage } from './closing.js';
import { logger } from './logger.js';

/** Conversas recentes ainda sem a marca de encerramento: calcula pelo que o contato mandou depois da ultima resposta. */
export async function backfillClosing(): Promise<void> {
  const rows = await q<{ id: string; msgs: Array<{ content: string; media: unknown[] | null }> | null }>(
    `SELECT t.id,
            (SELECT json_agg(json_build_object('content', m.content, 'media', m.media)) FROM app.messages m
              WHERE m.thread_id = t.id AND m.direction = 'INBOUND'
                AND m.created_at > coalesce((SELECT max(o.created_at) FROM app.messages o WHERE o.thread_id = t.id AND o.direction = 'OUTBOUND'
                                                AND o.status NOT IN ('DRAFT', 'DRAFT_DISCARDED')), 'epoch')) AS msgs
       FROM app.threads t
      WHERE t.last_inbound_closing IS NULL AND t.last_inbound_at > now() - interval '30 days'
      LIMIT 5000`,
  );
  let closing = 0;
  for (const r of rows) {
    const msgs = r.msgs ?? [];
    const v = msgs.length > 0 && msgs.every((m) => isClosingMessage(m.content, Array.isArray(m.media) && m.media.length > 0));
    if (v) closing++;
    await q(`UPDATE app.threads SET last_inbound_closing = $2 WHERE id = $1 AND last_inbound_closing IS NULL`, [r.id, v]);
  }
  if (rows.length) logger.info({ threads: rows.length, closing }, 'marca de encerramento calculada nas conversas recentes');
}
