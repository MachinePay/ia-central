import { env } from '../lib/env.js';

/**
 * Girakids (loja de brinquedos no atacado): catalogo publico (precos, pacotes, estoque) para todas as IAs
 * e, com login (GIRAKIDS_EMAIL / GIRAKIDS_SENHA), vendas e boletos para o dono.
 */
export type GkProduto = {
  id: string; sku: string; nome: string; descricao?: string | null; categoria: string; precoVenda: number; precoOriginal?: number | null;
  blackFriday?: boolean; unidadesPacote: number; estoque: number; disponivel: boolean; modoVenda?: string; imagemUrl?: string | null;
};

const BASE = () => env.GIRAKIDS_API_URL.replace(/\/$/, '');
export const LOJA_URL = 'https://girakidsfrontend.vercel.app';

export const COMO_PEDIR = [
  'Girakids: brinquedos e insumos no atacado para máquinas de grua e vending (bolinhas, cápsulas, brinquedos de cápsula, pelúcias, peças e máquinas).',
  'Preço do catálogo é por UNIDADE; a venda é em PACOTES. Total = preço unitário x unidades do pacote x quantidade de pacotes.',
  'Não tem pedido mínimo; cada item é no mínimo 1 pacote. Produto esgotado não entra no pedido (só os sob encomenda).',
  `Pedido pelo site: ${LOJA_URL}/catalogo -> escolhe os produtos -> carrinho (${LOJA_URL}/checkout) -> entrega -> pagamento -> confirma. Precisa de cadastro com CPF ou CNPJ.`,
  'Entrega: retirar na loja (grátis, Av. Cachoeira Paulista, 17), transportadora (combinada com o comercial), Correios PAC/SEDEX ou Braspress (o site calcula pelo CEP).',
  'Pagamento: PIX ou cartão pelo site, link de cartão enviado pelo comercial, ou "combinar com o comercial". Cartão de crédito tem taxa conforme as parcelas.',
  'Se preferir, o comercial monta o pedido pelo WhatsApp: precisa dos produtos e quantidades em pacotes, CPF/CNPJ, endereço ou retirada e a forma de pagamento.',
].join('\n');

/** Busca no catalogo; se a frase inteira nao achar nada, tenta com menos palavras (o site procura a frase exata). */
type Catalogo = { produtos: GkProduto[]; total: number; paginas: number; categorias?: Array<{ categoria: string; total: number }> };
export async function catalogo(o: { busca?: string; categoria?: string; pagina?: number }): Promise<Catalogo> {
  if (!o.busca) return catalogoBruto(o);
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const palavras = norm(o.busca).replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !/^(de|da|do|com|para|pct|pacote|pacotes|unidade|unidades)$/.test(w));
  // palavra que da nome ao produto (pokemon, minecraft, bolinha...): o resultado tem que conter ela
  const chave = palavras.find((w) => !/^\d+$/.test(w) && !/^(polegada|polegadas|capsula|capsulas|brinquedo|brinquedos|mm)$/.test(w)) ?? palavras[0];
  const bate = (p: GkProduto) => !chave || norm(`${p.nome} ${p.descricao ?? ''} ${p.categoria} ${p.sku}`).includes(chave);
  const tentativas = [o.busca, palavras.slice(0, 3).join(' '), palavras.slice(0, 2).join(' '), chave].filter((t, i, a) => t && a.indexOf(t) === i);
  let ultimo: Awaited<ReturnType<typeof catalogoBruto>> | undefined;
  for (const busca of tentativas) {
    const r = await catalogoBruto({ ...o, busca });
    ultimo = r;
    const pontos = (p: GkProduto) => { const t = norm(`${p.nome} ${p.descricao ?? ''} ${p.categoria}`); return palavras.filter((w) => t.includes(w)).length + (p.disponivel ? 0.5 : 0); };
    const ok = r.produtos.filter(bate).sort((a, b) => pontos(b) - pontos(a));
    if (ok.length) return { ...r, produtos: ok, total: ok.length };
  }
  return { ...(ultimo as any), produtos: [], total: 0 };
}

async function catalogoBruto(o: { busca?: string; categoria?: string; pagina?: number }) {
  const u = new URL(`${BASE()}/catalogo`);
  if (o.busca) u.searchParams.set('busca', o.busca);
  if (o.categoria) u.searchParams.set('categoria', o.categoria);
  if (o.pagina) u.searchParams.set('pagina', String(o.pagina));
  u.searchParams.set('limite', '30');
  const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`catálogo Girakids respondeu ${r.status}`);
  return r.json() as Promise<{ produtos: GkProduto[]; total: number; paginas: number; categorias?: Array<{ categoria: string; total: number }> }>;
}

const brl = (n: number) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`;
/** Linha curta e com as contas feitas (preco por unidade e por pacote), para a IA nao errar conta. */
export function produtoLinha(p: GkProduto): string {
  const pacote = p.precoVenda * (p.unidadesPacote || 1);
  return `${p.nome}${p.descricao ? ` (${p.descricao})` : ''} · SKU ${p.sku} · ${p.categoria} · ${brl(p.precoVenda)} a unidade`
    + (p.unidadesPacote > 1 ? `, pacote com ${p.unidadesPacote} = ${brl(pacote)}` : '')
    + (p.blackFriday && p.precoOriginal ? ` (promoção, antes ${brl(p.precoOriginal)})` : '')
    + (!p.disponivel || p.estoque <= 0 ? ' · ESGOTADO' : '');
}

// ------------------------------------------------------------------ com login (so para o dono)
export const girakidsLogado = () => !!(env.GIRAKIDS_EMAIL && env.GIRAKIDS_SENHA);
let token: { value: string; at: number } | undefined;
async function login() {
  const r = await fetch(`${BASE()}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.GIRAKIDS_EMAIL, senha: env.GIRAKIDS_SENHA }), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`login na Girakids recusado (${r.status})`);
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error('Girakids não devolveu token');
  token = { value: j.token, at: Date.now() };
  return j.token;
}
export async function girakids<T = any>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  if (!girakidsLogado()) throw new Error('Girakids sem login configurado (faltam GIRAKIDS_EMAIL e GIRAKIDS_SENHA no Render)');
  const t = token && Date.now() - token.at < 24 * 3600_000 ? token.value : await login();
  const go = (tk: string) => fetch(`${BASE()}${path}`, {
    method: init?.method ?? 'GET', signal: AbortSignal.timeout(45_000),
    headers: { authorization: `Bearer ${tk}`, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let r = await go(t);
  if (r.status === 401) r = await go(await login());
  if (!r.ok) {
    const msg = await r.text().catch(() => '');
    let err = msg; try { err = JSON.parse(msg).error ?? JSON.parse(msg).message ?? msg; } catch { /* texto */ }
    throw new Error(`Girakids: ${String(err).slice(0, 200) || r.status}`);
  }
  return r.json() as Promise<T>;
}

// ------------------------------------------------------------------ orcamento -> pedido (usuario da IA com permissao VENDAS)
export type ItemPedido = { produto: string; pacotes: number };
export type ClientePedido = { nome: string; telefone?: string; documento?: string; email?: string; cep?: string; rua?: string; numero?: string; complemento?: string; bairro?: string; cidade?: string; estado?: string };

/** Acha o produto do catalogo pelo SKU (exato) ou pelo nome. */
export async function acharProduto(ref: string): Promise<GkProduto | { varios: string[] } | undefined> {
  const r = await catalogo({ busca: ref });
  const bySku = r.produtos.find((p) => p.sku.toLowerCase() === ref.trim().toLowerCase());
  if (bySku) return bySku;
  const exact = r.produtos.filter((p) => p.nome.toLowerCase() === ref.trim().toLowerCase());
  if (exact.length === 1) return exact[0];
  if (r.produtos.length === 1) return r.produtos[0];
  if (r.produtos.length > 1) return { varios: r.produtos.slice(0, 8).map(produtoLinha) };
  return undefined;
}

export type PedidoResumo = { id: string; numero: number; tipo: string; total: number; subtotal?: number; frete?: number; itens: Array<{ nome: string; quantidade: number; unidadesPacote: number; precoUnitario: number; total: number }> };

export async function criarOrcamento(o: { itens: Array<{ produtoId: string; quantidade: number }>; cliente: ClientePedido; clienteId?: string; metodoEnvio?: string; formaPagamento?: string; observacoes?: string }): Promise<PedidoResumo> {
  return girakids<PedidoResumo>('/orcamentos', { method: 'POST', body: {
    itens: o.itens, cliente: o.cliente, ...o.cliente, clienteId: o.clienteId || undefined, // conta do cliente no site: o pedido aparece na conta dele
    metodoEnvio: o.metodoEnvio || undefined, formaPagamento: o.formaPagamento || 'A_DEFINIR',
    observacoes: o.observacoes ?? 'Orçamento feito pela IA (WhatsApp).',
  } });
}

export const gerarPedido = (orcamentoId: string) => girakids<PedidoResumo>(`/orcamentos/${orcamentoId}/gerar-pedido`, { method: 'POST', body: {} });

export function resumoPedido(p: PedidoResumo): string {
  const itens = (p.itens ?? []).map((i) => `${i.quantidade} pct ${i.nome} (${i.unidadesPacote} un) = ${brl(Number(i.total))}`).join('; ');
  return `${p.tipo === 'ORCAMENTO' ? 'Orçamento' : 'Pedido'} nº ${p.numero}: ${itens}${p.frete ? ` + frete ${brl(Number(p.frete))}` : ''} · total ${brl(Number(p.total))}`;
}

/** Frete pelo sistema da Girakids (Correios PAC/SEDEX, Braspress, retirada, transportadora) para os itens e o CEP. */
export async function cotarFrete(cep: string, itens: ItemPedido[]) {
  const resolved: Array<{ produtoId: string; quantidade: number }> = [];
  let subtotal = 0;
  for (const it of itens) {
    const p = await acharProduto(it.produto);
    if (!p || 'varios' in p) return { erro: `Não identifiquei "${it.produto}" no catálogo para calcular o frete.` };
    resolved.push({ produtoId: p.id, quantidade: it.pacotes });
    subtotal += p.precoVenda * (p.unidadesPacote || 1) * it.pacotes;
  }
  const r = await girakids<{ opcoes: Array<{ metodo: string; nome: string; valor: number; prazoDias: number | null; disponivel: boolean; motivo?: string }>; pesoGramas: number }>(
    '/checkout/frete', { method: 'POST', body: { cep: cep.replace(/\D/g, ''), itens: resolved } },
  );
  return {
    subtotal_produtos: brl(subtotal),
    peso: `${((r.pesoGramas ?? 0) / 1000).toFixed(1)} kg`,
    opcoes: (r.opcoes ?? []).map((o) => o.disponivel
      ? `${o.nome}: ${o.valor ? brl(o.valor) : 'sem custo'}${o.prazoDias ? ` · ${o.prazoDias} dias úteis` : ''}${o.valor ? ` · total com produtos ${brl(subtotal + o.valor)}` : ''}`
      : `${o.nome}: indisponível (${o.motivo ?? 'sem cotação'})`),
  };
}

// ------------------------------------------------------------------ conta (login) do cliente no site
export type ContaGirakids = { id: string; nome: string; email: string | null; documento: string | null; telefone: string | null; totalPedidos?: number };

/** Procura a conta do cliente no site (por e-mail, CPF/CNPJ, nome ou telefone). */
export async function buscarContaCliente(busca: string): Promise<ContaGirakids[]> {
  const b = busca.trim();
  if (b.length < 2) return [];
  const r = await girakids<any[]>(`/usuarios/clientes?busca=${encodeURIComponent(b)}`);
  return (r ?? []).filter((u) => !u.role || u.role === 'CLIENTE').map((u) => ({
    id: String(u.id), nome: u.nome, email: u.email ?? null, documento: u.documento ?? null, telefone: u.telefone ?? null, totalPedidos: u.totalPedidos,
  }));
}

export const contaLinha = (c: ContaGirakids) =>
  `${c.nome}${c.email ? ` · login ${c.email}` : ''}${c.documento ? ` · doc ${c.documento}` : ''}${c.totalPedidos ? ` · ${c.totalPedidos} pedidos` : ''} [id ${c.id}]`;
