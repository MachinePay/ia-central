import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, post, put } from '../lib/api';
import { AGENTS, phone, type AgentKey } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, Card, cx, ErrorState, Field, inputCls, PageHeader, Pill, Skeleton, StatusBadge } from '../ui';

const ROLES = [
  { v: 'ATENDIMENTO', l: 'Atendimento', d: 'João (comercial) e Clara (suporte) atendem como a pessoa deste número' },
  { v: 'OBSERVAR', l: 'Só aprendendo', d: 'Guarda as conversas e aprende com a equipe; nunca responde' },
  { v: 'GABRIEL', l: 'Pessoa', d: 'Fala como a pessoa deste número; responde quem você marcar em IAs → Cada IA' },
  { v: 'CENTRAL', l: 'IA central (orquestrador)', d: 'Fala só com você: manda alertas, rascunhos e aprovações e responde o que você perguntar' },
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
  useEffect(() => {
    const u = new URL(window.location.href);
    const g = u.searchParams.get('gmail');
    if (!g) return;
    toast(u.searchParams.get('msg') ?? (g === 'ok' ? 'E-mail conectado.' : 'Não deu para conectar o e-mail.'), g === 'ok' ? 'ok' : 'crit');
    window.history.replaceState(null, '', u.pathname);
  }, []);
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
            {!q.data.instances.some((i: any) => i.role === 'CENTRAL') && <CentralRow />}
            <p className="mb-3 text-[13px] text-text-2">O que o sistema faz com as mensagens de cada número.</p>
            <ul className="divide-y divide-line">
              {q.data.instances.map((i: any) => (
                <li key={i.name} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="w-32"><p className="serif text-[24px] leading-none">{personas[i.name]?.name || i.name}</p><p className="mt-1 text-[11px] text-text-2">{i.phone ? phone(i.phone) : 'número ainda não lido'}</p><StatusBadge status={i.state === 'open' ? 'OK' : 'FAIL'} label={i.state === 'open' ? 'conectado' : i.state} /></div>
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
                  <NumberLinks name={i.name} state={i.state} email={q.data.emails?.[i.name]} gmailReady={q.data.gmailReady} />
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

          {!q.data.gmailReady || Object.keys(q.data.emails ?? {}).length === 0 ? (
            <Card className="p-4 text-[12px] text-text-2">
              <p className="font-semibold text-text">Para conectar e-mails</p>
              <p className="mt-1">No Google Cloud, no cliente OAuth usado pelo Gmail (tipo Aplicativo da Web), adicione este endereço em URIs de redirecionamento autorizados:</p>
              <code className="mt-1 block break-all rounded bg-bg px-2 py-1 text-text">{q.data.gmailRedirectUri}</code>
              {!q.data.gmailReady && <p className="mt-1 text-amber">Faltam GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET no Render.</p>}
            </Card>
          ) : null}

          <PersonaProfiles />

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

/** Orquestrador (IA central) ainda sem numero proprio: fala com voce pelo "Voce"; aqui conecta o chip dela. */
function CentralRow() {
  const [qr, setQr] = useState(false);
  const create = useMutation({
    mutationFn: () => post('/api/whatsapp/instances', { name: 'central', role: 'CENTRAL', persona: 'IA central', about: 'orquestrador' }),
    onSuccess: () => setQr(true),
    onError: (e: any) => { if (/existe/i.test(String(e?.message))) setQr(true); else toastError(e); },
  });
  return (
    <div className="my-3 rounded-[12px] border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-32"><p className="serif text-[24px] leading-none">IA central</p><p className="mt-1 text-[11px] text-text-2">orquestrador</p><Pill tone="amber">sem número próprio</Pill></div>
        <p className="flex-1 text-[12px] text-text-2">Comanda todas as IAs e fala só com você: alertas, rascunhos e aprovações, e responde o que você perguntar. Enquanto não tiver número próprio, tudo chega no "Você" de cada número.</p>
        {!qr && <Button size="sm" variant="primary" busy={create.isPending} onClick={() => create.mutate()}>Conectar número da IA</Button>}
      </div>
      {qr && <QrBox name="central" onDone={() => setQr(false)} />}
    </div>
  );
}

/** WhatsApp (desconectar / conectar por QR) e e-mail (Gmail) de cada numero. */
function NumberLinks({ name, state, email, gmailReady }: { name: string; state: string; email?: { email: string; connected: boolean }; gmailReady: boolean }) {
  const qc = useQueryClient();
  const [qrOpen, setQrOpen] = useState(false);
  const [mail, setMail] = useState(email?.email ?? '');
  const logout = useMutation({
    mutationFn: () => post(`/api/whatsapp/instances/${name}/logout`, {}),
    onSuccess: () => { toast(`WhatsApp do número ${name} desconectado. Agora é só conectar o novo pelo QR.`); void qc.invalidateQueries({ queryKey: ['settings'] }); setQrOpen(true); },
    onError: toastError,
  });
  const [imap, setImap] = useState<null | { password: string; username: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; provider: string }>(null);
  const connectMail = useMutation({
    mutationFn: async () => {
      const g = await api<any>(`/api/mail/guess?email=${encodeURIComponent(mail.trim())}`);
      if (g.google) {
        if (!gmailReady) throw new Error('Este e-mail é do Google: falta configurar o login do Google no Render (GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET).');
        const r = await api<{ url: string }>(`/api/gmail/connect/${name}?${new URLSearchParams({ email: mail.trim() })}`);
        window.location.href = r.url;
        return;
      }
      setImap({ password: '', username: mail.trim(), imap_host: g.imap_host, imap_port: g.imap_port, smtp_host: g.smtp_host, smtp_port: g.smtp_port, provider: g.provider });
    },
    onError: toastError,
  });
  const saveImap = useMutation({
    mutationFn: () => post(`/api/mail/${name}`, { email: mail.trim(), ...imap }),
    onSuccess: () => { toast(`E-mail ${mail.trim()} conectado ao número ${name}.`); setImap(null); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: toastError,
  });
  const removeMail = useMutation({
    mutationFn: () => api(`/api/gmail/${name}`, { method: 'DELETE' }),
    onSuccess: () => { toast('E-mail desligado deste número.'); setMail(''); void qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: toastError,
  });
  const open = state === 'open';
  return (
    <div className="grid w-full gap-3 pl-[140px] md:grid-cols-2">
      <div className="rounded-[8px] border border-line p-2.5">
        <p className="text-[12px] font-semibold text-text-2">WhatsApp</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Pill tone={open ? 'ok' : 'amber'}>{open ? 'conectado' : 'desconectado'}</Pill>
          {open
            ? <Button size="sm" busy={logout.isPending} onClick={() => { if (confirm(`Desconectar o WhatsApp do número ${name}? As conversas e o aprendizado ficam guardados.`)) logout.mutate(); }}>Desconectar</Button>
            : <Button size="sm" variant="primary" onClick={() => setQrOpen(true)}>Conectar (QR)</Button>}
        </div>
        {qrOpen && <QrBox name={name} onDone={() => setQrOpen(false)} />}
      </div>
      <div className="rounded-[8px] border border-line p-2.5">
        <p className="text-[12px] font-semibold text-text-2">E-mail (Gmail)</p>
        {email?.connected ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Pill tone="ok">{email.email}</Pill>
            <Button size="sm" busy={removeMail.isPending} onClick={() => { if (confirm(`Desligar o e-mail ${email.email} deste número?`)) removeMail.mutate(); }}>Desligar</Button>
          </div>
        ) : (
          <div className="mt-1.5 flex gap-2">
            <input className={cx(inputCls, 'h-8!')} placeholder="email@empresa.com" value={mail} onChange={(e) => setMail(e.target.value)} aria-label={`E-mail do número ${name}`} />
            <Button size="sm" variant="primary" disabled={!mail.includes('@')} busy={connectMail.isPending} onClick={() => connectMail.mutate()}>Ativar</Button>
          </div>
        )}
        {imap && !email?.connected && (
          <div className="mt-2 space-y-1.5 rounded-[6px] bg-bg/60 p-2">
            <p className="text-[11px] text-text-2">Provedor: {imap.provider}. Digite a senha do e-mail (se o provedor pedir, use uma senha de aplicativo).</p>
            <input type="password" autoComplete="new-password" className={cx(inputCls, 'h-8!')} placeholder="Senha do e-mail" value={imap.password} onChange={(e) => setImap({ ...imap, password: e.target.value })} aria-label="Senha do e-mail" />
            <details className="text-[11px] text-text-2">
              <summary className="cursor-pointer">Servidores (já preenchidos)</summary>
              <div className="mt-1 grid grid-cols-[1fr_70px] gap-1.5">
                <input className={cx(inputCls, 'h-7! text-[12px]')} value={imap.username} onChange={(e) => setImap({ ...imap, username: e.target.value })} aria-label="Usuário" title="Usuário" />
                <span />
                <input className={cx(inputCls, 'h-7! text-[12px]')} value={imap.imap_host} onChange={(e) => setImap({ ...imap, imap_host: e.target.value })} aria-label="Servidor de entrada (IMAP)" title="Servidor de entrada (IMAP)" />
                <input className={cx(inputCls, 'h-7! text-[12px]')} value={imap.imap_port} onChange={(e) => setImap({ ...imap, imap_port: Number(e.target.value) })} aria-label="Porta IMAP" />
                <input className={cx(inputCls, 'h-7! text-[12px]')} value={imap.smtp_host} onChange={(e) => setImap({ ...imap, smtp_host: e.target.value })} aria-label="Servidor de saída (SMTP)" title="Servidor de saída (SMTP)" />
                <input className={cx(inputCls, 'h-7! text-[12px]')} value={imap.smtp_port} onChange={(e) => setImap({ ...imap, smtp_port: Number(e.target.value) })} aria-label="Porta SMTP" />
              </div>
            </details>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setImap(null)}>Cancelar</Button>
              <Button size="sm" variant="primary" disabled={!imap.password} busy={saveImap.isPending} onClick={() => saveImap.mutate()}>Testar e conectar</Button>
            </div>
          </div>
        )}
        <p className="mt-1 text-[11px] text-text-2">{email?.connected ? 'A IA lê e responde este e-mail como a pessoa deste número.' : 'Gmail: abre o login do Google. Outro e-mail (Uni5, Locaweb, Outlook…): pede a senha e testa antes de salvar.'}</p>
      </div>
    </div>
  );
}

function QrBox({ name, onDone }: { name: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState('');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r: any = await api(`/api/whatsapp/instances/${name}/qr`);
        if (stop) return;
        if (r.qr) setQr(r.qr);
        setState(r.state ?? '');
        if (r.state === 'open') { toast(`Número ${name} conectado.`); void qc.invalidateQueries({ queryKey: ['settings'] }); onDone(); stop = true; }
      } catch { /* tenta de novo */ }
    };
    void tick();
    const t = setInterval(() => { if (!stop) void tick(); }, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-2 text-center">
      {qr ? <img src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`} alt={`QR code para conectar o número ${name}`} className="mx-auto w-48 rounded bg-white p-2" /> : <p className="text-[12px] text-text-2">Gerando QR…</p>}
      <p className="mt-1 text-[11px] text-text-2">No celular: WhatsApp → Aparelhos conectados → Conectar aparelho. O QR atualiza sozinho. {state && `(${state})`}</p>
      <Button size="sm" variant="ghost" onClick={onDone}>Fechar</Button>
    </div>
  );
}

/** Jeito de escrever de cada numero: gerado das mensagens reais da pessoa, editavel. */
function PersonaProfiles() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['personas'], queryFn: () => api('/api/personas') });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const rebuild = useMutation({
    mutationFn: (instance: string) => post(`/api/personas/${instance}/rebuild`),
    onSuccess: () => { toast('Jeito de escrever reaprendido das suas mensagens.'); void qc.invalidateQueries({ queryKey: ['personas'] }); },
    onError: toastError,
  });
  useEffect(() => {
    const u = new URL(window.location.href);
    const g = u.searchParams.get('gmail');
    if (!g) return;
    toast(u.searchParams.get('msg') ?? (g === 'ok' ? 'E-mail conectado.' : 'Não deu para conectar o e-mail.'), g === 'ok' ? 'ok' : 'crit');
    window.history.replaceState(null, '', u.pathname);
  }, []);
  const save = useMutation({
    mutationFn: (instance: string) => put(`/api/personas/${instance}`, { profile: edit[instance] }),
    onSuccess: (_d, instance) => { toast('Salvo. A IA usa o novo jeito em até 10 minutos.'); setEdit((e) => { const n = { ...e }; delete n[instance]; return n; }); void qc.invalidateQueries({ queryKey: ['personas'] }); },
    onError: toastError,
  });
  if (q.isLoading) return <Card className="p-4"><Skeleton lines={2} /></Card>;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Card className="p-4">
      <h2 className="font-semibold">Jeito de escrever de cada número</h2>
      <p className="mb-3 text-[13px] text-text-2">Cada número aprende só com as próprias mensagens. A IA estuda o que foi mandado por aquele número e escreve este guia; ela segue à risca. Dá para corrigir à mão.</p>
      <div className="space-y-4">
        {(q.data as any[]).map((p) => (
          <div key={p.instance} className="rounded-[6px] border border-line p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">{p.persona.name}</span><span className="text-text-2">· número {p.instance} · {p.messages} mensagens suas guardadas</span>
              <span className="ml-auto text-[12px] text-text-2">{p.updatedAt ? `atualizado ${new Date(p.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'ainda não gerado'}</span>
            </div>
            <textarea className={cx(inputCls, 'h-48! py-2! font-mono text-[12px]')} value={edit[p.instance] ?? p.profile}
              placeholder={p.messages < 15 ? 'Ainda há poucas mensagens deste número. Continue usando o WhatsApp normalmente; o guia é gerado sozinho toda madrugada.' : 'Clique em "Reaprender" para gerar.'}
              onChange={(e) => setEdit({ ...edit, [p.instance]: e.target.value })} aria-label={`Jeito de escrever do número ${p.instance}`} />
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" busy={rebuild.isPending && rebuild.variables === p.instance} onClick={() => rebuild.mutate(p.instance)}>Reaprender das mensagens</Button>
              <Button size="sm" variant="primary" disabled={edit[p.instance] === undefined} busy={save.isPending && save.variables === p.instance} onClick={() => save.mutate(p.instance)}>Salvar edição</Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
