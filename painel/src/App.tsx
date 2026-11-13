import { useCallback, useEffect, useState } from 'react'
import { LogOut, MessageSquare, LayoutGrid, Gauge, Server, Settings } from 'lucide-react'
import { api, ErroApi, token, type AgenteId, type Resumo, type Saude, type Usuario } from './api'
import { Login } from './components/Login'
import { Orbe, type EstadoOrbe } from './components/Orbe'
import { Conversa } from './components/Conversa'
import { PainelControle, PainelPessoal, PainelSistemas } from './components/Paineis'
import { Inicio, PaginaAgente, CartaoEvento, type Aba, type StatusWa } from './components/Agentes'
import { AGENTES, ORDEM, Avatar, Hud, corDe, estadoDe } from './components/ui'

function Fundo() {
  return <div className="fundo" aria-hidden="true"><div className="estrelas" /><div className="grade" /><div className="scan" /></div>
}

function useLargura() {
  const [l, setL] = useState(window.innerWidth)
  useEffect(() => { const f = () => setL(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return l
}

type Pagina = 'inicio' | AgenteId | 'sistemas' | 'config'
const lerPagina = (): Pagina => { try { return (localStorage.getItem('nucleo.pagina') as Pagina) || 'inicio' } catch { return 'inicio' } }

export default function App() {
  const [usuario, setUsuario] = useState<Usuario | null>(null)
  const [resumo, setResumo] = useState<Resumo | null>(null)
  const [verificando, setVerificando] = useState(!!token.get())
  const [estado, setEstado] = useState<EstadoOrbe>('parado')
  const [abaUsuario, setAbaUsuario] = useState<'ia' | 'painel'>('ia')
  const [pagina, setPaginaBruta] = useState<Pagina>(lerPagina)
  const [abas, setAbas] = useState<Record<AgenteId, Aba>>({ leo: 'visao', joao: 'visao', suporte: 'visao', gabriel: 'visao' })
  const [saude, setSaude] = useState<Saude | null>(null)
  const [wa, setWa] = useState<StatusWa>({})
  const largura = useLargura()
  const admin = usuario?.papel === 'admin'

  const setPagina = (p: Pagina) => { setPaginaBruta(p); try { localStorage.setItem('nucleo.pagina', p) } catch { /* modo privado */ } }
  const abrir = (a: AgenteId, aba?: Aba) => { setPagina(a); if (aba) setAbas(x => ({ ...x, [a]: aba })) }

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
  const carregarSaude = useCallback(async () => { try { setSaude(await api.saude()) } catch { /* tenta de novo */ } }, [])
  const carregarWa = useCallback(async () => {
    const r: StatusWa = {}
    await Promise.all((['nucleo', 'joao', 'suporte', 'gabriel'] as const).map(async i => {
      try { r[i] = (await api.whatsapp('status', { instancia: i })).estado } catch { r[i] = 'erro' }
    }))
    setWa(r)
  }, [])

  useEffect(() => { if (token.get()) void atualizar() }, [atualizar])
  useEffect(() => {
    if (!usuario) return
    const t = setInterval(atualizar, 30000)
    return () => clearInterval(t)
  }, [usuario, atualizar])
  useEffect(() => {
    if (!admin) return
    void carregarSaude(); void carregarWa()
    const t1 = setInterval(carregarSaude, 20000), t2 = setInterval(carregarWa, 60000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [admin, carregarSaude, carregarWa])

  if (verificando) return <><Fundo /><div className="login-tela"><Orbe estado="pensando" tamanho={220} /></div></>
  if (!usuario) return <><Fundo /><Login aoEntrar={u => { setUsuario(u); void atualizar() }} /></>

  const chip = (
    <div className="chip-usuario">
      <span className="nome-usuario">{usuario.nome}</span>
      <span className={`papel ${usuario.papel}`}>{usuario.papel}</span>
      <button className="botao-icone" onClick={sair} aria-label="Sair" title="Sair"><LogOut size={16} /></button>
    </div>
  )

  // ---------------------------------------------------------------- usuario comum: a tela de conversa de sempre
  if (!admin) {
    const tamanhoOrbe = largura < 760 ? (abaUsuario === 'ia' ? 160 : 0) : largura < 1100 ? 230 : 270
    return (
      <>
        <Fundo />
        <div className="app">
          <header className="topo">
            <div className="marca"><img className="marca-logo" src="/icone.svg" alt="" /><div className="marca-nome">N<span>Ú</span>CLEO</div></div>
            <div className="topo-meio" />
            {chip}
          </header>
          <main className="grade-principal" data-aba={abaUsuario}>
            <aside className="coluna esquerda">{resumo && <PainelSistemas r={resumo} aoMudar={atualizar} />}</aside>
            <section className="centro">
              {tamanhoOrbe > 0 && <div style={{ display: 'grid', placeItems: 'center' }}><Orbe estado={estado} tamanho={tamanhoOrbe} /></div>}
              <Conversa sessao="painel" estado={estado} setEstado={setEstado} aoSair={sair} aoMudar={atualizar} />
            </section>
            <aside className="coluna direita">
              {resumo && <>
                <div className="so-estreito" style={{ flexDirection: 'column', gap: 16 }}><PainelSistemas r={resumo} aoMudar={atualizar} /></div>
                <PainelPessoal r={resumo} aoMudar={atualizar} />
                <PainelControle r={resumo} aoMudar={atualizar} />
              </>}
            </aside>
          </main>
          <nav className="abas">
            <button className={abaUsuario === 'ia' ? 'ativa' : ''} onClick={() => setAbaUsuario('ia')}><MessageSquare size={14} /> IA</button>
            <button className={abaUsuario === 'painel' ? 'ativa' : ''} onClick={() => setAbaUsuario('painel')}><LayoutGrid size={14} /> PAINEL</button>
          </nav>
        </div>
      </>
    )
  }

  // ---------------------------------------------------------------- admin: menu lateral + uma pagina por IA
  const estadoIa = (a: AgenteId) => estadoDe(saude?.agentes.find(s => s.agente === a), wa[AGENTES[a].instancia])
  const contador = (a: AgenteId) => {
    const s = saude?.agentes.find(x => x.agente === a)
    return s ? (a === 'gabriel' ? 0 : s.sugestoes) + s.pendentes : 0
  }
  const agenteAtual = ORDEM.includes(pagina as AgenteId) ? pagina as AgenteId : null

  return (
    <>
      <Fundo />
      <div className="app admin" style={corDe(agenteAtual)}>
        <aside className="menu-lateral">
          <div className="marca"><img className="marca-logo" src="/icone.svg" alt="" /><div className="marca-nome">N<span>Ú</span>CLEO</div></div>
          <nav aria-label="Navegação">
            <button className={`menu-item ${pagina === 'inicio' ? 'ativo' : ''}`} onClick={() => setPagina('inicio')}><Gauge size={18} /><span>Início</span></button>
            <div className="menu-secao">Suas IAs</div>
            {ORDEM.map(a => {
              const e = estadoIa(a), n = contador(a)
              return (
                <button key={a} className={`menu-item ia ${pagina === a ? 'ativo' : ''}`} style={corDe(a)} onClick={() => setPagina(a)}>
                  <Avatar a={a} tamanho={30} />
                  <span className="menu-nome"><b>{AGENTES[a].nome}</b><small>{AGENTES[a].papel}</small></span>
                  {n > 0 && <em className="menu-badge">{n}</em>}
                  <i className={`menu-luz ${e}`} title={e} />
                </button>
              )
            })}
            <div className="menu-secao">Geral</div>
            <button className={`menu-item ${pagina === 'sistemas' ? 'ativo' : ''}`} onClick={() => setPagina('sistemas')}>
              <Server size={18} /><span>Sistemas</span>{!!saude?.sistemas_fora && <em className="menu-badge erro">{saude.sistemas_fora}</em>}
            </button>
            <button className={`menu-item ${pagina === 'config' ? 'ativo' : ''}`} onClick={() => setPagina('config')}><Settings size={18} /><span>Usuários e memória</span></button>
          </nav>
          <div className="menu-rodape">{chip}</div>
        </aside>

        <header className="topo topo-celular">
          <div className="marca"><img className="marca-logo" src="/icone.svg" alt="" /><div className="marca-nome">N<span>Ú</span>CLEO</div></div>
          <div className="topo-meio" />
          {chip}
        </header>

        <main className="area-admin">
          {pagina === 'inicio' && <Inicio saude={saude} wa={wa} r={resumo} abrir={abrir} />}
          {agenteAtual && <PaginaAgente key={agenteAtual} a={agenteAtual} aba={abas[agenteAtual]} setAba={x => setAbas(v => ({ ...v, [agenteAtual]: x }))}
            saude={saude} wa={wa} aoSair={sair} aoMudar={atualizar} recarregarSaude={carregarSaude} />}
          {pagina === 'sistemas' && resumo && (
            <div className="pagina">
              <h1 className="titulo-pagina"><Server size={22} /> Sistemas monitorados</h1>
              <div className="duas-colunas">
                <PainelSistemas r={resumo} aoMudar={atualizar} />
                <Hud titulo="Falhas do monitor e do sistema">
                  {(saude?.outros_erros.length ?? 0) === 0 && <div className="vazio">Nenhuma falha nova ✓</div>}
                  {saude?.outros_erros.map(ev => <CartaoEvento key={ev.id} ev={ev} />)}
                </Hud>
              </div>
            </div>
          )}
          {pagina === 'config' && resumo && (
            <div className="pagina">
              <h1 className="titulo-pagina"><Settings size={22} /> Usuários e memória</h1>
              <div className="duas-colunas">
                <PainelControle r={resumo} aoMudar={atualizar} />
                <PainelPessoal r={resumo} aoMudar={atualizar} />
              </div>
            </div>
          )}
        </main>

        <nav className="menu-baixo" aria-label="Navegação">
          <button className={pagina === 'inicio' ? 'ativo' : ''} onClick={() => setPagina('inicio')} aria-label="Início"><Gauge size={18} /><span>Início</span></button>
          {ORDEM.map(a => {
            const I = AGENTES[a].icone, e = estadoIa(a)
            return (
              <button key={a} className={pagina === a ? 'ativo' : ''} style={corDe(a)} onClick={() => setPagina(a)} aria-label={AGENTES[a].nome}>
                <I size={18} /><span>{AGENTES[a].nome.split(' ')[0]}</span>{(e === 'erro' || e === 'whatsapp') && <i className="menu-luz erro" />}
              </button>
            )
          })}
          <button className={pagina === 'sistemas' || pagina === 'config' ? 'ativo' : ''} onClick={() => setPagina(pagina === 'sistemas' ? 'config' : 'sistemas')} aria-label="Sistemas e usuários"><Server size={18} /><span>Mais</span></button>
        </nav>
      </div>
    </>
  )
}
