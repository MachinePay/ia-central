import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Bot, BotOff, Building2, Check, ChevronDown, Hand, MessagesSquare, Plus, RefreshCw, RotateCcw, Save, Send, Trash2, X, XCircle } from 'lucide-react'
import { api, type AlcanceMulti, type ConversaMulti, type ConversaMultiDetalhe, type EmpresaMulti, type EstadoConversa, type ItemBaseEmpresa, type ModoIA, type Multi, type TipoBase } from '../api'
import { Hud, MODO, fmt, haQuanto } from './ui'
import { avisar, confirmar } from '../alerta'

const ESTADO: Record<EstadoConversa, { rotulo: string; classe: string }> = {
  aguardando_humano: { rotulo: 'Aguardando pessoa', classe: 'erro' },
  humano: { rotulo: 'Com uma pessoa', classe: 'whatsapp' },
  automatico: { rotulo: 'IA atendendo', classe: 'ok' },
  encerrado: { rotulo: 'Encerrado', classe: 'parada' },
}
const PAPEL = { usuario: 'CLIENTE', ia: 'IA', humano: 'EQUIPE', automatica: 'AUTOMÁTICA' } as const
const TIPOS: { id: TipoBase; nome: string }[] = [
  { id: 'faq', nome: 'Pergunta frequente' }, { id: 'politica', nome: 'Política / regra comercial' },
  { id: 'produto', nome: 'Produto / plano' }, { id: 'procedimento', nome: 'Como fazer' }, { id: 'contato', nome: 'Contato / encaminhamento' },
]
const INSTANCIAS: { id: string; nome: string }[] = [
  { id: '', nome: 'Nenhum (só o teste do painel)' }, { id: 'nucleo', nome: 'Número do Leo (nucleo)' },
  { id: 'joao', nome: 'Chip do João' }, { id: 'suporte', nome: 'Chip do suporte' }, { id: 'gabriel', nome: 'Número do Gabriel' },
]
const erroDe = (e: unknown) => (e instanceof Error ? e.message : 'Falhou')

// ------------------------------------------------------------------ pagina
export function Multiempresa() {
  const [m, setM] = useState<Multi | null>(null)
  const [erro, setErro] = useState('')
  const carregar = useCallback(async () => {
    try { setM(await api.multi()); setErro('') } catch (e) { setErro(erroDe(e)) }
  }, [])
  useEffect(() => { carregar(); const t = setInterval(carregar, 20000); return () => clearInterval(t) }, [carregar])

  return (
    <div className="pagina">
      <h1 className="titulo-pagina"><Building2 size={22} /> Atendimento multiempresa</h1>
      {erro && <div className="aviso erro">{erro}</div>}
      {!m && !erro && <div className="vazio">Carregando…</div>}
      {m && <>
        <Controle m={m} aoMudar={setM} />
        <div className="duas-colunas">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {m.fila.length > 0 && (
              <Hud titulo={`Esperando aprovação (${m.fila.length})`} icone={<Check size={14} />}>
                {m.fila.map(f => <ItemAprovar key={f.id} f={f} aoMudar={carregar} />)}
              </Hud>
            )}
            <Hud titulo="Conversas" icone={<MessagesSquare size={14} />}
              extra={<button className="botao-mini" onClick={carregar} aria-label="Atualizar"><RefreshCw size={12} /></button>}>
              {m.atendimentos.length === 0 && <div className="vazio">Nenhuma conversa ainda.</div>}
              {m.atendimentos.map(a => <ItemConversa key={a.id} a={a} aoMudar={carregar} />)}
            </Hud>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <SimuladorMulti modo={m.modo} aoMudar={carregar} />
            <Hud titulo="Empresas e informações aprovadas" icone={<Building2 size={14} />}>
              <div className="etiqueta" style={{ marginBottom: 8 }}>
                A IA só afirma o que está aqui (ou no catálogo da loja). Cada informação guarda quem é o responsável e quando foi atualizada.
              </div>
              {m.empresas.map(e => <CartaoEmpresa key={e.id} e={e} aoMudar={setM} />)}
              <NovaEmpresa aoMudar={setM} />
            </Hud>
          </div>
        </div>
      </>}
    </div>
  )
}

// ------------------------------------------------------------------ chave geral + numero
function Controle({ m, aoMudar }: { m: Multi; aoMudar: (m: Multi) => void }) {
  const [dono, setDono] = useState(m.dono)
  const [ocupado, setOcupado] = useState(false)
  const instancia = m.instancias[0] ?? ''
  async function salvar(d: { modo?: ModoIA; instancia?: string; dono?: string; alcance?: AlcanceMulti }) {
    setOcupado(true)
    try { aoMudar(await api.multiConfig(d)); avisar('Salvo') } catch (e) { avisar('Não salvou', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  return (
    <Hud titulo="Chave geral" icone={<Hand size={14} />}>
      <div className="modos">
        {(['desligado', 'observando', 'aprovacao', 'automatico'] as ModoIA[]).map(x => (
          <button key={x} className={m.modo === x ? 'ativo' : ''} disabled={ocupado}
            onClick={async () => {
              if (x === 'automatico' && !(await confirmar({ titulo: 'Responder sozinha?', botao: 'Ligar automático', perigo: true,
                texto: 'A IA passa a responder os clientes <b>sem aprovação</b>. Use depois de testar com aprovação.' }))) return
              salvar({ modo: x })
            }}>{MODO[x].rotulo}</button>
        ))}
      </div>
      <div className="etiqueta" style={{ marginTop: 6 }}>{m.modo === 'observando' ? 'Guarda as conversas e mostra aqui. Não responde ninguém.' : MODO[m.modo]?.texto}</div>
      <div className="campo" style={{ margin: '12px 0 0' }}>
        <label>Quem a IA responde</label>
        <div className="modos">
          <button className={m.alcance === 'selecionados' ? 'ativo' : ''} disabled={ocupado}
            onClick={() => salvar({ alcance: 'selecionados' })}>Só os escolhidos ({m.liberados})</button>
          <button className={m.alcance === 'todos' ? 'ativo' : ''} disabled={ocupado}
            onClick={async () => {
              if (!(await confirmar({ titulo: 'Responder todos os contatos?', botao: 'Responder todos', perigo: true,
                texto: 'A IA passa a responder <b>qualquer pessoa</b> que mandar mensagem neste número, não só os escolhidos.' }))) return
              salvar({ alcance: 'todos' })
            }}>Todos</button>
        </div>
        <div className="etiqueta" style={{ marginTop: 6 }}>
          {m.alcance === 'todos' ? 'Responde qualquer contato.'
            : 'Escolha em cada conversa abaixo (“IA responde este contato”). Os outros ficam guardados aqui, mas a IA não responde.'}
        </div>
      </div>
      <div className="linha-2" style={{ marginTop: 12 }}>
        <div className="campo" style={{ margin: 0 }}>
          <label htmlFor="multi-inst">Número que atende</label>
          <select id="multi-inst" value={instancia} disabled={ocupado}
            onChange={async e => {
              const v = e.target.value
              if (v && !(await confirmar({ titulo: 'Usar este número no atendimento?', botao: 'Usar',
                texto: 'As conversas de clientes desse número passam para o atendimento multiempresa (a conversa “Você” continua com o Leo). A IA que usava esse número deixa de ler os clientes dele.' }))) return
              salvar({ instancia: v })
            }}>
            {INSTANCIAS.map(i => <option key={i.id} value={i.id}>{i.nome}</option>)}
          </select>
        </div>
        <div className="campo" style={{ margin: 0 }}>
          <label htmlFor="multi-dono">Nome do dono (a IA diz que é o atendimento dele)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input id="multi-dono" value={dono} onChange={e => setDono(e.target.value)} />
            <button className="botao" style={{ width: 'auto' }} disabled={ocupado || !dono.trim() || dono === m.dono} onClick={() => salvar({ dono })} aria-label="Salvar nome"><Save size={14} /></button>
          </div>
        </div>
      </div>
      <div className="etiqueta" style={{ marginTop: 10 }}>
        Antes de cada envio o sistema confere de novo: se a conversa está com uma pessoa, se o cliente mandou algo mais novo e se ainda está
        na janela de {m.janela_horas}h do WhatsApp. Responder pelo celular passa a conversa para você na hora.
      </div>
    </Hud>
  )
}

// ------------------------------------------------------------------ conversa (assumir / devolver / encerrar)
function ItemConversa({ a, aoMudar }: { a: ConversaMulti; aoMudar: () => void }) {
  const [aberto, setAberto] = useState(false)
  const [det, setDet] = useState<ConversaMultiDetalhe | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const teste = a.instancia === 'simulador'
  async function abrir() {
    const novo = !aberto
    setAberto(novo)
    if (novo) { try { setDet(await api.multiConversa(a.id)) } catch (e) { avisar('Não carregou', 'error', erroDe(e)) } }
  }
  async function mudar(acao: 'assumir' | 'devolver' | 'encerrar') {
    setOcupado(true)
    try { setDet(await api.multiEstado(a.id, acao)); setAberto(true); aoMudar() } catch (e) { avisar('Não mudou', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  async function liberar(sim: boolean) {
    setOcupado(true)
    try { await api.multiLiberar(a.contato, a.nome, sim); avisar(sim ? 'A IA vai responder este contato' : 'A IA não responde mais este contato'); aoMudar() }
    catch (e) { avisar('Não salvou', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  const e = ESTADO[a.estado]
  return (
    <div className="fila-item">
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="item-titulo">{a.nome || 'Sem nome'}{a.empresa ? ` · ${a.empresa}` : ''}{teste ? ' · teste' : ''}</div>
          <div className="etiqueta">{teste ? 'conversa de teste do painel' : `+${a.contato}`} · {haQuanto(a.atualizado_em)}
            {a.conduzido_por ? ` · com ${a.conduzido_por}` : ''}{a.pendentes > 0 ? ` · ${a.pendentes} p/ aprovar` : ''}
            {!teste && !a.liberado ? ' · IA não responde' : ''}</div>
        </div>
        <span className={`pilula ${e.classe}`}><i />{e.rotulo}</span>
      </div>
      {a.ultima_mensagem && <div className="item-texto" style={{ marginTop: 4 }}>“{a.ultima_mensagem}”</div>}
      {a.motivo && a.estado !== 'automatico' && <div className="etiqueta" style={{ marginTop: 4 }}>Motivo: {a.motivo}</div>}
      {a.resumo && a.estado === 'aguardando_humano' && <div className="aviso" style={{ marginTop: 6 }}>Resumo: {a.resumo}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="botao-mini" onClick={abrir}><ChevronDown size={12} style={{ transform: aberto ? 'rotate(180deg)' : undefined }} /> histórico</button>
        {!teste && (a.liberado
          ? <button className="botao-mini" disabled={ocupado} onClick={() => liberar(false)}><BotOff size={12} /> IA para de responder</button>
          : <button className="botao-mini" disabled={ocupado} onClick={() => liberar(true)}><Bot size={12} /> IA responde este contato</button>)}
        {(a.estado === 'automatico' || a.estado === 'aguardando_humano') &&
          <button className="botao-mini" disabled={ocupado} onClick={() => mudar('assumir')}><Hand size={12} /> assumir</button>}
        {a.estado !== 'automatico' &&
          <button className="botao-mini" disabled={ocupado} onClick={() => mudar('devolver')}><RotateCcw size={12} /> devolver para a IA</button>}
        {a.estado !== 'encerrado' &&
          <button className="botao-mini" disabled={ocupado} onClick={() => mudar('encerrar')}><XCircle size={12} /> encerrar</button>}
      </div>
      {aberto && (
        <div className="sim-mensagens" style={{ marginTop: 8 }}>
          {!det && <div className="vazio">Carregando…</div>}
          {det?.mensagens.length === 0 && <div className="vazio">Nenhuma mensagem.</div>}
          {det?.mensagens.map((x, i) => (
            <div key={i} className={`sim-msg ${x.papel === 'usuario' ? 'cliente-de-la' : x.papel === 'ia' ? 'ia' : 'voce'}`}>
              <span className="via">{PAPEL[x.papel]} · {fmt(x.em)}</span>{x.texto}
            </div>
          ))}
          {det && det.respostas.some(r => r.status === 'descartada' || r.status === 'falhou') && (
            <details style={{ marginTop: 6 }}>
              <summary className="etiqueta">Respostas que não saíram</summary>
              {det.respostas.filter(r => r.status === 'descartada' || r.status === 'falhou').map(r => (
                <div key={r.id} className="etiqueta" style={{ marginTop: 4 }}>{fmt(r.em)} · {r.motivo}{r.texto ? ` — “${r.texto.slice(0, 120)}”` : ''}</div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ aprovacao
function ItemAprovar({ f, aoMudar }: { f: Multi['fila'][number]; aoMudar: () => void }) {
  const [texto, setTexto] = useState(f.texto || '')
  const [ocupado, setOcupado] = useState(false)
  const [msg, setMsg] = useState('')
  return (
    <div className="fila-item">
      <div className="etiqueta">{f.nome || 'Cliente'}{f.contato.startsWith('teste') ? ' · teste' : ` · +${f.contato}`}{f.empresa ? ` · ${f.empresa}` : ''} · {fmt(f.criado_em)}</div>
      {f.pergunta && <div className="fila-pergunta">“{f.pergunta}”</div>}
      <div className="campo" style={{ margin: '8px 0' }}>
        <label htmlFor={`ma-${f.id}`}>Resposta da IA (edite se quiser)</label>
        <textarea id={`ma-${f.id}`} rows={3} value={texto} onChange={e => setTexto(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="botao" style={{ flex: 1 }} disabled={ocupado || !texto.trim()} onClick={async () => {
          setOcupado(true)
          try { const r = await api.multiAprovar(f.id, texto); setMsg(r.enviado ? 'Enviado ✓' : `Não enviado: ${r.motivo}`); setTimeout(aoMudar, 1500) }
          catch (e) { setMsg(erroDe(e)) } finally { setOcupado(false) }
        }}><Check size={14} /> Aprovar e enviar</button>
        <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} aria-label="Rejeitar"
          onClick={async () => { await api.multiRejeitar(f.id); aoMudar() }}><X size={14} /></button>
      </div>
      {msg && <div className="aviso ok" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ simulador (passa pelas mesmas regras do WhatsApp)
function SimuladorMulti({ modo, aoMudar }: { modo: ModoIA; aoMudar: () => void }) {
  const [msgs, setMsgs] = useState<{ de: 'cliente' | 'ia' | 'erro'; texto: string }[]>([])
  const [texto, setTexto] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const fim = useRef<HTMLDivElement>(null)
  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [msgs, ocupado])
  async function enviar(e: FormEvent) {
    e.preventDefault()
    const t = texto.trim()
    if (!t || ocupado) return
    setTexto('')
    setMsgs(m => [...m, { de: 'cliente', texto: t }])
    setOcupado(true)
    try {
      const r = await api.multiSimular(t)
      setMsgs(m => [...m, r.resposta ? { de: 'ia', texto: r.resposta } : { de: 'erro', texto: `Sem resposta: ${r.motivo || r.erro || '?'}` }])
      aoMudar()
    } catch (err) { setMsgs(m => [...m, { de: 'erro', texto: erroDe(err) }]) } finally { setOcupado(false) }
  }
  return (
    <Hud titulo="Testar como cliente" icone={<MessagesSquare size={14} />}
      extra={<button className="botao-mini" onClick={async () => { await api.multiSimular('', true); setMsgs([]); aoMudar() }}><RefreshCw size={12} /> nova</button>}>
      <div className="etiqueta" style={{ marginBottom: 8 }}>
        Você é o cliente. Passa pela mesma entrada, estado e conferência do WhatsApp, mas nada é enviado a ninguém.
        {modo === 'desligado' && ' Ligue em “Só observando” ou mais para testar (com “Só observando” ela guarda e não responde).'}
      </div>
      <div className="sim-mensagens">
        {msgs.length === 0 && <div className="vazio">Ex.: “tem pelúcia do Bob Esponja?”, “quero receber Pix na minha grua”, “preciso de um sistema para minha clínica”</div>}
        {msgs.map((m, i) => <div key={i} className={`sim-msg ${m.de}`}>{m.texto}</div>)}
        {ocupado && <div className="sim-msg ia"><span className="digitando"><i /><i /><i /></span></div>}
        <div ref={fim} />
      </div>
      <form onSubmit={enviar} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Mensagem do cliente" placeholder="Mensagem do cliente…" value={texto} onChange={e => setTexto(e.target.value)} /></div>
        <button className="botao" style={{ width: 'auto' }} disabled={!texto.trim() || ocupado} aria-label="Enviar"><Send size={14} /></button>
      </form>
    </Hud>
  )
}

// ------------------------------------------------------------------ empresas
function CartaoEmpresa({ e, aoMudar }: { e: EmpresaMulti; aoMudar: (m: Multi) => void }) {
  const [aberto, setAberto] = useState(false)
  const [f, setF] = useState({ nome: e.nome, descricao: e.descricao, assuntos: e.assuntos, site: e.site ?? '', tom: e.tom ?? '',
    responsavel: e.responsavel ?? '', catalogo_url: e.catalogo_url ?? '', catalogo_env: e.catalogo_env ?? '' })
  const [ocupado, setOcupado] = useState(false)
  const campo = (k: keyof typeof f) => ({ value: f[k], onChange: (ev: { target: { value: string } }) => setF(x => ({ ...x, [k]: ev.target.value })) })
  async function salvar(extra: Partial<EmpresaMulti> = {}) {
    setOcupado(true)
    try { aoMudar(await api.multiEmpresa({ id: e.id, ...f, ...extra })); avisar('Empresa salva') } catch (err) { avisar('Não salvou', 'error', erroDe(err)) } finally { setOcupado(false) }
  }
  const revisar = e.descricao.includes('REVISAR')
  return (
    <div className="fila-item" style={{ opacity: e.ativo ? 1 : 0.6 }}>
      <button className="botao-mini" style={{ width: '100%', justifyContent: 'space-between', display: 'flex' }} onClick={() => setAberto(a => !a)}>
        <span><b>{e.nome}</b> · {e.base.length} informações{e.catalogo_url ? ' · catálogo conectado' : ''}{!e.ativo ? ' · desativada' : ''}{revisar ? ' · revisar descrição' : ''}</span>
        <ChevronDown size={12} style={{ transform: aberto ? 'rotate(180deg)' : undefined }} />
      </button>
      {aberto && (
        <div style={{ marginTop: 10 }}>
          <div className="linha-2">
            <div className="campo"><label>Nome</label><input {...campo('nome')} /></div>
            <div className="campo"><label>Responsável pelas informações</label><input {...campo('responsavel')} /></div>
          </div>
          <div className="campo"><label>O que a empresa faz/vende (a IA lê isto)</label><textarea rows={3} {...campo('descricao')} /></div>
          <div className="campo"><label>Como reconhecer o assunto (exemplos, produtos, termos)</label><textarea rows={2} {...campo('assuntos')} /></div>
          <div className="linha-2">
            <div className="campo"><label>Site</label><input placeholder="https://" {...campo('site')} /></div>
            <div className="campo"><label>Tom (opcional)</label><input {...campo('tom')} /></div>
          </div>
          <div className="linha-2">
            <div className="campo"><label>API do catálogo (somente leitura)</label><input placeholder="https://loja.com/api/atendimento" {...campo('catalogo_url')} /></div>
            <div className="campo"><label>Variável do token no servidor</label><input placeholder="GIRAKIDS_API_TOKEN" {...campo('catalogo_env')} /></div>
          </div>
          <div className="etiqueta" style={{ marginBottom: 8 }}>O token fica só no servidor (variável de ambiente do n8n). Aqui vai apenas o nome dela.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="botao" style={{ flex: 1 }} disabled={ocupado || !f.nome.trim()} onClick={() => salvar()}><Save size={14} /> Salvar empresa</button>
            <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} onClick={() => salvar({ ativo: !e.ativo })}>{e.ativo ? 'Desativar' : 'Ativar'}</button>
          </div>
          <div className="menu-secao" style={{ marginTop: 14 }}>Informações aprovadas</div>
          {e.base.length === 0 && <div className="vazio">Nada ainda. Sem informação aqui, a IA não afirma nada desta empresa e oferece passar para a equipe.</div>}
          {e.base.map(b => <ItemBase key={b.id} b={b} aoMudar={aoMudar} />)}
          <NovoItemBase empresaId={e.id} responsavel={e.responsavel ?? ''} aoMudar={aoMudar} />
        </div>
      )}
    </div>
  )
}

function ItemBase({ b, aoMudar }: { b: ItemBaseEmpresa; aoMudar: (m: Multi) => void }) {
  const [editando, setEditando] = useState(false)
  const [f, setF] = useState({ tipo: b.tipo, titulo: b.titulo, conteudo: b.conteudo, responsavel: b.responsavel ?? '' })
  if (!editando) return (
    <div className="item-base" style={{ padding: '6px 0', borderBottom: '1px solid var(--linha)' }}>
      <div className="item-titulo" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span className="origem">{TIPOS.find(t => t.id === b.tipo)?.nome}</span><span style={{ flex: 1 }}>{b.titulo}</span>
        <button className="botao-mini" onClick={() => setEditando(true)}>editar</button>
        <button className="botao-mini" aria-label="Apagar" onClick={async () => {
          if (await confirmar({ titulo: 'Apagar esta informação?', texto: 'A IA deixa de usar isto nas respostas.', botao: 'Apagar', perigo: true }))
            aoMudar(await api.multiBase({ id: b.id, apagar: true }))
        }}><Trash2 size={12} /></button>
      </div>
      <div className="item-texto" style={{ whiteSpace: 'pre-wrap' }}>{b.conteudo}</div>
      <div className="etiqueta">{b.responsavel ? `${b.responsavel} · ` : ''}atualizado {fmt(b.atualizado_em)}</div>
    </div>
  )
  return <FormBase f={f} setF={setF} botao="Salvar" aoCancelar={() => setEditando(false)}
    aoSalvar={async () => { aoMudar(await api.multiBase({ id: b.id, ...f })); setEditando(false) }} />
}

function NovoItemBase({ empresaId, responsavel, aoMudar }: { empresaId: number; responsavel: string; aoMudar: (m: Multi) => void }) {
  const vazio = { tipo: 'faq' as TipoBase, titulo: '', conteudo: '', responsavel }
  const [aberto, setAberto] = useState(false)
  const [f, setF] = useState(vazio)
  if (!aberto) return <button className="botao-mini" style={{ marginTop: 8 }} onClick={() => setAberto(true)}><Plus size={12} /> adicionar informação</button>
  return <FormBase f={f} setF={setF} botao="Adicionar" aoCancelar={() => setAberto(false)}
    aoSalvar={async () => { aoMudar(await api.multiBase({ empresa_id: empresaId, ...f })); setF(vazio); setAberto(false) }} />
}

type FBase = { tipo: TipoBase; titulo: string; conteudo: string; responsavel: string }
function FormBase({ f, setF, botao, aoSalvar, aoCancelar }: { f: FBase; setF: (f: FBase) => void; botao: string; aoSalvar: () => Promise<void>; aoCancelar: () => void }) {
  const [ocupado, setOcupado] = useState(false)
  return (
    <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--linha)', borderRadius: 8 }}>
      <div className="linha-2">
        <div className="campo"><label>Tipo</label>
          <select value={f.tipo} onChange={e => setF({ ...f, tipo: e.target.value as TipoBase })}>{TIPOS.map(t => <option key={t.id} value={t.id}>{t.nome}</option>)}</select></div>
        <div className="campo"><label>Responsável</label><input value={f.responsavel} onChange={e => setF({ ...f, responsavel: e.target.value })} /></div>
      </div>
      <div className="campo"><label>Título</label><input value={f.titulo} placeholder="Ex.: Formas de pagamento" onChange={e => setF({ ...f, titulo: e.target.value })} /></div>
      <div className="campo"><label>Informação (exatamente o que a IA pode dizer)</label>
        <textarea rows={4} value={f.conteudo} onChange={e => setF({ ...f, conteudo: e.target.value })} /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="botao" style={{ flex: 1 }} disabled={ocupado || !f.titulo.trim() || !f.conteudo.trim()}
          onClick={async () => { setOcupado(true); try { await aoSalvar() } catch (e) { avisar('Não salvou', 'error', erroDe(e)) } finally { setOcupado(false) } }}>
          <Check size={14} /> {botao}</button>
        <button className="botao secundario" style={{ width: 'auto' }} onClick={aoCancelar}>Cancelar</button>
      </div>
    </div>
  )
}

function NovaEmpresa({ aoMudar }: { aoMudar: (m: Multi) => void }) {
  const [nome, setNome] = useState('')
  return (
    <form style={{ display: 'flex', gap: 8, marginTop: 10 }} onSubmit={async ev => {
      ev.preventDefault()
      if (!nome.trim()) return
      try { aoMudar(await api.multiEmpresa({ nome: nome.trim() })); setNome(''); avisar('Empresa criada. Abra para descrever o que ela faz.') }
      catch (e) { avisar('Não criou', 'error', erroDe(e)) }
    }}>
      <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Nova empresa" placeholder="Nova empresa…" value={nome} onChange={e => setNome(e.target.value)} /></div>
      <button className="botao" style={{ width: 'auto' }} disabled={!nome.trim()}><Plus size={14} /> Criar</button>
    </form>
  )
}
