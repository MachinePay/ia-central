import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, CheckCircle2, FileText, Hand, ImageIcon, Mail, MessageCircle, Mic, Send, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, patch, post } from '../lib/api';
import { AGENTS, dateTime, ms, phone, timeAgo, usd, type AgentKey } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { AgentAvatar, Button, Chip, cx, EmptyState, ErrorState, inputCls, PageHeader, Pill, RefreshBar, Section, Skeleton, StatusBadge, Tab } from '../ui';

type Filters = { channel?: string; instance?: string; agent?: string; unanswered?: string; pending?: string; takeover?: string; q?: string; status?: string };
const VIEWS: Array<{ id: string; label: string; f: Filters }> = [
  { id: 'todas', label: 'Todas', f: {} },
  { id: 'sem-resposta', label: 'Sem resposta', f: { unanswered: '1' } },
  { id: 'aprovacao', label: 'Com aprovação', f: { pending: '1' } },
  { id: 'assumidas', label: 'Com a equipe', f: { takeover: '1' } },
];
const FILTER_LABEL: Record<string, string> = { channel: 'Canal', instance: 'Número', agent: 'Agente', unanswered: 'Sem resposta', pending: 'Aprovação pendente', takeover: 'Com a equipe', q: 'Busca', status: 'Status' };

export function Conversations() {
  const { id } = useParams({ strict: false }) as { id?: string };
  const search = useSearch({ strict: false }) as Filters;
  const navigate = useNavigate();
  const filters: Filters = Object.fromEntries(Object.entries(search).filter(([k, v]) => k in FILTER_LABEL && v !== undefined && v !== '')) as Filters;
  const qs = new URLSearchParams(filters as Record<string, string>).toString();
  const list = useInfiniteQuery({
    queryKey: ['threads', qs],
    queryFn: ({ pageParam }) => api(`/api/threads?${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last: any) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const items: any[] = useMemo(() => list.data?.pages.flatMap((p: any) => p.items) ?? [], [list.data]);
  const setFilters = (f: Filters) => navigate({ to: id ? '/conversas/$id' : '/conversas', params: id ? { id } : undefined, search: f as any });
  const open = (tid: string) => navigate({ to: '/conversas/$id', params: { id: tid }, search: filters as any });

  // J/K navega na lista
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select') || e.ctrlKey || e.metaKey) return;
      const i = items.findIndex((t) => t.id === id);
      if (e.key === 'j' && items[i + 1]) open(items[i + 1].id);
      if (e.key === 'k' && i > 0) open(items[i - 1].id);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const view = VIEWS.find((v) => JSON.stringify(v.f) === JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([k]) => k !== 'q' && k !== 'instance' && k !== 'agent' && k !== 'channel'))))?.id;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Conversas" accent="var(--cyan)"
        tabs={VIEWS.map((v) => <Tab key={v.id} active={view === v.id} onClick={() => setFilters({ ...v.f, ...(filters.q ? { q: filters.q } : {}) })}>{v.label}</Tab>)}>
        <input className={cx(inputCls, 'w-56!')} placeholder="Buscar nome, telefone, texto…" defaultValue={filters.q ?? ''}
          onKeyDown={(e) => { if (e.key === 'Enter') setFilters({ ...filters, q: (e.target as HTMLInputElement).value || undefined }); }} />
        <select className={cx(inputCls, 'w-auto!')} value={filters.agent ?? ''} onChange={(e) => setFilters({ ...filters, agent: e.target.value || undefined })} aria-label="Agente">
          <option value="">Todos os agentes</option>
          {(['LEO', 'JOAO', 'CLARA', 'GABRIEL'] as AgentKey[]).map((a) => <option key={a} value={a}>{AGENTS[a].name}</option>)}
        </select>
        <select className={cx(inputCls, 'w-auto!')} value={filters.channel ?? ''} onChange={(e) => setFilters({ ...filters, channel: e.target.value || undefined })} aria-label="Canal">
          <option value="">Todos os canais</option><option value="WHATSAPP">WhatsApp</option><option value="GMAIL">Gmail</option>
        </select>
      </PageHeader>
      {Object.keys(filters).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-2">
          {Object.entries(filters).map(([k, v]) => (
            <Chip key={k} label={`${FILTER_LABEL[k]}${v === '1' ? '' : `: ${k === 'agent' ? AGENTS[v as AgentKey]?.name ?? v : v}`}`} onRemove={() => setFilters({ ...filters, [k]: undefined })} />
          ))}
          {Object.keys(filters).length >= 2 && <Button variant="ghost" size="sm" onClick={() => setFilters({})}>Limpar tudo</Button>}
          <span className="ml-auto text-[12px] text-text-2 tabular">{items.length}{list.hasNextPage ? '+' : ''} conversas</span>
        </div>
      )}
      <div className={cx('grid min-h-0 flex-1', id ? 'grid-cols-1 lg:grid-cols-[320px_1fr] xl:grid-cols-[300px_1fr_300px] 2xl:grid-cols-[340px_1fr_340px]' : 'grid-cols-1')}>
        <div className={cx('min-h-0 overflow-y-auto border-r border-line', id && 'hidden lg:block')}>
          <RefreshBar active={list.isFetching && !list.isLoading} />
          {list.isLoading ? <Skeleton /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : items.length === 0 ? (
            <EmptyState title="Nenhuma conversa aqui." text={Object.keys(filters).length ? 'Os filtros zeraram o resultado.' : 'Quando um cliente escrever, a conversa aparece aqui.'}
              action={Object.keys(filters).length ? <Button size="sm" onClick={() => setFilters({})}>Remover filtros</Button> : undefined} />
          ) : (
            <ul>
              {items.map((t) => <InboxRow key={t.id} t={t} active={t.id === id} onClick={() => open(t.id)} />)}
              {list.hasNextPage && <li className="p-3"><Button size="sm" className="w-full" busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Carregar mais</Button></li>}
            </ul>
          )}
        </div>
        {id && <ThreadView key={id} id={id} back={() => navigate({ to: '/conversas', search: filters as any })} />}
      </div>
    </div>
  );
}

function InboxRow({ t, active, onClick }: { t: any; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button onClick={onClick} className={cx('flex w-full cursor-pointer gap-3 border-b border-line px-4 py-3 text-left', active ? 'bg-line' : 'hover:bg-line/40')}>
        <AgentAvatar agent={t.takeover ? 'HUMAN' : t.active_agent} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {t.channel === 'GMAIL' ? <Mail size={13} className="text-text-2" /> : <MessageCircle size={13} className="text-text-2" />}
            <span className={cx('truncate font-semibold', t.unanswered && 'text-text')}>{t.contact}</span>
            <span className="ml-auto shrink-0 text-[12px] text-text-2">{timeAgo(t.last_at)}</span>
          </div>
          <p className="truncate text-[13px] text-text-2">
            {t.last_direction === 'OUTBOUND' && <span>{t.last_status === 'DRAFT' ? '📝 ' : ''}{AGENTS[t.last_sender as AgentKey]?.name ?? ''}: </span>}{t.last_content}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Pill>{t.instance}</Pill>
            {t.unanswered && <Pill tone="cyan">sem resposta</Pill>}
            {t.pending > 0 && <Pill tone="amber">aprovação</Pill>}
            {t.takeover && <Pill tone="coral">com a equipe</Pill>}
            {t.tags?.includes('VIP') && <Pill tone="amber">VIP</Pill>}
          </div>
        </div>
      </button>
    </li>
  );
}

function ThreadView({ id, back }: { id: string; back: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['thread', id], queryFn: () => api(`/api/threads/${id}`), staleTime: 15_000 });
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['thread', id] }); void qc.invalidateQueries({ queryKey: ['threads'] }); };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body),
    onSuccess: (_d, v) => { refresh(); if (v.path.endsWith('/send')) setText(''); },
    onError: toastError,
  });
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [q.data?.messages?.length]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select') || e.ctrlKey || e.metaKey) return;
      if (e.key === 'a') act.mutate({ path: `/api/threads/${id}/takeover` });
      if (e.key === 'e') act.mutate({ path: `/api/threads/${id}/status`, body: { status: 'CLOSED' } });
      if (e.key === 'r') { e.preventDefault(); composerRef.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  if (q.isLoading) return <Skeleton lines={8} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const contactName = d.contact.name ?? phone(d.contact.phone) ?? d.contact.email;
  return (
    <>
      <section className="flex min-h-0 flex-col" aria-label="Conversa">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={back} aria-label="Voltar"><ArrowLeft size={16} /></Button>
          <AgentAvatar agent={d.takeover.on ? 'HUMAN' : d.thread.active_agent} size={30} />
          <div className="min-w-0">
            <p className="truncate font-semibold">{contactName}</p>
            <p className="text-[12px] text-text-2">{d.thread.channel === 'GMAIL' ? d.contact.email : phone(d.contact.phone)} · número {d.thread.instance} · {d.takeover.on ? 'com a equipe' : `atendido por ${AGENTS[d.thread.active_agent as AgentKey]?.name}`}</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {d.takeover.on ? (
              <>
                <Button size="sm" icon={<Undo2 size={14} />} onClick={() => act.mutate({ path: `/api/threads/${id}/release`, body: {} })}>Devolver para a IA</Button>
                <select className={cx(inputCls, 'h-7! w-auto! text-[12px]')} value="" onChange={(e) => e.target.value && act.mutate({ path: `/api/threads/${id}/release`, body: { agent: e.target.value } })} aria-label="Devolver para um agente">
                  <option value="">Devolver para…</option><option value="JOAO">João</option><option value="CLARA">Clara</option><option value="GABRIEL">Gabriel (IA)</option>
                </select>
              </>
            ) : (
              <Button size="sm" variant="primary" icon={<Hand size={14} />} title="Atalho: A" onClick={() => act.mutate({ path: `/api/threads/${id}/takeover` })}>Assumir</Button>
            )}
            <Button size="sm" variant="ghost" icon={<CheckCircle2 size={14} />} title="Atalho: E" onClick={() => act.mutate({ path: `/api/threads/${id}/status`, body: { status: d.thread.status === 'CLOSED' ? 'OPEN' : 'CLOSED' } })}>
              {d.thread.status === 'CLOSED' ? 'Reabrir' : 'Resolver'}
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-live="polite">
          {d.messages.map((m: any) => <Bubble key={m.id} m={m} threadId={id} onChanged={refresh} />)}
          <div ref={endRef} />
        </div>
        <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) act.mutate({ path: `/api/threads/${id}/send`, body: { text } }); }}>
          <textarea ref={composerRef} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escrever como você (sai na hora e a IA fica em silêncio por 2 h)… · atalho R"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
            className="min-h-[44px] flex-1 resize-y rounded-[6px] border border-line bg-bg px-3 py-2 text-[16px] focus:border-cyan focus:outline-none" />
          <Button variant="primary" type="submit" icon={<Send size={14} />} busy={act.isPending && act.variables?.path.endsWith('/send')}>Enviar</Button>
        </form>
      </section>
      <ContextPanel d={d} onChanged={refresh} />
    </>
  );
}

function Bubble({ m, threadId, onChanged }: { m: any; threadId: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const inbound = m.direction === 'INBOUND';
  const draft = m.status === 'DRAFT';
  const discarded = m.status === 'DRAFT_DISCARDED';
  const agent = AGENTS[m.sender as AgentKey];
  const send = useMutation({ mutationFn: (t?: string) => post(`/api/messages/${m.id}/send`, { text: t }), onSuccess: () => { toast('Enviado ao cliente.'); onChanged(); }, onError: toastError });
  const discard = useMutation({ mutationFn: () => post(`/api/messages/${m.id}/discard`), onSuccess: onChanged, onError: toastError });
  if (discarded) return null;
  const media = (m.media ?? []) as any[];
  return (
    <div className={cx('flex', inbound ? 'justify-start' : 'justify-end')}>
      <div className={cx('max-w-[75ch] rounded-[10px] border px-3 py-2',
        inbound ? 'border-line bg-surface' : draft ? 'border-dashed border-amber/60 bg-amber/5' : 'border-transparent',
      )} style={!inbound && !draft ? { background: `${agent?.color ?? '#5CC8D7'}18` } : undefined}>
        {!inbound && (
          <p className="mb-0.5 flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: agent?.color }}>
            {agent?.name ?? 'Sistema'}{draft && <Pill tone="amber">rascunho · o cliente não viu</Pill>}
          </p>
        )}
        {media.map((x, i) => (
          <p key={i} className="mb-1 flex items-start gap-1.5 text-[12px] text-text-2">
            {x.kind === 'audio' ? <Mic size={13} className="mt-0.5" /> : x.kind === 'image' ? <ImageIcon size={13} className="mt-0.5" /> : <FileText size={13} className="mt-0.5" />}
            {x.kind === 'audio' ? `Áudio${x.seconds ? ` de ${x.seconds} s` : ''}` : x.kind === 'image' ? 'Imagem' : x.fileName ?? 'Arquivo'}{x.description ? '' : ' (processando…)'}
          </p>
        ))}
        {editing ? (
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="w-full rounded-[6px] border border-line bg-bg p-2 text-[16px]" />
        ) : (
          <p className="text-[16px] leading-relaxed whitespace-pre-wrap">{m.content}</p>
        )}
        <p className="mt-1 text-right text-[11px] text-text-2">{dateTime(m.created_at)}{m.status === 'QUEUED' ? ' · enviando…' : m.status === 'FAILED' ? ' · falhou' : ''}</p>
        {draft && (
          <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            {editing ? (
              <><Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(m.content); }}>Cancelar</Button>
                <Button size="sm" variant="primary" busy={send.isPending} onClick={() => send.mutate(text)}>Enviar editado</Button></>
            ) : (
              <><Button size="sm" variant="ghost" busy={discard.isPending} onClick={() => discard.mutate()}>Descartar</Button>
                <Button size="sm" onClick={() => setEditing(true)}>Editar</Button>
                <Button size="sm" variant="primary" busy={send.isPending} onClick={() => send.mutate(undefined)}>Enviar ao cliente</Button></>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ContextPanel({ d, onChanged }: { d: any; onChanged: () => void }) {
  const c = d.contact;
  const [factsText, setFactsText] = useState(JSON.stringify(d.thread.facts ?? {}, null, 2));
  const [tag, setTag] = useState('');
  const saveContact = useMutation({ mutationFn: (body: any) => patch(`/api/contacts/${c.id}`, body), onSuccess: () => { toast('Contato atualizado.'); onChanged(); }, onError: toastError });
  const saveFacts = useMutation({
    mutationFn: () => patch(`/api/threads/${d.thread.id}/facts`, { facts: JSON.parse(factsText) }),
    onSuccess: () => { toast('Fatos salvos.'); onChanged(); },
    onError: (e) => toastError(e instanceof SyntaxError ? new Error('O JSON dos fatos tem um erro de formatação.') : e),
  });
  const promises = (d.thread.facts?.promessas ?? []) as any[];
  return (
    <aside className="hidden min-h-0 overflow-y-auto border-l border-line bg-surface xl:block" aria-label="Contexto">
      <Section title="Contato">
        <p className="text-[16px] font-semibold">{c.name ?? '—'}</p>
        <p className="text-text-2">{phone(c.phone)} {c.email}</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <select className={inputCls} value={c.role} onChange={(e) => saveContact.mutate({ role: e.target.value })} aria-label="Papel">
            {['CLIENTE', 'LEAD', 'FORNECEDOR', 'PARCEIRO', 'PESSOAL'].map((r) => <option key={r}>{r}</option>)}
          </select>
          <select className={inputCls} value={c.crm_stage} onChange={(e) => saveContact.mutate({ crm_stage: e.target.value })} aria-label="Estágio">
            {['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'CUSTOMER', 'LOST'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {(c.tags ?? []).map((t: string) => <Chip key={t} label={t} onRemove={() => saveContact.mutate({ tags: c.tags.filter((x: string) => x !== t) })} />)}
          <form onSubmit={(e) => { e.preventDefault(); if (tag.trim()) { saveContact.mutate({ tags: [...(c.tags ?? []), tag.trim().toUpperCase()] }); setTag(''); } }}>
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="+ tag (VIP, BOT…)" className={cx(inputCls, 'h-7! w-32! text-[12px]')} />
          </form>
        </div>
        {d.thread.instance && <p className="mt-2 text-[12px] text-text-2">Tag BOT: no seu número pessoal, a IA só fala com quem tem. Tag AUTO: a resposta sai sozinha para este contato (sem rascunho).</p>}
      </Section>
      <Section title="Resumo da conversa"><p className="text-[13px] whitespace-pre-wrap text-text-2">{d.thread.summary ?? 'Ainda sem resumo (é feito a cada 10 mensagens).'}</p></Section>
      {promises.length > 0 && (
        <Section title="Promessas">
          <ul className="space-y-1 text-[13px]">{promises.map((p, i) => <li key={i}>• {p.o_que} <span className="text-text-2">{p.prazo ? `até ${p.prazo}` : ''}</span></li>)}</ul>
        </Section>
      )}
      <Section title="Fatos (memória)" right={<Button size="sm" busy={saveFacts.isPending} onClick={() => saveFacts.mutate()}>Salvar</Button>}>
        <textarea value={factsText} onChange={(e) => setFactsText(e.target.value)} rows={8} spellCheck={false} className="w-full rounded-[6px] border border-line bg-bg p-2 font-mono text-[12px]" />
      </Section>
      {d.approvals.length > 0 && (
        <Section title="Aprovações">
          {d.approvals.map((a: any) => <p key={a.id} className="text-[13px]">{a.code} · {a.action} · <StatusBadge status={a.status === 'PENDING' ? 'WARN' : a.status === 'REJECTED' ? 'FAIL' : 'OK'} label={a.status.toLowerCase()} /></p>)}
          <Link to="/aprovacoes" className="text-[13px] text-cyan">Abrir aprovações</Link>
        </Section>
      )}
      {d.tickets.length > 0 && <Section title="Chamados">{d.tickets.map((t: any) => <p key={t.id} className="text-[13px]">{t.priority} · {t.category} · {t.summary.slice(0, 80)}</p>)}</Section>}
      {d.otherThreads.length > 0 && <Section title="Outros canais">{d.otherThreads.map((t: any) => <Link key={t.id} to="/conversas/$id" params={{ id: t.id }} className="block text-[13px] text-cyan">{t.channel} · {t.instance}</Link>)}</Section>}
      <Section title="Últimas decisões da IA">
        <ul className="space-y-1.5 text-[12px]">
          {d.runs.map((r: any) => (
            <li key={r.id} className="text-text-2">
              <span className="font-semibold text-text">{AGENTS[r.agent as AgentKey]?.name}</span> · {r.outcome.toLowerCase()} · {ms(r.latency_ms)} · {usd(r.cost_usd, 4)}
              <br />{r.route?.reason ?? ''}{r.route?.guard?.length ? ` · verificador: ${r.route.guard.join('; ')}` : ''}{r.error ? ` · erro: ${r.error}` : ''}
            </li>
          ))}
        </ul>
      </Section>
    </aside>
  );
}
