import { Worker, type Processor } from 'bullmq';
import { logger } from '../lib/logger.js';
import { redisOptions } from '../lib/redis.js';
import { summarizeThread } from '../memory/summarize.js';
import { ingestWorker, mediaWorker } from './ingest.js';
import { maintenanceWorker, renewGmailWatch, scheduleMaintenance } from './maintenance.js';
import { outboundWorker } from './outbound.js';
import { respondWorker } from './respond.js';

const connection = redisOptions();

function start(name: string, fn: Processor, concurrency: number) {
  const w = new Worker(name, fn, { connection, concurrency });
  w.on('failed', (job, err) => logger.error({ queue: name, jobId: job?.id, err: err.message }, 'job falhou'));
  return w;
}

const workers = [
  start('ingest', ingestWorker, 20),
  start('media', mediaWorker, 5),
  start('respond', respondWorker, 10),
  start('summarize', async (job) => summarizeThread(job.data.threadId), 2),
  start('outbound', outboundWorker, 10),
  start('maintenance', maintenanceWorker, 1),
];

await scheduleMaintenance();
await renewGmailWatch().catch((e) => logger.warn({ err: String(e) }, 'watch do Gmail nao iniciado'));
logger.info('workers no ar');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  });
}
