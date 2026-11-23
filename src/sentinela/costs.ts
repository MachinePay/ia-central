import { one, q } from '../lib/db.js';
import { env } from '../lib/env.js';
import { publish } from '../lib/events.js';
import { todayIn } from '../lib/util.js';
import { clear, raise } from './incidents.js';

/**
 * Custos por dia, de tres fontes:
 *  - LLM: medido (soma de app.agent_runs.cost_usd)
 *  - Render/Vercel: estimado (servicos ativos x tabela de precos / dias do mes)
 *  - Fixos: cadastrados no painel
 */
export async function computeCostsToday() {
  const day = todayIn(env.TIMEZONE);
  const daysInMonth = new Date(+day.slice(0, 4), +day.slice(5, 7), 0).getDate();

  await q(
    `INSERT INTO sentinela.cost_entries (provider, project, day, amount_usd, kind)
     SELECT 'LLM', a.agent::text, $1::date, coalesce(sum(a.cost_usd), 0), 'MEASURED'
       FROM app.agent_runs a WHERE (a.created_at AT TIME ZONE $2)::date = $1::date GROUP BY a.agent
     ON CONFLICT (provider, project, day, kind) DO UPDATE SET amount_usd = EXCLUDED.amount_usd`,
    [day, env.TIMEZONE],
  );
  // Render: plano de cada servico ativo
  await q(
    `INSERT INTO sentinela.cost_entries (provider, project, day, amount_usd, kind)
     SELECT 'RENDER', r.name, $1::date, coalesce(p.usd_per_month, 0) / $2, 'ESTIMATED'
       FROM sentinela.resources r LEFT JOIN sentinela.price_book p ON p.provider = 'RENDER' AND p.item = r.meta->>'plan'
      WHERE r.source = 'RENDER' AND r.status <> 'SUSPENDED'
     ON CONFLICT (provider, project, day, kind) DO UPDATE SET amount_usd = EXCLUDED.amount_usd`,
    [day, daysInMonth],
  );
  await q(
    `INSERT INTO sentinela.cost_entries (provider, project, day, amount_usd, kind)
     SELECT 'FIXO', f.name, $1::date, f.usd_per_month / $2, 'ESTIMATED' FROM sentinela.fixed_costs f WHERE f.active
     ON CONFLICT (provider, project, day, kind) DO UPDATE SET amount_usd = EXCLUDED.amount_usd`,
    [day, daysInMonth],
  );
  await publish('cost.updated', { day });
}

export type CostSummary = {
  monthToDate: number; projection: number; budget: number; today: number;
  byProvider: Array<{ provider: string; usd: number }>;
  daily: Array<{ day: string; usd: number }>;
  unpricedPlans: string[];
};

export async function costSummary(): Promise<CostSummary> {
  const day = todayIn(env.TIMEZONE);
  const first = `${day.slice(0, 8)}01`;
  const daysInMonth = new Date(+day.slice(0, 4), +day.slice(5, 7), 0).getDate();
  const dayOfMonth = +day.slice(8, 10);
  const byProvider = await q<{ provider: string; usd: string }>(
    `SELECT provider, sum(amount_usd) usd FROM sentinela.cost_entries WHERE day >= $1 GROUP BY provider ORDER BY 2 DESC`, [first],
  );
  const daily = await q<{ day: string; usd: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(amount_usd) usd FROM sentinela.cost_entries WHERE day >= $1 GROUP BY day ORDER BY day`, [first],
  );
  const last7 = await one<{ avg: string }>(
    `SELECT coalesce(avg(t), 0) avg FROM (SELECT day, sum(amount_usd) t FROM sentinela.cost_entries
       WHERE day > $1::date - 7 AND day <= $1::date GROUP BY day) x`, [day],
  );
  const budget = await one<{ monthly_usd: string }>(`SELECT monthly_usd FROM sentinela.budgets WHERE provider = 'TOTAL'`);
  const unpriced = await q<{ plan: string }>(
    `SELECT DISTINCT r.meta->>'plan' AS plan FROM sentinela.resources r
      LEFT JOIN sentinela.price_book p ON p.provider = 'RENDER' AND p.item = r.meta->>'plan'
      WHERE r.source = 'RENDER' AND r.status <> 'SUSPENDED' AND r.meta->>'plan' IS NOT NULL AND p.item IS NULL`,
  );
  const monthToDate = byProvider.reduce((s, r) => s + Number(r.usd), 0);
  const today = Number(daily.find((d) => d.day === day)?.usd ?? 0);
  return {
    monthToDate,
    projection: monthToDate + Number(last7?.avg ?? 0) * (daysInMonth - dayOfMonth),
    budget: Number(budget?.monthly_usd ?? env.MONTHLY_BUDGET_USD),
    today,
    byProvider: byProvider.map((r) => ({ provider: r.provider, usd: Number(r.usd) })),
    daily: daily.map((d) => ({ day: d.day, usd: Number(d.usd) })),
    unpricedPlans: unpriced.map((u) => u.plan),
  };
}

/** Regras de custo: projecao acima do orcamento, gasto real perto do limite, LLM disparado. */
export async function checkCostRules() {
  const s = await costSummary();
  const fmt = (n: number) => `US$ ${n.toFixed(2)}`;
  if (s.monthToDate > s.budget * 0.9) {
    await raise({ ruleId: 'cost-budget', source: 'COST', resourceId: 'cost:total', severity: 'CRITICAL', title: `Gasto do mês em ${fmt(s.monthToDate)} (orçamento ${fmt(s.budget)})` });
  } else if (s.projection > s.budget) {
    await raise({ ruleId: 'cost-projection', source: 'COST', resourceId: 'cost:total', severity: 'WARNING', title: `Projeção do mês ${fmt(s.projection)} acima do orçamento ${fmt(s.budget)}` });
  } else {
    await clear('cost-projection', 'cost:total');
    await clear('cost-budget', 'cost:total');
  }
  const llm = await one<{ today: string; avg: string }>(
    `SELECT coalesce(sum(amount_usd) FILTER (WHERE day = current_date), 0) today,
            coalesce(sum(amount_usd) FILTER (WHERE day < current_date AND day >= current_date - 14), 0) / 14 avg
       FROM sentinela.cost_entries WHERE provider = 'LLM'`,
  );
  const today = Number(llm?.today ?? 0);
  const avg = Number(llm?.avg ?? 0);
  if (avg > 0.05 && today > avg * 3) {
    await raise({ ruleId: 'cost-llm-spike', source: 'COST', resourceId: 'cost:llm', severity: 'CRITICAL', title: `Gasto com IA hoje ${fmt(today)}, 3× acima da média (${fmt(avg)}/dia)`, detail: 'Pode ser loop ou abuso: confira a tela de Agentes.' });
  } else {
    await clear('cost-llm-spike', 'cost:llm');
  }
}

export function formatCosts(s: CostSummary): string {
  const fmt = (n: number) => `US$ ${n.toFixed(2)}`;
  return [
    `💰 Custos · ${new Intl.DateTimeFormat('pt-BR', { timeZone: env.TIMEZONE, day: '2-digit', month: '2-digit' }).format(new Date())}`,
    `Mês até agora: ${fmt(s.monthToDate)} (orçamento ${fmt(s.budget)})`,
    `Projeção de fechamento: ${fmt(s.projection)}`,
    s.byProvider.length ? `• ${s.byProvider.map((p) => `${p.provider}: ${fmt(p.usd)}`).join(' · ')}` : '',
    s.unpricedPlans.length ? `Sem preço cadastrado: planos ${s.unpricedPlans.join(', ')} (ajuste em Custos no painel)` : '',
    'Render e fixos são estimativas.',
  ].filter(Boolean).join('\n');
}
