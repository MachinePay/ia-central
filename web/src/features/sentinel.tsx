import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ExternalLink, Play, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, del, patch, post } from '../lib/api';
import { dateTime, incidentCode, ms, phone, timeAgo } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, Card, Chip, cx, EmptyState, ErrorState, Field, inputCls, PageHeader, Pill, Section, SidePanel, Skeleton, StatusBadge, Tab } from '../ui';
import { TimeChart } from '../ui/Chart';

const SOURCE_LABEL: Record<string, string> = { RENDER: 'Render', VERCEL: 'Vercel', URL: 'Site', SELF: 'Sistema', COST: 'Custos' };

export function Sentinel() {
  const s = useSearch({ strict: false }) as { aba?: string; incidente?: number; novo?: number; status?: string };
  const navigate = useNavigate();
  const tab = s.incidente ? 'incidentes' : s.aba ?? 'incidentes';
  const go = (search: Record<string, unknown>) => navigate({ to: '/sentinela', search: search as any });
  const incidents = useQuery({ queryKey: ['incidents', s.status ?? 'ACTIVE'], queryFn: () => api(`/api/sentinela/incidents?status=${s.status ?? 'ACTIVE'}`) });
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Sentinela" accent="var(--ok)" tabs={<>
        <Tab active={tab === 'incidentes'} onClick={() => go({ aba: 'incidentes' })} count={s.status ? undefined : incidents.data?.length}>Incidentes</Tab>
        <Tab active={tab === 'servicos'} onClick={() => go({ aba: 'servicos' })}>Serviços</Tab>
        <Tab active={tab === 'monitores'} onClick={() => go({ aba: 'monitores' })}>Sites vigiados</Tab>
        <Tab active={tab === 'contatos'} onClick={() => go({ aba: 'contatos' })}>Quem recebe alertas</Tab>
      </>} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'incidentes' && <Incidents q={incidents} selected={s.incidente} status={s.status} go={go} />}
        {tab === 'servicos' && <Services />}
        {tab === 'monitores' && <Monitors startNew={!!s.novo} />}
        {tab === 'contatos' && <Contacts />}
      </div>
    </div>
  );
}

function Incidents({ q, selected, status, go }: { q: any; selected?: number; status?: string; go: (s: Record<string, unknown>) => void }) {
  return (
    <div className={cx('grid h-full', selected ? 'grid-cols-1 lg:grid-cols-[1fr_minmax(420px,40%)]' : 'grid-cols-1')}>
      <div className="min-h-0 overflow-y-auto">
        <div className="flex gap-1.5 border-b border-line px-5 py-2">
          {[['ACTIVE', 'Abertos'], ['RESOLVED', 'Resolvidos'], ['ALL', 'Todos']].map(([v, l]) => (
            <Chip key={v} label={l} active={(status ?? 'ACTIVE') === v} onClick={() => go({ aba: 'incidentes', status: v === 'ACTIVE' ? undefined : v })} />
          ))}
        </div>
        {q.isLoading ? <Skeleton /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : q.data.length === 0 ? (
          <EmptyState title="Nenhum incidente aberto." text="Quando algo quebrar na Render, na Vercel, nos sites ou nos WhatsApps, ele aparece aqui e no seu WhatsApp." />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.map((i: any) => (
              <li key={i.id}>
                <button onClick={() => go({ aba: 'incidentes', incidente: i.id, status })} className={cx('flex w-full cursor-pointer items-start gap-3 px-5 py-3 text-left', selected === i.id ? 'bg-line' : 'hover:bg-line/40')}>
                  <StatusBadge status={i.status === 'RESOLVED' ? 'RESOLVED' : i.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold"><span className="tabular text-text-2">{incidentCode(i.id)}</span> {i.title}</p>
                    <p className="truncate text-[13px] text-text-2">{i.diagnosis?.summary ?? i.detail}</p>
                  </div>
                  <div className="shrink-0 text-right text-[12px] text-text-2">
                    <Pill>{SOURCE_LABEL[i.source] ?? i.source}</Pill>
                    <p className="mt-1">{timeAgo(i.opened_at)}</p>
                    {i.status === 'ACKNOWLEDGED' && <p className="text-warn">reconhecido</p>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected && <IncidentPanel id={selected} onClose={() => go({ aba: 'incidentes', status })} />}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = { OPENED: 'Aberto', UPDATED: 'Atualizado', NOTIFIED: 'Aviso enviado', ACKED: 'Reconhecido', ESCALATED: 'Escalado', RESOLVED: 'Resolvido', DIAGNOSIS: 'Diagnóstico da IA', COMMAND: 'Comando' };

function IncidentPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['incident', id], queryFn: () => api(`/api/sentinela/incidents/${id}`) });
  const [cause, setCause] = useState('');
  const act = useMutation({
    mutationFn: (p: { path: string; body?: unknown }) => post(p.path, p.body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['incident'] }); void qc.invalidateQueries({ queryKey: ['incidents'] }); void qc.invalidateQueries({ queryKey: ['summary'] }); },
    onError: toastError,
  });
  const chart = useMemo(() => {
    const obs = (q.data?.observations ?? []).filter((o: any) => o.value != null);
    if (obs.length < 2) return null;
    return { x: obs.map((o: any) => Math.floor(new Date(o.observed_at).getTime() / 1000)), series: [{ label: 'Tempo de resposta (ms)', values: obs.map((o: any) => o.value) }] };
  }, [q.data]);
  if (q.isLoading) return <aside className="border-l border-line"><Skeleton /></aside>;
  if (q.error) return <ErrorState error={q.error} />;
  const inc = q.data.incident;
  const d = inc.diagnosis;
  return (
    <SidePanel onClose={onClose} title={<><span className="tabular text-text-2">{incidentCode(inc.id)}</span> {inc.title}</>}>
      <Section title="Situação">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={inc.status === 'RESOLVED' ? 'RESOLVED' : inc.severity} /><Pill>{SOURCE_LABEL[inc.source]}</Pill><span className="text-[12px] text-text-2">aberto {dateTime(inc.opened_at)} · {inc.hits} ocorrência(s)</span></div>
        {inc.detail && <p className="mt-2">{inc.detail}</p>}
        {inc.status !== 'RESOLVED' && (
          <div className="mt-3 flex flex-wrap gap-2">
            {inc.status === 'OPEN' && <Button variant="primary" size="sm" onClick={() => act.mutate({ path: `/api/sentinela/incidents/${id}/ack` })}>Reconhecer</Button>}
            <input className={cx(inputCls, 'h-7! flex-1 text-[12px]')} placeholder="Causa (opcional, ajuda nos próximos diagnósticos)" value={cause} onChange={(e) => setCause(e.target.value)} />
            <Button size="sm" onClick={() => act.mutate({ path: `/api/sentinela/incidents/${id}/resolve`, body: { rootCause: cause || undefined } })}>Marcar resolvido</Button>
          </div>
        )}
      </Section>
      {d && (
        <Section title="Diagnóstico da IA">
          <p className="max-w-[75ch]">{d.summary}</p>
          {d.probable_cause && <p className="mt-2 text-[13px]"><span className="text-text-2">Causa provável:</span> {d.probable_cause}</p>}
          {d.evidence?.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-text-2">{d.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
          {d.suggested_actions?.length > 0 && <p className="mt-2 text-[13px]"><span className="text-text-2">Sugestões:</span> {d.suggested_actions.map((a: any) => `${a.action.toLowerCase()} (${a.reason})`).join('; ')}</p>}
          <p className="mt-1 text-[12px] text-text-2">Confiança: {d.confidence === 'HIGH' ? 'alta' : d.confidence === 'MEDIUM' ? 'média' : 'baixa'}. A IA explica; quem decide é você.</p>
        </Section>
      )}
      {chart && <Section title="Antes e depois"><TimeChart x={chart.x} series={chart.series} height={160} label="Tempo de resposta em volta do incidente" /></Section>}
      <Section title="Linha do tempo">
        <ol className="space-y-2 border-l border-line pl-3 text-[13px]">
          {q.data.events.map((e: any) => (
            <li key={e.id}><span className="font-semibold">{EVENT_LABEL[e.type] ?? e.type}</span> <span className="text-text-2">· {dateTime(e.created_at)}</span>
              {e.payload?.by && <span className="text-text-2"> · por {e.payload.by}</span>}{e.payload?.to && <span className="text-text-2"> · para {e.payload.to} contato(s)</span>}
            </li>
          ))}
        </ol>
      </Section>
    </SidePanel>
  );
}

function Services() {
  const q = useQuery({ queryKey: ['resources'], queryFn: () => api('/api/sentinela/resources') });
  const [showSuspended, setShowSuspended] = useState(false);
  const [src, setSrc] = useState('');
  if (q.isLoading) return <Skeleton />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const rows = (q.data as any[]).filter((r) => (showSuspended || r.status !== 'SUSPENDED') && (!src || r.source === src));
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-wrap gap-1.5 border-b border-line px-5 py-2">
        {['', 'RENDER', 'VERCEL', 'SELF'].map((v) => <Chip key={v} label={v ? SOURCE_LABEL[v] : 'Todos'} active={src === v} onClick={() => setSrc(v)} />)}
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-text-2"><input type="checkbox" checked={showSuspended} onChange={(e) => setShowSuspended(e.target.checked)} /> mostrar suspensos</label>
      </div>
      {rows.length === 0 ? <EmptyState title="Nenhum serviço ainda." text="O Sentinela lê a Render a cada 2 min e a Vercel a cada 3 min." /> : (
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-bg text-left text-[12px] text-text-2"><tr><th className="px-5 py-2 font-semibold">Serviço</th><th className="font-semibold">Estado</th><th className="font-semibold">Último deploy</th><th className="font-semibold">Plano</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const dep = r.meta.lastDeploy ?? r.meta.production;
              return (
                <tr key={r.id} className="border-t border-line hover:bg-line/30">
                  <td className="px-5 py-2"><span className="font-semibold">{r.name}</span> <span className="text-text-2">· {SOURCE_LABEL[r.source]} {r.kind}</span></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="text-text-2">{dep ? `${dep.status ?? dep.state ?? ''} · ${dep.commitId ?? dep.commitSha ?? ''} ${(dep.commit ?? '').split('\n')[0].slice(0, 50)}` : r.meta.state ?? '—'}</td>
                  <td className="text-text-2">{r.meta.plan ?? ''}</td>
                  <td className="pr-5 text-right">{(r.meta.dashboardUrl || r.url) && <a href={r.meta.dashboardUrl ?? r.url} target="_blank" rel="noreferrer" className="inline-flex text-cyan" aria-label="Abrir no provedor"><ExternalLink size={14} /></a>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Monitors({ startNew }: { startNew: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['monitors'], queryFn: () => api('/api/sentinela/monitors'), refetchInterval: 60_000 });
  const uptime = useQuery({ queryKey: ['uptime'], queryFn: () => api('/api/sentinela/uptime'), refetchInterval: 120_000 });
  const [adding, setAdding] = useState(startNew);
  const [selected, setSelected] = useState<any | null>(null);
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/sentinela/monitors/${id}`), onSuccess: () => { toast('Site removido.'); void qc.invalidateQueries({ queryKey: ['monitors'] }); setSelected(null); } });
  const toggle = useMutation({ mutationFn: (m: any) => patch(`/api/sentinela/monitors/${m.id}`, { enabled: !m.enabled }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['monitors'] }) });
  const up = Object.fromEntries(((uptime.data ?? []) as any[]).map((u) => [u.resource_id, u]));
  return (
    <div className={cx('grid h-full', selected ? 'grid-cols-1 lg:grid-cols-[1fr_minmax(420px,40%)]' : 'grid-cols-1')}>
      <div className="min-h-0 overflow-y-auto p-5">
        <div className="mb-3 flex"><Button variant="primary" className="ml-auto" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Vigiar um site</Button></div>
        {adding && <MonitorForm onClose={() => setAdding(false)} />}
        {q.isLoading ? <Skeleton /> : (q.data as any[]).length === 0 ? (
          <EmptyState title="Nenhum site vigiado." text="Cadastre os sites e APIs que não podem cair. Também dá pelo WhatsApp: /monitor add https://seusite.com" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(q.data as any[]).map((m) => {
              const u = up[`url:${m.id}`];
              const sslDays = m.ssl_expires_at ? Math.floor((new Date(m.ssl_expires_at).getTime() - Date.now()) / 86_400_000) : null;
              return (
                <Card key={m.id} className={cx('cursor-pointer p-4 hover:border-cyan/50', !m.enabled && 'opacity-60', selected?.id === m.id && 'border-cyan')}>
                  <button className="w-full cursor-pointer text-left" onClick={() => setSelected(m)}>
                    <div className="flex items-center gap-2"><StatusBadge status={m.enabled ? m.last_status : 'SUSPENDED'} label={m.enabled ? undefined : 'Pausado'} /><span className="truncate font-semibold">{m.name}</span></div>
                    <p className="truncate text-[12px] text-text-2">{m.url}</p>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                      <div><p className="text-text-2">24 h</p><p className="tabular font-semibold">{u?.d1 != null ? `${u.d1}%` : '—'}</p></div>
                      <div><p className="text-text-2">Resposta</p><p className="tabular font-semibold">{ms(m.last_latency_ms)}</p></div>
                      <div><p className="text-text-2">SSL</p><p className={cx('tabular font-semibold', sslDays !== null && sslDays < 14 && 'text-warn')}>{sslDays !== null ? `${sslDays} d` : '—'}</p></div>
                    </div>
                    <p className="mt-2 text-[12px] text-text-2">checado {timeAgo(m.last_checked_at)}{m.silenced_until && new Date(m.silenced_until) > new Date() ? ' · silenciado' : ''}</p>
                  </button>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      {selected && (
        <SidePanel title={selected.name} onClose={() => setSelected(null)} actions={<>
          <Button size="sm" onClick={() => toggle.mutate(selected)}>{selected.enabled ? 'Pausar' : 'Reativar'}</Button>
          <Button size="sm" variant="danger" aria-label="Remover" onClick={() => confirm(`Parar de vigiar ${selected.name}?`) && remove.mutate(selected.id)}><Trash2 size={14} /></Button>
        </>}>
          <MonitorDetail m={selected} />
        </SidePanel>
      )}
    </div>
  );
}

function MonitorDetail({ m }: { m: any }) {
  const series = useQuery({ queryKey: ['series', m.id], queryFn: () => api(`/api/sentinela/series?resource=url:${m.id}&hours=24`) });
  const chart = useMemo(() => {
    const rows = (series.data ?? []) as any[];
    if (rows.length < 2) return null;
    return { x: rows.map((r) => Number(r.t)), series: [{ label: 'Resposta (ms)', values: rows.map((r) => (r.status === 'FAIL' ? null : r.value)) }, { label: 'Limite', values: rows.map(() => m.max_latency_ms), color: '#F2B33D', dash: true }] };
  }, [series.data, m.max_latency_ms]);
  return (
    <>
      <Section title="Últimas 24 h">{chart ? <TimeChart x={chart.x} series={chart.series} label="Tempo de resposta nas últimas 24 horas" /> : <p className="text-text-2">Os dados aparecem depois de algumas checagens.</p>}</Section>
      <Section title="Regras">
        <dl className="space-y-1 text-[13px]">
          <div className="flex"><dt className="text-text-2">Endereço</dt><dd className="ml-auto truncate pl-4">{m.url}</dd></div>
          <div className="flex"><dt className="text-text-2">Status esperado</dt><dd className="ml-auto">{m.expect_status.join(', ')}</dd></div>
          <div className="flex"><dt className="text-text-2">Limite de resposta</dt><dd className="ml-auto">{ms(m.max_latency_ms)}</dd></div>
          <div className="flex"><dt className="text-text-2">Deve conter</dt><dd className="ml-auto">{m.must_contain.join(', ') || '—'}</dd></div>
          <div className="flex"><dt className="text-text-2">Não pode conter</dt><dd className="ml-auto">{m.must_not_contain.join(', ') || '—'}</dd></div>
          <div className="flex"><dt className="text-text-2">Alerta depois de</dt><dd className="ml-auto">{m.failures_to_alert} falhas seguidas</dd></div>
          <div className="flex"><dt className="text-text-2">Intervalo</dt><dd className="ml-auto">{m.interval_sec / 60} min</dd></div>
        </dl>
      </Section>
    </>
  );
}

function MonitorForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', url: 'https://', max_latency_ms: 5000, must_contain: '', must_not_contain: '', failures_to_alert: 3, interval_sec: 60 });
  const [test, setTest] = useState<any>(null);
  const runTest = useMutation({ mutationFn: () => post('/api/sentinela/check', { url: f.url }), onSuccess: setTest, onError: toastError });
  const save = useMutation({
    mutationFn: () => post('/api/sentinela/monitors', {
      name: f.name || new URL(f.url).hostname, url: f.url, max_latency_ms: Number(f.max_latency_ms), failures_to_alert: Number(f.failures_to_alert), interval_sec: Number(f.interval_sec),
      must_contain: f.must_contain.split(';').map((s) => s.trim()).filter(Boolean), must_not_contain: f.must_not_contain.split(';').map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: () => { toast('Vigiando a cada minuto.'); void qc.invalidateQueries({ queryKey: ['monitors'] }); onClose(); },
    onError: toastError,
  });
  return (
    <Card className="mb-4 space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Endereço"><input className={inputCls} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} autoFocus /></Field>
        <Field label="Nome"><input className={inputCls} value={f.name} placeholder="ex.: Checkout Padaria Central" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Deve conter (separe com ;)"><input className={inputCls} value={f.must_contain} placeholder="Adicionar ao carrinho" onChange={(e) => setF({ ...f, must_contain: e.target.value })} /></Field>
        <Field label="Não pode conter (separe com ;)"><input className={inputCls} value={f.must_not_contain} placeholder="Internal Server Error" onChange={(e) => setF({ ...f, must_not_contain: e.target.value })} /></Field>
        <Field label="Limite de resposta (ms)"><input type="number" className={inputCls} value={f.max_latency_ms} onChange={(e) => setF({ ...f, max_latency_ms: +e.target.value })} /></Field>
        <Field label="Avisar depois de quantas falhas seguidas"><input type="number" min={1} className={inputCls} value={f.failures_to_alert} onChange={(e) => setF({ ...f, failures_to_alert: +e.target.value })} /></Field>
      </div>
      {test && <p className={cx('text-[13px]', test.status === 'OK' ? 'text-ok' : 'text-crit')}>Teste: {test.status === 'OK' ? `ok · ${test.httpStatus} · ${ms(test.latencyMs)}${test.title ? ` · "${test.title}"` : ''}` : test.problems.join('; ')}</p>}
      <p className="text-[12px] text-text-2">Serviços grátis da Render dormem sem acesso; checar a cada minuto mantém o serviço acordado e consome as horas grátis.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon={<Play size={14} />} busy={runTest.isPending} onClick={() => runTest.mutate()}>Testar agora</Button>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>Começar a vigiar</Button>
      </div>
    </Card>
  );
}

function Contacts() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alert-contacts'], queryFn: () => api('/api/sentinela/contacts') });
  const [f, setF] = useState({ name: '', phone: '', role: 'ENGINEER', min_severity: 'WARNING', quiet_start: '', quiet_end: '' });
  const add = useMutation({
    mutationFn: () => post('/api/sentinela/contacts', { ...f, quiet_start: f.quiet_start || null, quiet_end: f.quiet_end || null }),
    onSuccess: (r: any) => { toast(r.note); setF({ ...f, name: '', phone: '' }); void qc.invalidateQueries({ queryKey: ['alert-contacts'] }); },
    onError: toastError,
  });
  const upd = useMutation({ mutationFn: ({ id, body }: { id: string; body: any }) => patch(`/api/sentinela/contacts/${id}`, body), onSuccess: () => void qc.invalidateQueries({ queryKey: ['alert-contacts'] }), onError: toastError });
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/sentinela/contacts/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['alert-contacts'] }) });
  return (
    <div className="mx-auto h-full max-w-[960px] overflow-y-auto p-5">
      <Card className="mb-4 p-4">
        <p className="mb-3 font-semibold">Cadastrar número</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Nome"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="WhatsApp (com DDD)"><input className={inputCls} value={f.phone} placeholder="11 99999-9999" onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Papel"><select className={inputCls} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="OWNER">Dono (tudo)</option><option value="ENGINEER">Engenharia</option><option value="FINANCE">Financeiro (custos)</option>
          </select></Field>
          <Field label="A partir de"><select className={inputCls} value={f.min_severity} onChange={(e) => setF({ ...f, min_severity: e.target.value })}><option value="WARNING">Avisos</option><option value="CRITICAL">Só crítico</option></select></Field>
          <Field label="Silêncio das"><input type="time" className={inputCls} value={f.quiet_start} onChange={(e) => setF({ ...f, quiet_start: e.target.value })} /></Field>
          <Field label="até"><input type="time" className={inputCls} value={f.quiet_end} onChange={(e) => setF({ ...f, quiet_end: e.target.value })} /></Field>
        </div>
        <p className="mt-2 text-[12px] text-text-2">O número recebe um código de 6 dígitos e só passa a receber alertas depois de responder. Crítico ignora o horário de silêncio.</p>
        <div className="mt-3 flex justify-end"><Button variant="primary" busy={add.isPending} disabled={!f.name || f.phone.replace(/\D/g, '').length < 10} onClick={() => add.mutate()}>Cadastrar e mandar código</Button></div>
      </Card>
      {q.isLoading ? <Skeleton /> : (
        <Card className="divide-y divide-line">
          {(q.data as any[]).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><p className="font-semibold">{c.name} <span className="text-text-2">· {phone(c.phone)}</span></p>
                <p className="text-[12px] text-text-2">{c.role} · a partir de {c.min_severity === 'CRITICAL' ? 'crítico' : 'aviso'}{c.quiet_start ? ` · silêncio ${c.quiet_start}–${c.quiet_end}` : ''}</p></div>
              {c.verified_at ? <Pill tone="ok">confirmado</Pill> : <Pill tone="amber">esperando código</Pill>}
              <label className="flex items-center gap-1.5 text-[12px]"><input type="checkbox" checked={c.active} onChange={(e) => upd.mutate({ id: c.id, body: { active: e.target.checked } })} /> ativo</label>
              <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => confirm(`Remover ${c.name}?`) && remove.mutate(c.id)}><Trash2 size={14} /></Button>
            </div>
          ))}
        </Card>
      )}
      <p className="mt-3 text-[12px] text-text-2">Comandos pelo WhatsApp: /status · /custos · /incidentes · ok 42 · detalhes 42 · /silenciar &lt;site&gt; 30 · /monitor add &lt;url&gt; · /check &lt;url&gt;</p>
    </div>
  );
}
