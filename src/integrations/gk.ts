import { env } from '../lib/env.js';
import { normalizePhone, phoneVariants } from '../lib/phone.js';

/**
 * Grupo GK (sistema financeiro): mensalidades e cobrancas dos clientes MachinePay e CompactPay.
 * So leitura. Entra pela chave da IA (GK_API_KEY no Render, cabecalho X-API-Key), sem login.
 * Sem a chave, usa o usuario proprio do GK (GK_EMAIL / GK_SENHA) como reserva; o token fica em memoria.
 */
export type GkProduto = 'machinepay' | 'compactpay';
export const gkEnabled = () => !!(env.GK_API_KEY || (env.GK_EMAIL && env.GK_SENHA));

let token: { value: string; at: number } | undefined;
async function login(): Promise<string> {
  const r = await fetch(`${env.GK_API_URL}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.GK_EMAIL, senha: env.GK_SENHA }), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`login no Grupo GK recusado (${r.status})`);
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error('Grupo GK não devolveu token');
  token = { value: j.token, at: Date.now() };
  return j.token;
}

export async function gk<T = any>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  if (!gkEnabled()) throw new Error('Grupo GK não configurado (falta GK_API_KEY no Render)');
  if (env.GK_API_KEY) {
    const r = await fetch(`${env.GK_API_URL}${path}`, {
      method: init?.method ?? 'GET', signal: AbortSignal.timeout(45_000),
      headers: { 'x-api-key': env.GK_API_KEY, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!r.ok) throw new Error(`Grupo GK respondeu ${r.status} em ${path.split('?')[0]}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    const txt = await r.text();
    return (txt ? JSON.parse(txt) : null) as T;
  }
  if (init && init.method !== 'GET') throw new Error('Grupo GK: escrever só com a chave de API (GK_API_KEY)');
  const t = token && Date.now() - token.at < 6 * 3600_000 ? token.value : await login();
  let r = await fetch(`${env.GK_API_URL}${path}`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(45_000) });
  if (r.status === 401) r = await fetch(`${env.GK_API_URL}${path}`, { headers: { authorization: `Bearer ${await login()}` }, signal: AbortSignal.timeout(45_000) });
  if (!r.ok) throw new Error(`Grupo GK respondeu ${r.status} em ${path}`);
  return r.json() as Promise<T>;
}

export type GkCliente = {
  id: number; nome: string; documento?: string | null; telefone?: string | null; email?: string | null; status: string; produto?: string;
  diaVencimento?: number; totalMaquinas?: number; valorCalculado?: number; valorEmAberto?: number; valorAtrasado?: number;
  cobrancasAtrasadas?: number; diasEmAtraso?: number; ultimoPagamento?: string | null; semMensalidade?: boolean;
};

// lista de clientes muda pouco: guarda 5 min para nao pesar no GK
const cache = new Map<GkProduto, { at: number; list: GkCliente[] }>();
export async function gkClientes(produto: GkProduto): Promise<GkCliente[]> {
  const hit = cache.get(produto);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
  const list = (await gk<GkCliente[]>(`/${produto}/clientes`)).map((c) => ({ ...c, produto }));
  cache.set(produto, { at: Date.now(), list });
  return list;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export async function gkBuscar(busca: string, produtos: GkProduto[] = ['machinepay', 'compactpay']): Promise<GkCliente[]> {
  const b = norm(busca.trim()); const digits = busca.replace(/\D/g, '');
  const all = (await Promise.all(produtos.map((p) => gkClientes(p)))).flat();
  return all.filter((c) => norm(c.nome).includes(b) || (digits.length >= 4 && ((c.documento ?? '').replace(/\D/g, '').includes(digits) || (c.telefone ?? '').replace(/\D/g, '').includes(digits))));
}

/** Cliente pelo telefone do WhatsApp (para o proprio cliente saber da mensalidade dele, e so dele). */
export async function gkPorTelefone(phone: string): Promise<GkCliente[]> {
  const variants = new Set(phoneVariants(normalizePhone(phone)));
  const all = (await Promise.all((['machinepay', 'compactpay'] as GkProduto[]).map((p) => gkClientes(p).catch(() => [])))).flat();
  return all.filter((c) => c.telefone && variants.has(normalizePhone(c.telefone)));
}

export async function gkHistorico(produto: GkProduto, id: number) {
  return gk<{ cliente: GkCliente; cobrancas: Array<{ competencia: string; valor: number; valorMes?: number; situacao: string; vencimento: string; pagoEm?: string | null; valorPago?: number | null; pixCopiaCola?: string | null }> }>(`/${produto}/clientes/${id}/historico`);
}

export async function gkCobrancasMes(produto: GkProduto, competencia: string) {
  return gk<{ competencia: string; resumo: Record<string, number>; cobrancas: Array<{ situacao: string; valor: number; vencimento: string; cliente?: { nome: string } }>; clientesSemCobranca?: unknown[] }>(`/${produto}/cobrancas?competencia=${encodeURIComponent(competencia)}`);
}

export const brl = (n: number | string | null | undefined) => `R$ ${Number(n ?? 0).toFixed(2).replace('.', ',')}`;
export const dia = (d?: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: env.TIMEZONE }) : '-');

export function clienteLinha(c: GkCliente): string {
  const atraso = Number(c.valorAtrasado ?? 0), aberto = Number(c.valorEmAberto ?? 0);
  return `${c.nome} (${c.produto === 'compactpay' ? 'CompactPay' : 'MachinePay'}${c.status !== 'ATIVO' ? `, ${c.status.toLowerCase()}` : ''}): mensalidade ${c.semMensalidade ? 'isento' : brl(c.valorCalculado)}, vence dia ${c.diaVencimento ?? '-'}, ${c.totalMaquinas ?? 0} máquinas`
    + (atraso > 0 ? `, ATRASADO ${brl(atraso)} (${c.cobrancasAtrasadas ?? 0} cobrança(s), ${c.diasEmAtraso ?? 0} dias)` : aberto > 0 ? `, em aberto ${brl(aberto)}` : ', em dia')
    + (c.ultimoPagamento ? `, último pagamento ${dia(c.ultimoPagamento)}` : '');
}
