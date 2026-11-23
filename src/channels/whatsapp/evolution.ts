import { env } from '../../lib/env.js';
import { keys, redis } from '../../lib/redis.js';

/** Marca invisivel no inicio de toda mensagem do bot: o webhook do fromMe pode chegar antes de gravarmos sent:{id}. */
export const BOT_MARK = '⁣';

async function evo<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${env.EVOLUTION_BASE_URL}${path}`, {
    method,
    headers: { apikey: env.EVOLUTION_API_KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Evolution ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function fetchInstances(): Promise<Array<{ name: string; connectionStatus: string; ownerJid?: string }>> {
  return evo('GET', '/instance/fetchInstances');
}

/** Cria uma instancia nova (numero novo). O QR code vem de connectQr. */
export async function createInstance(instance: string) {
  return evo('POST', '/instance/create', { instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true });
}

/** QR code (base64 PNG) para conectar o numero, ou o estado se ja estiver conectado. */
export async function connectQr(instance: string): Promise<{ qr?: string; pairingCode?: string; state?: string }> {
  const r = await evo('GET', `/instance/connect/${instance}`);
  if (r?.base64) return { qr: r.base64, pairingCode: r.pairingCode };
  return { state: (r?.instance ?? r)?.state };
}

export async function connectionState(instance: string): Promise<string> {
  const r = await evo('GET', `/instance/connectionState/${instance}`);
  return (r.instance ?? r).state;
}

/** Aponta o webhook da instancia para a API nova. A sessao (QR) nao e tocada. */
export async function setWebhook(instance: string) {
  return evo('POST', `/webhook/set/${instance}`, {
    webhook: {
      enabled: true,
      url: `${env.WEBHOOK_BASE_URL}/webhooks/evolution/${instance}?token=${encodeURIComponent(env.EVOLUTION_WEBHOOK_TOKEN)}`,
      headers: { 'x-webhook-token': env.EVOLUTION_WEBHOOK_TOKEN },
      byEvents: false,
      base64: true,
      events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
    },
  });
}

/** Licao do sistema antigo: nunca marcar como lido nem ficar online (o numero pessoal tambem e usado a mao). */
export async function setSettings(instance: string, opts: { rejectCall: boolean }) {
  return evo('POST', `/settings/set/${instance}`, {
    rejectCall: opts.rejectCall,
    msgCall: opts.rejectCall ? 'Não atendo ligações por aqui, me manda mensagem ou áudio 🙂' : '',
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
  });
}

export async function sendPresence(instance: string, number: string, ms: number) {
  await evo('POST', `/chat/sendPresence/${instance}`, { number, delay: ms, presence: 'composing' }).catch(() => undefined);
}

export async function sendText(instance: string, number: string, text: string, quotedId?: string): Promise<string | undefined> {
  const body: any = { number, text: BOT_MARK + text };
  if (quotedId) body.quoted = { key: { id: quotedId } };
  const r = await evo('POST', `/message/sendText/${instance}`, body);
  const id: string | undefined = r?.key?.id;
  if (id) await redis.set(keys.sent(id), '1', 'EX', 600);
  return id;
}

/** Baixa a midia. Manda a mensagem inteira (com a chave de midia): so o id nao basta, a Evolution nao guarda mensagens. */
export async function getMediaBase64(instance: string, key: unknown, message: unknown): Promise<{ base64: string; mimetype?: string } | undefined> {
  for (const body of [{ message: { key, message }, convertToMp4: false }, { message: { key }, convertToMp4: false }]) {
    try {
      const r = await evo('POST', `/chat/getBase64FromMediaMessage/${instance}`, body);
      const b64 = r?.base64 ?? r?.media;
      if (b64) return { base64: b64, mimetype: r?.mimetype };
    } catch {
      /* tenta o proximo formato */
    }
  }
  return undefined;
}

export async function deleteForEveryone(instance: string, remoteJid: string, id: string) {
  await evo('DELETE', `/chat/deleteMessageForEveryone/${instance}`, { id, remoteJid, fromMe: true }).catch(() => undefined);
}
