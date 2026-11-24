import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MessageSquare, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, post, put, patch } from '../lib/api';
import { phone, timeAgo } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, Card, cx, EmptyState, ErrorState, inputCls, Pill, Skeleton } from '../ui';

type Rule = { reply: 'all' | 'selected'; auto: boolean };
type NumberInfo = {
  instance: string; role: string; state: string; persona: { name: string; about: string }; rule: Rule;
  profile: string; profileAt: string | null; styleMessages: number;
  contacts: { total: number; marked: number; auto: number; active: number; msgs: number };
};
type Row = {
  id: string; ai_enabled: boolean; ai_auto: boolean; contact: string; phone: string | null; role: string;
  has_treatment: boolean; last_at: string | null; messages: number; with_you: boolean;
};

const ROLES: Record<string, { l: string; d: string; tone: 'cyan' | 'amber' | 'default' | 'ok' }> = {
  GABRIEL: { l: 'Pessoa', d: 'A IA fala como a pessoa deste número.', tone: 'cyan' },
  ATENDIMENTO: { l: 'Atendimento', d: 'João e Clara atendem como a pessoa deste número.', tone: 'ok' },
  OBSERVAR: { l: 'Só aprendendo', d: 'Guarda e aprende as conversas, mas não responde ninguém.', tone: 'amber' },
  OFF: { l: 'Desligado', d: 'Ignorado pelo sistema.', tone: 'default' },
};

export function Numbers() {
  const q = useQuery<NumberInfo[]>({ queryKey: ['numbers'], queryFn: () => api('/api/numbers') });
  const list = (q.data ?? []).filter((n) => n.role !== 'CENTRAL');
  const [sel, setSel] = useState<string>('');
  useEffect(() => { if (!sel && list.length) setSel(list[0].instance); }, [list, sel]);
  if (q.isLoading) return <Skeleton />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!list.length) return <EmptyState title="Nenhum número ligado" text="Conecte um número em Ajustes." />;
  const cur = list.find((n) => n.instance === sel) ?? list[0];
  return (
    <div className="grid gap-4 p-5 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2">
        {list.map((n) => (
          <button key={n.instance} onClick={() => setSel(n.instance)}
            className={cx('glass w-full cursor-pointer p-3 text-left transition', n.instance === cur.instance ? 'ring-2 ring-cyan/60' : 'opacity-80 hover:opacity-100')}>
            <div className="flex items-center gap-2">
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-cyan/15 text-[15px] font-semibold text-cyan">{n.persona.name[0]}</span>
              <div className="min-w-0">
                <p className="truncate font-semibold">{n.persona.name}</p>
                <p className="truncate text-[12px] text-text-2">número {n.instance} · {n.persona.about || '—'}</p>
              </div>
              <span title={n.state === 'open' ? 'conectado' : n.state} className={cx('ml-auto size-2 shrink-0 rounded-full', n.state === 'open' ? 'bg-ok' : 'bg-crit')} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <Pill tone={ROLES[n.role]?.tone ?? 'default'}>{ROLES[n.role]?.l ?? n.role}</Pill>
              <Pill>{n.rule.reply === 'all' ? 'responde todos' : `${n.contacts.marked} marcados`}</Pill>
              <Pill tone={n.rule.auto ? 'coral' : 'default'}>{n.rule.auto ? 'manda sozinha' : 'rascunho'}</Pill>
            </div>
          </button>
        ))}
      </div>
      <Detail key={cur.instance} n={cur} />
    </div>
  );
}

function Detail({ n }: { n: NumberInfo }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings'), staleTime: 60_000 });
  const saveRule = useMutation({
    mutationFn: (r: Rule) => put(`/api/numbers/${n.instance}/rule`, r),
    onSuccess: () => { toast('Regra salva.'); void qc.invalidateQueries({ queryKey: ['numbers'] }); },
    onError: toastError,
  });
  const saveRole = useMutation({
    mutationFn: (role: string) => {
      const roles: Array<{ name: string; role: string }> = settings.data?.instances ?? [];
      const v = roles.map((i) => `${i.name}:${i.name === n.instance ? role : i.role}`).join(',');
      return put('/api/settings', { WA_INSTANCES: v });
    },
    onSuccess: () => { toast('Papel do número salvo.'); void qc.invalidateQueries({ queryKey: ['numbers'] }); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: toastError,
  });
  const learning = n.role === 'OBSERVAR' || n.role === 'OFF';
  return (
    <div className="min-w-0 space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <span className="inline-flex size-12 items-center justify-center rounded-full bg-cyan/15 text-[20px] font-semibold text-cyan">{n.persona.name[0]}</span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[20px] font-semibold">{n.persona.name}</h2>
            <p className="text-[13px] text-text-2">Número <b>{n.instance}</b> · {n.persona.about || 'sem descrição'} · {n.state === 'open' ? 'conectado' : `WhatsApp: ${n.state}`}</p>
            <p className="mt-1 text-[12px] text-text-2">A IA deste número escreve como {n.persona.name}, aprendendo só com as mensagens deste número.</p>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            <Mini label="Contatos" v={n.contacts.total} />
            <Mini label="Marcados" v={n.contacts.marked} />
            <Mini label="Respostas 7 dias" v={n.contacts.msgs} />
          </div>
        </div>
      </Card>

      <Card className="grid gap-4 p-4 md:grid-cols-3">
        <Choice title="O que este número faz" value={n.role} busy={saveRole.isPending}
          options={['GABRIEL', 'ATENDIMENTO', 'OBSERVAR'].map((r) => ({ v: r, l: ROLES[r].l, d: ROLES[r].d }))}
          onChange={(v) => saveRole.mutate(v)} />
        <Choice title="A IA responde para" value={n.rule.reply} busy={saveRule.isPending} disabled={learning}
          options={[{ v: 'selected', l: 'Só os marcados', d: 'Só quem estiver com a caixinha marcada abaixo.' }, { v: 'all', l: 'Todos os contatos', d: 'Qualquer pessoa que mandar mensagem.' }]}
          onChange={(v) => saveRule.mutate({ ...n.rule, reply: v as Rule['reply'] })} />
        <Choice title="Quando a IA responde" value={n.rule.auto ? 'auto' : 'draft'} busy={saveRule.isPending} disabled={learning}
          options={[{ v: 'draft', l: 'Rascunho para mim', d: 'Chega para você aprovar antes (exceto contatos marcados "sozinha").' }, { v: 'auto', l: 'Manda sozinha', d: 'Para todos que ela responder neste número.' }]}
          onChange={(v) => saveRule.mutate({ ...n.rule, auto: v === 'auto' })} />
        {learning && <p className="text-[12px] text-amber md:col-span-3">Este número está só aprendendo: a IA não responde ninguém. As caixinhas já ficam valendo quando você mudar o papel para Pessoa ou Atendimento.</p>}
      </Card>

      <Contacts n={n} />

      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="font-semibold">Jeito de escrever</h3>
          <span className="text-[12px] text-text-2">{n.styleMessages} mensagens deste número · {n.profileAt ? `atualizado ${timeAgo(n.profileAt)}` : 'ainda não gerado'}</span>
          <Link to="/" className="ml-auto text-[12px] text-cyan hover:underline">Editar no Início</Link>
        </div>
        <p className="max-h-56 overflow-y-auto text-[13px] whitespace-pre-wrap text-text-2">{n.profile || 'Ainda não há mensagens suficientes deste número para montar o jeito de escrever (mínimo 15, com 3 contatos).'}</p>
      </Card>
    </div>
  );
}

function Contacts({ n }: { n: NumberInfo }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'' | 'marked' | 'unmarked' | 'personal'>('');
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const key = ['number-contacts', n.instance, search, show];
  const q = useQuery<{ items: Row[] }>({
    queryKey: key,
    queryFn: () => api(`/api/numbers/${n.instance}/contacts?${new URLSearchParams({ ...(search && { q: search }), ...(show && { show }) })}`),
  });
  const items = q.data?.items ?? [];
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['number-contacts', n.instance] }); void qc.invalidateQueries({ queryKey: ['numbers'] }); };
  const toggle = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { enabled?: boolean; auto?: boolean } }) => patch<{ ai_enabled: boolean; ai_auto: boolean }>(`/api/threads/${id}/ai`, body),
    onMutate: ({ id, body }) => {
      qc.setQueryData<{ items: Row[] }>(key, (d) => d && {
        ...d,
        items: d.items.map((r) => r.id !== id ? r : {
          ...r,
          ai_enabled: body.auto ? true : body.enabled ?? r.ai_enabled,
          ai_auto: body.enabled === false ? false : body.auto ?? r.ai_auto,
        }),
      });
    },
    onError: (e) => { toastError(e); refresh(); },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['numbers'] }),
  });
  const bulk = useMutation({
    mutationFn: (enabled: boolean) => post<{ changed: number }>(`/api/numbers/${n.instance}/contacts/bulk`, { enabled, ...(search || show ? { ids: items.map((r) => r.id) } : {}) }),
    onSuccess: (r, enabled) => { toast(`${r.changed} contato(s) ${enabled ? 'marcados' : 'desmarcados'}.`); refresh(); },
    onError: toastError,
  });
  const release = useMutation({
    mutationFn: (id: string) => post<{ answering: boolean }>(`/api/threads/${id}/release`, {}),
    onSuccess: (r) => { toast(r.answering ? 'A IA assumiu e já vai responder.' : 'A IA assumiu a conversa.'); refresh(); },
    onError: toastError,
  });
  const marked = useMemo(() => items.filter((r) => r.ai_enabled).length, [items]);
  const scope = search || show ? 'da lista' : 'todos';
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">Contatos deste número</h3>
        <span className="text-[12px] text-text-2">{marked} de {items.length} marcados</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" busy={bulk.isPending} onClick={() => { if (confirm(`Marcar ${scope} (${items.length}) para a IA responder?`)) bulk.mutate(true); }}>Marcar {scope}</Button>
          <Button size="sm" busy={bulk.isPending} onClick={() => { if (confirm(`Desmarcar ${scope} (${items.length})?`)) bulk.mutate(false); }}>Desmarcar {scope}</Button>
        </div>
      </div>
      {n.rule.reply === 'all' && <p className="mb-3 rounded-[6px] bg-cyan/10 px-3 py-2 text-[12px] text-cyan">Este número responde todos os contatos. As caixinhas "IA responde" passam a valer se você trocar para "Só os marcados". "Sozinha" vale sempre.</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-text-2" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar nome ou telefone" className={cx(inputCls, 'pl-8')} />
        </div>
        {([['', 'Todos'], ['marked', 'Marcados'], ['unmarked', 'Não marcados'], ['personal', 'Pessoais']] as const).map(([v, l]) => (
          <button key={v} onClick={() => setShow(v)} className={cx('h-8 cursor-pointer rounded-[6px] border px-2.5 text-[12px] font-semibold', show === v ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-line text-text-2')}>{l}</button>
        ))}
      </div>
      {q.isLoading ? <Skeleton /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !items.length ? (
        <EmptyState title="Nenhum contato" text={search ? 'Nada com essa busca.' : 'Ainda não há conversas neste número.'} />
      ) : (
        <div className="max-h-[520px] overflow-y-auto rounded-[8px] border border-line">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface text-left text-[12px] text-text-2">
              <tr><th className="px-3 py-2">Contato</th><th className="px-3 py-2 text-center">IA responde</th><th className="px-3 py-2 text-center">Sozinha</th><th className="hidden px-3 py-2 md:table-cell">Última mensagem</th><th /></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={cx('border-t border-line', r.ai_enabled && 'bg-cyan/5')}>
                  <td className="px-3 py-2">
                    <p className="flex items-center gap-2 font-semibold">{r.contact}{r.with_you && <Pill tone="amber" title="Você falou com ele há pouco: a IA fica quieta 30 min">com você</Pill>}</p>
                    <p className="text-[12px] text-text-2">{phone(r.phone)}{r.role === 'PESSOAL' ? ' · pessoal' : ''}{r.has_treatment ? ' · jeito com ele aprendido' : ''}</p>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" aria-label={`IA responde ${r.contact}`} className="size-4 cursor-pointer accent-cyan" checked={r.ai_enabled}
                      onChange={(e) => toggle.mutate({ id: r.id, body: { enabled: e.target.checked } })} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" aria-label={`IA manda sozinha para ${r.contact}`} className="size-4 cursor-pointer accent-coral" checked={r.ai_auto}
                      onChange={(e) => toggle.mutate({ id: r.id, body: { auto: e.target.checked } })} />
                  </td>
                  <td className="hidden px-3 py-2 text-[12px] text-text-2 md:table-cell">{r.last_at ? timeAgo(r.last_at) : '—'} · {r.messages} msgs</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{r.with_you && <button onClick={() => release.mutate(r.id)} className="mr-3 cursor-pointer text-[12px] font-semibold text-cyan hover:underline">IA assume</button>}<Link to="/conversas/$id" params={{ id: r.id } as any} className="text-text-2 hover:text-cyan" aria-label="Abrir conversa"><MessageSquare size={15} /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[12px] text-text-2">"IA responde": a IA deste número pode falar com o contato. "Sozinha": a resposta sai direto, sem rascunho para você. Quando você mesmo fala com o contato, a IA fica quieta 30 min ("com você"); "IA assume" devolve na hora.</p>
    </Card>
  );
}

function Mini({ label, v }: { label: string; v: number }) {
  return <div><p className="tabular text-[22px] font-semibold leading-none">{v}</p><p className="mt-1 text-[11px] text-text-2">{label}</p></div>;
}

function Choice({ title, value, options, onChange, busy, disabled }: {
  title: string; value: string; options: Array<{ v: string; l: string; d: string }>; onChange: (v: string) => void; busy?: boolean; disabled?: boolean;
}) {
  return (
    <div className={cx(disabled && 'opacity-50')}>
      <p className="mb-2 text-[12px] font-semibold text-text-2">{title}</p>
      <div className="space-y-1.5">
        {options.map((o) => (
          <button key={o.v} disabled={busy || disabled || o.v === value} onClick={() => onChange(o.v)}
            className={cx('w-full rounded-[8px] border px-3 py-2 text-left transition', o.v === value ? 'border-cyan/60 bg-cyan/10' : 'cursor-pointer border-line hover:border-text-2/50')}>
            <p className={cx('text-[13px] font-semibold', o.v === value && 'text-cyan')}>{o.l}</p>
            <p className="text-[11px] text-text-2">{o.d}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
