import { notifyGabriel } from '../delivery.js';
import type { InboundEvent } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { numberOf, personaFor } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Regras de e-mail de cada IA (pagina E-mail):
 *  - reply: a IA sempre responde esse remetente (mesmo com o numero em "so os marcados")
 *  - delete: vai para a lixeira assim que chega
 *  - notify: avisa no WhatsApp ("Voce" do numero, ou a IA central)
 *  - ignore: so guarda, a IA nao responde
 * Tudo o que chega fica registrado em app.emails, com o que foi feito.
 */
export type RuleAction = 'reply' | 'delete' | 'notify' | 'ignore';
export type EmailRule = { id: number; instance: string; kind: 'from' | 'domain' | 'subject'; pattern: string; action: RuleAction; active: boolean };

function matches(r: EmailRule, from: string, subject: string): boolean {
  const p = r.pattern.trim().toLowerCase();
  if (!p) return false;
  if (r.kind === 'from') return from === p || from.includes(p);
  if (r.kind === 'domain') { const d = from.split('@')[1] ?? ''; const x = p.replace(/^@/, ''); return d === x || d.endsWith(`.${x}`); }
  return subject.toLowerCase().includes(p);
}

export type EmailDecision = { delete: boolean; process: boolean; forceReply: boolean };

/** Decide o que fazer com um e-mail que chegou, registra e avisa se for o caso. skip = motivo do filtro automatico (newsletter, noreply...). */
export async function decideEmail(ev: InboundEvent, skip?: string): Promise<EmailDecision> {
  const account = ev.instance.toLowerCase();
  const instance = numberOf(account);
  const from = (ev.sender.email ?? '').toLowerCase();
  const subject = String(ev.metadata.subject ?? '');
  const rules = await q<EmailRule>(`SELECT * FROM app.email_rules WHERE instance = $1 AND active ORDER BY id`, [instance]);
  const hit = rules.filter((r) => matches(r, from, subject));
  const del = hit.find((r) => r.action === 'delete');
  const reply = hit.find((r) => r.action === 'reply');
  const ignore = hit.find((r) => r.action === 'ignore');
  const notify = hit.find((r) => r.action === 'notify');
  const action = del ? 'apagado' : reply ? 'ia' : ignore ? 'guardado' : skip ? 'filtrado' : 'ia';
  const detail = del ? 'regra: apagar sempre' : reply ? 'regra: IA responde sempre' : ignore ? 'regra: só guardar' : skip ? `filtro automático: ${skip}` : '';
  const ruleId = (del ?? reply ?? ignore ?? notify)?.id ?? null;
  const inserted = await one<{ id: number }>(
    `INSERT INTO app.emails (instance, account, message_id, from_email, from_name, subject, snippet, received_at, action, notified, rule_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
    [instance, account, ev.externalMessageId, from, ev.sender.name ?? null, subject.slice(0, 300), ev.content.replace(/\s+/g, ' ').slice(0, 300),
      ev.receivedAt, action, !!notify, ruleId, detail],
  );
  if (!inserted) return { delete: false, process: false, forceReply: false }; // ja visto
  if (hit.length) await q(`UPDATE app.email_rules SET hits = hits + 1 WHERE id = ANY($1)`, [hit.map((r) => r.id)]);
  if (notify) {
    const who = ev.sender.name ? `${ev.sender.name} <${from}>` : from;
    await notifyGabriel(`📧 E-mail para ${personaFor(instance).name} (${account})\nDe: ${who}\nAssunto: ${subject || '(sem assunto)'}\n${ev.content.replace(/\s+/g, ' ').slice(0, 280)}`, instance)
      .catch((e) => logger.warn({ err: String(e) }, 'aviso de e-mail nao enviado'));
  }
  if (del) return { delete: true, process: false, forceReply: false };
  if (ignore || (skip && !reply)) return { delete: false, process: false, forceReply: false };
  return { delete: false, process: true, forceReply: !!reply };
}

/** Liga o e-mail registrado a conversa criada (para abrir pelo painel) e, se a regra manda, libera a IA nela. */
export async function linkEmailThread(ev: InboundEvent, forceReply: boolean) {
  const t = await one<{ id: string }>(`SELECT id FROM app.threads WHERE channel = 'GMAIL' AND instance = $1 AND external_id = $2`, [ev.instance, ev.externalThreadId]);
  if (!t) return;
  await q(`UPDATE app.emails SET thread_id = $2 WHERE message_id = $1`, [ev.externalMessageId, t.id]);
  if (forceReply) await q(`UPDATE app.threads SET ai_enabled = true WHERE id = $1`, [t.id]);
}
