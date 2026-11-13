import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BookOpen, Check, CircleUser, Eye, Headset, Inbox, MessagesSquare, RefreshCw, Send, Settings2, Trash2, X, LifeBuoy, Sparkles, UserPlus, ChevronDown } from 'lucide-react'
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

// ------------------------------------------------------------------ sugestao aprendida
function ItemSugestao({ s: sg, aoMudar }: { s: AtendimentoPainel['sugestoes'][number]; aoMudar: () => void }) {
  const [titulo, setTitulo] = useState(sg.titulo || '')
  const [conteudo, setConteudo] = useState(sg.conteudo)
  const [area, setArea] = useState<Area>(sg.dominio)
  return (
    <div className="fila-item">
      <div className="etiqueta">Aprendido de uma conversa{sg.cliente ? ` com ${sg.cliente}` : ''} · {fmt(sg.criado_em)}</div>
      <div className="linha-2" style={{ marginTop: 6 }}>
        <div className="campo" style={{ margin: 0 }}><select aria-label="Área" value={area} onChange={e => setArea(e.target.value as Area)}>
          <option value="comercial">Comercial</option><option value="suporte">Suporte</option><option value="geral">Geral</option></select></div>
        <div className="campo" style={{ margin: 0 }}><input aria-label="Título" value={titulo} onChange={e => setTitulo(e.target.value)} /></div>
      </div>
      <div className="campo" style={{ margin: '8px 0' }}><textarea aria-label="Conteúdo" rows={3} value={conteudo} onChange={e => setConteudo(e.target.value)} /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="botao" style={{ flex: 1 }} onClick={async () => { await api.sugestaoAprovar(sg.id, area, titulo, conteudo); aoMudar() }}><Check size={14} /> Aprovar</button>
        <button className="botao secundario" style={{ width: 'auto' }} aria-label="Descartar" onClick={async () => { await api.sugestaoDescartar(sg.id); aoMudar() }}><X size={14} /></button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ cliente (com conversa)
const ROTULO_PAPEL = { usuario: 'CLIENTE', humano: 'VOCÊ', ia: 'IA' } as const
function ItemCliente({ c, alcance, aoMudar }: { c: AtendimentoPainel['clientes'][number]; alcance: string; aoMudar: () => void }) {
  const [aberto, setAberto] = useState(false)
  const [msgs, setMsgs] = useState<{ papel: 'usuario' | 'humano' | 'ia'; texto: string; em: string }[] | null>(null)
  async function abrir() {
    setAberto(a => !a)
    if (!msgs) setMsgs((await api.clienteConversa(c.id)).mensagens)
  }
  return (
    <div className="fila-item">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="item-titulo"><span className="origem">{c.etapa.toUpperCase()}</span>{c.nome || 'sem nome'}{c.empresa ? ` · ${c.empresa}` : ''}</div>
          <div className="etiqueta">+{c.whatsapp} · {c.mensagens} msgs · {c.respostas_humanas} respostas suas</div>
          {c.interesse && <div className="item-texto">Quer: {c.interesse}</div>}
        </div>
        <span className="etiqueta" title="IA responde este cliente">IA</span>
        <button role="switch" aria-checked={c.ia_responde} aria-label={`IA responde ${c.nome || c.whatsapp}`}
          className={`interruptor ${c.ia_responde || alcance === 'todos' ? 'ligado' : ''}`} disabled={alcance === 'todos'}
          title={alcance === 'todos' ? 'A IA responde todos (mude o alcance para escolher)' : ''}
          onClick={async () => { await api.clienteIa(c.id, !c.ia_responde); aoMudar() }} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="botao-icone" style={{ width: 'auto', height: 24, padding: '0 8px', fontSize: 11, display: 'flex', gap: 4 }} onClick={abrir}>
          <ChevronDown size={12} style={{ transform: aberto ? 'rotate(180deg)' : undefined }} /> conversa
        </button>
        <button className="botao-icone" style={{ width: 'auto', height: 24, padding: '0 8px', fontSize: 11, display: 'flex', gap: 4 }}
          onClick={async () => { if (confirm('Parar de observar este cliente e apagar as conversas guardadas?')) { await api.clienteApagar(c.id); aoMudar() } }}>
          <Trash2 size={12} /> remover
        </button>
      </div>
      {aberto && (
        <div className="sim-mensagens" style={{ marginTop: 6 }}>
          {!msgs && <div className="vazio">Carregando…</div>}
          {msgs && msgs.length === 0 && <div className="vazio">Nenhuma mensagem guardada ainda.</div>}
          {msgs?.map((m, i) => (
            <div key={i} className={`sim-msg ${m.papel === 'usuario' ? 'cliente-de-la' : m.papel === 'humano' ? 'voce' : 'ia'}`}>
              <span className="via">{ROTULO_PAPEL[m.papel]} · {fmt(m.em)}</span>{m.texto}
            </div>
          ))}
        </div>
      )}
    </div>
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
  const [novoCli, setNovoCli] = useState({ nome: '', whatsapp: '' })
  const [aprendendo, setAprendendo] = useState('')

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
            {(['desligado', 'observando', 'aprovacao', 'automatico'] as const).map(m => (
              <button key={m} className={modo === m ? 'ativo' : ''} onClick={async () => { await api.atendimentoConfig({ modo: m }); void carregar() }}>
                {m === 'desligado' ? 'Desligada' : m === 'observando' ? 'Só observando' : m === 'aprovacao' ? 'Com aprovação' : 'Automática'}
              </button>
            ))}
          </div>
          <div className="etiqueta" style={{ margin: '8px 0 10px' }}>
            {modo === 'observando' ? `${empresa.persona || 'A IA'} só lê as conversas e aprende com as suas respostas. Ninguém recebe resposta da IA.`
              : modo === 'aprovacao' ? 'A IA sugere; você aprova/edita aqui antes de ir para o cliente. Cada aprovação ensina a IA.'
              : modo === 'automatico' ? 'A IA responde sozinha.' : 'Não lê nem responde clientes.'}
          </div>
          {(modo === 'aprovacao' || modo === 'automatico') && (
            <div className="chave">
              <div className="chave-texto"><b>Responde para</b><span>{d.config.alcance === 'todos' ? 'Todos os clientes' : 'Só os clientes marcados (interruptor IA na lista)'}</span></div>
              <div className="modos" style={{ flexWrap: 'nowrap' }}>
                {(['selecionados', 'todos'] as const).map(a => (
                  <button key={a} className={d.config.alcance === a ? 'ativo' : ''} onClick={async () => { await api.atendimentoConfig({ alcance: a }); void carregar() }}>{a === 'todos' ? 'Todos' : 'Marcados'}</button>
                ))}
              </div>
            </div>
          )}
          <div className="chave">
            <div className="chave-texto"><b>Lê conversas de</b>
              <span>{d.config.observar === 'todos' ? '⚠ Todos os números que falarem com você (inclui família e amigos)' : 'Só números cadastrados como cliente (abaixo). Família e amigos ficam de fora.'}</span></div>
            <div className="modos" style={{ flexWrap: 'nowrap' }}>
              {(['clientes', 'todos'] as const).map(o => (
                <button key={o} className={d.config.observar === o ? 'ativo' : ''} onClick={async () => {
                  if (o === 'todos' && !confirm('A IA vai ler e guardar as conversas de TODOS os números que falarem com você, inclusive pessoais. Continuar?')) return
                  await api.atendimentoConfig({ observar: o }); void carregar()
                }}>{o === 'todos' ? 'Todos' : 'Clientes'}</button>
              ))}
            </div>
          </div>
        </Hud>

        <Hud titulo={`Para aprovar`} icone={<Inbox size={14} />} extra={<span className="contagem">{d.fila.length}</span>}>
          {d.fila.length === 0 && <div className="vazio">Nada esperando aprovação.</div>}
          {d.fila.map(f => <ItemFila key={f.id} f={f} aoMudar={carregar} />)}
        </Hud>

        <Hud titulo="Aprendido para revisar" icone={<Sparkles size={14} />}
          extra={<button className="botao-icone" style={{ width: 'auto', height: 22, padding: '0 8px', fontSize: 10, display: 'flex', gap: 5 }}
            disabled={aprendendo === '…'} onClick={async () => {
              setAprendendo('…')
              try { const r = await api.aprenderAgora(); setAprendendo(r.sugestoes ? `${r.sugestoes} novas` : 'nada novo') } catch { setAprendendo('falhou') }
              void carregar(); setTimeout(() => setAprendendo(''), 4000)
            }}><RefreshCw size={12} className={aprendendo === '…' ? 'girando' : ''} /> {aprendendo || 'aprender agora'}</button>}>
          <div className="etiqueta" style={{ marginBottom: 6 }}>O que a IA tirou das suas respostas aos clientes (a cada 30 min). Só vale depois de aprovado.</div>
          {d.sugestoes.length === 0 && <div className="vazio">Nada novo. Responda clientes pelo WhatsApp e volte aqui.</div>}
          {d.sugestoes.map(sg => <ItemSugestao key={sg.id} s={sg} aoMudar={carregar} />)}
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
          <div className="linha-2">
            <div className="campo"><label htmlFor="e-nome">Empresa</label><input id="e-nome" value={empresa.nome} onChange={e => setEmpresa({ ...empresa, nome: e.target.value })} /></div>
            <div className="campo"><label htmlFor="e-pers">Nome de quem atende</label><input id="e-pers" placeholder="Leo 2.0" value={empresa.persona || ''} onChange={e => setEmpresa({ ...empresa, persona: e.target.value })} /></div>
          </div>
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
          <form onSubmit={async e => { e.preventDefault(); await api.clienteSalvar(novoCli.nome, novoCli.whatsapp); setNovoCli({ nome: '', whatsapp: '' }); void carregar() }}
            style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Nome do cliente" placeholder="Nome" value={novoCli.nome} onChange={e => setNovoCli({ ...novoCli, nome: e.target.value })} /></div>
            <div className="campo" style={{ flex: 1.2, margin: 0 }}><input aria-label="WhatsApp do cliente" placeholder="55 11 9…" inputMode="tel" value={novoCli.whatsapp} onChange={e => setNovoCli({ ...novoCli, whatsapp: e.target.value })} /></div>
            <button className="botao" style={{ width: 'auto' }} disabled={novoCli.whatsapp.replace(/[^0-9]/g, '').length < 10} aria-label="Cadastrar cliente"><UserPlus size={14} /></button>
          </form>
          <div className="etiqueta" style={{ marginBottom: 4 }}>Clientes cadastrados são lidos pela IA. O interruptor IA libera a resposta automática para aquele cliente.</div>
          {d.clientes.length === 0 && <div className="vazio">Nenhum cliente ainda.</div>}
          {d.clientes.map(c => <ItemCliente key={c.id} c={c} alcance={d.config.alcance} aoMudar={carregar} />)}
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
