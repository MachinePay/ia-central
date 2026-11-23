import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, del, patch, post } from '../lib/api';
import { AGENTS, ms, timeAgo, usd, type AgentKey } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { AgentAvatar, Button, Card, cx, EmptyState, ErrorState, Field, inputCls, PageHeader, Pill, Skeleton, Tab } from '../ui';

const KINDS = ['faq', 'procedimento', 'politica', 'produto', 'estilo', 'contato', 'manual'];

export function Agents() {
  const s = useSearch({ strict: false }) as { aba?: string; q?: string };
  const navigate = useNavigate();
  const tab = s.aba ?? 'metricas';
  const setTab = (aba: string) => navigate({ to: '/agentes', search: { aba } as any });
  const gaps = useQuery({ queryKey: ['gaps'], queryFn: () => api('/api/knowledge/gaps') });
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="IAs" accent="var(--lilac)" tabs={<>
        <Tab active={tab === 'metricas'} onClick={() => setTab('metricas')}>Desempenho</Tab>
        <Tab active={tab === 'base'} onClick={() => setTab('base')}>Base de conhecimento</Tab>
        <Tab active={tab === 'perguntas'} onClick={() => setTab('perguntas')} count={gaps.data?.length}>Perguntas sem resposta</Tab>
        <Tab active={tab === 'empresas'} onClick={() => setTab('empresas')}>Empresas</Tab>
      </>} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'metricas' && <Metrics />}
        {tab === 'base' && <Knowledge initialQ={s.q} />}
        {tab === 'perguntas' && <Gaps q={gaps} />}
        {tab === 'empresas' && <Companies />}
      </div>
    </div>
  );
}

function Metrics() {
  const q = useQuery({ queryKey: ['agents'], queryFn: () => api('/api/agents') });
  if (q.isLoading) return <Skeleton />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const stats = Object.fromEntries((q.data.stats as any[]).map((x) => [x.agent, x]));
  const active = Object.fromEntries((q.data.active as any[]).map((x) => [x.agent, x.n]));
  return (
    <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-4">
      {(['LEO', 'JOAO', 'CLARA', 'GABRIEL'] as AgentKey[]).map((a) => {
        const x = stats[a] ?? {};
        const rows: Array<[string, string]> = [
          ['Conversas ativas (24 h)', String(active[a] ?? 0)],
          ['Execuções hoje / 7 dias', `${x.runs_today ?? 0} / ${x.runs ?? 0}`],
          ['Rascunhos', String(x.drafts ?? 0)], ['Enviadas', String(x.sent ?? 0)],
          ['Aprovações pedidas', String(x.approvals ?? 0)], ['Passou para outro', String(x.handoffs ?? 0)],
          ['Em silêncio (regra)', String(x.silent ?? 0)], ['Erros', String(x.errors ?? 0)],
          ['Tempo médio', ms(x.avg_latency_ms)], ['Custo hoje / 7 dias', `${usd(x.cost_today ?? 0)} / ${usd(x.cost_usd ?? 0)}`],
        ];
        return (
          <Card key={a} className="p-4">
            <div className="mb-3 flex items-center gap-2"><AgentAvatar agent={a} size={32} /><div><p className="font-semibold">{AGENTS[a].name}</p><p className="text-[12px] text-text-2">{AGENTS[a].role}</p></div></div>
            <dl className="space-y-1.5 text-[13px]">
              {rows.map(([k, v]) => <div key={k} className="flex"><dt className="text-text-2">{k}</dt><dd className={cx('tabular ml-auto font-semibold', k === 'Erros' && v !== '0' && 'text-crit')}>{v}</dd></div>)}
            </dl>
          </Card>
        );
      })}
      <p className="text-[12px] text-text-2 md:col-span-2 xl:col-span-4">O editor de prompts com versões e testes vem na próxima etapa. Por enquanto, os prompts ficam em src/agents/prompts no repositório.</p>
    </div>
  );
}

function Knowledge({ initialQ }: { initialQ?: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(initialQ ?? '');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [instance, setInstance] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const list = useQuery({
    queryKey: ['knowledge', q, kind, source, instance],
    queryFn: () => api(`/api/knowledge?${new URLSearchParams({ ...(q && { q }), ...(kind && { kind }), ...(source && { source }), ...(instance && { instance }) })}`),
  });
  const numbers = useNumbers();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api('/api/companies') });
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/knowledge/${id}`), onSuccess: () => { toast('Removido da base.'); void qc.invalidateQueries({ queryKey: ['knowledge'] }); }, onError: toastError });
  return (
    <div className="p-5">
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={cx(inputCls, 'w-64!')} placeholder="Buscar na base…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={cx(inputCls, 'w-auto!')} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo"><option value="">Todos os tipos</option>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        <select className={cx(inputCls, 'w-auto!')} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Origem">
          <option value="">Todas as origens</option><option value="aprendido">Aprendido com a equipe</option><option value="legado">Sistema antigo</option><option value="painel">Escrito no painel</option>
        </select>
        <select className={cx(inputCls, 'w-auto!')} value={instance} onChange={(e) => setInstance(e.target.value)} aria-label="Número">
          <option value="">Todos os números</option>{numbers.map((n) => <option key={n} value={n}>Número {n}</option>)}<option value="*">Vale para todos</option>
        </select>
        <Button variant="primary" className="ml-auto" icon={<Plus size={14} />} onClick={() => setEditing({ title: '', content: '', kind: 'faq', company_slug: null })}>Novo conhecimento</Button>
      </div>
      {editing && <KnowledgeForm item={editing} companies={companies.data ?? []} numbers={numbers} onClose={() => setEditing(null)} />}
      {list.isLoading ? <Skeleton /> : list.error ? <ErrorState error={list.error} /> : list.data.length === 0 ? (
        <EmptyState title="Nada na base com esses filtros." text="A Clara só responde com o que estiver aqui. O aprendiz adiciona sozinho o que a equipe ensina nas conversas." />
      ) : (
        <Card className="divide-y divide-line">
          {list.data.map((k: any) => (
            <div key={k.id} className="flex gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold">{k.title}</span><Pill tone="coral">{k.instance ? `número ${k.instance}` : 'todos os números'}</Pill><Pill>{k.kind}</Pill>{k.company_slug && <Pill tone="cyan">{k.company_slug}</Pill>}
                  <Pill tone={k.source.startsWith('aprendido') ? 'ok' : 'default'}>{k.source.startsWith('aprendido') ? 'aprendido' : k.source.startsWith('legado') ? 'sistema antigo' : 'painel'}</Pill>
                  {!k.indexed && <Pill tone="amber" title="Ainda sem índice de busca por significado; a busca por palavra já funciona">indexando</Pill>}
                </div>
                <p className="mt-1 line-clamp-3 text-[13px] whitespace-pre-wrap text-text-2">{k.content}</p>
              </div>
              <div className="flex shrink-0 items-start gap-1">
                <span className="mr-2 text-[12px] text-text-2">{timeAgo(k.updated_at)}</span>
                <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing(k)}><Pencil size={14} /></Button>
                <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => confirm(`Remover "${k.title}" da base?`) && remove.mutate(k.id)}><Trash2 size={14} /></Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function KnowledgeForm({ item, companies, numbers, onClose }: { item: any; companies: any[]; numbers: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(item);
  const save = useMutation({
    mutationFn: () => (item.id ? patch(`/api/knowledge/${item.id}`, { title: f.title, content: f.content, kind: f.kind, company_slug: f.company_slug || null, instance: f.instance || null })
      : post('/api/knowledge', { title: f.title, content: f.content, kind: f.kind, company_slug: f.company_slug || null, instance: f.instance || null })),
    onSuccess: () => { toast('Salvo na base.'); void qc.invalidateQueries({ queryKey: ['knowledge'] }); onClose(); },
    onError: toastError,
  });
  return (
    <Card className="mb-4 space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_150px_150px_160px]">
        <Field label="Título"><input className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <Field label="Tipo"><select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Empresa"><select className={inputCls} value={f.company_slug ?? ''} onChange={(e) => setF({ ...f, company_slug: e.target.value })}><option value="">Todas</option>{companies.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select></Field>
        <Field label="Número"><select className={inputCls} value={f.instance ?? ''} onChange={(e) => setF({ ...f, instance: e.target.value })}><option value="">Todos os números</option>{numbers.map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
      </div>
      <Field label="Conteúdo" hint="Escreva como explicaria para alguém novo na equipe. Preços ficam no catálogo, não aqui.">
        <textarea className={cx(inputCls, 'h-32! py-2!')} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
      </Field>
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>Salvar</Button></div>
    </Card>
  );
}

/** Numeros de WhatsApp ativos (para separar o que cada IA sabe). */
function useNumbers(): string[] {
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings'), staleTime: 60_000 });
  return (s.data?.instances ?? []).filter((i: any) => i.role !== 'OFF').map((i: any) => i.name);
}

function Gaps({ q }: { q: any }) {
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const answer = useMutation({ mutationFn: (id: number) => post(`/api/knowledge/gaps/${id}/answer`, { answer: answers[id] }), onSuccess: () => { toast('Respondido: virou conhecimento da base.'); void qc.invalidateQueries({ queryKey: ['gaps'] }); }, onError: toastError });
  const dismiss = useMutation({ mutationFn: (id: number) => post(`/api/knowledge/gaps/${id}/dismiss`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['gaps'] }) });
  if (q.isLoading) return <Skeleton />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data.length) return <EmptyState title="Nenhuma pergunta sem resposta." text="Quando a IA não souber responder algo, a pergunta aparece aqui. Responda uma vez e ela passa a saber." />;
  return (
    <div className="mx-auto max-w-[880px] space-y-3 p-5">
      {q.data.map((g: any) => (
        <Card key={g.id} className="p-4">
          <p className="font-semibold">{g.question}</p>
          <p className="text-[12px] text-text-2">{g.company_slug ?? 'empresa não identificada'} · {g.contact ?? ''} · {timeAgo(g.created_at)}</p>
          <textarea className={cx(inputCls, 'mt-2 h-20! py-2!')} placeholder="Resposta que a IA deve usar daqui para frente…" value={answers[g.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [g.id]: e.target.value })} />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(g.id)}>Ignorar</Button>
            <Button variant="primary" size="sm" disabled={!answers[g.id]?.trim()} onClick={() => answer.mutate(g.id)}>Responder e ensinar</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Companies() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['companies'], queryFn: () => api('/api/companies') });
  const save = useMutation({ mutationFn: ({ slug, body }: { slug: string; body: any }) => patch(`/api/companies/${slug}`, body), onSuccess: () => { toast('Empresa salva.'); void qc.invalidateQueries({ queryKey: ['companies'] }); }, onError: toastError });
  if (q.isLoading) return <Skeleton />;
  return (
    <div className="mx-auto max-w-[880px] space-y-3 p-5">
      <p className="text-text-2">A IA usa a descrição e os sinais para saber de qual empresa é cada conversa. Escreva o que cada uma vende e para quem.</p>
      {q.data.map((c: any) => <CompanyCard key={c.slug} c={c} onSave={(body) => save.mutate({ slug: c.slug, body })} />)}
    </div>
  );
}
function CompanyCard({ c, onSave }: { c: any; onSave: (b: any) => void }) {
  const [f, setF] = useState({ name: c.name, description: c.description, topics: c.topics, site: c.site ?? '' });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Nome"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Site"><input className={inputCls} value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })} /></Field>
      </div>
      <Field label="O que vende e para quem">
        <textarea className={cx(inputCls, 'h-20! py-2!', /REVISAR/.test(f.description) && 'border-amber')} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <Field label="Sinais de que a conversa é desta empresa" hint="Produtos, termos e assuntos que os clientes usam."><input className={inputCls} value={f.topics} onChange={(e) => setF({ ...f, topics: e.target.value })} /></Field>
      <div className="flex justify-end"><Button variant="primary" onClick={() => onSave({ ...f, site: f.site || null })}>Salvar {c.name}</Button></div>
    </Card>
  );
}
