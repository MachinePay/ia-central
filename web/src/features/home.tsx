import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, CheckCheck, Clock, MessageSquareWarning, UserRound } from 'lucide-react';
import { useSummary } from '../app/shell';
import { api } from '../lib/api';
import { AGENTS, incidentCode, ms, timeAgo, usd, type AgentKey } from '../lib/format';
import { Card, cx, ErrorState, PageHeader, Pill, Skeleton, Stat, StatusBadge } from '../ui';

const EVENT_LABEL: Record<string, string> = {
  'message.created': 'Mensagem', 'approval.created': 'Aprovação pedida', 'approval.decided': 'Aprovação decidida',
  'incident.opened': 'Incidente aberto', 'incident.updated': 'Incidente atualizado', 'incident.resolved': 'Incidente resolvido',
  'resource.updated': 'Monitor mudou', 'cost.updated': 'Custos atualizados', 'thread.updated': 'Conversa atualizada',
};

export function Home() {
  const summary = useSummary();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api('/api/agents') });
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api('/api/sentinela/resources') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings'), staleTime: 60_000 });
  if (summary.isLoading) return <Skeleton lines={8} />;
  if (summary.error) return <ErrorState error={summary.error} retry={() => summary.refetch()} />;
  const s = summary.data;
  const n = s.needsYou;
  const items = [
    ...n.incidents.filter((i: any) => i.status === 'OPEN').map((i: any) => ({ key: `i${i.id}`, icon: <AlertTriangle size={16} className={i.severity === 'CRITICAL' ? 'text-crit' : 'text-warn'} />, text: `${incidentCode(i.id)} ${i.title}`, when: i.opened_at, to: '/sentinela', search: { incidente: i.id } })),
    ...n.approvals.map((a: any) => ({ key: `a${a.id}`, icon: <CheckCheck size={16} className="text-amber" />, text: `${a.code} · ${a.contact} pediu ${a.action.toLowerCase()}`, when: a.created_at, to: '/aprovacoes', search: {} })),
    ...n.unanswered.map((t: any) => ({ key: `t${t.id}`, icon: <MessageSquareWarning size={16} className="text-cyan" />, text: `${t.contact} sem resposta`, when: t.last_inbound_at, to: `/conversas/${t.id}`, search: {} })),
    ...n.promises.map((p: any, i: number) => ({ key: `p${i}`, icon: <Clock size={16} className="text-coral" />, text: `Promessa para ${p.contact}: ${p.what} (prazo ${p.due})`, when: null, to: `/conversas/${p.thread_id}`, search: {} })),
  ];
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Início" accent="var(--amber)">
        {n.takeovers > 0 && <Pill tone="coral"><UserRound size={12} />{n.takeovers} conversa(s) com a equipe</Pill>}
      </PageHeader>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[1fr_320px] xl:overflow-hidden">
        <div className="min-h-0 space-y-4 p-5 xl:overflow-y-auto">
          <section aria-label="Precisa de você">
            <h2 className="mb-2 text-[16px] font-semibold">Precisa de você {items.length > 0 && <span className="tabular text-amber">{items.length}</span>}</h2>
            {items.length === 0 ? (
              <Card className="p-4 text-text-2">Nada esperando por você agora. Aprovações, incidentes e conversas paradas aparecem aqui.</Card>
            ) : (
              <Card className="divide-y divide-line">
                {items.slice(0, 12).map((it) => (
                  <Link key={it.key} to={it.to} search={it.search as any} className="flex items-center gap-3 px-4 py-2.5 hover:bg-line/40">
                    {it.icon}<span className="min-w-0 flex-1 truncate">{it.text}</span><span className="text-[12px] text-text-2">{timeAgo(it.when)}</span>
                  </Link>
                ))}
              </Card>
            )}
          </section>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Conversas hoje" value={s.today.conversations ?? 0} hint={`${s.today.replies ?? 0} respostas/rascunhos da IA`} />
            <Stat label="Tempo médio da IA" value={ms(s.today.avg_latency_ms)} hint="da mensagem ao rascunho" />
            <Stat label="Incidentes hoje" value={s.today.incidents ?? 0} tone={s.today.incidents ? 'var(--warn)' : undefined} />
            <Stat label="Gasto de IA hoje" value={usd(s.today.costUsd)} />
          </div>
          <OperationMap agents={agents.data} resources={resources.data} instances={settings.data?.instances} incidents={n.incidents} />
        </div>
        <aside className="min-h-0 border-l border-line xl:overflow-y-auto" aria-label="Últimos eventos">
          <h2 className="sticky top-0 border-b border-line bg-bg px-4 py-3 text-[14px] font-semibold">Linha do tempo</h2>
          <ul aria-live="polite" className="divide-y divide-line">
            {s.timeline.length === 0 && <li className="p-4 text-text-2">Os eventos aparecem aqui em tempo real.</li>}
            {s.timeline.map((e: any) => (
              <li key={e.id} className="px-4 py-2 text-[13px]">
                <span className="font-semibold">{EVENT_LABEL[e.type] ?? e.type}</span>
                {e.data?.title && <span className="text-text-2"> · {e.data.title}</span>}
                {e.data?.sender && <span className="text-text-2"> · {AGENTS[e.data.sender as AgentKey]?.name ?? e.data.sender}</span>}
                <span className="block text-[12px] text-text-2">{timeAgo(e.at)}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

/**
 * Maquete 2D da operacao: portoes (WhatsApp), torres dos agentes e casa de maquinas (Render/Vercel/sites).
 * Clicar em qualquer peca leva aos dados reais. A cena 3D entra por cima desta base depois.
 */
function OperationMap({ agents, resources, instances, incidents }: { agents: any; resources: any[] | undefined; instances: any[] | undefined; incidents: any[] }) {
  const navigate = useNavigate();
  const active = Object.fromEntries((agents?.active ?? []).map((a: any) => [a.agent, a.n]));
  const res = (resources ?? []).filter((r) => r.status !== 'SUSPENDED');
  const bySource = (src: string) => ({
    ok: res.filter((r) => r.source === src && r.status === 'OK').length,
    fail: res.filter((r) => r.source === src && (r.status === 'FAIL' || r.status === 'WARN')).length,
    deploying: res.filter((r) => r.source === src && r.status === 'DEPLOYING').length,
  });
  const blocks = [
    { label: 'Render', ...bySource('RENDER') },
    { label: 'Vercel', ...bySource('VERCEL') },
    { label: 'Sistema', ...bySource('SELF') },
  ];
  const towers: AgentKey[] = ['LEO', 'JOAO', 'CLARA', 'GABRIEL'];
  const gates = (instances ?? []).filter((i) => i.role !== 'OFF');
  const crit = incidents.some((i) => i.severity === 'CRITICAL' && i.status !== 'RESOLVED');
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center border-b border-line px-4 py-2.5">
        <h2 className="text-[14px] font-semibold">Operação agora</h2>
        <span className="ml-auto text-[12px] text-text-2">mapa 2D · a visão 3D chega numa próxima etapa</span>
      </div>
      <svg viewBox="0 0 800 300" className="block w-full" role="img" aria-label="Mapa da operação">
        <defs>
          <radialGradient id="glow"><stop offset="0%" stopColor="var(--cyan)" stopOpacity=".35" /><stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" /></radialGradient>
        </defs>
        {/* portoes: numeros de WhatsApp */}
        {gates.map((g, i) => {
          const y = 60 + i * (180 / Math.max(1, gates.length - 1 || 1));
          const ok = g.state === 'open';
          return (
            <g key={g.name} className="cursor-pointer" onClick={() => navigate({ to: '/conversas', search: { instance: g.name } as any })}>
              <path d={`M110 ${y} C 220 ${y}, 240 150, 330 150`} fill="none" stroke="var(--line)" strokeWidth="2" strokeDasharray="4 6" />
              <rect x="20" y={y - 18} width="92" height="36" rx="6" fill="var(--surface)" stroke={ok ? 'var(--line)' : 'var(--crit)'} />
              <circle cx="34" cy={y} r="5" fill={ok ? 'var(--ok)' : 'var(--crit)'} className={ok ? '' : 'pulse-crit'} />
              <text x="44" y={y - 2} fill="var(--text)" fontSize="12" fontWeight="600">{g.name}</text>
              <text x="44" y={y + 12} fill="var(--text-2)" fontSize="10">{g.role.toLowerCase()}</text>
            </g>
          );
        })}
        {/* torres dos agentes */}
        {towers.map((a, i) => {
          const x = 350 + i * 62;
          const n = active[a] ?? 0;
          const h = 40 + Math.min(70, n * 8);
          return (
            <g key={a} className="cursor-pointer" onClick={() => navigate({ to: '/conversas', search: { agent: a } as any })}>
              {n > 0 && <circle cx={x + 18} cy={230 - h} r="34" fill="url(#glow)" />}
              <rect x={x} y={230 - h} width="36" height={h} rx="5" fill="var(--surface)" stroke={AGENTS[a].color} strokeOpacity=".7" />
              <circle cx={x + 18} cy={238 - h} r="4" fill={AGENTS[a].color} />
              <text x={x + 18} y="250" textAnchor="middle" fill="var(--text)" fontSize="11" fontWeight="600">{AGENTS[a].name.split(' ')[0]}</text>
              <text x={x + 18} y="264" textAnchor="middle" fill="var(--text-2)" fontSize="10" className="tabular">{n} ativas</text>
            </g>
          );
        })}
        {/* casa de maquinas */}
        <g className="cursor-pointer" onClick={() => navigate({ to: '/sentinela', search: { aba: 'servicos' } as any })}>
          <rect x="620" y="40" width="160" height="220" rx="10" fill="var(--surface)" stroke={crit ? 'var(--crit)' : 'var(--line)'} />
          <text x="636" y="64" fill="var(--text)" fontSize="12" fontWeight="600">Casa de máquinas</text>
          {blocks.map((b, i) => (
            <g key={b.label}>
              <rect x="636" y={80 + i * 58} width="128" height="46" rx="6" fill="var(--bg)" stroke={b.fail ? 'var(--crit)' : 'var(--line)'} />
              <text x="648" y={100 + i * 58} fill="var(--text)" fontSize="12" fontWeight="600">{b.label}</text>
              <text x="648" y={116 + i * 58} fill={b.fail ? 'var(--crit)' : 'var(--text-2)'} fontSize="11" className="tabular">
                {b.ok} ok{b.fail ? ` · ${b.fail} com erro` : ''}{b.deploying ? ` · ${b.deploying} publicando` : ''}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="flex flex-wrap gap-3 border-t border-line px-4 py-2 text-[12px] text-text-2">
        {blocks.map((b) => <span key={b.label} className={cx(b.fail ? 'text-crit' : '')}><StatusBadge status={b.fail ? 'FAIL' : 'OK'} label={`${b.label}: ${b.fail ? `${b.fail} com erro` : 'tudo ok'}`} /></span>)}
      </div>
    </Card>
  );
}
