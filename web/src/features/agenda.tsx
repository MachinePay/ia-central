import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, ChevronLeft, ChevronRight, ListTodo, NotebookPen, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, del, patch, post } from '../lib/api';
import { toast, toastError } from '../lib/toast';
import { Button, Card, cx, EmptyState, inputCls, PageHeader, Pill, Skeleton, Tab } from '../ui';

type Kind = 'evento' | 'tarefa' | 'nota';
type Item = { id: number; instance: string; kind: Kind; title: string; notes: string | null; due_at: string | null; all_day: boolean; remind_minutes: number[]; done_at: string | null };
type Num = { instance: string; role: string; persona: { name: string } };

const REMINDERS: Array<[number, string]> = [[10080, '1 semana'], [1440, '1 dia'], [180, '3 h'], [60, '1 h'], [30, '30 min'], [15, '15 min'], [0, 'na hora']];
const KIND_L: Record<Kind, string> = { evento: 'Compromisso', tarefa: 'Tarefa', nota: 'Anotação' };
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function Agenda() {
  const nums = useQuery<Num[]>({ queryKey: ['numbers'], queryFn: () => api('/api/numbers') });
  const ias = (nums.data ?? []).filter((n) => n.role !== 'CENTRAL');
  const [ia, setIa] = useState<string>(() => { try { return localStorage.getItem('cc.agenda.ia') ?? ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem('cc.agenda.ia', ia); } catch { /* ok */ } }, [ia]);
  const [tab, setTab] = useState<'calendario' | 'tarefas' | 'notas'>('calendario');
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [editing, setEditing] = useState<Partial<Item> & { date?: string; time?: string } | null>(null);
  const name = (inst: string) => ias.find((n) => n.instance === inst)?.persona.name ?? inst;

  const items = useQuery<Item[]>({ queryKey: ['agenda', ia], queryFn: () => api(`/api/agenda?${new URLSearchParams({ ...(ia && { instance: ia }), done: '1' })}`), refetchInterval: 60_000 });
  const all = items.data ?? [];
  const open = all.filter((i) => !i.done_at);
  const events = open.filter((i) => i.due_at && i.kind !== 'nota');
  const tasks = all.filter((i) => i.kind === 'tarefa');
  const notes = all.filter((i) => i.kind === 'nota');
  const newItem = (kind: Kind, date?: string) => setEditing({ kind, instance: ia || ias.find((n) => n.instance === 'gabriel')?.instance || ias[0]?.instance, remind_minutes: [1440, 60], date, time: date ? '09:00' : '' });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Agenda" subtitle="Compromissos, tarefas e anotações de cada IA. Pelo WhatsApp é só falar: “me lembra amanhã às 15h de…”."
        tabs={<>
          <Tab active={tab === 'calendario'} onClick={() => setTab('calendario')}>Calendário</Tab>
          <Tab active={tab === 'tarefas'} onClick={() => setTab('tarefas')} count={open.filter((i) => i.kind === 'tarefa').length}>Tarefas</Tab>
          <Tab active={tab === 'notas'} onClick={() => setTab('notas')}>Anotações</Tab>
        </>}>
        <div className="glass flex gap-0.5 rounded-full! p-[3px]" role="group" aria-label="De qual IA">
          <button className="cc-chip" aria-pressed={!ia} onClick={() => setIa('')}>Todas</button>
          {ias.map((n) => <button key={n.instance} className="cc-chip" aria-pressed={ia === n.instance} onClick={() => setIa(n.instance)}>{n.persona.name}</button>)}
        </div>
        <Button variant="primary" onClick={() => newItem(tab === 'notas' ? 'nota' : tab === 'tarefas' ? 'tarefa' : 'evento')}>Novo</Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8">
        {items.isLoading ? <Skeleton /> : (
          <div className="mt-2 grid gap-4 xl:grid-cols-[1fr_340px]">
            <div className="min-w-0">
              {tab === 'calendario' && <Month month={month} setMonth={setMonth} events={events} name={name} showWho={!ia} onDay={(d) => newItem('evento', d)} onItem={(i) => setEditing(toForm(i))} />}
              {tab === 'tarefas' && <List items={tasks} empty="Nenhuma tarefa. Pelo WhatsApp: “tarefa: mandar a proposta pro Marcos”." name={name} showWho={!ia} onItem={(i) => setEditing(toForm(i))} />}
              {tab === 'notas' && <List items={notes} empty="Nenhuma anotação. Pelo WhatsApp: “anota que o cliente X prefere boleto”." name={name} showWho={!ia} onItem={(i) => setEditing(toForm(i))} />}
            </div>
            <div className="space-y-4">
              {editing && <Editor key={editing.id ?? 'novo'} value={editing} ias={ias} onClose={() => setEditing(null)} />}
              <Upcoming events={events} tasks={open.filter((i) => i.kind === 'tarefa' && !i.due_at)} name={name} showWho={!ia} onItem={(i) => setEditing(toForm(i))} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const toForm = (i: Item) => ({ ...i, date: i.due_at ? ymd(new Date(i.due_at)) : '', time: i.due_at && !i.all_day ? hm(new Date(i.due_at)) : '' });

function Month({ month, setMonth, events, name, showWho, onDay, onItem }: { month: Date; setMonth: (d: Date) => void; events: Item[]; name: (i: string) => string; showWho: boolean; onDay: (d: string) => void; onItem: (i: Item) => void }) {
  const days = useMemo(() => {
    const start = new Date(month); start.setDate(1 - start.getDay());
    return Array.from({ length: 42 }, (_, k) => { const d = new Date(start); d.setDate(start.getDate() + k); return d; });
  }, [month]);
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const e of events) { const k = ymd(new Date(e.due_at!)); m.set(k, [...(m.get(k) ?? []), e]); }
    return m;
  }, [events]);
  const today = ymd(new Date());
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="serif text-[28px] capitalize leading-none">{month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</h2>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" aria-label="Mês anterior" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></Button>
          <Button size="sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Hoje</Button>
          <Button size="sm" variant="ghost" aria-label="Próximo mês" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[12px]">
        {WEEK.map((w) => <div key={w} className="px-1.5 pb-1 text-text-2">{w}</div>)}
        {days.map((d) => {
          const k = ymd(d); const list = byDay.get(k) ?? []; const other = d.getMonth() !== month.getMonth();
          return (
            <div key={k} className={cx('min-h-[92px] cursor-pointer rounded-[10px] border p-1.5 transition hover:border-cyan/50', k === today ? 'border-cyan/70 bg-cyan/5' : 'border-line', other && 'opacity-40')}
              onClick={() => onDay(k)} role="button" aria-label={`Marcar em ${d.toLocaleDateString('pt-BR')}`}>
              <p className={cx('mb-1 text-[12px] font-semibold', k === today && 'text-cyan')}>{d.getDate()}</p>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((e) => (
                  <button key={e.id} onClick={(ev) => { ev.stopPropagation(); onItem(e); }} className="block w-full cursor-pointer truncate rounded-[6px] bg-cyan/15 px-1.5 py-0.5 text-left text-[11.5px] text-text hover:bg-cyan/25" title={e.title}>
                    {!e.all_day && <b className="mr-1 tabular">{hm(new Date(e.due_at!))}</b>}{e.title}{showWho && <span className="text-text-2"> · {name(e.instance)}</span>}
                  </button>
                ))}
                {list.length > 3 && <p className="px-1 text-[11px] text-text-2">+{list.length - 3}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function List({ items, empty, name, showWho, onItem }: { items: Item[]; empty: string; name: (i: string) => string; showWho: boolean; onItem: (i: Item) => void }) {
  const qc = useQueryClient();
  const done = useMutation({ mutationFn: (i: Item) => patch(`/api/agenda/${i.id}`, { done: !i.done_at }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['agenda'] }), onError: toastError });
  if (!items.length) return <EmptyState title="Nada por aqui" text={empty} />;
  const sorted = [...items].sort((a, b) => (+!!a.done_at - +!!b.done_at) || ((a.due_at ? +new Date(a.due_at) : Infinity) - (b.due_at ? +new Date(b.due_at) : Infinity)));
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {sorted.map((i) => (
        <div key={i.id} className={cx('flex items-start gap-3 px-4 py-3', i.done_at && 'opacity-50')}>
          {i.kind !== 'nota' && <input type="checkbox" className="mt-1 size-4 cursor-pointer accent-cyan" checked={!!i.done_at} onChange={() => done.mutate(i)} aria-label="Feito" />}
          <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => onItem(i)}>
            <p className={cx('font-semibold', i.done_at && 'line-through')}>{i.title}</p>
            {i.notes && <p className="text-[12.5px] whitespace-pre-wrap text-text-2">{i.notes}</p>}
            <p className="mt-1 flex flex-wrap gap-1">
              {i.due_at ? <Pill tone={!i.done_at && new Date(i.due_at) < new Date() ? 'crit' : 'cyan'}>{new Date(i.due_at).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', ...(i.all_day ? {} : { hour: '2-digit', minute: '2-digit' }) })}</Pill> : i.kind === 'tarefa' && <Pill tone="amber">sem data · entra no resumo</Pill>}
              {showWho && <Pill>{name(i.instance)}</Pill>}
            </p>
          </button>
          <span className="text-[11px] text-text-2">#{i.id}</span>
        </div>
      ))}
    </Card>
  );
}

function Upcoming({ events, tasks, name, showWho, onItem }: { events: Item[]; tasks: Item[]; name: (i: string) => string; showWho: boolean; onItem: (i: Item) => void }) {
  const now = Date.now();
  const next = events.filter((e) => +new Date(e.due_at!) >= now - 3_600_000).sort((a, b) => +new Date(a.due_at!) - +new Date(b.due_at!)).slice(0, 8);
  return (
    <Card className="p-4">
      <p className="mb-2 flex items-center gap-2 font-semibold"><CalendarDays size={16} />Próximos</p>
      {!next.length && <p className="text-[13px] text-text-2">Nada marcado.</p>}
      <ul className="space-y-1.5">
        {next.map((e) => (
          <li key={e.id}><button className="w-full cursor-pointer text-left text-[13px] hover:text-cyan" onClick={() => onItem(e)}>
            <b className="tabular">{new Date(e.due_at!).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', ...(e.all_day ? {} : { hour: '2-digit', minute: '2-digit' }) })}</b> · {e.title}{showWho && <span className="text-text-2"> · {name(e.instance)}</span>}
          </button></li>
        ))}
      </ul>
      <p className="mt-4 mb-2 flex items-center gap-2 font-semibold"><ListTodo size={16} />Tarefas sem data</p>
      {!tasks.length && <p className="text-[13px] text-text-2">Nenhuma.</p>}
      <ul className="space-y-1.5">{tasks.slice(0, 8).map((t) => <li key={t.id}><button className="w-full cursor-pointer text-left text-[13px] hover:text-cyan" onClick={() => onItem(t)}>{t.title}{showWho && <span className="text-text-2"> · {name(t.instance)}</span>}</button></li>)}</ul>
    </Card>
  );
}

function Editor({ value, ias, onClose }: { value: Partial<Item> & { date?: string; time?: string }; ias: Num[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(value);
  const when = f.kind === 'nota' || !f.date ? null : f.time ? `${f.date}T${f.time}` : f.date;
  const body = { instance: f.instance, kind: f.kind, title: f.title ?? '', notes: f.notes ?? null, when, reminders: f.remind_minutes ?? [] };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['agenda'] });
  const save = useMutation({
    mutationFn: () => (f.id ? patch(`/api/agenda/${f.id}`, body) : post('/api/agenda', body)),
    onSuccess: () => { toast(f.id ? 'Atualizado.' : f.kind === 'evento' && !when ? 'Sem data: virou tarefa pendente.' : 'Salvo na agenda.'); refresh(); onClose(); },
    onError: toastError,
  });
  const remove = useMutation({ mutationFn: () => del(`/api/agenda/${f.id}`), onSuccess: () => { toast('Apagado.'); refresh(); onClose(); }, onError: toastError });
  const toggleR = (m: number) => setF({ ...f, remind_minutes: (f.remind_minutes ?? []).includes(m) ? (f.remind_minutes ?? []).filter((x) => x !== m) : [...(f.remind_minutes ?? []), m] });
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <NotebookPen size={16} /><p className="font-semibold">{f.id ? `Editar #${f.id}` : 'Novo'}</p>
        <div className="ml-auto flex gap-0.5 rounded-full border border-line p-[2px]">
          {(Object.keys(KIND_L) as Kind[]).map((k) => <button key={k} className="cc-chip h-7! px-2.5! text-[12px]!" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{KIND_L[k]}</button>)}
        </div>
      </div>
      <input autoFocus className={inputCls} placeholder={f.kind === 'nota' ? 'O que anotar' : f.kind === 'tarefa' ? 'O que fazer' : 'Compromisso'} value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <textarea className={cx(inputCls, 'h-20! py-2!')} placeholder="Detalhes (opcional)" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      {f.kind !== 'nota' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[12px] text-text-2">Dia<input type="date" className={inputCls} value={f.date ?? ''} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
            <label className="text-[12px] text-text-2">Hora<input type="time" className={inputCls} value={f.time ?? ''} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
          </div>
          {!f.date && <p className="text-[12px] text-amber">Sem dia: fica como tarefa pendente e aparece no resumo das 8h e das 21h30.</p>}
          {f.date && (
            <div>
              <p className="mb-1 text-[12px] text-text-2">Avisar no WhatsApp</p>
              <div className="flex flex-wrap gap-1">
                {REMINDERS.map(([m, l]) => (
                  <button key={m} onClick={() => toggleR(m)} className={cx('cursor-pointer rounded-full border px-2.5 py-0.5 text-[12px]', (f.remind_minutes ?? []).includes(m) ? 'border-cyan/60 bg-cyan/15 text-text' : 'border-line text-text-2')}>{l} antes</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <label className="block text-[12px] text-text-2">Agenda de
        <select className={inputCls} value={f.instance} onChange={(e) => setF({ ...f, instance: e.target.value })}>{ias.map((n) => <option key={n.instance} value={n.instance}>{n.persona.name}</option>)}</select>
      </label>
      <div className="flex items-center gap-2">
        {f.id && <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => { if (confirm('Apagar este item?')) remove.mutate(); }}>Apagar</Button>}
        {f.id && f.kind !== 'nota' && <Button size="sm" variant="ghost" icon={<Check size={14} />} onClick={() => patch(`/api/agenda/${f.id}`, { done: !f.done_at }).then(() => { refresh(); onClose(); }).catch(toastError)}>{f.done_at ? 'Reabrir' : 'Feito'}</Button>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button size="sm" variant="primary" disabled={!f.title?.trim() || !f.instance} busy={save.isPending} onClick={() => save.mutate()}>Salvar</Button>
        </div>
      </div>
    </Card>
  );
}
