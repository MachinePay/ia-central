import { createHash } from 'node:crypto';
import { sendText } from './channels/whatsapp/evolution.js';
import { saveOutbound } from './domain/repo.js';
import { one } from './lib/db.js';
import type { Agent, Thread } from './domain/types.js';
import { approvalInstance, autoSendAgents, centralInstance, env, instanceRole, numberOf, numberRule, sendMode, shadowNotify } from './lib/env.js';
import { ownPhone } from './lib/owners.js';
import { logger } from './lib/logger.js';
import { outboundQueue } from './lib/queues.js';

export function autoSendEnabled(agent: Agent, channel: Thread['channel']): boolean {
  if (sendMode() === 'auto') return true;
  const list = autoSendAgents();
  return list.includes(agent) || list.includes(`${agent}:${channel}`);
}

export type DeliverInput = {
  thread: Thread;
  agent: Agent;
  text: string;
  lastInboundId?: string;
  quotedId?: string;
  /** mensagens do sistema (aprovacao decidida pelo Gabriel, aviso neutro) saem mesmo no modo rascunho */
  force?: boolean;
};

/** Decide entre rascunho e envio; o envio de fato acontece no worker "outbound". */
export async function deliver(i: DeliverInput): Promise<'DRAFT' | 'QUEUED'> {
  const outboundKey = createHash('sha256').update(`${i.thread.id}|${i.lastInboundId ?? ''}|${i.agent}|${i.force ? i.text : ''}`).digest('hex').slice(0, 32);
  // marcado "responde sozinha" nesta conversa (ou o numero todo em envio automatico): sai sem rascunho
  const row = await one<{ ai_auto: boolean }>(`SELECT ai_auto FROM threads WHERE id = $1`, [i.thread.id]);
  const auto = i.force || !!row?.ai_auto || numberRule(numberOf(i.thread.instance)).auto || autoSendEnabled(i.agent, i.thread.channel);
  const status = auto ? 'QUEUED' : 'DRAFT';
  const msg = await saveOutbound(i.thread.id, i.text, i.agent, status, { outboundKey, quotedId: i.quotedId });
  if (!msg) return status;

  if (auto || i.thread.channel === 'GMAIL') {
    // Gmail em modo rascunho: cria o rascunho na propria thread para o Gabriel enviar com um clique
    await outboundQueue.add('send', { messageId: msg.id, outboundKey, mode: auto ? 'send' : 'draft' }, {
      jobId: `out-${outboundKey}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
    });
  } else if (shadowNotify()) {
    await notifyGabriel(`📝 Rascunho (${i.agent}) para ${i.thread.external_id.split('@')[0]}:\n\n${i.text}`, i.thread.instance).catch(() => undefined);
  }
  return status;
}

/**
 * Aviso para o dono (aprovacoes, rascunhos, alertas).
 * Com numero da IA (central): sai dele para o Gabriel. Sem ele: cai no "Voce" do proprio numero da conversa
 * (o numero manda para si mesmo). Sem numero conhecido: vai para o Gabriel pelo numero das aprovacoes.
 */
export async function notifyGabriel(text: string, instance?: string): Promise<string | undefined> {
  const central = centralInstance();
  if (central && env.GABRIEL_PERSONAL_PHONE) return sendText(central, env.GABRIEL_PERSONAL_PHONE, text);
  if (instance) instance = numberOf(instance);
  if (instance && instanceRole(instance) !== 'OFF') {
    const self = await ownPhone(instance).catch(() => undefined);
    if (self) return sendText(instance, self, text);
  }
  const inst = approvalInstance();
  if (!inst || !env.GABRIEL_PERSONAL_PHONE) {
    logger.warn({ text }, 'aviso para o Gabriel sem GABRIEL_PERSONAL_PHONE/APPROVAL_INSTANCE');
    return undefined;
  }
  return sendText(inst, env.GABRIEL_PERSONAL_PHONE, text);
}
