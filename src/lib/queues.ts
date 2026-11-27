import { Queue } from 'bullmq';
import { redis, keys, redisOptions } from './redis.js';

const connection = redisOptions();
// Redis tem 256 MB: guarda pouco historico de jobs (o que importa ja esta no Postgres)
const base = { connection, defaultJobOptions: { removeOnComplete: { count: 200, age: 86_400 }, removeOnFail: { count: 300, age: 7 * 86_400 } } };

export const ingestQueue = new Queue('ingest', base);
// midia carrega o arquivo inteiro (base64, ate 16 MB por job): apaga assim que termina
export const mediaQueue = new Queue('media', { connection, defaultJobOptions: { removeOnComplete: true, removeOnFail: { count: 30, age: 86_400 } } });
export const respondQueue = new Queue('respond', base);
export const summarizeQueue = new Queue('summarize', base);
export const outboundQueue = new Queue('outbound', base);
export const maintenanceQueue = new Queue('maintenance', base);

export const allQueues = [ingestQueue, mediaQueue, respondQueue, summarizeQueue, outboundQueue, maintenanceQueue];

const DEBOUNCE_MS = { WHATSAPP: 3000, GMAIL: 1000 } as const; // espera o cliente terminar de digitar
const MAX_WAIT_MS = 12_000;

/**
 * Debounce por thread: cada mensagem nova reinicia a janela (6 s no WhatsApp).
 * Para quem digita sem parar, a espera total nunca passa de 20 s desde a primeira mensagem pendente.
 */
export async function enqueueRespond(threadId: string, channel: 'WHATSAPP' | 'GMAIL', opts: { now?: boolean } = {}) {
  const now = Date.now();
  await redis.set(keys.pendingSince(threadId), String(now), 'PX', 120_000, 'NX');
  const since = Number((await redis.get(keys.pendingSince(threadId))) ?? now);
  const delay = opts.now ? 0 : Math.max(0, Math.min(DEBOUNCE_MS[channel], MAX_WAIT_MS - (now - since)));
  await respondQueue.add(
    'respond',
    { threadId, channel },
    {
      delay,
      deduplication: { id: `respond:${threadId}`, ttl: delay + 1000, extend: true, replace: true },
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: true,
    },
  );
}

export async function cancelPendingRespond(threadId: string) {
  const jobId = await respondQueue.getDeduplicationJobId(`respond:${threadId}`);
  if (jobId) {
    const job = await respondQueue.getJob(jobId);
    if (job && (await job.isDelayed())) await job.remove().catch(() => undefined);
  }
  await respondQueue.removeDeduplicationKey(`respond:${threadId}`);
  await redis.del(keys.pendingSince(threadId));
}
