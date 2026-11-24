import { fetchInstances } from '../channels/whatsapp/evolution.js';
import { normalizePhone } from './phone.js';
import { redis } from './redis.js';

/**
 * Telefone de cada numero conectado (o "Voce" de cada um).
 * Vem do proprio webhook (sender) e, se ainda nao chegou nenhum, da Evolution.
 */
const KEY = (instance: string) => `inst-phone:${instance}`;

export async function rememberOwnPhone(instance: string, jid?: string) {
  const phone = normalizePhone(jid ?? '');
  if (phone.length >= 10) await redis.set(KEY(instance), phone, 'EX', 7 * 86400);
}

export async function ownPhone(instance: string): Promise<string | undefined> {
  const hit = await redis.get(KEY(instance));
  if (hit) return hit;
  try {
    for (const i of await fetchInstances()) if (i.ownerJid) await rememberOwnPhone(i.name, i.ownerJid);
  } catch { /* Evolution fora */ }
  return (await redis.get(KEY(instance))) ?? undefined;
}

/** { telefone -> instancia } de todos os numeros conhecidos */
export async function ownPhones(instances: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const i of instances) { const p = await ownPhone(i); if (p) m.set(p, i); }
  return m;
}
