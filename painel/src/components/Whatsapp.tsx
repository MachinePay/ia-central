import { useCallback, useEffect, useState } from 'react'
import { MessageCircle, QrCode, Smartphone, Unplug, RefreshCw, Eye, Plus, Trash2, Brain, Check, X } from 'lucide-react'
import { api, type Agente, type Instancia, type ModoObservar, type Observacao, type WhatsappStatus } from '../api'

const ROTULO: Record<WhatsappStatus['estado'], string> = {
  open: 'Conectado', close: 'Desconectado', connecting: 'Aguardando leitura do QR',
  inexistente: 'Nunca conectado', erro: 'Evolution API fora do ar',
}
const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// ------------------------------------------------------------------ uma conexao (Leo ou Joao)
export function Conexao({ instancia, titulo, dica }: { instancia: Instancia; titulo: string; dica: string }) {
  const [st, setSt] = useState<WhatsappStatus | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState('')
  const [numero, setNumero] = useState('')
  const [qrEm, setQrEm] = useState('')   // hora do QR na tela (para ver que ele esta mudando)

  const chamar = useCallback(async (op: 'status' | 'conectar' | 'desconectar', num?: string) => {
    setCarregando(true); setErro('')
    try {
      const s = await api.whatsapp(op, { instancia, numero: num })
      setSt(s)
      if (s.qr) setQrEm(new Date().toLocaleTimeString('pt-BR'))
    }
    catch (e) { setErro(e instanceof Error ? e.message : 'Falhou') }
    finally { setCarregando(false) }
  }, [instancia])

  useEffect(() => { void chamar('status') }, [chamar])
  useEffect(() => {   // enquanto espera ler: a cada 5s ve se conectou e pega o QR mais novo (o WhatsApp troca a cada ~20s)
    if (!st || st.estado === 'open' || !(st.qr || st.codigo)) return
    const t = setInterval(async () => {
      try {
        const s = await api.whatsapp(st.qr ? 'qr' : 'status', { instancia })
        if (s.estado === 'open') { setSt(s); return }
        if (s.estado !== 'connecting') { setSt(a => a ? { ...a, estado: s.estado, qr: null, codigo: null, aviso: 'O QR venceu. Clique em “Novo QR code”.' } : s); return }
        if (s.qr) setSt(a => { if (a && a.qr !== s.qr) setQrEm(new Date().toLocaleTimeString('pt-BR')); return a ? { ...a, estado: s.estado, qr: s.qr } : s })
      } catch { /* tenta de novo */ }
    }, 5000)
    return () => clearInterval(t)
  }, [st, instancia])

  const conectado = st?.estado === 'open'
  return (
    <div className="conexao">
      <div className="sistema" style={{ borderBottom: 0, paddingTop: 0 }}>
        <span className={`luz ${conectado ? 'ok' : st?.estado === 'erro' ? 'falha' : 'desconhecido'}`} />
        <div>
          <div className="sistema-nome">{titulo}</div>
          <div className="sistema-info">{st ? ROTULO[st.estado] : 'Verificando…'}{conectado && st?.numero ? ` · +${st.numero}` : ''}</div>
        </div>
        <button className="botao-icone" style={{ width: 24, height: 24 }} onClick={() => chamar('status')} aria-label={`Atualizar ${titulo}`}><RefreshCw size={13} /></button>
      </div>
      {erro && <div className="aviso erro">{erro}</div>}
      {!erro && st?.aviso && !st.qr && <div className="aviso erro">{st.aviso}</div>}
      {!conectado && <div className="etiqueta" style={{ marginBottom: 8 }}>{dica}</div>}
      {!conectado && st?.qr && (
        <div className="qr-caixa"><img src={st.qr} alt={`QR code para conectar ${titulo}`} />
          <span className="etiqueta">WhatsApp → Aparelhos conectados → Conectar aparelho</span>
          <span className="etiqueta">QR de {qrEm} · atualiza sozinho</span></div>
      )}
      {!conectado && st?.codigo && (
        <div className="qr-caixa"><div className="codigo-pareamento">{st.codigo}</div>
          <span className="etiqueta">WhatsApp → Aparelhos conectados → Conectar com número de telefone</span></div>
      )}
      {!conectado && (
        <>
          <button className="botao" disabled={carregando} onClick={() => chamar('conectar')}>
            <QrCode size={14} /> {carregando ? 'Gerando…' : st?.qr ? 'Novo QR code' : 'Conectar com QR code'}
          </button>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}>
              <input aria-label={`Número para conectar ${titulo}`} placeholder="ou pelo número: 55 11 9…" inputMode="tel" value={numero} onChange={e => setNumero(e.target.value)} />
            </div>
            <button className="botao secundario" style={{ width: 'auto' }} disabled={carregando || numero.replace(/\D/g, '').length < 10}
              onClick={() => chamar('conectar', numero)} title="Gera um código para digitar no celular (se o painel está no próprio celular)"><Smartphone size={14} /></button>
          </div>
        </>
      )}
      {conectado && (
        <button className="botao secundario" disabled={carregando} onClick={() => { if (confirm(`Desconectar ${titulo}?`)) void chamar('desconectar') }}>
          <Unplug size={14} /> Desconectar
        </button>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ filtro: o que o agente le
const TEXTO_MODO: Record<Agente, Record<ModoObservar, string>> = {
  leo: {
    todos: '⚠ Lê todas as suas conversas (inclui família e amigos), menos nada.',
    exceto: 'Lê todas as suas conversas, menos os contatos da lista.',
    somente: 'Lê só as conversas com os contatos da lista.',
  },
  suporte: {
    todos: 'Lê todas as conversas do chip do Suporte24hrs.',
    exceto: 'Lê todas as conversas do chip, menos os números da lista.',
    somente: 'Lê só os números da lista e os clientes cadastrados.',
  },
  gabriel: {
    todos: 'Lê todas as conversas do número do Gabriel para aprender o seu jeito.',
    exceto: 'Lê todas as conversas do número do Gabriel, menos os contatos da lista.',
    somente: '',
  },
  joao: {
    todos: 'Lê todas as conversas do chip (todo mundo que falar com o João é cliente).',
    exceto: 'Lê todas as conversas do chip, menos os números da lista.',
    somente: 'Lê só os números da lista e os clientes cadastrados.',
  },
}

export function FiltroObservacao({ agente }: { agente: Agente }) {
  const [d, setD] = useState<Observacao | null>(null)
  const [novo, setNovo] = useState({ nome: '', numero: '' })
  const carregar = useCallback(async () => { try { setD(await api.observacao()) } catch { /* sem permissao */ } }, [])
  useEffect(() => { void carregar() }, [carregar])
  if (!d) return null
  const cfg = d[agente]
  const regraNova = cfg.modo === 'exceto' ? 'excluir' : 'incluir'
  const lista = cfg.lista.filter(l => cfg.modo === 'todos' ? false : l.regra === regraNova)
  const nome = agente === 'leo' ? 'Leo' : agente === 'suporte' ? 'Suporte24hrs' : agente === 'gabriel' ? 'Gabriel' : 'João'
  return (
    <div className="filtro">
      <div className="chave-texto" style={{ marginBottom: 6 }}><b><Eye size={12} style={{ verticalAlign: -1 }} /> O que o {nome} lê</b><span>{TEXTO_MODO[agente][cfg.modo]}</span></div>
      <div className="modos">
        {(agente === 'gabriel' ? ['exceto', 'todos'] as const : ['somente', 'exceto', 'todos'] as const).map(m => (
          <button key={m} className={cfg.modo === m ? 'ativo' : ''} onClick={async () => {
            if (m === 'todos' && agente === 'leo' && !confirm('O Leo vai ler e guardar TODAS as suas conversas, inclusive pessoais. Continuar?')) return
            setD(await api.observacaoConfig(agente, m))
          }}>{m === 'somente' ? 'Só escolhidos' : m === 'exceto' ? 'Todos menos' : 'Todos'}</button>
        ))}
      </div>
      {cfg.modo !== 'todos' && (
        <>
          <form style={{ display: 'flex', gap: 6, marginTop: 8 }} onSubmit={async e => {
            e.preventDefault(); setD(await api.observacaoAdd(agente, novo.numero, novo.nome, regraNova)); setNovo({ nome: '', numero: '' })
          }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Nome" placeholder="Nome" value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} /></div>
            <div className="campo" style={{ flex: 1.2, margin: 0 }}><input aria-label="Número" placeholder="55 11 9…" inputMode="tel" value={novo.numero} onChange={e => setNovo({ ...novo, numero: e.target.value })} /></div>
            <button className="botao" style={{ width: 'auto' }} disabled={novo.numero.replace(/\D/g, '').length < 10} aria-label={regraNova === 'excluir' ? 'Excluir da leitura' : 'Incluir na leitura'}><Plus size={14} /></button>
          </form>
          <div className="etiqueta" style={{ margin: '6px 0 2px' }}>{regraNova === 'excluir' ? 'NÃO LÊ ESTES:' : 'LÊ SÓ ESTES:'}</div>
          {lista.length === 0 && <div className="vazio" style={{ padding: '4px 0' }}>{regraNova === 'excluir' ? 'Ninguém excluído.' : 'Ninguém ainda.'}</div>}
          {lista.map(l => (
            <div className="item" key={l.id} style={{ padding: '6px 0' }}>
              <div><div className="item-titulo" style={{ fontSize: 13 }}>{l.nome || 'sem nome'}</div><div className="etiqueta">+{l.numero}</div></div>
              <button aria-label={`Remover ${l.nome || l.numero}`} onClick={async () => setD(await api.observacaoDel(l.id))}><Trash2 size={13} /></button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ cartao do admin
export function PainelWhatsapp() {
  return (
    <section className="hud">
      <div className="hud-titulo"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><MessageCircle size={14} />WhatsApp</span></div>
      <div className="hud-corpo">
        <Conexao instancia="nucleo" titulo="Leo 2.0 + Gabriel · seu número" dica="Conecte o SEU WhatsApp. Você fala com o Leo na conversa “Você”; o Gabriel responde só os contatos que você liberar." />
        <FiltroObservacao agente="leo" />
        <div className="divisor" />
        <Conexao instancia="joao" titulo="João · chip do vendedor" dica="Conecte o chip do João. Clientes falam com ele; você ou vendedores também respondem por esse número." />
        <FiltroObservacao agente="joao" />
        <div className="divisor" />
        <Conexao instancia="suporte" titulo="Suporte24hrs · chip do suporte" dica="Conecte o chip do suporte. Clientes com problema falam com ele; quem responde por esse número ensina o Suporte24hrs." />
        <FiltroObservacao agente="suporte" />
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ o que o Leo aprendeu (revisar)
function ItemLeo({ s, aoMudar }: { s: Observacao['leo_sugestoes'][number]; aoMudar: () => void }) {
  const [titulo, setTitulo] = useState(s.titulo || '')
  const [conteudo, setConteudo] = useState(s.conteudo)
  return (
    <div className="fila-item">
      <div className="etiqueta">Da conversa com +{s.contato} · {fmt(s.criado_em)}</div>
      <div className="campo" style={{ margin: '6px 0 0' }}><input aria-label="Título" value={titulo} onChange={e => setTitulo(e.target.value)} /></div>
      <div className="campo" style={{ margin: '6px 0' }}><textarea aria-label="Conteúdo" rows={2} value={conteudo} onChange={e => setConteudo(e.target.value)} /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="botao" style={{ flex: 1 }} onClick={async () => { await api.leoSugestaoAprovar(s.id, titulo, conteudo); aoMudar() }}><Check size={14} /> Guardar na memória</button>
        <button className="botao secundario" style={{ width: 'auto' }} aria-label="Descartar" onClick={async () => { await api.leoSugestaoDescartar(s.id); aoMudar() }}><X size={14} /></button>
      </div>
    </div>
  )
}

export function LeoAprendeu() {
  const [d, setD] = useState<Observacao | null>(null)
  const carregar = useCallback(async () => { try { setD(await api.observacao()) } catch { /* sem permissao */ } }, [])
  useEffect(() => { void carregar(); const t = setInterval(carregar, 60000); return () => clearInterval(t) }, [carregar])
  if (!d) return null
  return (
    <section className="hud">
      <div className="hud-titulo"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Brain size={14} />Leo aprendeu</span>
        <span className="contagem">{d.leo_sugestoes.length}</span></div>
      <div className="hud-corpo">
        <div className="etiqueta" style={{ marginBottom: 6 }}>Seu jeito de falar, como você resolve as coisas e fatos importantes, tirados das conversas que o Leo leu ({d.leo_conversas_lidas} msgs). Só vale depois de guardar.</div>
        {d.leo_sugestoes.length === 0 && <div className="vazio">Nada novo para revisar.</div>}
        {d.leo_sugestoes.map(s => <ItemLeo key={s.id} s={s} aoMudar={carregar} />)}
      </div>
    </section>
  )
}
