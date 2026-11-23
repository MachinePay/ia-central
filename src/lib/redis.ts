import { Redis } from 'ioredis';
import { env } from './env.js';

/** Opcoes para o BullMQ (ele cria as proprias conexoes). */
export function redisOptions() {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export const redis = new Redis(redisOptions());

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export async function acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
}

/** So apaga se o token bater (outro worker pode ter pego o lock depois do TTL). */
export async function releaseLock(key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, key, token);
}

export const keys = {
  lock: (threadId: string) => `lock:thread:${threadId}`,
  sent: (waId: string) => `sent:${waId}`,
  takeover: (threadId: string) => `takeover:${threadId}`,
  sentKey: (k: string) => `sent-key:${k}`,
  rate: (contactId: string) => `rate:${contactId}`,
  pendingSince: (threadId: string) => `pending-since:${threadId}`,
  cost: (day: string) => `cost:${day}`,
  gmailBotReplies: (threadId: string) => `gmail-bot-replies:${threadId}`,
};
