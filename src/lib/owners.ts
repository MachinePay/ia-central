import { fetchInstances } from '../channels/whatsapp/evolution.js';
import { env, instanceRoles } from './env.js';
import { normalizePhone, phoneVariants } from './phone.js';
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

/**
 * Donos: o Gabriel (GABRIEL_PERSONAL_PHONE) e o dono de cada numero pessoal (papel GABRIEL, ex.: o Leo).
 * Todos tem as mesmas permissoes: falam com o Maestro, aprovam pedidos e usam todas as ferramentas.
 * Devolve o numero (instancia) de quem mandou, '' se for dono sem numero proprio conhecido, ou undefined se nao for dono.
 */
export async function ownerInstanceOf(phone: string): Promise<string | undefined> {
  const p = normalizePhone(phone);
  if (!p) return undefined;
  for (const [name, role] of instanceRoles()) {
    if (role !== 'GABRIEL') continue;
    const own = await ownPhone(name).catch(() => undefined);
    if (own && phoneVariants(own).includes(p)) return name;
  }
  if (env.GABRIEL_PERSONAL_PHONE && phoneVariants(env.GABRIEL_PERSONAL_PHONE).includes(p)) {
    return [...instanceRoles()].find(([n, r]) => r === 'GABRIEL' && n === 'gabriel')?.[0] ?? '';
  }
  return undefined;
}

export const isOwnerPhone = async (phone: string) => (await ownerInstanceOf(phone)) !== undefined;
