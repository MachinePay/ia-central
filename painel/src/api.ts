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
  aviso?: string
  zumbi?: boolean
  desconectado?: boolean
  puxadas?: number
  encontradas?: number
  mais?: boolean
  numero?: string
  perfil?: string | null
  desconhecidos: { contato: string; mensagem: string; criado_em: string }[]
  config?: { modo: 'pessoal' | 'dedicado'; gatilho: string }
}


export type Area = 'suporte' | 'comercial' | 'geral'
export type Agente = 'leo' | 'joao' | 'suporte' | 'gabriel'
export type AgenteAtend = 'joao' | 'suporte'
export type ModoObservar = 'todos' | 'exceto' | 'somente'
export interface ItemLista { id: number; numero: string; nome: string | null; regra: 'incluir' | 'excluir' }
export interface Observacao {
  leo: { modo: ModoObservar; lista: ItemLista[] }
  joao: { modo: ModoObservar; lista: ItemLista[] }
  suporte: { modo: ModoObservar; lista: ItemLista[] }
  gabriel: { modo: ModoObservar; lista: ItemLista[] }
  leo_sugestoes: { id: number; titulo: string | null; conteudo: string; contato: string | null; criado_em: string }[]
  leo_conversas_lidas: number
}
export interface Empresa { nome: string; descricao: string; horario: string; tom: string; persona?: string }
export interface AtendimentoPainel {
  config: { agente: AgenteAtend; persona: string; modo: 'desligado' | 'observando' | 'aprovacao' | 'automatico'; alcance: 'selecionados' | 'todos'; empresa: Empresa }
  fila: { id: number; pergunta: string; rascunho: string; criado_em: string; nome: string | null; whatsapp: string | null }[]
  chamados: { id: number; area: string; titulo: string; descricao: string | null; prioridade: string; criado_em: string; nome: string | null; whatsapp: string | null }[]
  clientes: { id: number; nome: string | null; whatsapp: string; empresa: string | null; interesse: string | null; etapa: string; ultimo_contato: string; ia_responde: boolean; mensagens: number; respostas_humanas: number }[]
  sugestoes: { id: number; dominio: Area; titulo: string | null; conteudo: string; criado_em: string; cliente: string | null }[]
  base: { id: number; dominio: Area; titulo: string | null; conteudo: string; origem: string; criado_em: string }[]
  sistemas: { id: number; nome: string; publico: boolean }[]
}

export interface GabrielPainel {
  modo: 'desligado' | 'observando' | 'aprovacao' | 'automatico'
  contatos: { id: number; numero: string; nome: string | null }[]
  fila: AtendimentoPainel['fila']
  estilo: string
  conversas_lidas: number
  aprendidos: number
}

export type AgenteId = 'leo' | 'joao' | 'suporte' | 'gabriel'
export type Instancia = 'nucleo' | 'joao' | 'suporte' | 'gabriel'
export interface Evento { id: number; nivel?: 'erro' | 'aviso' | 'info'; agente?: string; titulo: string; detalhe: string | null; contexto?: Record<string, unknown>; visto?: boolean; em: string }
export interface SaudeAgente {
  agente: AgenteId; modo: string; instancia: Instancia
  lidas_24h: number; respostas_24h: number; pendentes: number; sugestoes: number; aprendidos: number; aprendeu_24h?: number
  ultima_atividade: string | null; erros_24h: number; ultimo_erro: Evento | null
}
export interface Saude { agentes: SaudeAgente[]; outros_erros: Evento[]; sistemas_fora: number; chamados_abertos: number }
export type Relacao = 'novo' | 'conhecido' | 'cliente' | 'cliente_antigo' | 'amigo' | 'familia' | 'namorada_conjuge' | 'trabalho' | 'outro'
export interface PerfilContato {
  numero: string; nome: string | null; relacao: Relacao; genero: 'homem' | 'mulher' | 'nao_sei'
  tom: string | null; resumo: string | null; cuidados: string | null; editado_manual: boolean; atualizado_em: string
}
export interface ConversaLida {
  numero: string; nome: string | null; mensagens: number; ultima: string; primeira?: string; ultimo_papel: string; ultima_mensagem: string
  da_ia: number; humanas: number; ultima_ia: string | null
  perfil?: PerfilContato | null
}
export type MsgLida = { papel: 'usuario' | 'humano' | 'ia' | 'automatica'; texto: string; em: string }
export interface HistoricoLido { numero: string; total: number; historico: MsgLida[] }
export interface ItemAprendido { id: number; titulo: string | null; conteudo: string; area: string | null; aprovado: boolean; origem: string; em: string; de?: string | null; copiado_de?: string | null }
export interface Feed { conversas: ConversaLida[]; aprendizado: ItemAprendido[]; eventos: Evento[] }

export interface Gastos {
  fonte: 'openai' | 'estimativa'; atualizado_em: string | null; limite: number; hoje: number; aprendiz_pausado: boolean
  dias: { dia: string; real: number | null; estimado: number; aprendiz: number; audio: number }[]
  por_item: { item: string; valor: number }[]
  por_uso?: { agente: string; tipo: string; valor: number; vezes: number; segundos: number }[]
  mes: number; mes_estimado: number; erro_openai?: string | null; lido_em?: string | null
}

export interface Rodada { id: number; em: string; origem: 'automatico' | 'painel'; conversas: number; mensagens: number; itens: number; erros: number; custo: number; duracao_ms: number }
export interface Rodadas { rodadas: Rodada[]; total_7d: { rodadas: number; conversas: number; mensagens: number; itens: number; custo: number } }

export type ModoIA = 'desligado' | 'observando' | 'aprovacao' | 'automatico'
export interface Responder {
  agente: AgenteId; modo: ModoIA; alcance: 'selecionados' | 'todos'; pode_todos: boolean; nome?: string | null
  contatos: { numero: string; nome: string | null }[]
  fila: AtendimentoPainel['fila']
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

// ------------------------------------------------------------------ e-mail e agenda de cada IA
export type ProvedorCorreio = 'google' | 'microsoft'
export interface ContaCorreio {
  id: number; tipo: ProvedorCorreio | 'imap'; email: string; nome: string | null
  ler_email: boolean; ler_agenda: boolean; ativo: boolean; estado: 'ok' | 'testando' | 'erro'; erro: string | null
  ultima_leitura: string | null; tem_agenda: boolean; lidos: number
  config: { imap_host?: string; imap_porta?: number; smtp_host?: string | null; smtp_porta?: number; caldav_url?: string | null }
}
export interface ItemCorreio {
  id: number; tipo: 'email' | 'evento'; de: string | null; assunto: string | null; resumo: string | null
  quando: string | null; fim: string | null; lido_em: string; aprendido: boolean; conta: string; local: string | null
}
export interface DadosProposta {
  para?: string; assunto?: string; corpo?: string
  titulo?: string; inicio?: string; fim?: string; local?: string; descricao?: string; convidados?: string[]
}
export interface PropostaCorreio {
  id: number; tipo: 'email' | 'evento'; motivo: string | null; dados: DadosProposta; status: 'pendente' | 'executando' | 'falhou'
  resultado: string | null; criado_em: string; conta_id: number; conta: string; conta_tipo: ContaCorreio['tipo']
  item_de: string | null; item_assunto: string | null; item_texto: string | null; item_quando: string | null
}
export interface Correio {
  agente: AgenteId
  apps: Record<ProvedorCorreio, { client_id: string; atualizado_em: string } | null>
  contas: ContaCorreio[]; itens: ItemCorreio[]; propostas: PropostaCorreio[]
}
export interface ResultadoCorreio { ok: boolean; erro?: string | null; resultado?: string; painel?: Correio }
export interface DadosImap {
  email: string; nome?: string; senha: string; usuario?: string
  imap_host: string; imap_porta?: string; smtp_host?: string; smtp_porta?: string; caldav_url?: string
}

// ------------------------------------------------------------------ atendimento multiempresa (26-multiempresa.sql)
export type EstadoConversa = 'automatico' | 'aguardando_humano' | 'humano' | 'encerrado'
export type TipoBase = 'produto' | 'politica' | 'faq' | 'procedimento' | 'contato'
export interface ItemBaseEmpresa { id: number; tipo: TipoBase; titulo: string; conteudo: string; responsavel: string | null; atualizado_em: string }
export interface EmpresaMulti {
  id: number; slug: string; nome: string; descricao: string; assuntos: string; site: string | null
  catalogo_url: string | null; catalogo_env: string | null; tom: string | null; responsavel: string | null
  ativo: boolean; atualizado_em: string; base: ItemBaseEmpresa[]
}
export interface ConversaMulti {
  id: number; instancia: string; contato: string; nome: string | null; estado: EstadoConversa; motivo: string | null
  resumo: string | null; atualizado_em: string; ultima_cliente_em: string | null; empresa: string | null
  conduzido_por: string | null; ultima_mensagem: string | null; pendentes: number
  liberado: boolean   // contato na lista de quem a IA responde
  sem_resposta?: string | null   // por que a IA nao respondeu a ultima mensagem do cliente
}
export type AlcanceMulti = 'selecionados' | 'todos'
export interface Multi {
  modo: ModoIA; janela_horas: number; dono: string; instancias: string[]
  alcance: AlcanceMulti; liberados: number
  empresas: EmpresaMulti[]
  atendimentos: ConversaMulti[]
  fila: { id: number; atendimento_id: number; pergunta: string | null; texto: string | null; criado_em: string; nome: string | null; contato: string; empresa: string | null }[]
}
export interface ConversaMultiDetalhe {
  atendimento: (Omit<ConversaMulti, 'conduzido_por' | 'ultima_mensagem' | 'pendentes'> & { conduzido_por_nome: string | null; versao: number }) | null
  mensagens: { papel: 'usuario' | 'ia' | 'humano' | 'automatica'; texto: string; em: string }[]
  respostas: { id: number; status: string; texto: string | null; motivo: string | null; em: string }[]
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
  saude: () => chamar<Saude>('admin_saude'),
  feed: (agente: AgenteId) => chamar<Feed>('admin_agente_feed', { agente }),
  conversaLida: (agente: AgenteId, numero: string, limite = 150) => chamar<HistoricoLido>('admin_agente_conversa', { agente, numero, limite }),
  eventosVistos: (agente: string) => chamar('admin_eventos_vistos', { agente }),
  gastos: () => chamar<Gastos>('admin_gastos'),
  rodadas: (agente: AgenteId) => chamar<Rodadas>('admin_rodadas', { agente }),
  responder: (agente: AgenteId) => chamar<Responder>('admin_responder', { agente }),
  correio: (agente: AgenteId) => chamar<Correio>('admin_correio', { agente }),
  correioApp: (agente: AgenteId, provedor: ProvedorCorreio, client_id: string, segredo: string) =>
    chamar<Correio>('admin_correio_app_salvar', { agente, provedor, client_id, segredo }),
  correioAppApagar: (agente: AgenteId, provedor: ProvedorCorreio) => chamar<Correio>('admin_correio_app_apagar', { agente, provedor }),
  correioConectar: (agente: AgenteId, provedor: ProvedorCorreio, redirect: string, volta: string) =>
    chamar<{ url: string }>('admin_correio_conectar', { agente, provedor, redirect, volta }),
  correioImap: (agente: AgenteId, d: DadosImap) => chamar<ResultadoCorreio>('admin_correio_imap_salvar', { agente, ...d }),
  correioConta: (id: number, d: { ler_email?: boolean; ler_agenda?: boolean; ativo?: boolean }) => chamar<Correio>('admin_correio_conta', { id, ...d }),
  correioDesconectar: (id: number) => chamar<Correio>('admin_correio_desconectar', { id }),
  correioTestar: (id: number) => chamar<ResultadoCorreio>('admin_correio_testar', { id }),
  correioLer: (agente: AgenteId) => chamar<{ ok: boolean; lidos?: number; itens?: number; contas?: number; erro?: string }>('admin_correio_ler', { agente }),
  correioAprovar: (id: number, modo: 'enviar' | 'rascunho' | 'criar', dados: DadosProposta, conta_id?: number) =>
    chamar<ResultadoCorreio>('admin_correio_aprovar', { id, modo, dados, conta_id }),
  correioRejeitar: (id: number) => chamar<Correio>('admin_correio_rejeitar', { id }),
  responderConfig: (agente: AgenteId, d: { modo?: ModoIA; alcance?: string; nome?: string }) => chamar<Responder>('admin_responder_config', { agente, ...d }),
  responderDefinir: (agente: AgenteId, numero: string, nome: string, sim: boolean) =>
    chamar<Responder>('admin_responder_definir', { agente, numero, nome, sim: String(sim) }),
  gastosLimite: (limite: number) => chamar<Gastos>('admin_gastos_limite', { limite: String(limite) }),
  async gastosAtualizar(): Promise<Gastos | null> {   // busca agora o gasto real na OpenAI (chave admin)
    const r = await fetch(`${BASE}/webhook/gastos-atualizar`, { method: 'POST', headers: { Authorization: `Bearer ${token.get() ?? ''}` } })
    if (!r.ok) throw await lerErro(r)
    const j = await r.json().catch(() => null)
    return (j && j.gastos) || null
  },
  perfilSalvar: (agente: AgenteId, numero: string, d: { relacao?: Relacao; genero?: string; cuidados?: string }) =>
    chamar('admin_perfil_salvar', { agente, numero, ...d }),
  multi: () => chamar<Multi>('admin_multi'),
  multiConfig: (d: { modo?: ModoIA; instancia?: string; dono?: string; alcance?: AlcanceMulti }) => chamar<Multi>('admin_multi_config', d),
  multiLiberar: (contato: string, nome: string | null, liberar: boolean) =>
    chamar<Multi>('admin_multi_liberar', { contato, nome: nome ?? '', liberar }),
  multiConversa: (id: number) => chamar<ConversaMultiDetalhe>('admin_multi_conversa', { id }),
  multiEstado: (id: number, acao: 'assumir' | 'devolver' | 'encerrar') => chamar<ConversaMultiDetalhe>('admin_multi_estado', { id, acao }),
  multiEmpresa: (d: Partial<Omit<EmpresaMulti, 'base' | 'atualizado_em'>>) => chamar<Multi>('admin_multi_empresa', d),
  multiBase: (d: { id?: number; empresa_id?: number; tipo?: TipoBase; titulo?: string; conteudo?: string; responsavel?: string; apagar?: boolean }) =>
    chamar<Multi>('admin_multi_base', d),
  multiAprovar: (id: number, texto: string) => chamar<{ ok: boolean; enviado: boolean; motivo?: string }>('admin_multi_aprovar', { id, texto }),
  multiRejeitar: (id: number) => chamar<Multi>('admin_multi_rejeitar', { id }),
  multiSimular: (mensagem: string, reiniciar = false) =>
    chamar<{ resposta?: string | null; motivo?: string; erro?: string }>('admin_multi_simular', { mensagem, reiniciar }),
  atendimento: (agente: AgenteAtend) => chamar<AtendimentoPainel>('admin_atendimento', { agente }),
  gabriel: () => chamar<GabrielPainel>('admin_gabriel'),
  gabrielConfig: (modo: string) => chamar<GabrielPainel>('admin_gabriel_config', { modo }),
  atendimentoConfig: (agente: AgenteAtend, d: { modo?: string; alcance?: string; empresa?: Empresa }) => chamar('admin_atendimento_config', { agente, ...d }),
  clienteSalvar: (nome: string, whatsapp: string) => chamar('admin_cliente_salvar', { nome, whatsapp }),
  clienteIa: (id: number, ativa: boolean, agente: AgenteAtend) => chamar('admin_cliente_ia', { id, ativa, agente }),
  clienteApagar: (id: number) => chamar('admin_cliente_apagar', { id }),
  clienteConversa: (id: number) => chamar<{ mensagens: { papel: 'usuario' | 'humano' | 'ia'; texto: string; em: string }[] }>('admin_cliente_conversa', { id }),
  sugestaoAprovar: (id: number, area: Area, titulo: string, conteudo: string) => chamar('admin_sugestao_aprovar', { id, area, titulo, conteudo }),
  sugestaoDescartar: (id: number) => chamar('admin_sugestao_descartar', { id }),
  aprenderAgora: () => chamar<{ ok: boolean; sugestoes: number }>('admin_aprender_agora'),
  baseSalvar: (area: Area, titulo: string, conteudo: string, agente?: AgenteAtend) => chamar('admin_base_salvar', { area, titulo, conteudo, agente }),
  conhecimentoCopiar: (id: number, para: AgenteId) => chamar<{ id: number | null }>('admin_conhecimento_copiar', { id, para }),
  baseApagar: (id: number) => chamar('admin_base_apagar', { id }),
  chamadoResolver: (id: number) => chamar('admin_chamado_resolver', { id }),
  sistemaPublico: (id: number, publico: boolean) => chamar('admin_sistema_publico', { id, publico }),
  sistemaAtivo: (id: number, ativo: boolean) => chamar('admin_sistema_ativo', { id, ativo: String(ativo) }),
  filaRejeitar: (id: number) => chamar('admin_fila_rejeitar', { id }),
  filaAprovar: (id: number, texto: string, area: Area) => chamar<{ ok: boolean; enviado: boolean; motivo?: string }>('admin_fila_aprovar', { id, texto, area }),
  atendimentoTeste: (mensagem: string, sessao: string, agente: AgenteAtend | 'gabriel') => chamar<{ resposta: string }>('admin_atendimento_teste', { mensagem, sessao, agente }),
  participar: (compartilha: boolean) => chamar('participar', { compartilha }),
  esquecer: (id: number) => chamar('esquecer', { id }),
  perfil: (dados: { telegram_chat_id?: string; whatsapp?: string }) => chamar('perfil', dados),
  whatsapp: (op: 'status' | 'conectar' | 'desconectar' | 'qr' | 'puxar' | 'reiniciar', extra: { numero?: string; instancia?: Instancia } = {}) =>
    chamar<WhatsappStatus>('admin_whatsapp', { op, ...extra }),
  observacao: () => chamar<Observacao>('admin_observacao'),
  observacaoConfig: (agente: Agente, modo: ModoObservar) => chamar<Observacao>('admin_observacao_config', { agente, modo }),
  observacaoAdd: (agente: Agente | 'gabriel', numero: string, nome: string, regra: 'incluir' | 'excluir') => chamar<Observacao>('admin_observacao_add', { agente, numero, nome, regra }),
  observacaoDel: (id: number) => chamar<Observacao>('admin_observacao_del', { id }),
  leoSugestaoAprovar: (id: number, titulo: string, conteudo: string) => chamar('admin_leo_sugestao_aprovar', { id, titulo, conteudo }),
  leoSugestaoDescartar: (id: number) => chamar('admin_leo_sugestao_descartar', { id }),
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
