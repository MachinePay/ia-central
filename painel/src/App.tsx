import { useCallback, useEffect, useState } from 'react'
import { LogOut, MessageSquare, LayoutGrid, Headset, LifeBuoy, UserRound } from 'lucide-react'
import { api, ErroApi, token, type Resumo, type Usuario } from './api'
import { Login } from './components/Login'
import { Orbe, type EstadoOrbe } from './components/Orbe'
import { Conversa } from './components/Conversa'
import { PainelControle, PainelPessoal, PainelSistemas } from './components/Paineis'
import { Atendimento } from './components/Atendimento'
import { LeoAprendeu } from './components/Whatsapp'
import { Gabriel } from './components/Gabriel'

function Fundo() {
  return <div className="fundo" aria-hidden="true"><div className="estrelas" /><div className="grade" /><div className="scan" /></div>
}

function Relogio() {
  const [agora, setAgora] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setAgora(new Date()), 1000); return () => clearInterval(t) }, [])
  return (
    <div className="relogio">
      {agora.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()} · <b>{agora.toLocaleTimeString('pt-BR')}</b>
    </div>
  )
}

function useLargura() {
  const [l, setL] = useState(window.innerWidth)
  useEffect(() => { const f = () => setL(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return l
}

export default function App() {
  const [usuario, setUsuario] = useState<Usuario | null>(null)
  const [resumo, setResumo] = useState<Resumo | null>(null)
  const [verificando, setVerificando] = useState(!!token.get())
  const [estado, setEstado] = useState<EstadoOrbe>('parado')
  const [aba, setAba] = useState<'ia' | 'painel' | 'joao' | 'suporte' | 'gabriel'>('ia')
  const largura = useLargura()

  const sair = useCallback(() => {
    api.logout().catch(() => {})
    token.set(null)
    setUsuario(null)
    setResumo(null)
  }, [])

  const atualizar = useCallback(async () => {
    try {
      const r = await api.resumo()
      setResumo(r)
      setUsuario(r.usuario)
    } catch (e) {
      if (e instanceof ErroApi && e.status === 401) { token.set(null); setUsuario(null) }
    } finally {
      setVerificando(false)
    }
  }, [])

  useEffect(() => { if (token.get()) void atualizar() }, [atualizar])
  useEffect(() => {
    if (!usuario) return
    const t = setInterval(atualizar, 30000)
    return () => clearInterval(t)
  }, [usuario, atualizar])

  if (verificando) return <><Fundo /><div className="login-tela"><Orbe estado="pensando" tamanho={220} /></div></>
  if (!usuario) return <><Fundo /><Login aoEntrar={u => { setUsuario(u); void atualizar() }} /></>

  const tamanhoOrbe = largura < 760 ? (aba === 'ia' ? 160 : 0) : largura < 1100 ? 230 : 270
  return (
    <>
      <Fundo />
      <div className="app">
        <header className="topo">
          <div className="marca">
            <img className="marca-logo" src="/icone.svg" alt="" />
            <div className="marca-nome">N<span>Ú</span>CLEO</div>
          </div>
          <div className="topo-meio">
            {usuario.papel === 'admin' ? (
              <div className="seletor-tela">
                <button className={aba === 'ia' || aba === 'painel' ? 'ativo' : ''} onClick={() => setAba('ia')}><MessageSquare size={13} /> Leo 2.0</button>
                <button className={aba === 'joao' ? 'ativo' : ''} onClick={() => setAba('joao')}><Headset size={13} /> João</button>
                <button className={aba === 'suporte' ? 'ativo' : ''} onClick={() => setAba('suporte')}><LifeBuoy size={13} /> Suporte24hrs</button>
                <button className={aba === 'gabriel' ? 'ativo' : ''} onClick={() => setAba('gabriel')}><UserRound size={13} /> Gabriel</button>
              </div>
            ) : <Relogio />}
          </div>
          <div className="chip-usuario">
            <span className="nome-usuario">{usuario.nome}</span>
            <span className={`papel ${usuario.papel}`}>{usuario.papel}</span>
            <button className="botao-icone" onClick={sair} aria-label="Sair" title="Sair"><LogOut size={16} /></button>
          </div>
        </header>

        {(aba === 'joao' || aba === 'suporte') && usuario.papel === 'admin' ? <Atendimento aoSair={sair} agente={aba} />
          : aba === 'gabriel' && usuario.papel === 'admin' ? <Gabriel aoSair={sair} /> : (
        <main className="grade-principal" data-aba={aba}>
          <aside className="coluna esquerda">{resumo && <PainelSistemas r={resumo} aoMudar={atualizar} />}</aside>

          <section className="centro">
            {tamanhoOrbe > 0 && <div style={{ display: 'grid', placeItems: 'center' }}><Orbe estado={estado} tamanho={tamanhoOrbe} /></div>}
            <Conversa sessao="painel" estado={estado} setEstado={setEstado} aoSair={sair} aoMudar={atualizar} />
          </section>

          <aside className="coluna direita">
            {resumo && (
              <>
                <div className="so-estreito" style={{ flexDirection: 'column', gap: 16 }}><PainelSistemas r={resumo} aoMudar={atualizar} /></div>
                <PainelPessoal r={resumo} aoMudar={atualizar} />
                {usuario.papel === 'admin' && <LeoAprendeu />}
                <PainelControle r={resumo} aoMudar={atualizar} />
              </>
            )}
          </aside>
        </main>
        )}

        <nav className="abas">
          <button className={aba === 'ia' ? 'ativa' : ''} onClick={() => setAba('ia')}><MessageSquare size={14} /> IA</button>
          <button className={aba === 'painel' ? 'ativa' : ''} onClick={() => setAba('painel')}><LayoutGrid size={14} /> PAINEL</button>
          {usuario.papel === 'admin' && <>
            <button className={aba === 'joao' ? 'ativa' : ''} onClick={() => setAba('joao')} aria-label="João"><Headset size={14} /></button>
            <button className={aba === 'suporte' ? 'ativa' : ''} onClick={() => setAba('suporte')} aria-label="Suporte24hrs"><LifeBuoy size={14} /></button>
            <button className={aba === 'gabriel' ? 'ativa' : ''} onClick={() => setAba('gabriel')} aria-label="Gabriel"><UserRound size={14} /></button>
          </>}
        </nav>
      </div>
    </>
  )
}
