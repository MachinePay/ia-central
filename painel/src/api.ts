// Fala com a API do painel no n8n (POST /webhook/painel e /webhook/painel-audio).
// Em dev o Vite faz proxy de /webhook para o n8n; em producao use VITE_API_URL.
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const CHAVE_TOKEN = 'nucleo.token'

export type Papel = 'admin' | 'usuario'
export interface Usuario { id: number; nome: string; papel: Papel; compartilha?: boolean; telegram?: boolean; whatsapp?: string | null }
export interface Sistema {
  id?: number; nome: string; estado: 'ok' | 'falha' | 'desconhecido'; url: string; ativo: boolean; detalhe: string | null
  ultimo_check: string | null; caiu_em: string | null
  origem?: 'manual' | 'render' | 'vercel'; tipo?: 'http' | 'plataforma'; tempo_ms?: number | null; painel_url?: string | null
}
export interface Incidente { nome: string; inicio: string; fim: string | null }
export interface Lembrete { id: number; texto: string; quando: string; contato: string | null }
export interface Memoria { id: number; titulo: string | null; conteudo: string; criado_em: string }
export interface UsuarioAdmin { id: number; nome: string; login: string; papel: Papel; compartilha: boolean; ativo: boolean; memorias: number }
export interface Resumo {
  usuario: Usuario
  memoria_compartilhada: boolean
  sistemas: Sistema[]
  incidentes: Incidente[]
  lembretes: Lembrete[]
  memorias: Memoria[]
  total_memorias: number
  usuarios: UsuarioAdmin[] | null
}
export interface Mensagem { papel: 'eu' | 'ia'; texto: string }
export interface WhatsappStatus {
  estado: 'open' | 'close' | 'connecting' | 'inexistente' | 'erro'
  qr?: string | null
  codigo?: string | null
  numero?: string
  perfil?: string | null
  desconhecidos: { contato: string; mensagem: string; criado_em: string }[]
  config?: { modo: 'pessoal' | 'dedicado'; gatilho: string }
}


export type Area = 'suporte' | 'comercial' | 'geral'
export interface Empresa { nome: string; descricao: string; horario: string; tom: string }
export interface AtendimentoPainel {
  config: { modo: 'desligado' | 'aprovacao' | 'automatico'; empresa: Empresa }
  fila: { id: number; pergunta: string; rascunho: string; criado_em: string; nome: string | null; whatsapp: string | null }[]
  chamados: { id: number; area: string; titulo: string; descricao: string | null; prioridade: string; criado_em: string; nome: string | null; whatsapp: string | null }[]
  clientes: { id: number; nome: string | null; whatsapp: string; empresa: string | null; interesse: string | null; etapa: string; ultimo_contato: string }[]
  base: { id: number; dominio: Area; titulo: string | null; conteudo: string; origem: string; criado_em: string }[]
  sistemas: { id: number; nome: string; publico: boolean }[]
}

export class ErroApi extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem) }
}

export const token = {
  get: () => { try { return localStorage.getItem(CHAVE_TOKEN) } catch { return null } },
  set: (t: string | null) => {
    try { if (t) localStorage.setItem(CHAVE_TOKEN, t); else localStorage.removeItem(CHAVE_TOKEN) } catch { /* modo privado */ }
  },
}

async function lerErro(r: Response): Promise<ErroApi> {
  let msg = `Erro ${r.status}`
  try { const j = await r.json(); if (j?.erro) msg = j.erro } catch { /* corpo vazio */ }
  return new ErroApi(r.status, msg)
}

async function chamar<T>(acao: string, dados: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${BASE}/webhook/painel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.get() ?? ''}` },
    body: JSON.stringify({ acao, dados }),
  })
  if (!r.ok) throw await lerErro(r)
  return r.json() as Promise<T>
}

export const api = {
  login: (login: string, senha: string) => chamar<{ token: string; usuario: Usuario }>('login', { login, senha }),
  logout: () => chamar('logout'),
  resumo: () => chamar<Resumo>('resumo'),
  historico: (sessao: string) => chamar<{ mensagens: Mensagem[] }>('historico', { sessao }),
  chat: (mensagem: string, sessao: string) => chamar<{ resposta: string }>('chat', { mensagem, sessao }),
  verificar: () => chamar<{ ok: boolean }>('verificar'),
  atendimento: () => chamar<AtendimentoPainel>('admin_atendimento'),
  atendimentoConfig: (d: { modo?: string; empresa?: Empresa }) => chamar('admin_atendimento_config', d),
  baseSalvar: (area: Area, titulo: string, conteudo: string) => chamar('admin_base_salvar', { area, titulo, conteudo }),
  baseApagar: (id: number) => chamar('admin_base_apagar', { id }),
  chamadoResolver: (id: number) => chamar('admin_chamado_resolver', { id }),
  sistemaPublico: (id: number, publico: boolean) => chamar('admin_sistema_publico', { id, publico }),
  filaRejeitar: (id: number) => chamar('admin_fila_rejeitar', { id }),
  filaAprovar: (id: number, texto: string, area: Area) => chamar<{ ok: boolean; enviado: boolean; motivo?: string }>('admin_fila_aprovar', { id, texto, area }),
  atendimentoTeste: (mensagem: string, sessao: string) => chamar<{ resposta: string }>('admin_atendimento_teste', { mensagem, sessao }),
  participar: (compartilha: boolean) => chamar('participar', { compartilha }),
  esquecer: (id: number) => chamar('esquecer', { id }),
  perfil: (dados: { telegram_chat_id?: string; whatsapp?: string }) => chamar('perfil', dados),
  whatsapp: (op: 'status' | 'conectar' | 'desconectar' | 'modo', extra: { numero?: string; modo?: 'pessoal' | 'dedicado' } = {}) =>
    chamar<WhatsappStatus>('admin_whatsapp', { op, ...extra }),
  configurar: (memoria_compartilhada: boolean) => chamar('admin_config', { memoria_compartilhada }),
  criarUsuario: (d: { nome: string; login: string; senha: string; papel: Papel }) => chamar('admin_criar_usuario', d),
  ativarUsuario: (id: number, ativo: boolean) => chamar('admin_ativar_usuario', { id, ativo }),

  async falar(texto: string): Promise<ArrayBuffer> {
    const r = await fetch(`${BASE}/webhook/painel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.get() ?? ''}` },
      body: JSON.stringify({ acao: 'falar', dados: { texto } }),
    })
    if (!r.ok) throw await lerErro(r)
    return r.arrayBuffer()
  },

  async audio(blob: Blob, sessao: string): Promise<{ transcricao: string; resposta?: string; erro?: string }> {
    const r = await fetch(`${BASE}/webhook/painel-audio?sessao=${encodeURIComponent(sessao)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', Authorization: `Bearer ${token.get() ?? ''}` },
      body: blob,
    })
    if (!r.ok) throw await lerErro(r)
    return r.json()
  },
}
