import type { Job } from 'bullmq';
import { q } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { collectRender } from './collectors/render.js';
import { collectSelf } from './collectors/self.js';
import { collectSsl, collectUrls } from './collectors/urls.js';
import { collectVercel } from './collectors/vercel.js';
import { statusText } from './commands.js';
import { checkCostRules, computeCostsToday, costSummary, formatCosts } from './costs.js';
import { code } from './incidents.js';
import { diagnoseAndNotify, ensureOwner, notify, notifyOne, sendAlert, sweepEscalations } from './notify.js';
import { sentinelQueue } from './queue.js';

export async function scheduleSentinel() {
  if (!env.SENTINEL_ENABLED) return;
  await ensureOwner();
  const every = (name: string, pattern: string) => sentinelQueue.upsertJobScheduler(name, { pattern, tz: env.TIMEZONE }, { name });
  await every('urls', '* * * * *');
  await every('render', '*/2 * * * *');
  await every('vercel', '*/3 * * * *');
  await every('self', '*/5 * * * *');
  await every('ssl', '0 */6 * * *');
  await every('costs', '15 * * * *');
  await every('escalations', '* * * * *');
  await every('daily-summary', '0 8 * * *');
  await every('cleanup', '40 3 * * *');
}

export async function sentinelWorker(job: Job) {
  switch (job.name) {
    case 'urls': return collectUrls();
    case 'render': return collectRender();
    case 'vercel': return collectVercel();
    case 'self': return collectSelf();
    case 'ssl': return collectSsl();
    case 'costs': await computeCostsToday(); return checkCostRules();
    case 'escalations': return sweepEscalations();
    case 'diagnose-notify': return diagnoseAndNotify(job.data.incidentId);
    case 'notify': return notify(job.data.incidentId, job.data.kind);
    case 'notify-one': return notifyOne(job.data.incidentId, job.data.kind, job.data.phone);
    case 'daily-summary': return dailySummary();
    case 'cleanup': await q(`DELETE FROM sentinela.observations WHERE observed_at < now() - interval '30 days'`); return;
  }
}

/** Resumo das 8h: incidentes das ultimas 24 h, status atual e custos. */
async function dailySummary() {
  await computeCostsToday();
  const last24 = await q<{ id: number; title: string; status: string; severity: string }>(
    `SELECT id, title, status, severity FROM sentinela.incidents WHERE opened_at > now() - interval '24 hours' ORDER BY opened_at`,
  );
  const ssl = await q<{ name: string; days: number }>(
    `SELECT name, floor(extract(epoch from ssl_expires_at - now()) / 86400)::int days FROM sentinela.monitors
      WHERE ssl_expires_at < now() + interval '30 days' ORDER BY ssl_expires_at`,
  );
  const text = [
    '☀️ Bom dia · resumo do Sentinela',
    await statusText(),
    last24.length ? `Últimas 24 h: ${last24.length} incidente(s)\n${last24.map((i) => `• ${code(i.id)} ${i.title} (${i.status === 'RESOLVED' ? 'resolvido' : 'aberto'})`).join('\n')}` : 'Últimas 24 h: nenhum incidente.',
    ssl.length ? `Certificados vencendo: ${ssl.map((s) => `${s.name} em ${s.days} d`).join(', ')}` : '',
    formatCosts(await costSummary()),
  ].filter(Boolean).join('\n\n');
  const owners = await q<{ phone: string }>(`SELECT phone FROM sentinela.contacts WHERE active AND verified_at IS NOT NULL AND role IN ('OWNER', 'FINANCE')`);
  for (const o of owners) await sendAlert(o.phone, text).catch((e) => logger.error({ err: String(e) }, 'resumo diario falhou'));
}
