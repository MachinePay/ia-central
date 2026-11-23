import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { AGENTS, timeAgo, type AgentKey } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { AgentAvatar, Button, Card, cx, EmptyState, ErrorState, PageHeader, Pill, Skeleton, Tab } from '../ui';

const ACTION: Record<string, string> = {
  DISCOUNT: 'Desconto acima da tabela', CUSTOM_TERM: 'Condição fora do padrão', CONTRACT: 'Contrato',
  DEADLINE: 'Prazo de desenvolvimento', REFUND: 'Reembolso / cancelamento', PAYMENT_LINK: 'Fechar pedido',
};

export function Approvals() {
  const [tab, setTab] = useState<'PENDING' | 'ALL'>('PENDING');
  const q = useQuery({ queryKey: ['approvals', tab], queryFn: () => api(`/api/approvals?status=${tab}`) });
  const [focus, setFocus] = useState(0);
  const pending = (q.data ?? []) as any[];
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Aprovações" accent="var(--amber)"
        tabs={<><Tab active={tab === 'PENDING'} onClick={() => setTab('PENDING')} count={tab === 'PENDING' ? pending.length : undefined}>Pendentes</Tab><Tab active={tab === 'ALL'} onClick={() => setTab('ALL')}>Histórico</Tab></>}>
        <span className="text-[12px] text-text-2">Atalhos: 1 aprovar · 2 editar · 3 recusar</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {q.isLoading ? <Skeleton /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : pending.length === 0 ? (
          <EmptyState title="Nenhuma aprovação pendente." text="Quando um agente pedir um desconto, prazo especial, reembolso ou fechamento de pedido, ele aparece aqui e no seu WhatsApp." />
        ) : (
          <div className="mx-auto max-w-[880px] space-y-3">
            {pending.map((a, i) => <ApprovalCard key={a.id} a={a} focused={i === focus} onFocus={() => setFocus(i)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ a, focused, onFocus }: { a: any; focused: boolean; onFocus: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.draft_reply);
  const decide = useMutation({
    mutationFn: (body: { decision: string; text?: string }) => post(`/api/approvals/${a.id}/decide`, body),
    onMutate: async () => {
      // otimista: o cartao sai da fila na hora; volta se o servidor recusar
      await qc.cancelQueries({ queryKey: ['approvals', 'PENDING'] });
      const prev = qc.getQueryData(['approvals', 'PENDING']);
      qc.setQueryData(['approvals', 'PENDING'], (old: any[] | undefined) => old?.filter((x) => x.id !== a.id));
      return { prev };
    },
    onError: (e, _v, ctx) => { qc.setQueryData(['approvals', 'PENDING'], ctx?.prev); toastError(e); },
    onSuccess: (_d, v) => toast(v.decision === 'REJECT' ? 'Recusado; o cliente recebeu uma alternativa educada.' : 'Aprovado e enviado.'),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['approvals'] }); void qc.invalidateQueries({ queryKey: ['summary'] }); },
  });
  const isPending = a.status === 'PENDING';
  useEffect(() => {
    if (!focused || !isPending) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return;
      if (e.key === '1') decide.mutate({ decision: 'APPROVE' });
      if (e.key === '2') setEditing(true);
      if (e.key === '3') decide.mutate({ decision: 'REJECT' });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const expires = new Date(new Date(a.created_at).getTime() + 24 * 3600_000);
  return (
    <Card className={cx('p-4', focused && isPending && 'border-amber/60')}>
      <div onMouseEnter={onFocus} onFocus={onFocus}>
        <div className="flex flex-wrap items-center gap-2">
          <AgentAvatar agent={a.requested_by} />
          <span className="font-semibold">{AGENTS[a.requested_by as AgentKey]?.name}</span>
          <span className="text-text-2">pediu</span>
          <Pill tone="amber">{ACTION[a.action] ?? a.action}</Pill>
          <span className="tabular text-text-2">{a.code}</span>
          <span className="ml-auto text-[12px] text-text-2">{timeAgo(a.created_at)}{isPending ? ` · expira ${timeAgo(expires)}` : ` · ${a.status.toLowerCase()}`}</span>
        </div>
        <p className="mt-2">
          <Link to="/conversas/$id" params={{ id: a.thread_id }} className="font-semibold text-cyan">{a.contact}</Link>
          {a.company && <span className="text-text-2"> · {a.company}</span>}<span className="text-text-2"> · {a.crm_stage} · {a.channel === 'GMAIL' ? 'Gmail' : `WhatsApp ${a.instance}`}</span>
        </p>
        <p className="mt-1 font-mono text-[12px] text-text-2">{JSON.stringify(a.payload)}</p>
        {a.summary && <p className="mt-2 line-clamp-3 text-[13px] text-text-2">{a.summary}</p>}
        <div className="mt-3 rounded-[6px] border border-line bg-bg p-3">
          <p className="mb-1 text-[12px] font-semibold text-text-2">Resposta que vai para o cliente</p>
          {editing ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus className="w-full rounded-[6px] border border-line bg-surface p-2 text-[16px]" />
            : <p className="text-[16px] whitespace-pre-wrap">{a.draft_reply}</p>}
        </div>
        {isPending && (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="danger" onClick={() => decide.mutate({ decision: 'REJECT' })}>Recusar</Button>
            {editing ? <Button variant="primary" onClick={() => decide.mutate({ decision: 'EDIT', text })}>Enviar editado</Button>
              : <Button onClick={() => setEditing(true)}>Editar e enviar</Button>}
            {!editing && <Button variant="primary" onClick={() => decide.mutate({ decision: 'APPROVE' })}>Aprovar e enviar</Button>}
          </div>
        )}
      </div>
    </Card>
  );
}
