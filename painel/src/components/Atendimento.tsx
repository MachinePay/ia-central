import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BookOpen, Check, CircleUser, Eye, Headset, Inbox, MessagesSquare, RefreshCw, Send, Settings2, Trash2, X, LifeBuoy } from 'lucide-react'
import { api, ErroApi, type Area, type AtendimentoPainel, type Empresa } from '../api'

const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const ROTULO_AREA: Record<string, string> = { suporte: 'SUPORTE', comercial: 'COMERCIAL', sistemico: 'SISTÊMICO', humano: 'HUMANO', geral: 'GERAL' }

function Hud({ titulo, icone, extra, children, className = '' }: { titulo: string; icone: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`hud ${className}`}>
      <div className="hud-titulo"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{icone}{titulo}</span>{extra}</div>
      <div className="hud-corpo">{children}</div>
    </section>
  )
}

// ------------------------------------------------------------------ fila de aprovacao
function ItemFila({ f, aoMudar }: { f: AtendimentoPainel['fila'][number]; aoMudar: () => void }) {
  const [texto, setTexto] = useState(f.rascunho)
  const [area, setArea] = useState<Area>('geral')
  const [msg, setMsg] = useState('')
  const [ocupado, setOcupado] = useState(false)
  async function aprovar() {
    setOcupado(true)
    try {
      const r = await api.filaAprovar(f.id, texto, area)
      setMsg(r.enviado ? 'Enviado e aprendido ✓' : `Aprendido ✓ (não enviado: ${r.motivo})`)
      setTimeout(aoMudar, 1200)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Falhou') } finally { setOcupado(false) }
  }
  return (
    <div className="fila-item">
      <div className="etiqueta">{f.nome || 'Cliente'}{f.whatsapp && !f.whatsapp.startsWith('teste') ? ` · +${f.whatsapp}` : ''} · {fmt(f.criado_em)}</div>
      <div className="fila-pergunta">“{f.pergunta}”</div>
      <div className="campo" style={{ margin: '8px 0' }}>
        <label htmlFor={`r-${f.id}`}>Resposta da IA (edite se quiser)</label>
        <textarea id={`r-${f.id}`} rows={4} value={texto} onChange={e => setTexto(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="campo" style={{ margin: 0, width: 130 }}>
          <select aria-label="Aprender como" value={area} onChange={e => setArea(e.target.value as Area)}>
            <option value="geral">Aprender: geral</option><option value="suporte">Aprender: suporte</option><option value="comercial">Aprender: comercial</option>
          </select>
        </div>
        <button className="botao" style={{ width: 'auto', flex: 1 }} disabled={ocupado || !texto.trim()} onClick={aprovar}><Check size={14} /> Aprovar e enviar</button>
        <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} onClick={async () => { await api.filaRejeitar(f.id); aoMudar() }} aria-label="Rejeitar"><X size={14} /></button>
      </div>
      {msg && <div className="aviso ok" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ simulador
function Simulador({ aoMudar }: { aoMudar: () => void }) {
  const [msgs, setMsgs] = useState<{ de: 'cliente' | 'ia' | 'erro'; texto: string }[]>([])
  const [texto, setTexto] = useState('')
  const [sessao, setSessao] = useState(() => String(Date.now()))
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
    try { const r = await api.atendimentoTeste(t, sessao); setMsgs(m => [...m, { de: 'ia', texto: r.resposta }]); aoMudar() }
    catch (err) { setMsgs(m => [...m, { de: 'erro', texto: err instanceof Error ? err.message : 'Falhou' }]) }
    finally { setOcupado(false) }
  }
  return (
    <Hud titulo="Simular cliente" icone={<MessagesSquare size={14} />}
      extra={<button className="botao-icone" style={{ width: 'auto', height: 22, padding: '0 8px', fontSize: 10, display: 'flex', gap: 5 }}
        onClick={() => { setMsgs([]); setSessao(String(Date.now())) }}><RefreshCw size={12} /> nova</button>}>
      <div className="etiqueta" style={{ marginBottom: 8 }}>Você é o cliente. Resposta direta (sem fila de aprovação). Chamados de teste não avisam ninguém.</div>
      <div className="sim-mensagens">
        {msgs.length === 0 && <div className="vazio">Ex.: "oi, quanto custa?", "o sistema caiu?", "não consigo entrar"</div>}
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

// ------------------------------------------------------------------ tela
export function Atendimento({ aoSair }: { aoSair: () => void }) {
  const [d, setD] = useState<AtendimentoPainel | null>(null)
  const [erro, setErro] = useState('')
  const [empresa, setEmpresa] = useState<Empresa | null>(null)
  const [salvo, setSalvo] = useState('')
  const [nova, setNova] = useState<{ area: Area; titulo: string; conteudo: string }>({ area: 'comercial', titulo: '', conteudo: '' })
  const [filtro, setFiltro] = useState<Area | 'todas'>('todas')

  const carregar = useCallback(async () => {
    try { const r = await api.atendimento(); setD(r); setEmpresa(e => e ?? r.config.empresa); setErro('') }
    catch (e) { if (e instanceof ErroApi && e.status === 401) aoSair(); else setErro(e instanceof Error ? e.message : 'Falhou') }
  }, [aoSair])
  useEffect(() => { void carregar(); const t = setInterval(carregar, 15000); return () => clearInterval(t) }, [carregar])

  if (!d || !empresa) return <div className="atendimento"><div className="vazio">{erro || 'Carregando…'}</div></div>
  const modo = d.config.modo
  const base = d.base.filter(b => filtro === 'todas' || b.dominio === filtro)

  return (
    <div className="atendimento">
      <div className="atend-coluna">
        <Hud titulo="Atendente" icone={<Headset size={14} />}>
          <div className="modos">
            {(['desligado', 'aprovacao', 'automatico'] as const).map(m => (
              <button key={m} className={modo === m ? 'ativo' : ''} onClick={async () => { await api.atendimentoConfig({ modo: m }); void carregar() }}>
                {m === 'desligado' ? 'Desligada' : m === 'aprovacao' ? 'Com aprovação' : 'Automática'}
              </button>
            ))}
          </div>
          <div className="etiqueta" style={{ margin: '8px 0 4px' }}>
            {modo === 'aprovacao' ? 'A IA sugere; você aprova/edita aqui antes de ir para o cliente. Cada aprovação ensina a IA.'
              : modo === 'automatico' ? 'A IA responde os clientes sozinha.' : 'Clientes não recebem resposta.'}
            {' '}Só atende no WhatsApp em <b>modo dedicado</b> (chip da IA).
          </div>
        </Hud>

        <Hud titulo={`Para aprovar`} icone={<Inbox size={14} />} extra={<span className="contagem">{d.fila.length}</span>}>
          {d.fila.length === 0 && <div className="vazio">Nada esperando aprovação.</div>}
          {d.fila.map(f => <ItemFila key={f.id} f={f} aoMudar={carregar} />)}
        </Hud>

        <Simulador aoMudar={carregar} />
      </div>

      <div className="atend-coluna">
        <Hud titulo="Base de conhecimento" icone={<BookOpen size={14} />} extra={<span className="contagem">{d.base.length}</span>}>
          <form onSubmit={async e => { e.preventDefault(); await api.baseSalvar(nova.area, nova.titulo, nova.conteudo); setNova({ ...nova, titulo: '', conteudo: '' }); void carregar() }}>
            <div className="linha-2">
              <div className="campo"><label htmlFor="b-area">Área</label>
                <select id="b-area" value={nova.area} onChange={e => setNova({ ...nova, area: e.target.value as Area })}>
                  <option value="comercial">Comercial</option><option value="suporte">Suporte</option><option value="geral">Geral (todas)</option>
                </select></div>
              <div className="campo"><label htmlFor="b-tit">Título</label><input id="b-tit" placeholder="Ex.: Preço do plano" value={nova.titulo} onChange={e => setNova({ ...nova, titulo: e.target.value })} /></div>
            </div>
            <div className="campo"><label htmlFor="b-cont">O que a IA deve saber</label>
              <textarea id="b-cont" rows={3} required placeholder="Ex.: O plano mensal custa R$ 99, cancela quando quiser, pagamento por Pix ou cartão." value={nova.conteudo} onChange={e => setNova({ ...nova, conteudo: e.target.value })} /></div>
            <button className="botao" disabled={!nova.conteudo.trim()}>Adicionar à base</button>
          </form>
          <div className="modos" style={{ marginTop: 12 }}>
            {(['todas', 'comercial', 'suporte', 'geral'] as const).map(a => <button key={a} className={filtro === a ? 'ativo' : ''} onClick={() => setFiltro(a)}>{a}</button>)}
          </div>
          {base.length === 0 && <div className="vazio">Vazia. Cadastre preços, FAQ, políticas, horários…</div>}
          {base.map(b => (
            <div className="item" key={b.id}>
              <div>
                <div className="item-titulo"><span className="origem">{ROTULO_AREA[b.dominio]}</span>{b.titulo || 'sem título'}{b.origem === 'resposta_aprovada' && <span className="aprendido"> aprendido</span>}</div>
                <div className="item-texto">{b.conteudo}</div>
              </div>
              <button aria-label="Apagar" onClick={async () => { await api.baseApagar(b.id); void carregar() }}><Trash2 size={14} /></button>
            </div>
          ))}
        </Hud>

        <Hud titulo="Empresa" icone={<Settings2 size={14} />}>
          {salvo && <div className="aviso ok">{salvo}</div>}
          <div className="campo"><label htmlFor="e-nome">Nome</label><input id="e-nome" value={empresa.nome} onChange={e => setEmpresa({ ...empresa, nome: e.target.value })} /></div>
          <div className="campo"><label htmlFor="e-desc">O que a empresa faz</label><textarea id="e-desc" rows={2} value={empresa.descricao} onChange={e => setEmpresa({ ...empresa, descricao: e.target.value })} /></div>
          <div className="linha-2">
            <div className="campo"><label htmlFor="e-hor">Horário humano</label><input id="e-hor" value={empresa.horario} onChange={e => setEmpresa({ ...empresa, horario: e.target.value })} /></div>
            <div className="campo"><label htmlFor="e-tom">Tom de voz</label><input id="e-tom" value={empresa.tom} onChange={e => setEmpresa({ ...empresa, tom: e.target.value })} /></div>
          </div>
          <button className="botao secundario" onClick={async () => { await api.atendimentoConfig({ empresa }); setSalvo('Salvo ✓'); setTimeout(() => setSalvo(''), 2000) }}>Salvar empresa</button>
        </Hud>
      </div>

      <div className="atend-coluna">
        <Hud titulo="Chamados abertos" icone={<LifeBuoy size={14} />} extra={<span className="contagem">{d.chamados.length}</span>}>
          {d.chamados.length === 0 && <div className="vazio">Nenhum chamado aberto.</div>}
          {d.chamados.map(c => (
            <div className="item" key={c.id}>
              <div>
                <div className="item-titulo"><span className={`origem ${c.prioridade === 'alta' ? 'alta' : ''}`}>{ROTULO_AREA[c.area] ?? c.area}</span>#{c.id} {c.titulo}</div>
                {c.descricao && <div className="item-texto">{c.descricao}</div>}
                <div className="etiqueta">{c.nome || 'Cliente'}{c.whatsapp && !c.whatsapp.startsWith('teste') ? ` · +${c.whatsapp}` : ' · teste'} · {fmt(c.criado_em)}</div>
              </div>
              <button aria-label="Marcar resolvido" title="Resolvido" onClick={async () => { await api.chamadoResolver(c.id); void carregar() }}><Check size={14} /></button>
            </div>
          ))}
        </Hud>

        <Hud titulo="Clientes" icone={<CircleUser size={14} />} extra={<span className="contagem">{d.clientes.length}</span>}>
          {d.clientes.length === 0 && <div className="vazio">Ninguém ainda.</div>}
          {d.clientes.map(c => (
            <div className="item" key={c.id}>
              <div>
                <div className="item-titulo"><span className="origem">{c.etapa.toUpperCase()}</span>{c.nome || 'sem nome'}{c.empresa ? ` · ${c.empresa}` : ''}</div>
                {c.interesse && <div className="item-texto">Quer: {c.interesse}</div>}
                <div className="etiqueta">+{c.whatsapp} · {fmt(c.ultimo_contato)}</div>
              </div>
            </div>
          ))}
        </Hud>

        <Hud titulo="Visível para clientes" icone={<Eye size={14} />}>
          <div className="etiqueta" style={{ marginBottom: 6 }}>Serviços que o especialista sistêmico pode dizer se estão fora.</div>
          {d.sistemas.length === 0 && <div className="vazio">Nenhum site monitorado.</div>}
          {d.sistemas.map(s => (
            <div className="chave" key={s.id}>
              <div className="chave-texto"><b>{s.nome}</b></div>
              <button role="switch" aria-checked={s.publico} aria-label={`Mostrar ${s.nome} para clientes`} className={`interruptor ${s.publico ? 'ligado' : ''}`}
                onClick={async () => { await api.sistemaPublico(s.id, !s.publico); void carregar() }} />
            </div>
          ))}
        </Hud>
      </div>
    </div>
  )
}
