import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, put } from '../lib/api';
import { AGENTS, phone, type AgentKey } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, Card, cx, ErrorState, Field, inputCls, PageHeader, Pill, Skeleton, StatusBadge } from '../ui';

const ROLES = [
  { v: 'ATENDIMENTO', l: 'Atendimento', d: 'O Léo roteia e os agentes respondem (rascunho ou envio)' },
  { v: 'OBSERVAR', l: 'Só aprendendo', d: 'Guarda as conversas e aprende com a equipe; nunca responde' },
  { v: 'GABRIEL', l: 'Pessoal do Gabriel', d: 'Só fala com contatos com a tag BOT; recebe rascunhos e aprovações' },
  { v: 'OFF', l: 'Desligado', d: 'Ignorado pelo sistema' },
];

export function Settings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [v, setV] = useState<Record<string, string>>({});
  const [personas, setPersonas] = useState<Record<string, { name: string; about: string }>>({});
  useEffect(() => {
    if (!q.data) return;
    setRoles(Object.fromEntries(q.data.instances.map((i: any) => [i.name, i.role])));
    setV(q.data.values);
    const p: Record<string, { name: string; about: string }> = {};
    for (const part of String(q.data.values.PERSONAS ?? '').split(/[;\n]/)) {
      const m = part.match(/^\s*([^:]+):([^|]*)\|?(.*)$/);
      if (m) p[m[1].trim()] = { name: m[2].trim(), about: m[3].trim() };
    }
    setPersonas(p);
  }, [q.data]);
  const save = useMutation({ mutationFn: (body: Record<string, string>) => put('/api/settings', body), onSuccess: () => { toast('Ajuste salvo. Vale em até 30 segundos, sem deploy.'); void qc.invalidateQueries({ queryKey: ['settings'] }); }, onError: toastError });
  if (q.isLoading) return <Skeleton lines={8} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const auto = (v.AUTO_SEND_AGENTS ?? '').split(',').filter(Boolean);
  const toggleAuto = (a: string) => setV({ ...v, AUTO_SEND_AGENTS: (auto.includes(a) ? auto.filter((x) => x !== a) : [...auto, a]).join(',') });
  const info = q.data.info;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Configurações" accent="var(--text-2)" />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[880px] space-y-4">
          <Card className="p-4">
            <h2 className="font-semibold">Números de WhatsApp</h2>
            <p className="mb-3 text-[13px] text-text-2">O que o sistema faz com as mensagens de cada número.</p>
            <ul className="divide-y divide-line">
              {q.data.instances.map((i: any) => (
                <li key={i.name} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="w-32"><p className="font-semibold">{i.name}</p><StatusBadge status={i.state === 'open' ? 'OK' : 'FAIL'} label={i.state === 'open' ? 'conectado' : i.state} /></div>
                  <select className={cx(inputCls, 'w-56!')} value={roles[i.name] ?? i.role} onChange={(e) => setRoles({ ...roles, [i.name]: e.target.value })} aria-label={`Papel do número ${i.name}`}>
                    {ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
                  </select>
                  <span className="flex-1 text-[12px] text-text-2">{ROLES.find((r) => r.v === (roles[i.name] ?? i.role))?.d}</span>
                  {(roles[i.name] ?? i.role) !== 'OFF' && (
                    <div className="grid w-full gap-2 pl-[140px] md:grid-cols-[180px_1fr]">
                      <input className={inputCls} placeholder="Quem responde (ex.: Gabriel)" value={personas[i.name]?.name ?? ''} aria-label={`Nome de quem responde pelo ${i.name}`}
                        onChange={(e) => setPersonas({ ...personas, [i.name]: { name: e.target.value, about: personas[i.name]?.about ?? '' } })} />
                      <input className={inputCls} placeholder="Quem é essa pessoa (ex.: dono da AGarraMais, atende o suporte)" value={personas[i.name]?.about ?? ''} aria-label={`Descrição de quem responde pelo ${i.name}`}
                        onChange={(e) => setPersonas({ ...personas, [i.name]: { name: personas[i.name]?.name ?? '', about: e.target.value } })} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-text-2">A IA escreve como essa pessoa, em primeira pessoa, copiando o jeito das mensagens que vocês já mandaram por esse número. Se perguntarem a sério se é robô, ela não nega.</p>
            <div className="mt-3 flex justify-end">
              <Button variant="primary" onClick={() => save.mutate({
                WA_INSTANCES: Object.entries(roles).map(([n, r]) => `${n}:${r}`).join(','),
                PERSONAS: Object.entries(personas).filter(([, p]) => p.name.trim()).map(([n, p]) => `${n}:${p.name.trim()}|${p.about.trim().replace(/[;|]/g, ',')}`).join(';'),
              })}>Salvar números</Button>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="font-semibold">Envio das respostas</h2>
            <p className="mb-3 text-[13px] text-text-2">No modo rascunho nada sai sozinho para o cliente: a resposta fica na conversa para você enviar com um clique.</p>
            <div className="flex flex-wrap gap-2">
              {[['draft', 'Rascunho (modo sombra)'], ['auto', 'Enviar sozinho']].map(([val, l]) => (
                <label key={val} className={cx('flex cursor-pointer items-center gap-2 rounded-[6px] border px-3 py-2', v.SEND_MODE === val ? 'border-amber' : 'border-line')}>
                  <input type="radio" name="mode" checked={v.SEND_MODE === val} onChange={() => setV({ ...v, SEND_MODE: val })} />{l}
                </label>
              ))}
            </div>
            {v.SEND_MODE === 'draft' && (
              <div className="mt-3">
                <p className="mb-1.5 text-[13px]">Liberar envio sozinho só para:</p>
                <div className="flex flex-wrap gap-2">
                  {(['JOAO', 'CLARA', 'GABRIEL'] as AgentKey[]).map((a) => (
                    <label key={a} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={auto.includes(a)} onChange={() => toggleAuto(a)} />{AGENTS[a].name}</label>
                  ))}
                </div>
              </div>
            )}
            <label className="mt-3 flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={/true|1/.test(v.SHADOW_NOTIFY ?? '')} onChange={(e) => setV({ ...v, SHADOW_NOTIFY: e.target.checked ? 'true' : 'false' })} />
              Mandar cada rascunho também para o meu WhatsApp (conversa "Você")
            </label>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="Horário comercial" hint="ex.: seg-sex 08:00-18:00"><input className={inputCls} value={v.BUSINESS_HOURS ?? ''} onChange={(e) => setV({ ...v, BUSINESS_HOURS: e.target.value })} /></Field>
              <Field label="Desconto automático até (%)"><input type="number" min={0} max={100} className={inputCls} value={v.MAX_AUTO_DISCOUNT_PERCENT ?? ''} onChange={(e) => setV({ ...v, MAX_AUTO_DISCOUNT_PERCENT: e.target.value })} /></Field>
              <Field label="Teto de gasto de IA por dia (US$)"><input type="number" min={0} step="0.5" className={inputCls} value={v.DAILY_COST_LIMIT_USD ?? ''} onChange={(e) => setV({ ...v, DAILY_COST_LIMIT_USD: e.target.value })} /></Field>
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="primary" onClick={() => save.mutate({ SEND_MODE: v.SEND_MODE, AUTO_SEND_AGENTS: v.AUTO_SEND_AGENTS ?? '', SHADOW_NOTIFY: v.SHADOW_NOTIFY ?? 'false', BUSINESS_HOURS: v.BUSINESS_HOURS, MAX_AUTO_DISCOUNT_PERCENT: v.MAX_AUTO_DISCOUNT_PERCENT, DAILY_COST_LIMIT_USD: v.DAILY_COST_LIMIT_USD })}>Salvar envio</Button>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 font-semibold">Integrações</h2>
            <dl className="grid gap-2 text-[13px] md:grid-cols-2">
              {[
                ['OpenAI', info.integrations.openai], ['Anthropic (reserva)', info.integrations.anthropic],
                [`Render${info.integrations.renderKeyEnd ? ` · …${info.integrations.renderKeyEnd}` : ''}`, info.integrations.render],
                [`Vercel${info.integrations.vercelKeyEnd ? ` · …${info.integrations.vercelKeyEnd}` : ''}`, info.integrations.vercel],
                ['Gmail', info.integrations.gmail],
              ].map(([l, ok]) => <div key={String(l)} className="flex items-center"><dt>{l}</dt><dd className="ml-auto">{ok ? <Pill tone="ok">ligado</Pill> : <Pill>desligado</Pill>}</dd></div>)}
            </dl>
            <p className="mt-3 text-[12px] text-text-2">Chaves ficam nas variáveis de ambiente do Render e nunca aparecem aqui. Aprovações vão para {phone(info.gabrielPhone)} pelo número {info.approvalInstance}. Modelos: agentes {info.models.agent}, roteador {info.models.router}.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
