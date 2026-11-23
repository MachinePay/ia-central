import { one, q } from '../lib/db.js';
import { publish } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { sentinelQueue } from './queue.js';
import type { Severity, Source } from './core.js';

export type Incident = {
  id: number; key: string; rule_id: string; source: Source; resource_id: string | null; severity: Severity;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; title: string; detail: string | null; diagnosis: any;
  hits: number; opened_at: Date; last_hit_at: Date; notified_at: Date | null; escalated_at: Date | null;
  acked_by: string | null; acked_at: Date | null; resolved_at: Date | null;
};

export const code = (id: number) => `#I-${String(id).padStart(3, '0')}`;

async function event(incidentId: number, type: string, payload: Record<string, unknown> = {}) {
  await q(`INSERT INTO sentinela.incident_events (incident_id, type, payload) VALUES ($1, $2, $3)`, [incidentId, type, JSON.stringify(payload)]);
}

/**
 * Regra violada: abre o incidente (um problema = um incidente) ou so atualiza o que ja esta aberto.
 * A chave regra+recurso evita mandar dez mensagens para o mesmo problema.
 */
export async function raise(o: { ruleId: string; source: Source; resourceId: string; severity: Severity; title: string; detail?: string }) {
  const key = `${o.ruleId}:${o.resourceId}`;
  const open = await one<Incident>(`SELECT * FROM sentinela.incidents WHERE key = $1 AND status <> 'RESOLVED'`, [key]);
  if (open) {
    const escalate = o.severity === 'CRITICAL' && open.severity !== 'CRITICAL';
    await q(
      `UPDATE sentinela.incidents SET hits = hits + 1, last_hit_at = now(), detail = coalesce($2, detail),
         severity = CASE WHEN $3 THEN 'CRITICAL' ELSE severity END WHERE id = $1`,
      [open.id, o.detail ?? null, escalate],
    );
    if (escalate) {
      await event(open.id, 'UPDATED', { severity: 'CRITICAL' });
      await sentinelQueue.add('notify', { incidentId: open.id, kind: 'escalated' });
    }
    return open.id;
  }
  // flapping: o mesmo problema abriu e fechou 4+ vezes em 30 min -> um incidente "instavel" so
  const flaps = await one<{ n: number }>(
    `SELECT count(*)::int n FROM sentinela.incidents WHERE key = $1 AND opened_at > now() - interval '30 minutes'`, [key],
  );
  const title = (flaps?.n ?? 0) >= 4 ? `Instável: ${o.title}` : o.title;
  const inc = await one<Incident>(
    `INSERT INTO sentinela.incidents (key, rule_id, source, resource_id, severity, title, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING *`,
    [key, o.ruleId, o.source, o.resourceId, o.severity, title, o.detail ?? null],
  );
  if (!inc) return undefined;
  await event(inc.id, 'OPENED', { title, detail: o.detail });
  await publish('incident.opened', { id: inc.id, severity: inc.severity, title });
  logger.warn({ incident: code(inc.id), title }, 'incidente aberto');
  // diagnostico da IA e aviso no WhatsApp (o aviso sai mesmo se a IA falhar)
  await sentinelQueue.add('diagnose-notify', { incidentId: inc.id }, { attempts: 2 });
  return inc.id;
}

/** Condicao voltou ao normal: resolve e avisa quanto tempo durou. */
export async function clear(ruleId: string, resourceId: string, note?: string) {
  const inc = await one<Incident>(
    `UPDATE sentinela.incidents SET status = 'RESOLVED', resolved_at = now() WHERE key = $1 AND status <> 'RESOLVED' RETURNING *`,
    [`${ruleId}:${resourceId}`],
  );
  if (!inc) return;
  await event(inc.id, 'RESOLVED', { note });
  await publish('incident.resolved', { id: inc.id });
  if (inc.notified_at) await sentinelQueue.add('notify', { incidentId: inc.id, kind: 'resolved' });
}

export async function ack(id: number, by: string): Promise<Incident | undefined> {
  const inc = await one<Incident>(
    `UPDATE sentinela.incidents SET status = 'ACKNOWLEDGED', acked_by = $2, acked_at = now() WHERE id = $1 AND status = 'OPEN' RETURNING *`,
    [id, by],
  );
  if (inc) {
    await event(id, 'ACKED', { by });
    await publish('incident.updated', { id, status: 'ACKNOWLEDGED' });
  }
  return inc;
}

export async function resolveManually(id: number, by: string, rootCause?: string) {
  const inc = await one<Incident>(
    `UPDATE sentinela.incidents SET status = 'RESOLVED', resolved_at = now(), root_cause = coalesce($3, root_cause)
      WHERE id = $1 AND status <> 'RESOLVED' RETURNING *`,
    [id, by, rootCause ?? null],
  );
  if (inc) {
    await event(id, 'RESOLVED', { by, rootCause });
    await publish('incident.resolved', { id });
  }
  return inc;
}

export const getIncident = (id: number) => one<Incident>(`SELECT * FROM sentinela.incidents WHERE id = $1`, [id]);
export const openIncidents = () => q<Incident>(`SELECT * FROM sentinela.incidents WHERE status <> 'RESOLVED' ORDER BY severity DESC, opened_at`);
