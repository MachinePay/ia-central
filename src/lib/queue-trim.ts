import { logger } from './logger.js';
import { redis } from './redis.js';

/**
 * Apaga jobs terminados antigos das filas (concluidos e com falha), guardando so os mais recentes.
 * Usa so ZRANGE/ZREM/DEL (sem script Lua): funciona mesmo com o Redis cheio ("OOM command not allowed"),
 * que e justamente quando o BullMQ para de conseguir limpar sozinho.
 */
const QUEUES = ['ingest', 'media', 'respond', 'summarize', 'outbound', 'maintenance', 'sentinela'];
// midia guarda o arquivo inteiro no job: nada de concluido fica, e so poucas falhas
const KEEP = (q: string) => (q === 'media' ? { completed: 0, failed: 30 } : { completed: 100, failed: 300 });

export async function trimFinishedJobs(): Promise<number> {
  let removed = 0;
  for (const q of QUEUES) {
    for (const state of ['completed', 'failed'] as const) {
      const set = `bull:${q}:${state}`;
      try {
        // os mais antigos primeiro (score = horario em que terminou), deixando os KEEP mais novos
        for (;;) {
          const ids = await redis.zrange(set, 0, -(KEEP(q)[state] + 1)).then((all) => all.slice(0, 500));
          if (!ids.length) break;
          const p = redis.pipeline();
          for (const id of ids) p.del(`bull:${q}:${id}`, `bull:${q}:${id}:logs`);
          p.zrem(set, ...ids);
          await p.exec();
          removed += ids.length;
        }
      } catch (e) {
        logger.warn({ err: String(e), set }, 'limpeza da fila falhou');
      }
    }
  }
  if (removed) logger.info({ removed }, 'jobs antigos apagados das filas');
  return removed;
}
