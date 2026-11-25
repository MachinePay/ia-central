/** Leitura: ultimas conversas com o Maestro de cada numero (historico guardado no Redis). */
import { redis } from '../lib/redis.js';

const keys = await redis.keys('owner-chat:history*');
for (const k of keys) {
  const items = (await redis.lrange(k, -14, -1)).map((h) => JSON.parse(h));
  console.log(`[maestro] ===== ${k}`);
  for (const m of items) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    console.log(`[maestro] ${m.role}: ${c.replace(/\s+/g, ' ').slice(0, 600)}`);
  }
}
process.exit(0);
