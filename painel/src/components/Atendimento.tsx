import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, MessagesSquare, RefreshCw, Send, Trash2, X, ChevronDown } from 'lucide-react'
import { api, type Area, type AgenteAtend, type AtendimentoPainel } from '../api'
import { Hud, fmt } from './ui'


// ------------------------------------------------------------------ fila de aprovacao
export function ItemFila({ f, aoMudar, areaPadrao = 'geral', aprender = true }: { f: AtendimentoPainel['fila'][number]; aoMudar: () => void; areaPadrao?: Area; aprender?: boolean }) {
  const [texto, setTexto] = useState(f.rascunho)
  const [area, setArea] = useState<Area>(areaPadrao)
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
        {aprender && <div className="campo" style={{ margin: 0, width: 130 }}>
          <select aria-label="Aprender como" value={area} onChange={e => setArea(e.target.value as Area)}>
            <option value="geral">Aprender: geral</option><option value="suporte">Aprender: suporte</option><option value="comercial">Aprender: comercial</option>
          </select>
        </div>}
        <button className="botao" style={{ width: 'auto', flex: 1 }} disabled={ocupado || !texto.trim()} onClick={aprovar}><Check size={14} /> Aprovar e enviar</button>
        <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} onClick={async () => { await api.filaRejeitar(f.id); aoMudar() }} aria-label="Rejeitar"><X size={14} /></button>
      </div>
      {msg && <div className="aviso ok" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ simulador
export function Simulador({ aoMudar, agente, dica }: { aoMudar: () => void; agente: AgenteAtend | 'gabriel'; dica?: string }) {
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
    try { const r = await api.atendimentoTeste(t, sessao, agente); setMsgs(m => [...m, { de: 'ia', texto: r.resposta }]); aoMudar() }
    catch (err) { setMsgs(m => [...m, { de: 'erro', texto: err instanceof Error ? err.message : 'Falhou' }]) }
    finally { setOcupado(false) }
  }
  return (
    <Hud titulo="Simular cliente" icone={<MessagesSquare size={14} />}
      extra={<button className="botao-icone" style={{ width: 'auto', height: 22, padding: '0 8px', fontSize: 10, display: 'flex', gap: 5 }}
        onClick={() => { setMsgs([]); setSessao(String(Date.now())) }}><RefreshCw size={12} /> nova</button>}>
      <div className="etiqueta" style={{ marginBottom: 8 }}>{dica || 'Você é o cliente. Resposta direta (sem fila de aprovação). Chamados de teste não avisam ninguém.'}</div>
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
export function ItemSugestao({ s: sg, aoMudar }: { s: AtendimentoPainel['sugestoes'][number]; aoMudar: () => void }) {
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
export function ItemCliente({ c, alcance, aoMudar, agente }: { c: AtendimentoPainel['clientes'][number]; alcance: string; aoMudar: () => void; agente: AgenteAtend }) {
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
          onClick={async () => { await api.clienteIa(c.id, !c.ia_responde, agente); aoMudar() }} />
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

