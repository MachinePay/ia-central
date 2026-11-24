/**
 * PrimePlush (loja de pelucias): catalogo publico (/api/menu), pedido direto (/api/orders, sem orcamento no sistema)
 * e o PDF do pedido (/api/orders/:id/receipt-pdf). O relatorio de vendas usa o login de admin (PRIMEPLUSH_ADMIN_SENHA).
 */
const BASE = () => (process.env.PRIMEPLUSH_API_URL || 'https://backendprimeplush.onrender.com').replace(/\/$/, '');
const brl = (n: number) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export type PpProduto = { id: string; name: string; price: number; category?: string | null; stock: number | null; isAvailable?: boolean; active?: boolean; description?: string | null };

let cache: { at: number; list: PpProduto[] } | undefined;
export async function produtosPrimeplush(): Promise<PpProduto[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.list;
  const r = await fetch(`${BASE()}/api/menu`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`catálogo PrimePlush respondeu ${r.status}`);
  const list = ((await r.json()) as PpProduto[]).filter((p) => p.active !== false);
  cache = { at: Date.now(), list };
  return list;
}

const disponivel = (p: PpProduto) => p.isAvailable !== false && (p.stock === null || p.stock > 0);
export function produtoLinhaPp(p: PpProduto): string {
  return `${p.name} · ${p.category ?? 'sem categoria'} · ${brl(p.price)} a unidade`
    + (p.stock === null ? '' : disponivel(p) ? ` · ${p.stock} em estoque` : ' · ESGOTADO');
}

/** Busca por nome/categoria (todas as palavras; se nada bater, qualquer palavra, com os que batem mais primeiro). */
export async function catalogoPrimeplush(busca?: string, categoria?: string): Promise<PpProduto[]> {
  let list = await produtosPrimeplush();
  if (categoria) list = list.filter((p) => norm(p.category ?? '').includes(norm(categoria)));
  if (!busca) return list;
  const ws = norm(busca).split(/\s+/).filter((w) => w.length > 1 && !/^(de|da|do|com|para|unidade|unidades)$/.test(w));
  const txt = (p: PpProduto) => norm(`${p.name} ${p.category ?? ''} ${p.description ?? ''}`);
  const all = list.filter((p) => ws.every((w) => txt(p).includes(w)));
  if (all.length) return all;
  const pts = (p: PpProduto) => ws.filter((w) => txt(p).includes(w)).length;
  return list.filter((p) => pts(p) > 0).sort((a, b) => pts(b) - pts(a)).slice(0, 15);
}

export async function acharProdutoPp(ref: string): Promise<PpProduto | { varios: string[] } | undefined> {
  const list = await produtosPrimeplush();
  const byId = list.find((p) => String(p.id) === ref.trim());
  if (byId) return byId;
  const exact = list.filter((p) => norm(p.name) === norm(ref));
  if (exact.length === 1) return exact[0];
  const r = await catalogoPrimeplush(ref);
  if (r.length === 1) return r[0];
  if (r.length > 1) return { varios: r.slice(0, 8).map(produtoLinhaPp) };
  return undefined;
}

export type ItemPp = { produto: string; quantidade: number };
export type OrcamentoPp = { itens: Array<{ id: string; nome: string; quantidade: number; preco: number; total: number }>; total: number; resumo: string };

/** Orcamento (calculado aqui, a PrimePlush nao tem orcamento no sistema) com os precos do catalogo. */
export async function orcarPrimeplush(itens: ItemPp[]): Promise<OrcamentoPp | { erro: string }> {
  const out: OrcamentoPp['itens'] = [];
  for (const it of itens) {
    const p = await acharProdutoPp(it.produto);
    if (!p) return { erro: `Não achei "${it.produto}" no catálogo da PrimePlush.` };
    if ('varios' in p) return { erro: `"${it.produto}" bate com mais de um produto, escolha um: ${p.varios.join(' | ')}` };
    if (p.stock !== null && p.stock < it.quantidade) return { erro: `${p.name}: só tem ${Math.max(0, p.stock)} em estoque (pediu ${it.quantidade}).` };
    out.push({ id: String(p.id), nome: p.name, quantidade: it.quantidade, preco: p.price, total: Math.round(p.price * it.quantidade * 100) / 100 });
  }
  const total = Math.round(out.reduce((s, i) => s + i.total, 0) * 100) / 100;
  const resumo = `${out.map((i) => `${i.quantidade}x ${i.nome} (${brl(i.preco)} cada) = ${brl(i.total)}`).join('; ')} · total ${brl(total)}`;
  return { itens: out, total, resumo };
}

export type PedidoPp = { id: string; total: number; status?: string };

/** Cria o pedido (reserva o estoque; o pagamento e a entrega a loja combina). Cliente identificado pelo CPF/CNPJ. */
export async function criarPedidoPrimeplush(o: { itens: OrcamentoPp['itens']; total: number; nome: string; documento: string; observacao?: string; pagamento?: string }): Promise<PedidoPp> {
  const doc = o.documento.replace(/\D/g, '');
  if (doc.length !== 11 && doc.length !== 14) throw new Error('CPF ou CNPJ inválido.');
  const r = await fetch(`${BASE()}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      userId: `ia_${doc}`, userName: o.nome, userDoc: doc,
      items: o.itens.map((i) => ({ id: i.id, name: i.nome, quantity: i.quantidade, price: i.preco })),
      total: o.total, paymentMethod: o.pagamento || undefined,
      observation: o.observacao ?? 'Pedido feito pela IA (WhatsApp).',
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PrimePlush: ${String(j.error ?? j.message ?? r.status).slice(0, 200)}`);
  cache = undefined; // estoque mudou
  return { id: j.id, total: Number(j.total ?? o.total), status: j.status };
}

export const pdfPedidoUrl = (id: string) => `${BASE()}/api/orders/${encodeURIComponent(id)}/receipt-pdf`;

/** PDF do pedido gerado pelo proprio sistema da PrimePlush. */
export async function pdfPedidoPrimeplush(id: string): Promise<Buffer> {
  const r = await fetch(pdfPedidoUrl(id), { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`PDF do pedido respondeu ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ------------------------------------------------------------------ relatorio (admin)
export const primeplushAdmin = () => !!process.env.PRIMEPLUSH_ADMIN_SENHA;
let token: { v: string; at: number } | undefined;
async function adminToken(): Promise<string> {
  if (token && Date.now() - token.at < 7 * 3600_000) return token.v;
  if (!primeplushAdmin()) throw new Error('PrimePlush sem a senha de admin (falta PRIMEPLUSH_ADMIN_SENHA no Render)');
  const r = await fetch(`${BASE()}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin', password: process.env.PRIMEPLUSH_ADMIN_SENHA }), signal: AbortSignal.timeout(60_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error(`login de admin na PrimePlush recusado (${r.status})`);
  token = { v: j.token, at: Date.now() };
  return j.token;
}

/** Faturamento, pedidos, ticket medio, mais vendidos e alertas de estoque no periodo. */
export async function relatorioPrimeplush(inicio: Date, fim: Date) {
  const qs = new URLSearchParams({ startAt: inicio.toISOString(), endAt: fim.toISOString() });
  const r = await fetch(`${BASE()}/api/admin/management-report?${qs}`, { headers: { authorization: `Bearer ${await adminToken()}` }, signal: AbortSignal.timeout(90_000) });
  if (r.status === 401 || r.status === 403) token = undefined;
  if (!r.ok) throw new Error(`relatório da PrimePlush respondeu ${r.status}`);
  const j: any = await r.json();
  const s = j.summary ?? {};
  return {
    faturamento: brl(s.totalRevenue ?? 0), pedidos: s.successfulOrders ?? s.totalOrders, cancelados: s.canceledOrders, pendentes: s.pendingOrders,
    itens_vendidos: s.totalItemsSold, ticket_medio: brl(s.averageTicket ?? 0),
    a_pagar_girakids: brl(s.totalToPayGiraKids ?? 0), pago_girakids: brl(s.totalPaidToGiraKids ?? 0),
    mais_vendidos: (j.analytics?.topProductsByVolume ?? []).slice(0, 8).map((p: any) => `${p.name ?? p.nome}: ${p.quantity ?? p.quantidade ?? p.total ?? ''}`),
    alertas_estoque: (j.analytics?.stockAlerts ?? []).slice(0, 10).map((p: any) => `${p.name ?? p.nome}: ${p.stock ?? p.estoque ?? ''}`),
  };
}
