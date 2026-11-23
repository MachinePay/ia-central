import { connectionState } from '../../channels/whatsapp/evolution.js';
import { one } from '../../lib/db.js';
import { env, instanceRoles, setting } from '../../lib/env.js';
import { respondQueue } from '../../lib/queues.js';
import { isBusinessHours } from '../../lib/util.js';
import { saveObservation, upsertResource } from '../core.js';
import { clear, raise } from '../incidents.js';

const SILENCE_HOURS = 12;

/**
 * Vigia do proprio sistema de atendimento.
 * Licao de 16/11: a Evolution pode dizer "open" com a conexao morta. Por isso, alem do estado,
 * avisamos quando um numero com movimento normal fica horas sem receber nenhuma mensagem.
 */
export async function collectSelf() {
  for (const [name, role] of instanceRoles()) {
    if (role === 'OFF') continue;
    const resourceId = `self:whatsapp:${name}`;
    let state = 'erro';
    try { state = await connectionState(name); } catch { /* Evolution fora */ }
    const last = await one<{ at: Date | null; usual: number }>(
      `SELECT max(m.created_at) AS at,
              count(*) FILTER (WHERE m.created_at > now() - interval '7 days')::int AS usual
         FROM app.messages m JOIN app.threads t ON t.id = m.thread_id
        WHERE t.channel = 'WHATSAPP' AND t.instance = $1 AND m.direction = 'INBOUND'`,
      [name],
    );
    const hours = last?.at ? (Date.now() - new Date(last.at).getTime()) / 3_600_000 : null;
    const ok = state === 'open';
    await upsertResource({ source: 'SELF', externalId: `whatsapp:${name}`, name: `WhatsApp ${name}`, kind: 'whatsapp', status: ok ? 'OK' : 'FAIL', meta: { state, role, lastInboundAt: last?.at, messages7d: last?.usual } });
    await saveObservation({ source: 'SELF', resourceId, resourceName: `WhatsApp ${name}`, kind: 'whatsapp_state', status: ok ? 'OK' : 'FAIL', details: { state } });

    if (!ok) {
      await raise({ ruleId: 'whatsapp-down', source: 'SELF', resourceId, severity: 'CRITICAL', title: `WhatsApp "${name}" desconectado (${state})`, detail: 'Reconecte a instância na Evolution (pode precisar de QR code).' });
    } else {
      await clear('whatsapp-down', resourceId);
    }
    // numero que costuma receber mensagens e esta mudo ha horas em horario comercial
    const busy = (last?.usual ?? 0) >= 20;
    if (ok && busy && hours !== null && hours > SILENCE_HOURS && isBusinessHours(setting('BUSINESS_HOURS'), env.TIMEZONE)) {
      await raise({ ruleId: 'whatsapp-silent', source: 'SELF', resourceId, severity: 'WARNING', title: `WhatsApp "${name}" sem receber mensagens há ${Math.round(hours)} h`, detail: 'A Evolution diz que está conectado, mas nada chega. Confira em Aparelhos conectados no celular; se estiver parado, reinicie a instância.' });
    } else if (hours !== null && hours < 1) {
      await clear('whatsapp-silent', resourceId);
    }
  }

  // fila de respostas acumulando
  const waiting = await respondQueue.getWaitingCount();
  if (waiting > 50) await raise({ ruleId: 'queue-backlog', source: 'SELF', resourceId: 'self:queue:respond', severity: 'WARNING', title: `Fila de respostas com ${waiting} conversas esperando` });
  else await clear('queue-backlog', 'self:queue:respond');

  // agentes falhando
  const err = await one<{ total: number; errors: number }>(
    `SELECT count(*)::int total, count(*) FILTER (WHERE outcome = 'ERROR')::int errors FROM app.agent_runs WHERE created_at > now() - interval '15 minutes'`,
  );
  if (err && err.total >= 5 && err.errors / err.total > 0.05) {
    await raise({ ruleId: 'agents-errors', source: 'SELF', resourceId: 'self:agents', severity: 'CRITICAL', title: `Agentes com ${Math.round((err.errors / err.total) * 100)}% de erro nos últimos 15 min`, detail: `${err.errors} de ${err.total} execuções falharam.` });
  } else if (err && err.total >= 5) {
    await clear('agents-errors', 'self:agents');
  }
}
