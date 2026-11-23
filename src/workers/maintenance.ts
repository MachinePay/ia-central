import type { Job } from 'bullmq';
import { sweepApprovals } from '../approvals/approvals.js';
import { gmailEnabled, startWatch } from '../channels/gmail/gmail.js';
import { notifyGabriel } from '../delivery.js';
import { q } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { ingestQueue, maintenanceQueue, outboundQueue, respondQueue, summarizeQueue } from '../lib/queues.js';
import { backfillEmbeddings } from '../memory/kb.js';
import { learnFromTeam } from '../memory/learn.js';
import { buildPersonaProfile, refreshContactTreatments } from '../memory/persona.js';
import { instanceRoles } from '../lib/env.js';

export async function scheduleMaintenance() {
  const every = (name: string, pattern: string) =>
    maintenanceQueue.upsertJobScheduler(name, { pattern, tz: env.TIMEZONE }, { name });
  await every('gmail-watch', '0 6 * * *');          // o watch expira em 7 dias: renova todo dia
  await every('gmail-poll', '* * * * *');           // rede de seguranca do Pub/Sub
  await every('approvals', '*/15 * * * *');
  await every('idle-summaries', '*/10 * * * *');
  await every('promises', '0 8 * * 1-5');
  await every('embeddings', '*/5 * * * *');
  await every('queue-health', '*/2 * * * *');
  await every('lgpd-retention', '30 3 * * *');
  await every('learn', '*/30 * * * *');
  await every('personas', '0 4 * * *');                // jeito geral de cada numero, toda madrugada
  await every('treatments', '20 * * * *');             // jeito com cada contato, de hora em hora
}

export async function maintenanceWorker(job: Job) {
  switch (job.name) {
    case 'gmail-watch': return renewGmailWatch();
    case 'gmail-poll': if (gmailEnabled()) await ingestQueue.add('gmail-sync', {}, { deduplication: { id: 'gmail-sync', ttl: 3000 } }); return;
    case 'approvals': return sweepApprovals();
    case 'idle-summaries': return idleSummaries();
    case 'promises': return promisesDue();
    case 'embeddings': { const n = await backfillEmbeddings(); if (n) logger.info({ n }, 'embeddings gerados'); return; }
    case 'queue-health': return queueHealth();
    case 'lgpd-retention': return retention();
    case 'learn': { await learnFromTeam(); return; }
    case 'treatments': { await refreshContactTreatments(); return; }
    case 'personas': {
      for (const [inst, role] of instanceRoles()) if (role !== 'OFF') await buildPersonaProfile(inst).catch((e) => logger.warn({ err: String(e), inst }, 'perfil nao gerado'));
      return;
    }
  }
}

export async function renewGmailWatch() {
  if (!gmailEnabled()) return;
  const w = await startWatch();
  await q(
    `INSERT INTO gmail_sync_state (account, history_id, watch_expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (account) DO UPDATE SET watch_expires_at = EXCLUDED.watch_expires_at`,
    [env.GMAIL_ACCOUNT, w.historyId, w.expiration],
  );
}

/** Thread inativa ha 30 min depois de resposta do bot: atualiza resumo e fatos. */
async function idleSummaries() {
  const rows = await q<{ id: string }>(
    `SELECT id FROM threads WHERE msgs_since_summary > 0 AND last_bot_at IS NOT NULL
       AND greatest(last_bot_at, coalesce(last_inbound_at, 'epoch')) < now() - interval '30 minutes'
       AND greatest(last_bot_at, coalesce(last_inbound_at, 'epoch')) > now() - interval '1 day' LIMIT 50`,
  );
  for (const r of rows) await summarizeQueue.add('summarize', { threadId: r.id }, { deduplication: { id: `sum:${r.id}` }, removeOnComplete: true });
}

/** O campo mais valioso dos fatos: promessas com prazo vencendo. */
async function promisesDue() {
  const rows = await q<{ name: string; o_que: string; prazo: string }>(
    `SELECT coalesce(c.name, c.phone, c.email) AS name, p->>'o_que' AS o_que, p->>'prazo' AS prazo
       FROM threads t JOIN contacts c ON c.id = t.contact_id, jsonb_array_elements(coalesce(t.facts->'promessas', '[]')) p
      WHERE (p->>'prazo') ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (p->>'prazo')::date <= current_date + 1`,
  );
  if (!rows.length) return;
  await notifyGabriel(`📌 Promessas vencendo:\n${rows.map((r) => `• ${r.name}: ${r.o_que} (prazo ${r.prazo})`).join('\n')}`);
}

/** Rede de seguranca: resposta liberada para envio (QUEUED) parada ha mais de 2 min volta para a fila. */
async function requeueStuckOutbound() {
  const stuck = await q<{ id: string; key: string | null; channel: string }>(
    `SELECT m.id, m.metadata->>'outboundKey' AS key, t.channel FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.status = 'QUEUED' AND m.created_at < now() - interval '2 minutes' AND m.created_at > now() - interval '1 day' LIMIT 50`,
  );
  for (const s of stuck) {
    if (!s.key) continue;
    await outboundQueue.add('send', { messageId: s.id, outboundKey: s.key, mode: 'send' }, { jobId: `out-${s.key}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
  }
}

async function queueHealth() {
  await requeueStuckOutbound();
  const waiting = await respondQueue.getWaitingCount();
  if (waiting > 50) await notifyGabriel(`⚠️ Fila de respostas com ${waiting} jobs esperando.`).catch(() => undefined);
}

/** Retencao LGPD: midia fica so a descricao; leads sem interacao em 12 meses sao anonimizados; runs perdem conteudo. */
async function retention() {
  await q(`UPDATE agent_runs SET reply = NULL, tool_calls = '[]' WHERE created_at < now() - interval '30 days' AND reply IS NOT NULL`);
  await q(`DELETE FROM agent_runs WHERE created_at < now() - interval '24 months'`);
  await q(
    `WITH old AS (
       SELECT c.id FROM contacts c WHERE c.crm_stage IN ('NEW','QUALIFIED','LOST')
          AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.contact_id = c.id AND t.updated_at > now() - interval '12 months')
          AND c.updated_at < now() - interval '12 months' AND c.name IS DISTINCT FROM '[anonimizado]')
     UPDATE messages SET content = '[anonimizado]', media = NULL, metadata = '{}'
      WHERE thread_id IN (SELECT t.id FROM threads t JOIN old ON old.id = t.contact_id)`,
  );
}
