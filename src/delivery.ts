import { createHash } from 'node:crypto';
import { sendText } from './channels/whatsapp/evolution.js';
import { saveOutbound } from './domain/repo.js';
import type { Agent, Thread } from './domain/types.js';
import { approvalInstance, autoSendAgents, env, sendMode, shadowNotify } from './lib/env.js';
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
  const auto = i.force || autoSendEnabled(i.agent, i.thread.channel);
  const status = auto ? 'QUEUED' : 'DRAFT';
  const msg = await saveOutbound(i.thread.id, i.text, i.agent, status, { outboundKey, quotedId: i.quotedId });
  if (!msg) return status;

  if (auto || i.thread.channel === 'GMAIL') {
    // Gmail em modo rascunho: cria o rascunho na propria thread para o Gabriel enviar com um clique
    await outboundQueue.add('send', { messageId: msg.id, outboundKey, mode: auto ? 'send' : 'draft' }, {
      jobId: `out:${outboundKey}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
    });
  } else if (shadowNotify()) {
    await notifyGabriel(`📝 Rascunho (${i.agent}) para ${i.thread.external_id.split('@')[0]}:\n\n${i.text}`).catch(() => undefined);
  }
  return status;
}

/** Mensagem para o WhatsApp pessoal do Gabriel real (aprovacoes, alertas). */
export async function notifyGabriel(text: string): Promise<string | undefined> {
  const inst = approvalInstance();
  if (!inst || !env.GABRIEL_PERSONAL_PHONE) {
    logger.warn({ text }, 'aviso para o Gabriel sem GABRIEL_PERSONAL_PHONE/APPROVAL_INSTANCE');
    return undefined;
  }
  return sendText(inst, env.GABRIEL_PERSONAL_PHONE, text);
}
