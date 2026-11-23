import { redis } from './redis.js';

/** Eventos em tempo real para o painel (SSE). Publicados no Redis; a API repassa aos navegadores. */
export type EventType =
  | 'message.created' | 'thread.updated' | 'approval.created' | 'approval.decided'
  | 'incident.opened' | 'incident.updated' | 'incident.resolved' | 'resource.updated' | 'cost.updated';

export const EVENTS_CHANNEL = 'painel:events';

export async function publish(type: EventType, data: Record<string, unknown>) {
  const id = await redis.incr('painel:events:seq');
  const payload = JSON.stringify({ id, type, data, at: new Date().toISOString() });
  await redis.multi().publish(EVENTS_CHANNEL, payload).lpush('painel:events:log', payload).ltrim('painel:events:log', 0, 499).exec();
}
