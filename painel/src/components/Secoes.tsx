// Pedacos da configuracao do Joao / Suporte24hrs, usados nas abas da pagina de cada IA.
import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Check, CircleUser, Eye, Inbox, LifeBuoy, Settings2, UserPlus } from 'lucide-react'
import { api, ErroApi, type Area, type AgenteAtend, type AtendimentoPainel, type Empresa } from '../api'
import { Hud, fmt } from './ui'
import { ItemCliente, ItemFila } from './Atendimento'

const ROTULO_AREA: Record<string, string> = { suporte: 'SUPORTE', comercial: 'COMERCIAL', sistemico: 'SISTÊMICO', humano: 'HUMANO', geral: 'GERAL' }

export function useAtendimento(agente: AgenteAtend | null, aoSair: () => void) {
  const [d, setD] = useState<AtendimentoPainel | null>(null)
  const [erro, setErro] = useState('')
  const carregar = useCallback(async () => {
    if (!agente) return
    try { setD(await api.atendimento(agente)); setErro('') }
    catch (e) { if (e instanceof ErroApi && e.status === 401) aoSair(); else setErro(e instanceof Error ? e.message : 'Falhou') }
  }, [aoSair, agente])
  useEffect(() => { setD(null) }, [agente])
  useEffect(() => { void carregar(); const t = setInterval(carregar, 20000); return () => clearInterval(t) }, [carregar])
  return { d, erro, carregar }
}

type Sec = { d: AtendimentoPainel; agente: AgenteAtend; carregar: () => void }

export function ConfigModo({ d, agente, carregar }: Sec) {
  const modo = d.config.modo
  return (
    <>
      <div className="modos">
        {(['desligado', 'observando', 'aprovacao', 'automatico'] as const).map(m => (
          <button key={m} className={modo === m ? 'ativo' : ''} onClick={async () => {
            if (m === 'automatico' && !confirm(`${d.config.persona} vai responder clientes SOZINHO. Continuar?`)) return
            await api.atendimentoConfig(agente, { modo: m }); carregar()
          }}>
            {m === 'desligado' ? 'Desligada' : m === 'observando' ? 'Só observando' : m === 'aprovacao' ? 'Com aprovação' : 'Automática'}
          </button>
        ))}
      </div>
      {(modo === 'aprovacao' || modo === 'automatico') && (
        <div className="chave">
          <div className="chave-texto"><b>Responde para</b><span>{d.config.alcance === 'todos' ? 'Todos os clientes' : 'Só os clientes com o interruptor IA ligado (em Clientes)'}</span></div>
          <div className="modos" style={{ flexWrap: 'nowrap' }}>
            {(['selecionados', 'todos'] as const).map(a => (
              <button key={a} className={d.config.alcance === a ? 'ativo' : ''} onClick={async () => { await api.atendimentoConfig(agente, { alcance: a }); carregar() }}>{a === 'todos' ? 'Todos' : 'Marcados'}</button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export function EmpresaForm({ d, agente }: Omit<Sec, 'carregar'>) {
  const [empresa, setEmpresa] = useState<Empresa>(d.config.empresa)
  const [salvo, setSalvo] = useState('')
  return (
    <Hud titulo="Empresa e jeito de falar" icone={<Settings2 size={14} />}>
      {salvo && <div className="aviso ok">{salvo}</div>}
      <div className="linha-2">
        <div className="campo"><label htmlFor="e-nome">Empresa</label><input id="e-nome" value={empresa.nome} onChange={e => setEmpresa({ ...empresa, nome: e.target.value })} /></div>
        <div className="campo"><label htmlFor="e-pers">Nome de quem atende</label><input id="e-pers" placeholder={agente === 'suporte' ? 'Suporte24hrs' : 'João'} value={empresa.persona || ''} onChange={e => setEmpresa({ ...empresa, persona: e.target.value })} /></div>
      </div>
      <div className="campo"><label htmlFor="e-desc">O que a empresa faz</label><textarea id="e-desc" rows={2} value={empresa.descricao} onChange={e => setEmpresa({ ...empresa, descricao: e.target.value })} /></div>
      <div className="linha-2">
        <div className="campo"><label htmlFor="e-hor">Horário humano</label><input id="e-hor" value={empresa.horario} onChange={e => setEmpresa({ ...empresa, horario: e.target.value })} /></div>
        <div className="campo"><label htmlFor="e-tom">Tom de voz</label><input id="e-tom" value={empresa.tom} onChange={e => setEmpresa({ ...empresa, tom: e.target.value })} /></div>
      </div>
      <button className="botao secundario" onClick={async () => { await api.atendimentoConfig(agente, { empresa }); setSalvo('Salvo ✓'); setTimeout(() => setSalvo(''), 2000) }}>Salvar</button>
    </Hud>
  )
}

export function EnsinarManual({ d, agente, carregar }: Sec) {
  const [nova, setNova] = useState<{ area: Area; titulo: string; conteudo: string }>({ area: agente === 'suporte' ? 'suporte' : 'comercial', titulo: '', conteudo: '' })
  return (
    <Hud titulo="Ensinar manualmente" icone={<BookOpen size={14} />}>
      <form onSubmit={async e => { e.preventDefault(); await api.baseSalvar(nova.area, nova.titulo, nova.conteudo); setNova({ ...nova, titulo: '', conteudo: '' }); carregar() }}>
        <div className="linha-2">
          <div className="campo"><label htmlFor="b-area">Área</label>
            <select id="b-area" value={nova.area} onChange={e => setNova({ ...nova, area: e.target.value as Area })}>
              <option value="comercial">Comercial</option><option value="suporte">Suporte</option><option value="geral">Geral (todas)</option>
            </select></div>
          <div className="campo"><label htmlFor="b-tit">Título</label><input id="b-tit" placeholder="Ex.: Preço do plano" value={nova.titulo} onChange={e => setNova({ ...nova, titulo: e.target.value })} /></div>
        </div>
        <div className="campo"><label htmlFor="b-cont">O que a IA deve saber</label>
          <textarea id="b-cont" rows={3} required placeholder="Ex.: O plano mensal custa R$ 99, cancela quando quiser, pagamento por Pix ou cartão." value={nova.conteudo} onChange={e => setNova({ ...nova, conteudo: e.target.value })} /></div>
        <button className="botao" disabled={!nova.conteudo.trim()}>Ensinar {d.config.persona}</button>
      </form>
    </Hud>
  )
}

export function Chamados({ d, carregar }: Omit<Sec, 'agente'>) {
  return (
    <Hud titulo="Chamados abertos" icone={<LifeBuoy size={14} />} extra={<span className="contagem">{d.chamados.length}</span>}>
      {d.chamados.length === 0 && <div className="vazio">Nenhum chamado aberto.</div>}
      {d.chamados.map(c => (
        <div className="item" key={c.id}>
          <div>
            <div className="item-titulo"><span className={`origem ${c.prioridade === 'alta' ? 'alta' : ''}`}>{ROTULO_AREA[c.area] ?? c.area}</span>#{c.id} {c.titulo}</div>
            {c.descricao && <div className="item-texto">{c.descricao}</div>}
            <div className="etiqueta">{c.nome || 'Cliente'}{c.whatsapp && !c.whatsapp.startsWith('teste') ? ` · +${c.whatsapp}` : ' · teste'} · {fmt(c.criado_em)}</div>
          </div>
          <button aria-label="Marcar resolvido" title="Resolvido" onClick={async () => { await api.chamadoResolver(c.id); carregar() }}><Check size={14} /></button>
        </div>
      ))}
    </Hud>
  )
}

export function Clientes({ d, agente, carregar }: Sec) {
  const [novoCli, setNovoCli] = useState({ nome: '', whatsapp: '' })
  return (
    <Hud titulo="Clientes" icone={<CircleUser size={14} />} extra={<span className="contagem">{d.clientes.length}</span>}>
      <form onSubmit={async e => { e.preventDefault(); await api.clienteSalvar(novoCli.nome, novoCli.whatsapp); setNovoCli({ nome: '', whatsapp: '' }); carregar() }}
        style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Nome do cliente" placeholder="Nome" value={novoCli.nome} onChange={e => setNovoCli({ ...novoCli, nome: e.target.value })} /></div>
        <div className="campo" style={{ flex: 1.2, margin: 0 }}><input aria-label="WhatsApp do cliente" placeholder="55 11 9…" inputMode="tel" value={novoCli.whatsapp} onChange={e => setNovoCli({ ...novoCli, whatsapp: e.target.value })} /></div>
        <button className="botao" style={{ width: 'auto' }} disabled={novoCli.whatsapp.replace(/[^0-9]/g, '').length < 10} aria-label="Cadastrar cliente"><UserPlus size={14} /></button>
      </form>
      <div className="etiqueta" style={{ marginBottom: 4 }}>O interruptor IA libera a resposta da IA para aquele cliente (quando o modo permitir).</div>
      {d.clientes.length === 0 && <div className="vazio">Nenhum cliente ainda.</div>}
      {d.clientes.map(c => <ItemCliente key={c.id} c={c} alcance={d.config.alcance} aoMudar={carregar} agente={agente} />)}
    </Hud>
  )
}

export function VisivelClientes({ d, carregar }: Omit<Sec, 'agente'>) {
  return (
    <Hud titulo="O que clientes podem saber" icone={<Eye size={14} />}>
      <div className="etiqueta" style={{ marginBottom: 6 }}>Serviços que a IA pode dizer ao cliente se estão fora do ar.</div>
      {d.sistemas.length === 0 && <div className="vazio">Nenhum site monitorado.</div>}
      {d.sistemas.map(s => (
        <div className="chave" key={s.id}>
          <div className="chave-texto"><b>{s.nome}</b></div>
          <button role="switch" aria-checked={s.publico} aria-label={`Mostrar ${s.nome} para clientes`} className={`interruptor ${s.publico ? 'ligado' : ''}`}
            onClick={async () => { await api.sistemaPublico(s.id, !s.publico); carregar() }} />
        </div>
      ))}
    </Hud>
  )
}

export function FilaAprovacao({ fila, carregar, areaPadrao, aprender = true }: { fila: AtendimentoPainel['fila']; carregar: () => void; areaPadrao?: Area; aprender?: boolean }) {
  return (
    <Hud titulo="Respostas esperando você" icone={<Inbox size={14} />} extra={<span className="contagem">{fila.length}</span>}>
      <div className="etiqueta" style={{ marginBottom: 6 }}>Só aparece algo aqui no modo “Com aprovação”. Edite se quiser: o que você aprovar vai para o contato e ensina a IA.</div>
      {fila.length === 0 && <div className="vazio">Nada esperando aprovação.</div>}
      {fila.map(f => <ItemFila key={f.id} f={f} aoMudar={carregar} areaPadrao={areaPadrao} aprender={aprender} />)}
    </Hud>
  )
}
