/**
 * AgarraMais (lojas de maquinas): faturamento, lucro, lojas e desempenho das maquinas. So leitura.
 * Entra pela chave da IA (AGARRAMAIS_API_KEY no Render, cabecalho X-API-Key), sem login.
 * Sem a chave, usa o login de um ADMIN em AGARRAMAIS_EMAIL / AGARRAMAIS_SENHA como reserva.
 */
const BASE = () => (process.env.AGARRAMAIS_API_URL || 'https://backend-agarramais.onrender.com/api').replace(/\/+$/, '');
const CHAVE = () => process.env.AGARRAMAIS_API_KEY || '';
export const agarramaisLigada = () => !!(CHAVE() || (process.env.AGARRAMAIS_EMAIL && process.env.AGARRAMAIS_SENHA));

let token: { value: string; at: number } | undefined;
async function login(): Promise<string> {
  const r = await fetch(`${BASE()}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.AGARRAMAIS_EMAIL, senha: process.env.AGARRAMAIS_SENHA }), signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`login na AgarraMais recusado (${r.status})`);
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error('AgarraMais não devolveu token');
  token = { value: j.token, at: Date.now() };
  return j.token;
}

export async function agarramais<T = any>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
  if (!agarramaisLigada()) throw new Error('AgarraMais não configurada (falta AGARRAMAIS_API_KEY no Render)');
  if (CHAVE()) {
    const r = await fetch(`${BASE()}${path}`, {
      method: init?.method ?? 'GET', signal: AbortSignal.timeout(60_000),
      headers: { 'x-api-key': CHAVE(), ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!r.ok) throw new Error(`AgarraMais respondeu ${r.status} em ${path.split('?')[0]}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    const txt = await r.text();
    return (txt ? JSON.parse(txt) : null) as T;
  }
  if (init && init.method !== 'GET') throw new Error('AgarraMais: escrever só com a chave de API (AGARRAMAIS_API_KEY)');
  const t = token && Date.now() - token.at < 3 * 86_400_000 ? token.value : await login();
  let r = await fetch(`${BASE()}${path}`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(60_000) });
  if (r.status === 401) r = await fetch(`${BASE()}${path}`, { headers: { authorization: `Bearer ${await login()}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`AgarraMais respondeu ${r.status} em ${path.split('?')[0]}`);
  return r.json() as Promise<T>;
}

export type Loja = { id: string; nome: string; cidade?: string; ativo?: boolean };
export async function lojas(): Promise<Loja[]> {
  const r: any = await agarramais('/lojas');
  return (Array.isArray(r) ? r : r.lojas ?? r.data ?? []).map((l: any) => ({ id: String(l.id), nome: l.nome ?? l.name, cidade: l.cidade, ativo: l.ativo }));
}

export async function acharLoja(busca: string): Promise<Loja[]> {
  const n = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (await lojas()).filter((l) => n(l.nome).includes(n(busca)) || l.id === busca);
}
