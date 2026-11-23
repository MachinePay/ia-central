import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, del, post, put } from '../lib/api';
import { AGENTS, usd, type AgentKey } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { Button, Card, cx, ErrorState, Field, inputCls, PageHeader, Pill, Skeleton, Stat } from '../ui';
import { TimeChart } from '../ui/Chart';

export function Costs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['costs'], queryFn: () => api('/api/costs') });
  const [budget, setBudget] = useState('');
  const saveBudget = useMutation({ mutationFn: (v: number) => put('/api/costs/budget', { provider: 'TOTAL', monthly_usd: v }), onSuccess: () => { toast('Orçamento salvo.'); void qc.invalidateQueries({ queryKey: ['costs'] }); }, onError: toastError });
  const chart = useMemo(() => {
    const s = q.data?.summary;
    if (!s?.daily?.length) return null;
    const now = new Date();
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const x: number[] = [];
    const acc: Array<number | null> = [];
    const proj: Array<number | null> = [];
    const bud: number[] = [];
    let total = 0;
    const byDay = Object.fromEntries(s.daily.map((d: any) => [Number(d.day.slice(8, 10)), d.usd]));
    const last = Math.max(...Object.keys(byDay).map(Number));
    const avg = last ? (s.projection - s.monthToDate) / Math.max(1, days - last) : 0;
    for (let d = 1; d <= days; d++) {
      x.push(Date.UTC(now.getFullYear(), now.getMonth(), d) / 1000);
      if (d <= last) { total += byDay[d] ?? 0; acc.push(total); proj.push(d === last ? total : null); }
      else { acc.push(null); proj.push(s.monthToDate + avg * (d - last)); }
      bud.push(s.budget);
    }
    return { x, series: [
      { label: 'Gasto acumulado', values: acc, color: '#A796E8', fill: true },
      { label: 'Projeção', values: proj, color: '#A796E8', dash: true },
      { label: 'Orçamento', values: bud, color: '#F2B33D', dash: true },
    ] };
  }, [q.data]);
  if (q.isLoading) return <Skeleton lines={8} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { summary: s, byAgent, byContact, priceBook, fixed, renderServices } = q.data;
  const over = s.projection > s.budget;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Custos" accent="var(--lilac)">
        {over && <Pill tone="amber">projeção acima do orçamento</Pill>}
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (budget) saveBudget.mutate(Number(budget)); }}>
          <input className={cx(inputCls, 'w-32!')} type="number" min={0} placeholder={`Orçamento ${s.budget}`} value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Orçamento mensal em dólar" />
          <Button size="sm" type="submit">Salvar orçamento</Button>
        </form>
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Mês até agora" value={usd(s.monthToDate)} hint={`orçamento ${usd(s.budget, 0)}`} />
          <Stat label="Projeção de fechamento" value={usd(s.projection)} tone={over ? 'var(--warn)' : undefined} hint="média dos últimos 7 dias" />
          <Stat label="Hoje" value={usd(s.today)} />
          <Stat label="IA no mês" value={usd(byAgent.reduce((a: number, b: any) => a + b.usd, 0))} hint="medido em cada execução" />
        </div>
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Gasto acumulado do mês</h2>
          {chart ? <TimeChart x={chart.x} series={chart.series} height={220} label="Gasto acumulado do mês com projeção e orçamento" /> : <p className="text-text-2">O gráfico aparece depois do primeiro cálculo (a cada hora).</p>}
          <p className="mt-2 text-[12px] text-text-2">IA é medido. Render e custos fixos são estimativas pela tabela de preços abaixo; ajuste os valores para bater com a fatura.</p>
        </Card>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-4">
            <h2 className="mb-2 font-semibold">Por provedor</h2>
            <Bars rows={s.byProvider.map((p: any) => ({ label: p.provider, value: p.usd }))} />
          </Card>
          <Card className="p-4">
            <h2 className="mb-2 font-semibold">IA por agente</h2>
            <Bars rows={byAgent.map((a: any) => ({ label: AGENTS[a.agent as AgentKey]?.name ?? a.agent, value: a.usd }))} digits={3} />
          </Card>
          <Card className="p-4">
            <h2 className="mb-2 font-semibold">IA por cliente</h2>
            <Bars rows={byContact.slice(0, 8).map((c: any) => ({ label: c.contact, value: c.usd }))} digits={3} />
          </Card>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <PriceBook priceBook={priceBook} renderServices={renderServices} unpriced={s.unpricedPlans} />
          <FixedCosts fixed={fixed} />
        </div>
      </div>
    </div>
  );
}

function Bars({ rows, digits = 2 }: { rows: Array<{ label: string; value: number }>; digits?: number }) {
  if (!rows.length) return <p className="text-text-2">Sem dados ainda.</p>;
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex text-[13px]"><span className="truncate">{r.label}</span><span className="tabular ml-auto pl-2 font-semibold">{usd(r.value, digits)}</span></div>
          <div className="mt-1 h-1.5 rounded bg-line"><div className="h-1.5 rounded bg-lilac" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function PriceBook({ priceBook, renderServices, unpriced }: { priceBook: any[]; renderServices: any[]; unpriced: string[] }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Record<string, string>>({});
  const save = useMutation({ mutationFn: (b: any) => put('/api/costs/price', b), onSuccess: () => { toast('Preço salvo. O custo é recalculado na próxima hora.'); void qc.invalidateQueries({ queryKey: ['costs'] }); }, onError: toastError });
  const plans = [...new Set([...priceBook.filter((p) => p.provider === 'RENDER').map((p) => p.item), ...unpriced])];
  const count = (plan: string) => renderServices.filter((r) => r.plan === plan).length;
  return (
    <Card className="p-4">
      <h2 className="mb-1 font-semibold">Preços da Render (US$/mês)</h2>
      <p className="mb-3 text-[12px] text-text-2">Planos sem preço contam como zero. Confira em render.com/pricing.</p>
      <table className="w-full text-[13px]">
        <tbody>
          {plans.map((plan) => {
            const p = priceBook.find((x) => x.provider === 'RENDER' && x.item === plan);
            return (
              <tr key={plan} className="border-t border-line">
                <td className="py-1.5">{plan} {!p && <Pill tone="amber">sem preço</Pill>}</td>
                <td className="tabular text-text-2">{count(plan)} serviço(s)</td>
                <td className="w-40 py-1.5">
                  <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); save.mutate({ provider: 'RENDER', item: plan, usd_per_month: Number(edit[plan]) }); }}>
                    <input type="number" step="0.01" min={0} className={cx(inputCls, 'h-7! text-[12px]')} placeholder={p ? String(Number(p.usd_per_month)) : '0'} value={edit[plan] ?? ''} onChange={(e) => setEdit({ ...edit, [plan]: e.target.value })} aria-label={`Preço do plano ${plan}`} />
                    <Button size="sm" type="submit" disabled={!edit[plan]}>Ok</Button>
                  </form>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function FixedCosts({ fixed }: { fixed: any[] }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', usd: '' });
  const add = useMutation({ mutationFn: () => post('/api/costs/fixed', { name: f.name, usd_per_month: Number(f.usd) }), onSuccess: () => { setF({ name: '', usd: '' }); void qc.invalidateQueries({ queryKey: ['costs'] }); }, onError: toastError });
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/costs/fixed/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['costs'] }) });
  return (
    <Card className="p-4">
      <h2 className="mb-1 font-semibold">Custos fixos (US$/mês)</h2>
      <p className="mb-3 text-[12px] text-text-2">Vercel Pro, domínios, servidor, chips... entram na projeção.</p>
      <ul className="mb-3 divide-y divide-line">
        {fixed.map((x) => (
          <li key={x.id} className="flex items-center py-1.5 text-[13px]"><span>{x.name}</span><span className="tabular ml-auto pr-2 font-semibold">{usd(x.usd_per_month)}</span>
            <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => remove.mutate(x.id)}><Trash2 size={13} /></Button></li>
        ))}
        {!fixed.length && <li className="py-1.5 text-text-2">Nenhum cadastrado.</li>}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Field label="Nome"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="US$/mês"><input type="number" step="0.01" min={0} className={inputCls} value={f.usd} onChange={(e) => setF({ ...f, usd: e.target.value })} /></Field>
        <Button className="self-end" type="submit" icon={<Plus size={14} />} disabled={!f.name || !f.usd}>Adicionar</Button>
      </form>
    </Card>
  );
}
