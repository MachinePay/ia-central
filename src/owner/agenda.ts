import { one, q } from '../lib/db.js';
import { env, instanceRoles, personaFor } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { notifyGabriel } from '../delivery.js';

/**
 * Agenda de cada IA (numero): compromissos com dia e hora, tarefas (sem data ficam pendentes e aparecem no resumo)
 * e anotacoes. Lembretes por padrao 1 dia e 1 hora antes; a pessoa pode pedir outros.
 */
export type AgendaKind = 'evento' | 'tarefa' | 'nota';
export type AgendaItem = {
  id: number; instance: string; kind: AgendaKind; title: string; notes: string | null; due_at: Date | null; all_day: boolean;
  remind_minutes: number[]; reminded: number[]; done_at: Date | null; created_at: Date;
};
export const DEFAULT_REMINDERS = [1440, 60];

/** Diferenca (minutos) entre o fuso configurado e UTC numa data. */
function tzOffsetMinutes(at: Date, tz = env.TIMEZONE): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "2026-11-25T14:30" (hora local) -> Date. Sem hora = dia inteiro (09:00 para os lembretes). */
export function parseLocal(input: string): { at: Date; allDay: boolean } | undefined {
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return undefined;
  const allDay = !m[4];
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], allDay ? 9 : +m[4], allDay ? 0 : +m[5]);
  const at = new Date(guess - tzOffsetMinutes(new Date(guess)) * 60_000);
  return Number.isNaN(at.getTime()) ? undefined : { at, allDay };
}

export function fmtWhen(d: Date | null, allDay = false): string {
  if (!d) return 'sem data';
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone: env.TIMEZONE, weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(d));
  if (allDay) return day;
  const hour = new Intl.DateTimeFormat('pt-BR', { timeZone: env.TIMEZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  return `${day} às ${hour}`;
}

const fmtBefore = (min: number) => (min === 0 ? 'na hora' : min % 1440 === 0 ? `${min / 1440} dia(s) antes` : min % 60 === 0 ? `${min / 60} h antes` : `${min} min antes`);
export const remindersText = (r: number[]) => (r.length ? r.slice().sort((a, b) => b - a).map(fmtBefore).join(', ') : 'sem lembrete');

/** Aceita o nome da pessoa ("Léo") ou do numero ("nucleo"); sem nada, usa o padrao. */
export function resolveInstance(ia: string | undefined, fallback: string): string {
  if (!ia) return fallback;
  const x = ia.trim().toLowerCase();
  for (const [name, role] of instanceRoles()) {
    if (role === 'OFF') continue;
    if (name.toLowerCase() === x || personaFor(name).name.toLowerCase() === x) return name;
  }
  return fallback;
}

export async function addItem(o: { instance: string; kind: AgendaKind; title: string; notes?: string; when?: string; reminders?: number[]; via?: string }): Promise<AgendaItem> {
  const when = o.when ? parseLocal(o.when) : undefined;
  const kind: AgendaKind = o.kind === 'evento' && !when ? 'tarefa' : o.kind; // sem dia e hora vira tarefa pendente
  const reminders = (o.reminders?.length ? o.reminders : DEFAULT_REMINDERS).filter((n) => Number.isFinite(n) && n >= 0).map((n) => Math.round(n));
  return (await one<AgendaItem>(
    `INSERT INTO app.agenda (instance, kind, title, notes, due_at, all_day, remind_minutes, created_via) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [o.instance, kind, o.title.slice(0, 300), o.notes ?? null, when?.at ?? null, when?.allDay ?? false, kind === 'nota' ? [] : reminders, o.via ?? null],
  ))!;
}

export async function updateItem(id: number, o: { title?: string; notes?: string | null; when?: string | null; reminders?: number[]; done?: boolean; kind?: AgendaKind; instance?: string }) {
  const sets: string[] = []; const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (o.title !== undefined) set('title', o.title);
  if (o.notes !== undefined) set('notes', o.notes);
  if (o.kind !== undefined) set('kind', o.kind);
  if (o.instance !== undefined) set('instance', o.instance);
  if (o.when !== undefined) {
    const w = o.when ? parseLocal(o.when) : undefined;
    set('due_at', w?.at ?? null); set('all_day', w?.allDay ?? false); set('reminded', []);
  }
  if (o.reminders !== undefined) { set('remind_minutes', o.reminders); set('reminded', []); }
  if (o.done !== undefined) set('done_at', o.done ? new Date() : null);
  if (!sets.length) return one<AgendaItem>(`SELECT * FROM app.agenda WHERE id = $1`, [id]);
  return one<AgendaItem>(`UPDATE app.agenda SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
}

export const removeItem = (id: number) => q(`DELETE FROM app.agenda WHERE id = $1`, [id]);

export async function listItems(o: { instance?: string; from?: Date; to?: Date; includeDone?: boolean; kind?: AgendaKind }) {
  const where: string[] = []; const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('$?', `$${vals.length}`)); };
  if (o.instance) add('instance = $?', o.instance);
  if (o.kind) add('kind = $?', o.kind);
  if (!o.includeDone) where.push('done_at IS NULL');
  if (o.from) add('(due_at IS NULL OR due_at >= $?)', o.from);
  if (o.to) add('(due_at IS NULL OR due_at <= $?)', o.to);
  return q<AgendaItem>(`SELECT * FROM app.agenda ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY due_at NULLS LAST, created_at LIMIT 300`, vals);
}

export const itemLine = (i: AgendaItem) =>
  `#${i.id} ${i.kind === 'evento' ? '' : i.kind === 'tarefa' ? '[tarefa] ' : '[nota] '}${i.title}${i.due_at ? ` · ${fmtWhen(i.due_at, i.all_day)}` : ''}${i.done_at ? ' (feito)' : ''}`;

/** Roda a cada minuto: manda os lembretes que chegaram na hora (no "Voce" do numero, ou pela IA central). */
export async function sendDueReminders() {
  const due = await q<AgendaItem>(
    `SELECT * FROM app.agenda WHERE done_at IS NULL AND due_at IS NOT NULL AND kind <> 'nota'
        AND due_at > now() - interval '2 hours'
        AND EXISTS (SELECT 1 FROM unnest(remind_minutes) m WHERE NOT (m = ANY(reminded)) AND now() >= due_at - make_interval(mins => m))`,
  );
  for (const i of due) {
    const pending = i.remind_minutes.filter((m) => !i.reminded.includes(m) && Date.now() >= new Date(i.due_at!).getTime() - m * 60_000);
    if (!pending.length) continue;
    const mins = Math.max(0, Math.round((new Date(i.due_at!).getTime() - Date.now()) / 60_000));
    const quando = mins <= 1 ? 'agora' : mins < 60 ? `em ${mins} min` : mins < 1440 ? `em ${Math.round(mins / 60)} h` : 'amanhã';
    const text = `Lembrete (${personaFor(i.instance).name}): ${i.title}, ${quando} (${fmtWhen(i.due_at, i.all_day)}).${i.notes ? `\n${i.notes}` : ''}`;
    try {
      await notifyGabriel(text, i.instance);
      // marca todos os que ja passaram (nao manda o de 1 dia e o de 1 h juntos se o item foi criado em cima da hora)
      await q(`UPDATE app.agenda SET reminded = array(SELECT DISTINCT unnest(reminded || $2::int[])) WHERE id = $1`, [i.id, pending]);
    } catch (e) {
      logger.warn({ err: String(e), id: i.id }, 'lembrete nao enviado');
    }
  }
}
