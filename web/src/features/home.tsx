import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, Bell, CheckCheck, ExternalLink, MessageSquareWarning, QrCode, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { onEvent } from '../app/realtime';
import { useSummary } from '../app/shell';
import { api, post, put } from '../lib/api';
import { incidentCode, timeAgo } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, cx, inputCls, Pill } from '../ui';
import { areaColor, OperationScene, STATUS_COL, type SceneArea, type SceneItem, type Status } from '../scene3d/OperationScene';

type SceneData = { areas: Array<SceneArea & { role?: string; about?: string; messages24h?: number; active24h?: number }>; items: SceneItem[]; threadAreas: Record<string, string> };
type Panel = null | { kind: 'area'; id: string; tab: 'conversas' | 'jeito' | 'ajustes' } | { kind: 'item'; item: SceneItem } | { kind: 'needs' };

const STATUS_TXT: Record<Status, string> = { ok: 'Ok', warn: 'Atenção', crit: 'Crítico' };
const ROLE_OPTIONS = [
  { v: 'GABRIEL', l: 'Pessoa (só contatos liberados)' },
  { v: 'ATENDIMENTO', l: 'Atende todos os clientes' },
  { v: 'OBSERVAR', l: 'Só aprendendo' },
  { v: 'OFF', l: 'Desligado' },
];
const EVENT_TXT: Record<string, string> = {
  'message.created': 'Mensagem', 'approval.created': 'Aprovação pedida', 'approval.decided': 'Aprovação decidida',
  'incident.opened': 'Incidente aberto', 'incident.resolved': 'Incidente resolvido', 'incident.updated': 'Incidente atualizado',
  'resource.updated': 'Site mudou de estado', 'cost.updated': 'Custos atualizados',
};

export function Home() {
  const scene = useQuery({ queryKey: ['scene'], queryFn: () => api<SceneData>('/api/scene'), refetchInterval: 60_000 });
  const summary = useSummary();
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OperationScene | null>(null);
  const [noGl, setNoGl] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [status, setStatus] = useState<'all' | Status>('all');
  const [q, setQ] = useState('');
  const [area, setArea] = useState<string | null>(null);
  const [tools, setTools] = useState({ labels: true, flow: true, spin: !matchMedia('(prefers-reduced-motion: reduce)').matches });
  const [feed, setFeed] = useState<Array<{ id: string; txt: string; at: string }>>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const data = scene.data;
  const threadAreasRef = useRef<Record<string, string>>({});
  threadAreasRef.current = data?.threadAreas ?? {};

  // cria a cena uma vez
  useEffect(() => {
    if (!canvasRef.current || !labelsRef.current || !tipRef.current) return;
    try {
      sceneRef.current = new OperationScene(canvasRef.current, labelsRef.current, tipRef.current, {
        onArea: (id) => selectArea(id),
        onItem: (it) => { setArea(it.area); sceneRef.current?.setFilter({ area: it.area }); setPanel({ kind: 'item', item: it }); },
      });
    } catch {
      setNoGl(true);
    }
    return () => { sceneRef.current?.dispose(); sceneRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (data && sceneRef.current) sceneRef.current.setData(data.areas, data.items); }, [data]);
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    sceneRef.current?.setFilter({ status, q, area });
    setVisible(sceneRef.current && (q || status !== 'all' || area) ? sceneRef.current.count() : null);
  }, [status, q, area, data]);
  useEffect(() => { sceneRef.current?.setLabels(tools.labels); sceneRef.current?.setFlow(tools.flow); sceneRef.current?.setSpin(tools.spin); }, [tools]);
  useEffect(() => {
    const t = new MutationObserver(() => sceneRef.current?.applyTheme());
    t.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => t.disconnect();
  }, []);

  // linha do tempo real + particulas quando chega mensagem de verdade
  useEffect(() => {
    if (summary.data?.timeline && !feed.length) {
      setFeed(summary.data.timeline.slice(0, 6).map((e: any) => ({ id: String(e.id), txt: describe(e.type, e.data), at: e.at })));
    }
  }, [summary.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onEvent((e) => {
    setFeed((f) => [{ id: `${Date.now()}${Math.random()}`, txt: describe(e.type, e.data), at: new Date().toISOString() }, ...f].slice(0, 6));
    if (e.type === 'message.created' && e.data?.direction === 'INBOUND') {
      const target = threadAreasRef.current[e.data.threadId];
      if (target) sceneRef.current?.burst('WHATSAPP', target);
    }
  }), []);

  // atalhos: / busca, Esc fecha, 0-9 doca
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input,textarea,select');
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Escape' && !typing) { if (panel) setPanel(null); else goHome(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  function selectArea(id: string) {
    setArea(id); sceneRef.current?.focusArea(id); setTools((t) => ({ ...t, spin: false }));
    setPanel({ kind: 'area', id, tab: 'conversas' });
  }
  function goHome() { setArea(null); setPanel(null); sceneRef.current?.home(); }

  const counts = useMemo(() => {
    const it = data?.items ?? [];
    return { all: it.length, ok: it.filter((i) => i.status === 'ok').length, warn: it.filter((i) => i.status === 'warn').length, crit: it.filter((i) => i.status === 'crit').length };
  }, [data]);
  const needs = summary.data?.needsYou;
  const needsCount = (needs?.approvals.length ?? 0) + (needs?.incidents.filter((i: any) => i.status === 'OPEN').length ?? 0) + (needs?.unanswered.length ?? 0);
  const areas = data?.areas ?? [];

  return (
    <div className="relative h-full overflow-hidden" style={{ background: 'var(--scene-bg)' }}>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full outline-none" aria-label="Maquete 3D da operação. Use a doca de baixo ou a busca para navegar." />
      <div ref={labelsRef} className="cc-labels" />
      <div ref={tipRef} className="cc-tip glass" role="tooltip" />
      {noGl && <Fallback areas={areas} items={data?.items ?? []} onArea={selectArea} />}

      {/* barra superior */}
      <div className="pointer-events-none absolute top-3 right-3 left-3 z-[5] flex flex-wrap items-center gap-2">
        <div className="glass pointer-events-auto px-3 py-2">
          <p className="text-[15px] font-semibold leading-tight">Centro de Comando</p>
          <p className="text-[12px] text-text-2">{areas.filter((a) => a.kind === 'desks').length} IAs · dados reais, ao vivo</p>
        </div>
        <label className="glass pointer-events-auto flex h-10 min-w-[240px] flex-[0_1_340px] items-center gap-2 px-2.5">
          <Search size={16} className="text-text-2" />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pessoa, contato, serviço…" aria-label="Buscar no mapa"
            onKeyDown={(e) => {
              if (e.key === 'Enter') { const f = sceneRef.current?.firstVisible(); if (f) { sceneRef.current?.focusItem(f.id); setPanel({ kind: 'item', item: f }); } }
              if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur(); }
            }}
            className="h-full w-full border-0 bg-transparent text-[14px] outline-none placeholder:text-text-2" />
          {visible !== null && <span className="text-[12px] whitespace-nowrap text-text-2">{visible} itens</span>}
          <kbd className="rounded border border-line px-1.5 text-[11px] text-text-2">/</kbd>
        </label>
        <div className="glass pointer-events-auto flex gap-1 p-1" role="group" aria-label="Filtrar por estado">
          {([['all', 'Todos', null], ['ok', 'Ok', STATUS_COL.ok], ['warn', 'Atenção', STATUS_COL.warn], ['crit', 'Crítico', STATUS_COL.crit]] as const).map(([k, t, c]) => (
            <button key={k} className="cc-chip" aria-pressed={status === k} onClick={() => setStatus(k)}>
              {c && <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />}{t} <span className="text-[12px] opacity-80 tabular">{counts[k]}</span>
            </button>
          ))}
        </div>
        <button className="glass pointer-events-auto flex h-10 cursor-pointer items-center gap-2 px-3 font-semibold" onClick={() => setPanel({ kind: 'needs' })}>
          <Bell size={16} className={needsCount ? 'text-amber' : 'text-text-2'} />Precisa de você {needsCount > 0 && <span className="bad warn">{needsCount}</span>}
        </button>
        <div className="glass pointer-events-auto ml-auto flex gap-1 p-1" role="group" aria-label="Opções">
          <button className="cc-chip" aria-pressed={tools.labels} onClick={() => setTools((t) => ({ ...t, labels: !t.labels }))}>Rótulos</button>
          <button className="cc-chip" aria-pressed={tools.flow} onClick={() => setTools((t) => ({ ...t, flow: !t.flow }))}>Mensagens</button>
          <button className="cc-chip" aria-pressed={tools.spin} onClick={() => setTools((t) => ({ ...t, spin: !t.spin }))}>Girar</button>
        </div>
      </div>

      {/* linha do tempo */}
      <section className="glass absolute bottom-[68px] left-3 z-[4] hidden w-[300px] px-3 py-2.5 md:block" aria-label="Últimos eventos">
        <h3 className="mb-1.5 text-[13px] font-semibold">Agora</h3>
        <ol aria-live="polite" className="space-y-1.5">
          {feed.length === 0 && <li className="text-[12px] text-text-2">Os eventos aparecem aqui ao vivo.</li>}
          {feed.map((f) => (
            <li key={f.id} className="grid grid-cols-[42px_1fr] gap-1.5 text-[12px] leading-snug">
              <time className="tabular text-text-2">{new Date(f.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</time><span>{f.txt}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* doca */}
      <nav className="glass absolute bottom-3 left-1/2 z-[5] flex max-w-[calc(100%-24px)] -translate-x-1/2 gap-1 overflow-x-auto p-1" aria-label="Áreas">
        <button className="cc-chip" aria-pressed={!area} onClick={goHome}>Visão geral</button>
        {areas.map((a, i) => {
          const list = (data?.items ?? []).filter((it) => it.area === a.id);
          const warn = list.filter((x) => x.status === 'warn').length, crit = list.filter((x) => x.status === 'crit').length;
          return (
            <button key={a.id} className="cc-chip" aria-pressed={area === a.id} onClick={() => selectArea(a.id)}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: areaColor(a, i) }} />{a.name}
              {a.kind !== 'hub' && <span className="text-[12px] opacity-80 tabular">{list.length}</span>}
              {a.state && a.state !== 'open' && <span className="bad crit">off</span>}
              {crit > 0 && <span className="bad crit">{crit}</span>}{warn > 0 && <span className="bad warn">{warn}</span>}
            </button>
          );
        })}
      </nav>

      {/* painel lateral */}
      <aside className={cx('cc-side glass absolute top-[72px] right-3 bottom-[64px] z-[6] flex w-[min(400px,calc(100%-24px))] flex-col', panel && 'open')} aria-label="Detalhes">
        {panel?.kind === 'area' && <AreaPanel area={areas.find((a) => a.id === panel.id)} areaIndex={areas.findIndex((a) => a.id === panel.id)} items={(data?.items ?? []).filter((i) => i.area === panel.id)} tab={panel.tab}
          setTab={(tab) => setPanel({ ...panel, tab })} onItem={(it) => setPanel({ kind: 'item', item: it })} onClose={() => setPanel(null)} />}
        {panel?.kind === 'item' && <ItemPanel item={panel.item} area={areas.find((a) => a.id === panel.item.area)} onBack={() => setPanel({ kind: 'area', id: panel.item.area, tab: 'conversas' })}
          onFocus={() => sceneRef.current?.focusItem(panel.item.id)} onOpen={() => panel.item.link && navigate({ to: panel.item.link as any })} onClose={() => setPanel(null)} />}
        {panel?.kind === 'needs' && <NeedsPanel needs={needs} onClose={() => setPanel(null)} />}
      </aside>
    </div>
  );
}

function describe(type: string, d: any): string {
  if (type === 'message.created') return d?.direction === 'INBOUND' ? 'Chegou mensagem de cliente' : d?.status === 'DRAFT' ? 'IA deixou um rascunho' : d?.sender === 'HUMAN' ? 'Você respondeu' : 'IA respondeu';
  if (d?.title) return `${EVENT_TXT[type] ?? type}: ${d.title}`;
  return EVENT_TXT[type] ?? type;
}

function PanelHeader({ title, sub, onClose, color }: { title: string; sub?: string; onClose: () => void; color?: string }) {
  return (
    <header className="flex items-start gap-2 border-b border-line px-4 pt-3.5 pb-2.5" style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}>
      <div className="min-w-0 flex-1"><h2 className="text-[19px] font-semibold leading-tight">{title}</h2>{sub && <p className="mt-0.5 text-[13px] text-text-2">{sub}</p>}</div>
      <button className="h-8 w-8 cursor-pointer rounded-[6px] border border-line" onClick={onClose} aria-label="Fechar painel"><X size={16} className="mx-auto" /></button>
    </header>
  );
}

function Row({ it, onClick }: { it: SceneItem; onClick: () => void }) {
  return (
    <button onClick={onClick} className="grid w-full cursor-pointer grid-cols-[10px_1fr_auto] items-center gap-2.5 rounded-[6px] px-2 py-2 text-left hover:bg-line/40">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COL[it.status] }} />
      <span className="min-w-0"><strong className="block truncate text-[13px] font-semibold">{it.name}</strong><small className="block truncate text-[12px] text-text-2">{it.sub}</small></span>
      <span className="rounded border px-1.5 py-0.5 text-[11px] font-semibold" style={{ color: STATUS_COL[it.status], borderColor: 'currentColor' }}>{STATUS_TXT[it.status]}</span>
    </button>
  );
}

function AreaPanel({ area, areaIndex, items, tab, setTab, onItem, onClose }: {
  area?: SceneData['areas'][number]; areaIndex: number; items: SceneItem[]; tab: 'conversas' | 'jeito' | 'ajustes';
  setTab: (t: 'conversas' | 'jeito' | 'ajustes') => void; onItem: (it: SceneItem) => void; onClose: () => void;
}) {
  if (!area) return null;
  const color = areaColor(area, areaIndex);
  const sorted = [...items].sort((a, b) => ({ crit: 0, warn: 1, ok: 2 }[a.status] - { crit: 0, warn: 1, ok: 2 }[b.status]));
  const isPerson = area.kind === 'desks';
  return (
    <>
      <PanelHeader title={area.name} sub={area.who} onClose={onClose} color={color} />
      {area.state && area.state !== 'open' && <p className="mx-4 mt-2 rounded-[6px] bg-crit/15 px-3 py-2 text-[13px] text-crit">WhatsApp desconectado ({area.state}). Reconecte o número.</p>}
      {isPerson && (
        <div className="flex gap-1 border-b border-line px-3 pt-2">
          {([['conversas', 'Conversas'], ['jeito', 'Jeito de escrever'], ['ajustes', 'Ajustes']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cx('-mb-px cursor-pointer border-b-2 px-2.5 py-1.5 text-[13px] font-semibold', tab === k ? 'border-amber text-text' : 'border-transparent text-text-2')}>{l}</button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
        {area.kind === 'hub' && <CentralPanel item={items[0]} />}
        {(area.kind === 'racks' || (isPerson && tab === 'conversas')) && (
          <>
            {isPerson && <p className="px-2 pb-2 text-[12px] text-text-2">{area.active24h ?? 0} conversas e {area.messages24h ?? 0} mensagens nas últimas 24 h</p>}
            {sorted.length === 0 ? <p className="px-2 text-text-2">Nada por aqui ainda.</p> : sorted.map((it) => <Row key={it.id} it={it} onClick={() => onItem(it)} />)}
            <div className="px-2 pt-2">
              <Link to={area.kind === 'racks' ? '/sentinela' : '/conversas'} search={(area.kind === 'racks' ? {} : { instance: area.id }) as any} className="inline-flex items-center gap-1 text-[13px] text-cyan">
                {area.kind === 'racks' ? 'Abrir o Sentinela' : 'Ver todas as conversas deste número'} <ExternalLink size={12} />
              </Link>
            </div>
          </>
        )}
        {isPerson && tab === 'jeito' && <StyleTab instance={area.id} />}
        {isPerson && tab === 'ajustes' && <SettingsTab instance={area.id} />}
      </div>
    </>
  );
}

function CentralPanel({ item }: { item?: SceneItem }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const central = (settings.data?.instances ?? []).find((i: any) => i.role === 'CENTRAL');
  const [connecting, setConnecting] = useState(false);
  return (
    <div className="space-y-3 px-2 text-[14px]">
      <p className="leading-relaxed">O orquestrador lê as mensagens de todos os números, escolhe quem responde e fala com você. É por ele que chegam alertas, rascunhos e aprovações.</p>
      {item && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">{Object.entries(item.extra).flatMap(([k, v]) => [<dt key={`k${k}`} className="text-text-2">{k}</dt>, <dd key={`v${k}`}>{v}</dd>])}</dl>}
      <div className="rounded-[6px] border border-line p-3">
        <p className="font-semibold">Como falar com ele</p>
        <p className="mt-1 text-[13px] text-text-2">
          {central ? `Mande mensagem para o número ${central.name}.` : 'Escreva na sua conversa "Você" do WhatsApp (você com você mesmo).'} Exemplos: "como tá tudo?", "o que o Marcos falou?",
          "aprova a A-0003", "manda pro Marcos: chego amanhã", "liga a IA pra Ana respondendo sozinha".
        </p>
      </div>
      {!central && (connecting ? <ConnectNumber onDone={() => setConnecting(false)} /> : (
        <div className="rounded-[6px] border border-dashed border-line p-3">
          <p className="font-semibold">Número próprio da IA</p>
          <p className="mt-1 text-[13px] text-text-2">Com um chip só para a IA, os alertas e a conversa com o orquestrador saem da sua conversa "Você" e passam para esse número.</p>
          <Button className="mt-2" variant="primary" icon={<QrCode size={14} />} onClick={() => setConnecting(true)}>Conectar número da IA</Button>
        </div>
      ))}
    </div>
  );
}

function ConnectNumber({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<string>('');
  const create = useMutation({
    mutationFn: () => post('/api/whatsapp/instances', { name: 'central', role: 'CENTRAL', persona: 'IA central', about: 'orquestrador' }),
    onSuccess: (r: any) => { setQr(r.qr ?? null); setState(r.state ?? ''); },
    onError: toastError,
  });
  useEffect(() => {
    if (!create.isSuccess) return;
    const t = setInterval(async () => {
      try {
        const r: any = await api('/api/whatsapp/instances/central/qr');
        if (r.qr) setQr(r.qr);
        if (r.state === 'open') { clearInterval(t); toast('Número da IA conectado. Os alertas passam a sair dele.'); void qc.invalidateQueries(); onDone(); }
        setState(r.state ?? '');
      } catch { /* tenta de novo */ }
    }, 4000);
    return () => clearInterval(t);
  }, [create.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rounded-[6px] border border-line p-3">
      {!create.isSuccess ? (
        <>
          <p className="text-[13px]">Coloque o chip novo num celular com WhatsApp instalado. Depois clique abaixo e leia o QR em <b>WhatsApp → Aparelhos conectados → Conectar aparelho</b>.</p>
          <div className="mt-2 flex gap-2"><Button variant="ghost" onClick={onDone}>Cancelar</Button><Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>Gerar QR code</Button></div>
        </>
      ) : (
        <div className="text-center">
          {qr ? <img src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`} alt="QR code para conectar o número da IA" className="mx-auto w-56 rounded bg-white p-2" /> : <p className="text-text-2">Gerando QR…</p>}
          <p className="mt-2 text-[12px] text-text-2">O QR muda a cada ~40 s; esta tela atualiza sozinha. {state && `Estado: ${state}`}</p>
        </div>
      )}
    </div>
  );
}

function StyleTab({ instance }: { instance: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['personas'], queryFn: () => api('/api/personas') });
  const p = (q.data ?? []).find((x: any) => x.instance === instance);
  const [text, setText] = useState<string | null>(null);
  const rebuild = useMutation({ mutationFn: () => post(`/api/personas/${instance}/rebuild`), onSuccess: () => { toast('Reaprendido das mensagens deste número.'); setText(null); void qc.invalidateQueries({ queryKey: ['personas'] }); }, onError: toastError });
  const save = useMutation({ mutationFn: () => put(`/api/personas/${instance}`, { profile: text }), onSuccess: () => { toast('Salvo.'); setText(null); void qc.invalidateQueries({ queryKey: ['personas'] }); }, onError: toastError });
  if (!p) return <p className="px-2 text-text-2">Carregando…</p>;
  return (
    <div className="space-y-2 px-2">
      <p className="text-[12px] text-text-2">Aprendido só com as {p.messages} mensagens deste número. O jeito com cada contato fica na ficha da conversa.</p>
      <textarea value={text ?? p.profile} onChange={(e) => setText(e.target.value)} rows={16} placeholder="Ainda não gerado."
        className="w-full rounded-[6px] border border-line bg-bg p-2 font-mono text-[12px]" aria-label="Jeito de escrever" />
      <div className="flex justify-end gap-2">
        <Button size="sm" busy={rebuild.isPending} onClick={() => rebuild.mutate()}>Reaprender</Button>
        <Button size="sm" variant="primary" disabled={text === null} busy={save.isPending} onClick={() => save.mutate()}>Salvar</Button>
      </div>
    </div>
  );
}

function SettingsTab({ instance }: { instance: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const values = q.data?.values ?? {};
  const roles: Record<string, string> = Object.fromEntries(String(values.WA_INSTANCES ?? '').split(',').filter(Boolean).map((p: string) => p.split(':')));
  const personas: Record<string, { name: string; about: string }> = {};
  for (const part of String(values.PERSONAS ?? '').split(/[;\n]/)) { const m = part.match(/^\s*([^:]+):([^|]*)\|?(.*)$/); if (m) personas[m[1].trim()] = { name: m[2].trim(), about: m[3].trim() }; }
  const [f, setF] = useState<{ role: string; name: string; about: string } | null>(null);
  const cur = f ?? { role: roles[instance] ?? 'OFF', name: personas[instance]?.name ?? '', about: personas[instance]?.about ?? '' };
  const save = useMutation({
    mutationFn: () => {
      const r = { ...roles, [instance]: cur.role };
      const p = { ...personas, [instance]: { name: cur.name, about: cur.about } };
      return put('/api/settings', {
        WA_INSTANCES: Object.entries(r).map(([n, x]) => `${n}:${x}`).join(','),
        PERSONAS: Object.entries(p).filter(([, x]) => x.name.trim()).map(([n, x]) => `${n}:${x.name.trim()}|${x.about.trim().replace(/[;|]/g, ',')}`).join(';'),
      });
    },
    onSuccess: () => { toast('Salvo. Vale em até 30 segundos.'); setF(null); void qc.invalidateQueries(); },
    onError: toastError,
  });
  if (q.isLoading) return <p className="px-2 text-text-2">Carregando…</p>;
  return (
    <div className="space-y-3 px-2">
      <label className="block space-y-1"><span className="text-[12px] font-semibold text-text-2">Quem é (nome que a IA usa)</span>
        <input className={inputCls} value={cur.name} onChange={(e) => setF({ ...cur, name: e.target.value })} /></label>
      <label className="block space-y-1"><span className="text-[12px] font-semibold text-text-2">Descrição</span>
        <input className={inputCls} value={cur.about} placeholder="ex.: dono da AGarraMais, atende o suporte" onChange={(e) => setF({ ...cur, about: e.target.value })} /></label>
      <label className="block space-y-1"><span className="text-[12px] font-semibold text-text-2">O que este número faz</span>
        <select className={inputCls} value={cur.role} onChange={(e) => setF({ ...cur, role: e.target.value })}>{ROLE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></label>
      <p className="text-[12px] text-text-2">Em "Pessoa", a IA só fala com contatos que têm a tag BOT (e responde sozinha com AUTO). Mude isso na ficha de cada conversa.</p>
      <div className="flex justify-end"><Button variant="primary" disabled={!f} busy={save.isPending} onClick={() => save.mutate()}>Salvar</Button></div>
    </div>
  );
}

function ItemPanel({ item, area, onBack, onFocus, onOpen, onClose }: { item: SceneItem; area?: SceneArea; onBack: () => void; onFocus: () => void; onOpen: () => void; onClose: () => void }) {
  return (
    <>
      <PanelHeader title={item.name} sub={area ? `${area.name} · ${area.who}` : ''} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Pill tone={item.status === 'crit' ? 'crit' : item.status === 'warn' ? 'amber' : 'ok'}>{STATUS_TXT[item.status]}</Pill>
        <p className="mt-2.5 max-w-[60ch] text-[14px] leading-relaxed">{item.sub}</p>
        {Object.keys(item.extra).length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {Object.entries(item.extra).flatMap(([k, v]) => [<dt key={`k${k}`} className="text-text-2">{k}</dt>, <dd key={`v${k}`}>{v}</dd>])}
          </dl>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {item.link && <Button variant="primary" onClick={onOpen}>{item.link.startsWith('/conversas') ? 'Abrir conversa' : 'Abrir'}</Button>}
          <Button onClick={onFocus}>Mostrar no mapa</Button>
          <Button variant="ghost" onClick={onBack}>Voltar</Button>
        </div>
      </div>
    </>
  );
}

function NeedsPanel({ needs, onClose }: { needs: any; onClose: () => void }) {
  const rows = [
    ...(needs?.incidents ?? []).filter((i: any) => i.status === 'OPEN').map((i: any) => ({ k: `i${i.id}`, icon: <AlertTriangle size={15} className={i.severity === 'CRITICAL' ? 'text-crit' : 'text-warn'} />, txt: `${incidentCode(i.id)} ${i.title}`, at: i.opened_at, to: '/sentinela', search: { incidente: i.id } })),
    ...(needs?.approvals ?? []).map((a: any) => ({ k: `a${a.id}`, icon: <CheckCheck size={15} className="text-amber" />, txt: `${a.code} · ${a.contact}: ${a.action.toLowerCase()}`, at: a.created_at, to: '/aprovacoes', search: {} })),
    ...(needs?.unanswered ?? []).map((t: any) => ({ k: `t${t.id}`, icon: <MessageSquareWarning size={15} className="text-cyan" />, txt: `${t.contact} sem resposta (${t.instance})`, at: t.last_inbound_at, to: `/conversas/${t.id}`, search: {} })),
  ];
  return (
    <>
      <PanelHeader title="Precisa de você" sub={rows.length ? `${rows.length} itens` : 'Tudo em dia'} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.length === 0 && <p className="px-2 text-text-2">Nada esperando por você agora.</p>}
        {rows.map((r) => (
          <Link key={r.k} to={r.to} search={r.search as any} className="flex items-center gap-2.5 rounded-[6px] px-2 py-2 text-[13px] hover:bg-line/40">
            {r.icon}<span className="min-w-0 flex-1 truncate">{r.txt}</span><span className="text-[12px] text-text-2">{timeAgo(r.at)}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

/** Sem WebGL: lista plana com os mesmos dados e cliques. */
function Fallback({ areas, items, onArea }: { areas: SceneArea[]; items: SceneItem[]; onArea: (id: string) => void }) {
  return (
    <div className="absolute inset-0 z-[2] overflow-y-auto p-4 pt-24">
      <p className="mb-3 text-text-2">Seu navegador não suporta a visão 3D; mostrando a versão plana.</p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {areas.map((a, i) => (
          <button key={a.id} onClick={() => onArea(a.id)} className="glass cursor-pointer p-4 text-left" style={{ borderLeft: `3px solid ${areaColor(a, i)}` }}>
            <p className="font-semibold">{a.name}</p><p className="text-[12px] text-text-2">{a.who}</p>
            <p className="mt-2 text-[13px]">{items.filter((x) => x.area === a.id).length} itens</p>
          </button>
        ))}
      </div>
    </div>
  );
}
