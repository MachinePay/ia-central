import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell, Bot, Inbox, MessageSquare, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, del, patch, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, Card, cx, EmptyState, ErrorState, inputCls, PageHeader, Pill, Skeleton, Tab } from '../ui';

type Account = { instance: string; email: string; persona: { name: string; about: string }; provider: string; canSend: boolean };
type Mail = {
  id: number; from_email: string | null; from_name: string | null; subject: string | null; snippet: string | null; received_at: string;
  action: 'ia' | 'guardado' | 'apagado' | 'filtrado'; notified: boolean; detail: string | null; thread_id: string | null; reply_status: string | null;
};
type Rule = { id: number; kind: 'from' | 'domain' | 'subject'; pattern: string; action: 'reply' | 'delete' | 'notify' | 'ignore'; active: boolean; hits: number };

const ACTIONS: Record<Rule['action'], { l: string; d: string; icon: typeof Bot; tone: 'cyan' | 'crit' | 'amber' | 'default' }> = {
  reply: { l: 'IA responde sempre', d: 'A IA deste número responde, mesmo que o contato não esteja marcado', icon: Bot, tone: 'cyan' },
  notify: { l: 'Avisar no WhatsApp', d: 'Manda um aviso no "Você" do número (ou pela IA central)', icon: Bell, tone: 'amber' },
  ignore: { l: 'Só guardar', d: 'Fica registrado aqui, mas a IA não responde', icon: Inbox, tone: 'default' },
  delete: { l: 'Apagar sempre', d: 'Vai direto para a lixeira (dá para recuperar no webmail)', icon: Trash2, tone: 'crit' },
};
const KINDS: Record<Rule['kind'], string> = { from: 'Remetente contém', domain: 'Domínio é', subject: 'Assunto contém' };
const MAIL_STATUS: Record<Mail['action'], { l: string; tone: 'cyan' | 'crit' | 'amber' | 'default' | 'ok' }> = {
  ia: { l: 'para a IA', tone: 'cyan' }, guardado: { l: 'só guardado', tone: 'default' }, filtrado: { l: 'filtrado', tone: 'default' }, apagado: { l: 'apagado', tone: 'crit' },
};

export function Email() {
  const accounts = useQuery<Account[]>({ queryKey: ['email-accounts'], queryFn: () => api('/api/email/accounts') });
  const [sel, setSel] = useState<string>(() => { try { return localStorage.getItem('cc.email.ia') ?? ''; } catch { return ''; } });
  const [tab, setTab] = useState<'caixa' | 'regras'>('caixa');
  const list = accounts.data ?? [];
  const cur = list.find((a) => a.instance === sel) ?? list[0];
  useEffect(() => { if (cur) { try { localStorage.setItem('cc.email.ia', cur.instance); } catch { /* ok */ } } }, [cur]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="E-mail" subtitle={cur ? <>Caixa de <b>{cur.persona.name}</b> · {cur.email}</> : 'O e-mail de cada IA, com as regras de cada uma.'}
        tabs={cur ? <>
          <Tab active={tab === 'caixa'} onClick={() => setTab('caixa')}>Caixa de entrada</Tab>
          <Tab active={tab === 'regras'} onClick={() => setTab('regras')}>Regras</Tab>
        </> : undefined}>
        {list.length > 0 && (
          <div className="glass flex gap-0.5 rounded-full! p-[3px]" role="group" aria-label="Qual IA">
            {list.map((a) => (
              <button key={a.instance} className="cc-chip" aria-pressed={cur?.instance === a.instance} onClick={() => setSel(a.instance)} title={a.email}>{a.persona.name}</button>
            ))}
          </div>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8">
        {accounts.isLoading ? <Skeleton /> : accounts.error ? <ErrorState error={accounts.error} retry={() => accounts.refetch()} /> : !cur ? (
          <EmptyState title="Nenhum e-mail conectado" text="Conecte o e-mail de cada IA em Configurações (Gmail pelo login do Google; outros e-mails com a senha)."
            action={<Link to="/configuracoes" className="text-cyan hover:underline">Ir para Configurações</Link>} />
        ) : (
          <>
            {!cur.canSend && (
              <p className="mt-3 rounded-[12px] border border-line bg-surface px-4 py-2.5 text-[13px] text-text-2">
                O provedor deste e-mail não deixa enviar a partir do servidor: as respostas da IA ficam prontas em <b>Rascunhos</b> do webmail, no mesmo fio, para enviar com um clique.
              </p>
            )}
            {tab === 'caixa' ? <MailBox acc={cur} onRules={() => setTab('regras')} /> : <Rules acc={cur} />}
          </>
        )}
      </div>
    </div>
  );
}

function useAddRule(instance: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: Pick<Rule, 'kind' | 'pattern' | 'action'>) => post(`/api/email/${instance}/rules`, r),
    onSuccess: (_r, v) => { toast(`Regra criada: ${KINDS[v.kind].toLowerCase()} "${v.pattern}" → ${ACTIONS[v.action].l.toLowerCase()}.`); void qc.invalidateQueries({ queryKey: ['email-rules', instance] }); },
    onError: toastError,
  });
}

function MailBox({ acc, onRules }: { acc: Account; onRules: () => void }) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  useEffect(() => { const t = setTimeout(() => setSearch(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const q = useQuery<{ items: Mail[]; stats: any }>({
    queryKey: ['emails', acc.instance, search, action],
    queryFn: () => api(`/api/email/${acc.instance}/messages?${new URLSearchParams({ ...(search && { q: search }), ...(action && { action }) })}`),
    refetchInterval: 60_000,
  });
  const add = useAddRule(acc.instance);
  const s = q.data?.stats ?? {};
  return (
    <div className="mt-4 space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {[['Hoje', s.today], ['Para a IA (7 d)', s.ia], ['Avisados (7 d)', s.notified], ['Só guardados (7 d)', s.kept], ['Apagados (7 d)', s.deleted]].map(([l, v]) => (
          <Card key={String(l)} className="px-4 py-3"><p className="text-[12px] text-text-2">{l}</p><p className="tabular mt-1 text-[24px] font-semibold leading-none">{v ?? 0}</p></Card>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="glass flex h-10 min-w-[260px] flex-1 items-center gap-2 rounded-full! px-3.5">
          <Search size={16} className="text-text-2" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar remetente, assunto ou texto" className="h-full w-full border-0 bg-transparent outline-none placeholder:text-text-2" />
        </label>
        <div className="glass flex gap-0.5 rounded-full! p-[3px]">
          {[['', 'Todos'], ['ia', 'Para a IA'], ['guardado', 'Guardados'], ['filtrado', 'Filtrados'], ['apagado', 'Apagados']].map(([v, l]) => (
            <button key={v} className="cc-chip" aria-pressed={action === v} onClick={() => setAction(v)}>{l}</button>
          ))}
        </div>
      </div>
      {q.isLoading ? <Skeleton /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !q.data?.items.length ? (
        <EmptyState title="Nenhum e-mail ainda" text="Os e-mails que chegarem a partir da conexão aparecem aqui, com o que a IA fez com cada um." />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {q.data.items.map((m) => <MailRow key={m.id} m={m} onRule={(kind, pattern, a) => add.mutate({ kind, pattern, action: a })} />)}
        </Card>
      )}
      <p className="text-[12px] text-text-2">Os botões de cada e-mail criam uma regra para aquele remetente. Para regras por domínio ou por assunto (ex.: avisar quando chegar "boleto"), use <button className="cursor-pointer text-cyan hover:underline" onClick={onRules}>Regras</button>.</p>
    </div>
  );
}

function MailRow({ m, onRule }: { m: Mail; onRule: (kind: Rule['kind'], pattern: string, a: Rule['action']) => void }) {
  const [open, setOpen] = useState(false);
  const st = MAIL_STATUS[m.action];
  const domain = m.from_email?.split('@')[1];
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-cyan/15 font-semibold text-cyan">{(m.from_name || m.from_email || '?')[0].toUpperCase()}</span>
        <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setOpen((o) => !o)}>
          <p className="flex flex-wrap items-center gap-2">
            <b className="truncate">{m.from_name || m.from_email}</b>
            {m.from_name && <span className="truncate text-[12px] text-text-2">{m.from_email}</span>}
            <span className="ml-auto text-[12px] whitespace-nowrap text-text-2">{timeAgo(m.received_at)}</span>
          </p>
          <p className="truncate text-[13.5px]">{m.subject || '(sem assunto)'}</p>
          <p className={cx('text-[12.5px] text-text-2', !open && 'truncate')}>{m.snippet}</p>
          <p className="mt-1.5 flex flex-wrap gap-1">
            <Pill tone={st.tone}>{st.l}</Pill>
            {m.notified && <Pill tone="amber">avisado no WhatsApp</Pill>}
            {m.reply_status === 'SENT' && <Pill tone="ok">respondido</Pill>}
            {m.reply_status === 'DRAFT' && <Pill tone="amber">resposta em rascunho</Pill>}
            {m.detail && <span className="text-[11.5px] text-text-2">{m.detail}</span>}
          </p>
        </button>
      </div>
      {open && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-12">
          {m.thread_id && <Link to="/conversas/$id" params={{ id: m.thread_id } as any} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] hover:bg-[var(--hover)]"><MessageSquare size={14} />Abrir conversa</Link>}
          {m.from_email && (Object.keys(ACTIONS) as Rule['action'][]).map((a) => {
            const A = ACTIONS[a];
            return <Button key={a} size="sm" icon={<A.icon size={14} />} onClick={() => onRule('from', m.from_email!, a)} title={A.d}>{A.l}</Button>;
          })}
          {domain && <Button size="sm" variant="ghost" onClick={() => onRule('domain', domain, 'notify')} title={`Avisar no WhatsApp quando chegar qualquer e-mail de @${domain}`}>Avisar tudo de @{domain}</Button>}
        </div>
      )}
    </div>
  );
}

function Rules({ acc }: { acc: Account }) {
  const qc = useQueryClient();
  const q = useQuery<Rule[]>({ queryKey: ['email-rules', acc.instance], queryFn: () => api(`/api/email/${acc.instance}/rules`) });
  const add = useAddRule(acc.instance);
  const [f, setF] = useState<Pick<Rule, 'kind' | 'pattern' | 'action'>>({ kind: 'from', pattern: '', action: 'notify' });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['email-rules', acc.instance] });
  const toggle = useMutation({ mutationFn: (r: Rule) => patch(`/api/email/${acc.instance}/rules/${r.id}`, { active: !r.active }), onSuccess: refresh, onError: toastError });
  const remove = useMutation({ mutationFn: (r: Rule) => del(`/api/email/${acc.instance}/rules/${r.id}`), onSuccess: () => { toast('Regra apagada.'); refresh(); }, onError: toastError });
  const SUGG: Array<Pick<Rule, 'kind' | 'pattern' | 'action'>> = [
    { kind: 'subject', pattern: 'boleto', action: 'notify' }, { kind: 'subject', pattern: 'nota fiscal', action: 'notify' },
    { kind: 'subject', pattern: 'pagamento', action: 'notify' }, { kind: 'subject', pattern: 'urgente', action: 'notify' },
    { kind: 'subject', pattern: 'orçamento', action: 'reply' }, { kind: 'subject', pattern: 'newsletter', action: 'delete' },
  ];
  return (
    <div className="mt-4 space-y-3">
      <Card className="p-4">
        <p className="mb-2 font-semibold">Nova regra para {acc.persona.name}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-text-2">Quando</span>
          <select className={cx(inputCls, 'w-auto!')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Rule['kind'] })}>
            {(Object.keys(KINDS) as Rule['kind'][]).map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}
          </select>
          <input className={cx(inputCls, 'min-w-[200px] flex-1')} placeholder={f.kind === 'from' ? 'ex.: financeiro@banco.com' : f.kind === 'domain' ? 'ex.: mercadopago.com' : 'ex.: boleto'} value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} />
          <span className="text-[13px] text-text-2">então</span>
          <select className={cx(inputCls, 'w-auto!')} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as Rule['action'] })}>
            {(Object.keys(ACTIONS) as Rule['action'][]).map((a) => <option key={a} value={a}>{ACTIONS[a].l}</option>)}
          </select>
          <Button variant="primary" disabled={f.pattern.trim().length < 2} busy={add.isPending} onClick={() => add.mutate(f, { onSuccess: () => setF({ ...f, pattern: '' }) })}>Adicionar</Button>
        </div>
        <p className="mt-2 text-[12px] text-text-2">{ACTIONS[f.action].d}.</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="text-[12px] text-text-2">Sugestões:</span>
          {SUGG.map((s) => (
            <button key={s.pattern + s.action} className="cursor-pointer rounded-full border border-line px-2.5 py-0.5 text-[12px] text-text-2 hover:text-text" onClick={() => add.mutate(s)}>
              {KINDS[s.kind].split(' ')[0]} “{s.pattern}” → {ACTIONS[s.action].l.toLowerCase()}
            </button>
          ))}
        </div>
      </Card>
      {q.isLoading ? <Skeleton /> : !q.data?.length ? (
        <EmptyState title="Nenhuma regra ainda" text="Sem regras, a IA segue o que está em IAs → Cada IA (todos ou só os marcados) e newsletters ficam só guardadas." />
      ) : (
        <Card className="divide-y divide-line overflow-hidden">
          {q.data.map((r) => {
            const A = ACTIONS[r.action];
            return (
              <div key={r.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', !r.active && 'opacity-50')}>
                <A.icon size={18} className="text-text-2" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px]">{KINDS[r.kind]} <b>“{r.pattern}”</b> → <Pill tone={A.tone}>{A.l}</Pill></p>
                  <p className="text-[12px] text-text-2">{r.hits ? `usada ${r.hits} ${r.hits === 1 ? 'vez' : 'vezes'}` : 'ainda não usada'}</p>
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px]"><input type="checkbox" className="size-4 accent-cyan" checked={r.active} onChange={() => toggle.mutate(r)} />ativa</label>
                <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => { if (confirm('Apagar esta regra?')) remove.mutate(r); }}>Apagar</Button>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
