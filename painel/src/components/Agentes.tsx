import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowRight, BookOpen, Brain, Check, CheckCircle2, ChevronRight, Eye, Inbox, MessageSquare,
  Box, LayoutList, MessagesSquare, Plus, RefreshCw, Search, Settings2, ShieldAlert, Sparkles, Trash2, UserRound, Wrench,
} from 'lucide-react'
import { api, ErroApi, type AgenteId, type AgenteAtend, type Evento, type Feed, type GabrielPainel, type Instancia, type ItemAprendido, type Resumo, type Saude, type WhatsappStatus } from '../api'
import { AGENTES, Avatar, BotaoMini, Hud, MODO, Numero, ORDEM, Pilula, comoResolver, corDe, estadoDe, fmt, haQuanto } from './ui'
import { Simulador } from './Atendimento'
import { Chamados, Clientes, ConfigModo, EmpresaForm, EnsinarManual, FilaAprovacao, VisivelClientes, useAtendimento } from './Secoes'
import { Conexao, FiltroObservacao } from './Whatsapp'
import { Conversa } from './Conversa'
import { Orbe, type EstadoOrbe } from './Orbe'

export type StatusWa = Partial<Record<Instancia, WhatsappStatus['estado']>>
export type Aba = 'conversar' | 'visao' | 'leu' | 'aprendizado' | 'aprovar' | 'simular' | 'configurar' | 'erros'

const Escritorio3D = lazy(() => import('./Escritorio3D'))
const lerVista = (): '3d' | 'lista' => { try { return localStorage.getItem('nucleo.vista') === 'lista' ? 'lista' : '3d' } catch { return '3d' } }

const ROTULO_WA: Record<string, string> = { open: 'conectado', close: 'desconectado', connecting: 'esperando o QR', inexistente: 'nunca conectado', erro: 'Evolution fora do ar' }

// ================================================================== INICIO: todas as IAs de uma vez
export function Inicio({ saude, wa, r, abrir }: { saude: Saude | null; wa: StatusWa; r: Resumo | null; abrir: (a: AgenteId, aba?: Aba) => void }) {
  const [vista, setVistaBruta] = useState(lerVista)
  const setVista = (v: '3d' | 'lista') => { setVistaBruta(v); try { localStorage.setItem('nucleo.vista', v) } catch { /* modo privado */ } }
  if (!saude) return <div className="pagina"><div className="vazio">Carregando a saúde das IAs…</div></div>
  const estados = saude.agentes.map(s => ({ s, e: estadoDe(s, wa[s.instancia]) }))
  const problemas = estados.filter(x => x.e === 'erro' || x.e === 'whatsapp')
  const novos = saude.agentes.reduce((a, s) => a + (s.aprendeu_24h || 0), 0)
  const aprovar = saude.agentes.reduce((a, s) => a + s.pendentes, 0)

  return (
    <div className={`pagina ${vista === '3d' ? 'pagina-3d' : ''}`}>
      <div className={`faixa-status ${problemas.length ? 'ruim' : 'bom'}`}>
        {problemas.length ? <ShieldAlert size={28} /> : <CheckCircle2 size={28} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{problemas.length ? `${problemas.length} IA${problemas.length > 1 ? 's' : ''} precisa${problemas.length > 1 ? 'm' : ''} de você` : 'Todas as IAs funcionando'}</b>
          <span>{problemas.length ? problemas.map(p => `${AGENTES[p.s.agente].nome}: ${p.e === 'erro' ? p.s.ultimo_erro?.titulo : 'WhatsApp desconectado'}`).join(' · ')
            : 'Nenhuma falha nova. Atualiza sozinho a cada 20 segundos.'}</span>
        </div>
        <div className="troca-vista" role="group" aria-label="Como ver">
          <button className={vista === '3d' ? 'ativo' : ''} onClick={() => setVista('3d')}><Box size={14} /> 3D</button>
          <button className={vista === 'lista' ? 'ativo' : ''} onClick={() => setVista('lista')}><LayoutList size={14} /> Lista</button>
        </div>
      </div>

      {vista === '3d' ? (
        <Suspense fallback={<div className="escritorio"><div className="vazio" style={{ padding: 20 }}>Montando o escritório…</div></div>}>
          <Escritorio3D saude={saude} wa={wa} r={r} abrir={abrir} />
        </Suspense>
      ) : <>

      <div className="numeros">
        <Numero valor={novos} rotulo="coisas aprendidas (24h)" />
        <Numero valor={aprovar} rotulo="respostas esperando aprovação" destaque={aprovar ? 'alerta' : undefined} />
        <Numero valor={saude.chamados_abertos} rotulo="chamados abertos" />
        <Numero valor={saude.sistemas_fora} rotulo={`sistemas fora${r ? ` de ${r.sistemas.filter(s => s.ativo).length}` : ''}`} destaque={saude.sistemas_fora ? 'erro' : undefined} />
      </div>

      <div className="cartoes-ia">
        {estados.map(({ s, e }) => {
          const a = AGENTES[s.agente]
          const st = wa[s.instancia]
          return (
            <button key={s.agente} className={`cartao-ia ${e}`} style={corDe(s.agente)} onClick={() => abrir(s.agente, e === 'erro' ? 'erros' : 'visao')}>
              <div className="cartao-topo">
                <Avatar a={s.agente} tamanho={44} />
                <div className="cartao-nome"><b>{a.nome}</b><span>{a.papel}</span></div>
                <Pilula estado={e} />
              </div>
              <div className="cartao-linha"><span>Modo</span><b>{MODO[s.modo]?.rotulo || s.modo}</b></div>
              <div className="cartao-linha"><span>WhatsApp</span><b className={st === 'open' ? 'verde' : 'vermelho'}>{st ? ROTULO_WA[st] : '…'}</b></div>
              <div className="cartao-numeros">
                <div><b>{s.lidas_24h}</b><span>leu 24h</span></div>
                <div><b>{s.respostas_24h}</b><span>respondeu</span></div>
                <div><b>{s.aprendidos}</b><span>sabe</span></div>
                <div><b>{s.aprendeu_24h || 0}</b><span>novos 24h</span></div>
              </div>
              {e === 'erro' && s.ultimo_erro ? (
                <div className="cartao-erro"><AlertTriangle size={13} /> {s.ultimo_erro.titulo} <i>{haQuanto(s.ultimo_erro.em)}</i></div>
              ) : <div className="cartao-rodape">Última atividade {haQuanto(s.ultima_atividade)} <ArrowRight size={13} /></div>}
            </button>
          )
        })}
      </div>

      </>}

      {saude.outros_erros.length > 0 && (
        <Hud titulo="Outras falhas (monitor, aprendiz, sistema)" icone={<AlertTriangle size={14} />}
          extra={<BotaoMini onClick={async () => { await api.eventosVistos('outros'); location.reload() }}><Check size={12} /> visto</BotaoMini>}>
          {saude.outros_erros.map(ev => <CartaoEvento key={ev.id} ev={ev} />)}
        </Hud>
      )}
    </div>
  )
}

// ================================================================== PAGINA DE UMA IA
export function PaginaAgente({ a, aba, setAba, saude, wa, aoSair, aoMudar, recarregarSaude }: {
  a: AgenteId; aba: Aba; setAba: (x: Aba) => void; saude: Saude | null; wa: StatusWa
  aoSair: () => void; aoMudar: () => void; recarregarSaude: () => void
}) {
  const info = AGENTES[a]
  const s = saude?.agentes.find(x => x.agente === a)
  const estado = estadoDe(s, wa[info.instancia])
  const [feed, setFeed] = useState<Feed | null>(null)
  const atend = useAtendimento(a === 'joao' || a === 'suporte' ? a : null, aoSair)
  const [gab, setGab] = useState<GabrielPainel | null>(null)
  const [estadoOrbe, setEstadoOrbe] = useState<EstadoOrbe>('parado')

  const carregarFeed = useCallback(async () => {
    try { setFeed(await api.feed(a)) } catch (e) { if (e instanceof ErroApi && e.status === 401) aoSair() }
  }, [a, aoSair])
  const carregarGab = useCallback(async () => { if (a === 'gabriel') try { setGab(await api.gabriel()) } catch { /* tenta de novo */ } }, [a])
  const tudo = useCallback(() => { void carregarFeed(); void carregarGab(); void atend.carregar(); recarregarSaude() }, [carregarFeed, carregarGab, atend, recarregarSaude])

  useEffect(() => { setFeed(null); setGab(null) }, [a])
  useEffect(() => { void carregarFeed(); void carregarGab(); const t = setInterval(() => { void carregarFeed(); void carregarGab() }, 20000); return () => clearInterval(t) }, [carregarFeed, carregarGab])

  const revisar = 0   // aprende sozinho: nada para revisar
  const pendentes = a === 'gabriel' ? gab?.fila.length ?? 0 : atend.d?.fila.length ?? 0
  const errosNovos = feed?.eventos.filter(e => !e.visto && e.nivel === 'erro').length ?? 0
  const modo = a === 'leo' ? 'ativo' : a === 'gabriel' ? gab?.modo ?? s?.modo ?? '' : atend.d?.config.modo ?? s?.modo ?? ''

  const abas: { id: Aba; rotulo: string; icone: React.ReactNode; badge?: number; alerta?: boolean }[] = [
    ...(a === 'leo' ? [{ id: 'conversar' as Aba, rotulo: 'Conversar', icone: <MessageSquare size={14} /> }] : []),
    { id: 'visao', rotulo: 'Visão geral', icone: <Activity size={14} /> },
    { id: 'leu', rotulo: 'O que leu', icone: <Eye size={14} />, badge: feed?.conversas.length },
    { id: 'aprendizado', rotulo: 'Aprendizado', icone: <Sparkles size={14} />, badge: s?.aprendeu_24h || undefined },
    ...(a !== 'leo' ? [
      { id: 'aprovar' as Aba, rotulo: 'Aprovar', icone: <Inbox size={14} />, badge: pendentes || undefined, alerta: pendentes > 0 },
      { id: 'simular' as Aba, rotulo: 'Testar', icone: <MessagesSquare size={14} /> },
    ] : []),
    { id: 'configurar', rotulo: 'Configurar', icone: <Settings2 size={14} /> },
    { id: 'erros', rotulo: 'Erros', icone: <AlertTriangle size={14} />, badge: errosNovos || undefined, alerta: errosNovos > 0 },
  ]

  return (
    <div className="pagina pagina-agente" style={corDe(a)}>
      <header className="cabeca-agente">
        <Avatar a={a} tamanho={54} />
        <div className="cabeca-texto">
          <span className="voce-esta">Você está em</span>
          <h1>{info.nome}</h1>
          <span className="cabeca-papel">{info.papel} · {info.numero}</span>
        </div>
        <div className="cabeca-estado">
          <Pilula estado={estado} />
          <span className="modo-atual" title={MODO[modo]?.texto}>{MODO[modo]?.rotulo || '…'}</span>
        </div>
      </header>

      <nav className="abas-agente" aria-label={`Seções de ${info.nome}`}>
        {abas.map(x => (
          <button key={x.id} className={aba === x.id ? 'ativa' : ''} onClick={() => setAba(x.id)}>
            {x.icone}<span>{x.rotulo}</span>{x.badge !== undefined && <em className={x.alerta ? 'alerta' : ''}>{x.badge}</em>}
          </button>
        ))}
      </nav>

      <div className="conteudo-agente">
        {aba === 'conversar' && a === 'leo' && (
          <div className="conversar-leo">
            <div style={{ display: 'grid', placeItems: 'center' }}><Orbe estado={estadoOrbe} tamanho={window.innerWidth < 760 ? 140 : 200} /></div>
            <Conversa sessao="painel" estado={estadoOrbe} setEstado={setEstadoOrbe} aoSair={aoSair} aoMudar={aoMudar} />
          </div>
        )}
        {aba === 'visao' && <Visao a={a} s={s} estado={estado} wa={wa[info.instancia]} feed={feed} modo={modo} revisar={revisar} pendentes={pendentes}
          irPara={setAba} extra={atend.d && <Chamados d={atend.d} carregar={atend.carregar} />} gab={gab} />}
        {aba === 'leu' && <OQueLeu a={a} feed={feed} />}
        {aba === 'aprendizado' && <Aprendizado a={a} feed={feed} recarregar={tudo}
          manual={atend.d && (a === 'joao' || a === 'suporte') ? <EnsinarManual d={atend.d} agente={a} carregar={tudo} /> : null} />}
        {aba === 'aprovar' && (a === 'gabriel'
          ? gab && <FilaAprovacao fila={gab.fila} carregar={tudo} aprender={false} />
          : atend.d && <FilaAprovacao fila={atend.d.fila} carregar={tudo} areaPadrao={a === 'suporte' ? 'suporte' : 'comercial'} />)}
        {aba === 'simular' && a !== 'leo' && (
          <div className="duas-colunas">
            <Simulador aoMudar={tudo} agente={a as AgenteAtend | 'gabriel'} dica={a === 'gabriel'
              ? 'Você é um amigo/contato falando com o Gabriel. Veja se ele responde como você. Nada vai para o WhatsApp.'
              : `Você é o cliente falando com ${info.nome}. Nada vai para o WhatsApp; chamados de teste não avisam ninguém.`} />
            <Hud titulo="Como testar bem" icone={<Wrench size={14} />}>
              <ul className="lista-dicas">
                {a === 'joao' && <><li>Pergunte preço de algo que você ensinou e de algo que ele não sabe: ele não pode inventar.</li><li>Peça suporte técnico: ele deve passar para o suporte, não resolver.</li></>}
                {a === 'suporte' && <><li>Pergunte “o sistema caiu?”: ele consulta o monitor de verdade.</li><li>Descreva um erro: ele deve abrir chamado se não souber resolver.</li></>}
                {a === 'gabriel' && <><li>Peça dinheiro emprestado ou um compromisso: ele deve enrolar, não decidir.</li><li>Pergunte se é IA: ele nunca nega (diz que é o assistente do Gabriel).</li></>}
                <li>Se der erro, o motivo aparece aqui e fica salvo na aba Erros.</li>
              </ul>
            </Hud>
          </div>
        )}
        {aba === 'configurar' && <Configurar a={a} atend={atend} gab={gab} setGab={setGab} recarregar={tudo} />}
        {aba === 'erros' && <Erros a={a} feed={feed} recarregar={tudo} />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ visao geral
function Visao({ a, s, estado, wa, feed, modo, revisar, pendentes, irPara, extra, gab }: {
  a: AgenteId; s: Saude['agentes'][number] | undefined; estado: string; wa: string | undefined; feed: Feed | null; modo: string
  revisar: number; pendentes: number; irPara: (x: Aba) => void; extra?: React.ReactNode; gab: GabrielPainel | null
}) {
  const info = AGENTES[a]
  const ultimoErro = feed?.eventos.find(e => e.nivel === 'erro')
  return (
    <div className="duas-colunas">
      <div className="coluna-pilha">
        <Hud titulo="O que está fazendo agora" icone={<Activity size={14} />}>
          <p className="frase-grande">{info.resumo}</p>
          <div className="cartao-linha"><span>Modo</span><b>{MODO[modo]?.rotulo || modo}</b></div>
          <div className="etiqueta" style={{ margin: '-2px 0 8px' }}>{MODO[modo]?.texto}</div>
          <div className="cartao-linha"><span>WhatsApp ({info.numero})</span><b className={wa === 'open' ? 'verde' : 'vermelho'}>{wa ? ROTULO_WA[wa] : '…'}</b></div>
          <div className="cartao-linha"><span>Última atividade</span><b>{haQuanto(s?.ultima_atividade)}</b></div>
          {a === 'gabriel' && gab && <div className="cartao-linha"><span>Contatos liberados</span><b>{gab.contatos.length}</b></div>}
          <div className="numeros pequeno">
            <Numero valor={s?.lidas_24h ?? '…'} rotulo="mensagens lidas (24h)" />
            <Numero valor={s?.respostas_24h ?? '…'} rotulo="respostas (24h)" />
            <Numero valor={s?.aprendidos ?? '…'} rotulo="coisas que sabe" />
            <Numero valor={s?.erros_24h ?? '…'} rotulo="falhas (24h)" destaque={s?.erros_24h ? 'erro' : undefined} />
          </div>
        </Hud>
        {estado === 'erro' && ultimoErro && (
          <div className="alerta-erro">
            <AlertTriangle size={20} />
            <div>
              <b>Última falha: {ultimoErro.titulo}</b>
              <span>{haQuanto(ultimoErro.em)} · {comoResolver(ultimoErro.titulo)}</span>
              <BotaoMini onClick={() => irPara('erros')}>ver detalhes <ChevronRight size={12} /></BotaoMini>
            </div>
          </div>
        )}
        {(revisar > 0 || pendentes > 0) && (
          <Hud titulo="Precisa de você" icone={<Inbox size={14} />}>
            {revisar > 0 && <button className="acao-linha" onClick={() => irPara('aprendizado')}><Sparkles size={15} /> {revisar} aprendizado{revisar > 1 ? 's' : ''} para revisar<ChevronRight size={15} /></button>}
            {pendentes > 0 && <button className="acao-linha" onClick={() => irPara('aprovar')}><Inbox size={15} /> {pendentes} resposta{pendentes > 1 ? 's' : ''} esperando aprovação<ChevronRight size={15} /></button>}
          </Hud>
        )}
        {extra}
      </div>
      <div className="coluna-pilha">
        <Hud titulo="Últimas conversas lidas" icone={<Eye size={14} />} extra={<BotaoMini onClick={() => irPara('leu')}>todas <ChevronRight size={12} /></BotaoMini>}>
          {!feed && <div className="vazio">Carregando…</div>}
          {feed && feed.conversas.length === 0 && <div className="vazio">Ainda não leu nada nos últimos 14 dias. Confira em Configurar o que {info.nome} pode ler.</div>}
          {feed?.conversas.slice(0, 6).map(c => (
            <button key={c.numero} className="conversa-linha" onClick={() => irPara('leu')}>
              <span className="conversa-nome">{c.nome || `+${c.numero}`}</span>
              <span className="conversa-prev">{c.ultima_mensagem}</span>
              <span className="conversa-quando">{haQuanto(c.ultima)}</span>
            </button>
          ))}
        </Hud>
        <Hud titulo="Aprendeu por último" icone={<Brain size={14} />} extra={<BotaoMini onClick={() => irPara('aprendizado')}>tudo <ChevronRight size={12} /></BotaoMini>}>
          {feed && feed.aprendizado.length === 0 && <div className="vazio">Nada ainda. O aprendiz roda a cada 15 minutos.</div>}
          {feed?.aprendizado.slice(0, 5).map(i => (
            <div className="item" key={i.id}><div>
              <div className="item-titulo">{i.titulo || 'sem título'}</div>
              <div className="item-texto">{i.conteudo}</div>
            </div></div>
          ))}
        </Hud>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ o que leu
function OQueLeu({ a, feed }: { a: AgenteId; feed: Feed | null }) {
  const [sel, setSel] = useState<string | null>(null)
  const [busca, setBusca] = useState('')
  const lista = useMemo(() => (feed?.conversas || []).filter(c => !busca || `${c.nome} ${c.numero} ${c.historico.map(h => h.texto).join(' ')}`.toLowerCase().includes(busca.toLowerCase())), [feed, busca])
  const atual = lista.find(c => c.numero === sel) || lista[0]
  const outro = a === 'joao' || a === 'suporte' ? 'CLIENTE' : 'CONTATO'
  const rotulo = { usuario: outro, humano: a === 'joao' || a === 'suporte' ? 'EQUIPE (humano)' : 'VOCÊ', ia: AGENTES[a].nome.toUpperCase() }
  if (!feed) return <div className="vazio">Carregando…</div>
  return (
    <div className="leitor">
      <div className="leitor-lista hud">
        <div className="busca"><Search size={14} /><input aria-label="Buscar nas conversas" placeholder="Buscar nome, número ou texto…" value={busca} onChange={e => setBusca(e.target.value)} /></div>
        <div className="etiqueta" style={{ padding: '0 12px 6px' }}>{feed.conversas.length} conversas nos últimos 14 dias</div>
        <div className="leitor-itens">
          {lista.length === 0 && <div className="vazio" style={{ padding: 12 }}>Nada encontrado.</div>}
          {lista.map(c => (
            <button key={c.numero} className={`conversa-linha ${atual?.numero === c.numero ? 'ativa' : ''}`} onClick={() => setSel(c.numero)}>
              <span className="conversa-nome">{c.nome || `+${c.numero}`}</span>
              <span className="conversa-prev">{c.ultima_mensagem}</span>
              <span className="conversa-quando">{c.mensagens} msgs · {haQuanto(c.ultima)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="leitor-conversa hud">
        {!atual ? <div className="vazio" style={{ padding: 16 }}>Escolha uma conversa.</div> : (
          <>
            <div className="hud-titulo"><span>{atual.nome || 'sem nome'} · +{atual.numero}</span><span className="contagem">{atual.mensagens} msgs</span></div>
            <div className="leitor-msgs">
              {atual.historico.map((m, i) => (
                <div key={i} className={`sim-msg ${m.papel === 'usuario' ? 'cliente-de-la' : m.papel === 'humano' ? 'voce' : 'ia'}`}>
                  <span className="via">{rotulo[m.papel] ?? m.papel} · {fmt(m.em)}</span>{m.texto}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ aprendizado
function grupoDe(a: AgenteId, i: ItemAprendido) {
  if (a === 'leo' || a === 'gabriel') {
    const t = (i.titulo || '').toLowerCase()
    return t.startsWith('jeito de') ? 'Jeito de falar' : t.startsWith('como resolve') ? 'Como resolve as coisas' : i.origem === 'resposta_aprovada' ? 'Respostas que você aprovou' : 'Fatos e memórias'
  }
  return ({ comercial: 'Vendas', suporte: 'Suporte', geral: 'Geral', sistemico: 'Sistemas' } as Record<string, string>)[i.area || ''] || 'Outros'
}

// de onde veio cada coisa que a IA aprendeu
function origemDe(i: ItemAprendido) {
  const de = i.de ? ` na conversa com ${/^\d+$/.test(i.de) ? '+' + i.de : i.de}` : ''
  if (i.origem.startsWith('observacao')) return `aprendeu sozinho${de}`
  if (i.origem === 'resposta_aprovada') return 'de uma resposta que você aprovou'
  if (i.origem === 'manual') return 'você ensinou'
  if (i.origem === 'ensinado_pelo_dono') return 'você ensinou conversando com ele'
  if (i.origem === 'conversa') return 'você pediu para lembrar'
  if (i.origem === 'copiado') return `copiado ${i.copiado_de && i.copiado_de in AGENTES ? 'do ' + AGENTES[i.copiado_de as AgenteId].nome : 'de outra IA'}`
  return `aprendeu${de}`
}
function diaDe(iso: string) {
  const d = new Date(iso), hoje = new Date(), ontem = new Date(Date.now() - 864e5)
  const mesmo = (x: Date) => x.toDateString() === d.toDateString()
  return mesmo(hoje) ? 'Hoje' : mesmo(ontem) ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function Acoes({ a, i, recarregar }: { a: AgenteId; i: ItemAprendido; recarregar: () => void }) {
  return <>
    <CopiarPara a={a} id={i.id} />
    <button aria-label={`Esquecer ${i.titulo || ''}`} title="Esquecer" onClick={async () => {
      if (!confirm('Fazer a IA esquecer isso?')) return
      if (a === 'leo' || a === 'gabriel') await api.esquecer(i.id); else await api.baseApagar(i.id)
      recarregar()
    }}><Trash2 size={13} /></button>
  </>
}

function Aprendizado({ a, feed, recarregar, manual }: { a: AgenteId; feed: Feed | null; recarregar: () => void; manual: React.ReactNode }) {
  const [busca, setBusca] = useState('')
  const [rodando, setRodando] = useState('')
  if (!feed) return <div className="vazio">Carregando…</div>
  const filtra = (i: ItemAprendido) => !busca || `${i.titulo} ${i.conteudo} ${i.de || ''}`.toLowerCase().includes(busca.toLowerCase())
  const todos = feed.aprendizado.filter(filtra)
  const porDia = todos.reduce<[string, ItemAprendido[]][]>((l, i) => {
    const d = diaDe(i.em); const ult = l[l.length - 1]
    if (ult && ult[0] === d) ult[1].push(i); else l.push([d, [i]])
    return l
  }, [])
  const grupos = todos.reduce<Record<string, ItemAprendido[]>>((g, i) => { (g[grupoDe(a, i)] ||= []).push(i); return g }, {})
  const hoje = feed.aprendizado.filter(i => diaDe(i.em) === 'Hoje').length
  const suas = feed.conversas.reduce((n, c) => n + c.historico.filter(h => h.papel === 'humano').length, 0)
  return (
    <div className="duas-colunas">
      <div className="coluna-pilha">
        <Hud titulo="Histórico do que aprendeu" icone={<Sparkles size={14} />} extra={
          <BotaoMini disabled={rodando === '…'} onClick={async () => {
            setRodando('…')
            try { const r = await api.aprenderAgora(); setRodando(r.sugestoes ? `+${r.sugestoes}` : 'nada novo') } catch { setRodando('falhou') }
            recarregar(); setTimeout(() => setRodando(''), 6000)
          }}><RefreshCw size={12} className={rodando === '…' ? 'girando' : ''} /> {rodando || 'aprender agora'}</BotaoMini>}>
          <div className="etiqueta" style={{ marginBottom: 8 }}>
            {AGENTES[a].nome} aprende sozinho a cada 15 min com o que {a === 'joao' || a === 'suporte' ? 'a equipe responde' : 'você escreve'} no número dele
            (áudios incluídos) e já passa a usar.{hoje > 0 ? ` Hoje: ${hoje} coisa${hoje > 1 ? 's' : ''} nova${hoje > 1 ? 's' : ''}.` : ''} Se algo estiver errado, mande esquecer.
          </div>
          {suas === 0 && feed.conversas.length > 0 && (
            <div className="aviso erro" style={{ marginBottom: 8 }}>
              Nas conversas lidas ainda não há nenhuma mensagem {a === 'joao' || a === 'suporte' ? 'da equipe' : 'sua'} — só dos contatos.
              A IA aprende com quem responde pelo número dela: responda algumas conversas por ele e clique em “aprender agora”.
            </div>
          )}
          <div className="busca" style={{ margin: '0 0 8px' }}><Search size={14} /><input aria-label="Buscar no histórico" placeholder="Buscar no que aprendeu…" value={busca} onChange={e => setBusca(e.target.value)} /></div>
          {todos.length === 0 && <div className="vazio">{busca ? 'Nada encontrado.' : 'Ainda não aprendeu nada.'}</div>}
          <div className="linha-tempo">
            {porDia.map(([dia, itens]) => (
              <div key={dia}>
                <div className="dia">{dia} <span className="contagem">{itens.length}</span></div>
                {itens.map(i => (
                  <div className="marco" key={i.id}>
                    <div>
                      <div className="etiqueta"><b>{new Date(i.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b> · {grupoDe(a, i)} · {origemDe(i)}</div>
                      <div className="item-titulo">{i.titulo || 'sem título'}</div>
                      <div className="item-texto">{i.conteudo}</div>
                    </div>
                    <Acoes a={a} i={i} recarregar={recarregar} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Hud>
      </div>
      <div className="coluna-pilha">
        <Hud titulo={`O que ${AGENTES[a].nome} sabe, por assunto`} icone={<BookOpen size={14} />} extra={<span className="contagem">{feed.aprendizado.length}</span>}>
          {Object.keys(grupos).length === 0 && <div className="vazio">Nada ainda.</div>}
          {Object.entries(grupos).map(([g, itens]) => (
            <details key={g} className="grupo">
              <summary>{g} <span className="contagem">{itens.length}</span></summary>
              {itens.map(i => (
                <div className="item" key={i.id}>
                  <div><div className="item-titulo">{i.titulo || 'sem título'}</div><div className="item-texto">{i.conteudo}</div></div>
                  <Acoes a={a} i={i} recarregar={recarregar} />
                </div>
              ))}
            </details>
          ))}
        </Hud>
        {manual}
      </div>
    </div>
  )
}

// passar um conhecimento para outra IA: so quando voce escolhe
function CopiarPara({ a, id }: { a: AgenteId; id: number }) {
  const [feito, setFeito] = useState('')
  if (feito) return <span className="copiado">{feito}</span>
  return (
    <select className="copiar-para" aria-label="Ensinar também para outra IA" title="Ensinar também para outra IA" value=""
      onChange={async e => {
        const para = e.target.value as AgenteId
        if (!para) return
        await api.conhecimentoCopiar(id, para)
        setFeito(`✓ ${AGENTES[para].nome}`)
      }}>
      <option value="">copiar para…</option>
      {ORDEM.filter(x => x !== a).map(x => <option key={x} value={x}>{AGENTES[x].nome}</option>)}
    </select>
  )
}

// ------------------------------------------------------------------ configurar
function Configurar({ a, atend, gab, setGab, recarregar }: {
  a: AgenteId; atend: ReturnType<typeof useAtendimento>; gab: GabrielPainel | null; setGab: (g: GabrielPainel) => void; recarregar: () => void
}) {
  const info = AGENTES[a]
  const [novo, setNovo] = useState({ nome: '', numero: '' })
  const conexao = (
    <Hud titulo={`WhatsApp · ${info.numero}`} icone={<MessageSquare size={14} />}>
      <Conexao instancia={info.instancia} titulo={info.numero} dica={
        a === 'leo' ? 'Conecte o número do Leo. Você fala com ele na conversa “Você” desse número; as outras conversas ele lê para aprender.'
        : a === 'gabriel' ? 'Conecte o número do Gabriel. Ele lê as conversas desse número para aprender o seu jeito e só responde quem você liberar.'
        : `Conecte o chip ${a === 'joao' ? 'do João' : 'do Suporte24hrs'}. Quem responder por esse número ensina a IA.`} />
      <div className="etiqueta" style={{ marginTop: 8 }}>Para trocar o número desta IA: desconecte e conecte outro. O que ela já aprendeu continua.</div>
    </Hud>
  )
  if (a === 'leo') return (
    <div className="duas-colunas">
      <Hud titulo="O que o Leo pode ler" icone={<Eye size={14} />}><FiltroObservacao agente="leo" /></Hud>
      {conexao}
    </div>
  )
  if (a === 'gabriel') {
    if (!gab) return <div className="vazio">Carregando…</div>
    return (
      <div className="duas-colunas">
        <div className="coluna-pilha">
          <Hud titulo="Como o Gabriel trabalha" icone={<UserRound size={14} />}>
            <div className="modos">
              {(['desligado', 'observando', 'aprovacao', 'automatico'] as const).map(m => (
                <button key={m} className={gab.modo === m ? 'ativo' : ''} onClick={async () => {
                  if (m === 'automatico' && !confirm('O Gabriel vai responder SOZINHO, como você, os contatos liberados. Continuar?')) return
                  setGab(await api.gabrielConfig(m)); recarregar()
                }}>{MODO[m].rotulo}</button>
              ))}
            </div>
            <div className="etiqueta" style={{ marginTop: 8 }}>{MODO[gab.modo]?.texto} Só responde os contatos liberados ao lado.</div>
            <FiltroObservacao agente="gabriel" />
          </Hud>
          {conexao}
        </div>
        <Hud titulo="Contatos que ele pode responder" icone={<UserRound size={14} />} extra={<span className="contagem">{gab.contatos.length}</span>}>
          <div className="etiqueta" style={{ marginBottom: 6 }}>Só estes recebem resposta do Gabriel. Todo o resto do número dele ele só lê para aprender.</div>
          <form style={{ display: 'flex', gap: 6, marginBottom: 6 }} onSubmit={async e => {
            e.preventDefault(); await api.observacaoAdd('gabriel', novo.numero, novo.nome, 'incluir'); setNovo({ nome: '', numero: '' }); recarregar()
          }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Nome" placeholder="Nome" value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} /></div>
            <div className="campo" style={{ flex: 1.2, margin: 0 }}><input aria-label="Número" placeholder="55 11 9…" inputMode="tel" value={novo.numero} onChange={e => setNovo({ ...novo, numero: e.target.value })} /></div>
            <button className="botao" style={{ width: 'auto' }} disabled={novo.numero.replace(/\D/g, '').length < 10} aria-label="Liberar contato"><Plus size={14} /></button>
          </form>
          {gab.contatos.length === 0 && <div className="vazio">Ninguém liberado ainda.</div>}
          {gab.contatos.map(c => (
            <div className="item" key={c.id}>
              <div><div className="item-titulo">{c.nome || 'sem nome'}</div><div className="etiqueta">+{c.numero}</div></div>
              <button aria-label={`Remover ${c.nome || c.numero}`} onClick={async () => { await api.observacaoDel(c.id); recarregar() }}><Trash2 size={13} /></button>
            </div>
          ))}
        </Hud>
      </div>
    )
  }
  const d = atend.d
  if (!d) return <div className="vazio">{atend.erro || 'Carregando…'}</div>
  const ag = a as AgenteAtend
  return (
    <div className="duas-colunas">
      <div className="coluna-pilha">
        <Hud titulo={`Como ${info.nome} trabalha`} icone={<Settings2 size={14} />}>
          <ConfigModo d={d} agente={ag} carregar={recarregar} />
          <div className="etiqueta" style={{ marginTop: 8 }}>{MODO[d.config.modo]?.texto}</div>
          <FiltroObservacao agente={ag} />
        </Hud>
        {conexao}
        <EmpresaForm key={a} d={d} agente={ag} />
      </div>
      <div className="coluna-pilha">
        <Clientes d={d} agente={ag} carregar={recarregar} />
        <VisivelClientes d={d} carregar={recarregar} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ erros
export function CartaoEvento({ ev }: { ev: Evento }) {
  const ctx = ev.contexto || {}
  return (
    <div className={`evento ${ev.nivel || 'erro'} ${ev.visto ? 'visto' : ''}`}>
      <div className="evento-topo">
        <AlertTriangle size={15} />
        <b>{ev.titulo}</b>
        <span className="etiqueta">{fmt(ev.em)} · {haQuanto(ev.em)}</span>
      </div>
      <div className="evento-resolver"><Wrench size={12} /> {comoResolver(ev.titulo)}</div>
      {(ctx.numero || ctx.mensagem || ctx.workflow) ? (
        <div className="etiqueta" style={{ marginTop: 4 }}>
          {ctx.numero ? `Contato +${String(ctx.numero)}` : ''}{ctx.mensagem ? ` · mensagem: “${String(ctx.mensagem).slice(0, 120)}”` : ''}
          {ctx.workflow ? `Onde: ${String(ctx.workflow)}${ctx.no ? ` → ${String(ctx.no)}` : ''}` : ''}
        </div>
      ) : null}
      {ev.detalhe && <details><summary>detalhe técnico</summary><pre>{ev.detalhe}</pre></details>}
    </div>
  )
}

function Erros({ a, feed, recarregar }: { a: AgenteId; feed: Feed | null; recarregar: () => void }) {
  if (!feed) return <div className="vazio">Carregando…</div>
  const novos = feed.eventos.filter(e => !e.visto).length
  return (
    <Hud titulo={`Falhas de ${AGENTES[a].nome} (30 dias)`} icone={<AlertTriangle size={14} />}
      extra={novos > 0 && <BotaoMini onClick={async () => { await api.eventosVistos(a); recarregar() }}><Check size={12} /> marcar {novos} como visto</BotaoMini>}>
      <div className="etiqueta" style={{ marginBottom: 8 }}>Toda vez que esta IA falha, fica registrado aqui com o motivo em português e o que fazer. Quando falha no WhatsApp, o contato não recebe nada e você é avisado.</div>
      {feed.eventos.length === 0 && <div className="vazio">Nenhuma falha registrada ✓</div>}
      {feed.eventos.map(ev => <CartaoEvento key={ev.id} ev={ev} />)}
    </Hud>
  )
}

export { ORDEM }
