import { sendText } from '../channels/whatsapp/evolution.js';
import { q } from '../lib/db.js';
import { centralInstance, emailsByNumber, env, instanceRoles, personaFor } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { ownPhone } from '../lib/owners.js';
import { normalizePhone } from '../lib/phone.js';

/**
 * Resumo do dia (toda manha): o que cada IA fez nas ultimas 24 h, o que ficou pendente e quem esta esperando.
 * Cada numero recebe o seu no proprio "Voce". Com numero da IA (central), o Gabriel recebe tudo junto por ele.
 */
type NumberBrief = { instance: string; name: string; text: string };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function numberBrief(instance: string): Promise<NumberBrief> {
  const persona = personaFor(instance);
  const accounts = [instance, ...Object.entries(emailsByNumber()).filter(([i]) => i === instance).map(([, mail]) => mail.toLowerCase())];
  const [stats] = await q<{ convs: number; sent: number; drafts: number; mine: number }>(
    `SELECT
       (SELECT count(DISTINCT m.thread_id)::int FROM app.messages m JOIN app.threads t ON t.id = m.thread_id
         WHERE t.instance = ANY($1) AND m.direction = 'INBOUND' AND m.created_at > now() - interval '24 hours') AS convs,
       (SELECT count(*)::int FROM app.messages m JOIN app.threads t ON t.id = m.thread_id
         WHERE t.instance = ANY($1) AND m.direction = 'OUTBOUND' AND m.sender <> 'HUMAN' AND m.status = 'SENT' AND m.created_at > now() - interval '24 hours') AS sent,
       (SELECT count(*)::int FROM app.messages m JOIN app.threads t ON t.id = m.thread_id
         WHERE t.instance = ANY($1) AND m.status = 'DRAFT' AND m.created_at > now() - interval '24 hours') AS drafts,
       (SELECT count(*)::int FROM app.messages m JOIN app.threads t ON t.id = m.thread_id
         WHERE t.instance = ANY($1) AND m.sender = 'HUMAN' AND m.created_at > now() - interval '24 hours') AS mine`,
    [accounts],
  );
  const waiting = await q<{ name: string; since: Date }>(
    `SELECT coalesce(c.name, c.phone, c.email) AS name, t.last_inbound_at AS since
       FROM app.threads t JOIN app.contacts c ON c.id = t.contact_id
      WHERE t.instance = ANY($1) AND t.last_inbound_at > now() - interval '3 days' AND t.last_inbound_at < now() - interval '30 minutes'
        AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)
        AND NOT EXISTS (SELECT 1 FROM app.contacts x WHERE x.id = c.id AND x.role = 'PESSOAL')
      ORDER BY t.last_inbound_at LIMIT 8`,
    [accounts],
  );
  const approvals = await q<{ code: string; name: string }>(
    `SELECT a.code, coalesce(c.name, c.phone, c.email) AS name FROM app.pending_approvals a
       JOIN app.threads t ON t.id = a.thread_id JOIN app.contacts c ON c.id = t.contact_id
      WHERE a.status = 'PENDING' AND t.instance = ANY($1) ORDER BY a.created_at`,
    [accounts],
  );
  const ago = (d: Date) => {
    const h = Math.floor((Date.now() - new Date(d).getTime()) / 3_600_000);
    return h < 1 ? 'há pouco' : h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} d`;
  };
  const s = stats ?? { convs: 0, sent: 0, drafts: 0, mine: 0 };
  const lines = [
    `${persona.name}: ${plural(s.convs, 'conversa', 'conversas')} nas últimas 24 h, ${plural(s.sent, 'resposta enviada', 'respostas enviadas')} pela IA` +
      (s.drafts ? `, ${plural(s.drafts, 'rascunho', 'rascunhos')}` : '') + (s.mine ? `, ${plural(s.mine, 'mensagem sua', 'mensagens suas')}` : '') + '.',
    approvals.length ? `Aprovações esperando: ${approvals.map((a) => `#${a.code} (${a.name})`).join(', ')}.` : '',
    waiting.length ? `Esperando resposta: ${waiting.map((w) => `${w.name} (${ago(w.since)})`).join(', ')}.` : 'Ninguém esperando resposta.',
  ].filter(Boolean);
  return { instance, name: persona.name, text: lines.join('\n') };
}

async function sentinelBrief(): Promise<string> {
  const open = await q<{ id: number; title: string; severity: string }>(
    `SELECT id, title, severity FROM sentinela.incidents WHERE status <> 'RESOLVED' ORDER BY severity DESC, opened_at LIMIT 5`,
  ).catch(() => []);
  const [day] = await q<{ n: number }>(`SELECT count(*)::int n FROM sentinela.incidents WHERE opened_at > now() - interval '24 hours'`).catch(() => [{ n: 0 }]);
  if (!open.length) return `Sentinela: tudo no ar${day?.n ? ` (${plural(day.n, 'incidente', 'incidentes')} nas últimas 24 h, já resolvidos)` : ''}.`;
  return `Sentinela: ${plural(open.length, 'incidente aberto', 'incidentes abertos')}: ${open.map((i) => `#I-${i.id} ${i.title}`).join('; ')}.`;
}

/** Monta e manda os resumos. Retorna o que foi enviado (para o teste pelo painel). */
export async function sendDailyBrief(): Promise<Array<{ to: string; via: string; text: string }>> {
  const numbers = [...instanceRoles()].filter(([, r]) => r !== 'OFF' && r !== 'CENTRAL').map(([n]) => n);
  const briefs: NumberBrief[] = [];
  for (const n of numbers) briefs.push(await numberBrief(n).catch((e) => ({ instance: n, name: n, text: `(não consegui montar: ${String(e).slice(0, 80)})` })));
  const sentinel = await sentinelBrief();
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone: env.TIMEZONE, weekday: 'long', day: '2-digit', month: '2-digit' }).format(new Date());
  const out: Array<{ to: string; via: string; text: string }> = [];
  const send = async (via: string, to: string, text: string) => {
    try { await sendText(via, to, text); out.push({ to, via, text }); } catch (e) { logger.warn({ err: String(e), via }, 'resumo do dia nao enviado'); }
  };

  const gabriel = normalizePhone(env.GABRIEL_PERSONAL_PHONE);
  const central = centralInstance();
  if (central && gabriel) {
    // com numero da IA: o Gabriel recebe tudo junto, pelo orquestrador
    await send(central, gabriel, [`Bom dia. Resumo de ${date}:`, ...briefs.map((b) => b.text), sentinel].join('\n\n'));
  }
  for (const b of briefs) {
    const self = await ownPhone(b.instance).catch(() => undefined);
    if (!self) continue;
    if (central && self === gabriel) continue; // o Gabriel ja recebeu o resumo completo pelo orquestrador
    const withSentinel = self === gabriel; // o numero do Gabriel tambem leva o Sentinela
    await send(b.instance, self, [`Bom dia, ${b.name}. Resumo de ${date}:`, b.text, withSentinel ? sentinel : ''].filter(Boolean).join('\n\n'));
  }
  logger.info({ sent: out.length }, 'resumo do dia enviado');
  return out;
}
