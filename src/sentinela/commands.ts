import { one, q } from '../lib/db.js';
import { normalizePhone, phoneVariants } from '../lib/phone.js';
import { checkUrl } from './collectors/urls.js';
import { SEVERITY_ICON } from './core.js';
import { costSummary, formatCosts } from './costs.js';
import { ack, code, getIncident, openIncidents } from './incidents.js';
import { formatIncident, sendAlert, type AlertContact } from './notify.js';

const ROLE_CAN: Record<string, string[]> = {
  OWNER: ['status', 'custos', 'incidentes', 'ok', 'detalhes', 'silenciar', 'monitor', 'check'],
  ENGINEER: ['status', 'custos', 'incidentes', 'ok', 'detalhes', 'silenciar', 'monitor', 'check'],
  FINANCE: ['status', 'custos'],
  CLIENT_VIEWER: ['status'],
};

const COMMAND = /^\s*(?:\/(status|custos|incidentes|silenciar|monitor|check)\b(.*)|(ok|detalhes)\s+#?(?:I-)?(\d+))\s*$/i;

export async function statusText(): Promise<string> {
  const incs = await openIncidents();
  const res = await one<{ fail: number; ok: number }>(
    `SELECT count(*) FILTER (WHERE status = 'FAIL')::int fail, count(*) FILTER (WHERE status = 'OK')::int ok FROM sentinela.resources WHERE status <> 'SUSPENDED'`,
  );
  const mons = await one<{ fail: number; total: number }>(`SELECT count(*) FILTER (WHERE last_status = 'FAIL')::int fail, count(*)::int total FROM sentinela.monitors WHERE enabled`);
  if (!incs.length) return `✅ Tudo OK · ${res?.ok ?? 0} serviços no ar · ${mons?.total ?? 0} sites vigiados`;
  return [`⚠️ ${incs.length} incidente(s) aberto(s):`, ...incs.map((i) => `${SEVERITY_ICON[i.severity]} ${code(i.id)} ${i.title}${i.status === 'ACKNOWLEDGED' ? ' (reconhecido)' : ''}`)].join('\n');
}

/**
 * Comandos do Sentinela pelo WhatsApp. So numeros cadastrados e verificados, conforme o papel.
 * Retorna true se a mensagem era um comando (ja respondido).
 */
export async function handleSentinelCommand(phone: string, text: string): Promise<boolean> {
  // confirmacao do cadastro: o contato responde o codigo de 6 digitos
  const codeMatch = text.trim().match(/^(\d{6})$/);
  if (codeMatch) {
    const v = await one<{ name: string; phone: string }>(
      `UPDATE sentinela.contacts SET verified_at = now(), verify_code = NULL
        WHERE phone = ANY($1) AND verify_code = $2 AND verified_at IS NULL RETURNING name, phone`,
      [phoneVariants(phone), codeMatch[1]],
    );
    if (v) {
      await sendAlert(v.phone, `✅ Pronto, ${v.name}! Você vai receber os alertas do Sentinela por aqui. Comandos: /status · /custos · /incidentes · ok <número>`);
      return true;
    }
  }
  const m = text.match(COMMAND);
  if (!m) return false;
  const contact = await one<AlertContact>(
    `SELECT * FROM sentinela.contacts WHERE active AND verified_at IS NOT NULL AND phone = ANY($1)`, [phoneVariants(phone)],
  );
  if (!contact) return false;
  const cmd = (m[1] ?? m[3]).toLowerCase();
  const arg = (m[2] ?? m[4] ?? '').trim();
  const reply = (t: string) => sendAlert(normalizePhone(contact.phone), t);
  if (!(ROLE_CAN[contact.role] ?? []).includes(cmd)) {
    await reply('Seu cadastro não permite esse comando.');
    return true;
  }
  switch (cmd) {
    case 'status': await reply(await statusText()); break;
    case 'custos': await reply(formatCosts(await costSummary())); break;
    case 'incidentes': await reply(await statusText()); break;
    case 'ok': {
      const inc = await ack(+arg, contact.name);
      await reply(inc ? `👍 ${code(+arg)} reconhecido por ${contact.name}.` : `Não achei ${code(+arg)} aberto.`);
      break;
    }
    case 'detalhes': {
      const inc = await getIncident(+arg);
      if (!inc) { await reply(`Não achei ${code(+arg)}.`); break; }
      const d = inc.diagnosis as any;
      await reply([formatIncident(inc), d?.probable_cause ? `Causa provável: ${d.probable_cause}` : '', d?.evidence?.length ? `Evidências:\n• ${d.evidence.join('\n• ')}` : '', `Aberto ${new Date(inc.opened_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · ${inc.hits} ocorrência(s)`].filter(Boolean).join('\n'));
      break;
    }
    case 'silenciar': {
      // /silenciar <nome do monitor> <minutos>
      const mm = arg.match(/^(.+?)\s+(\d+)\s*(m|min|h)?$/i);
      if (!mm) { await reply('Use: /silenciar <nome do site> <minutos>'); break; }
      const minutes = +mm[2] * (mm[3]?.toLowerCase() === 'h' ? 60 : 1);
      const r = await q(`UPDATE sentinela.monitors SET silenced_until = now() + make_interval(mins => $2) WHERE name ILIKE $1 RETURNING name`, [`%${mm[1]}%`, minutes]);
      await reply(r.length ? `🔕 Silenciado por ${minutes} min: ${r.map((x: any) => x.name).join(', ')}` : 'Não achei esse site.');
      break;
    }
    case 'monitor': {
      // /monitor add <url>
      const url = arg.replace(/^add\s+/i, '').trim();
      if (!/^https?:\/\//.test(url)) { await reply('Use: /monitor add https://seusite.com'); break; }
      const name = new URL(url).hostname;
      await q(`INSERT INTO sentinela.monitors (name, url) VALUES ($1, $2) ON CONFLICT (url, method) DO UPDATE SET enabled = true`, [name, url]);
      const r = await checkUrl({ url, method: 'GET', expect_status: [200], max_latency_ms: 5000, must_contain: [], must_not_contain: [] });
      await reply(`👀 Vigiando ${name} a cada 1 min. Agora: ${r.status === 'OK' ? `ok (${r.latencyMs} ms)` : r.problems.join('; ')}. Ajuste textos esperados no painel.`);
      break;
    }
    case 'check': {
      const url = arg.trim();
      if (!/^https?:\/\//.test(url)) { await reply('Use: /check https://seusite.com'); break; }
      const r = await checkUrl({ url, method: 'GET', expect_status: [200], max_latency_ms: 5000, must_contain: [], must_not_contain: [] });
      await reply(`${r.status === 'OK' ? '✅' : r.status === 'WARN' ? '🟡' : '🔴'} ${url}\nStatus ${r.httpStatus ?? '-'} · ${r.latencyMs} ms${r.title ? ` · "${r.title}"` : ''}${r.problems.length ? `\n${r.problems.join('; ')}` : ''}`);
      break;
    }
  }
  return true;
}
