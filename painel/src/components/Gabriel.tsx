import { useCallback, useEffect, useState } from 'react'
import { UserRound, Inbox, Plus, Trash2, Sparkles } from 'lucide-react'
import { api, ErroApi, type GabrielPainel } from '../api'
import { ItemFila, Simulador } from './Atendimento'

function Hud({ titulo, icone, extra, children }: { titulo: string; icone: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="hud">
      <div className="hud-titulo"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{icone}{titulo}</span>{extra}</div>
      <div className="hud-corpo">{children}</div>
    </section>
  )
}

export function Gabriel({ aoSair }: { aoSair: () => void }) {
  const [d, setD] = useState<GabrielPainel | null>(null)
  const [novo, setNovo] = useState({ nome: '', numero: '' })
  const carregar = useCallback(async () => {
    try { setD(await api.gabriel()) } catch (e) { if (e instanceof ErroApi && e.status === 401) aoSair() }
  }, [aoSair])
  useEffect(() => { void carregar(); const t = setInterval(carregar, 15000); return () => clearInterval(t) }, [carregar])
  if (!d) return <div className="atendimento"><div className="vazio">Carregando…</div></div>

  return (
    <div className="atendimento">
      <div className="atend-coluna">
        <Hud titulo="Gabriel · seu clone" icone={<UserRound size={14} />}>
          <div className="modos">
            {(['desligado', 'observando', 'aprovacao', 'automatico'] as const).map(m => (
              <button key={m} className={d.modo === m ? 'ativo' : ''} onClick={async () => {
                if (m === 'automatico' && !confirm('O Gabriel vai responder SOZINHO, como você, os contatos liberados. Continuar?')) return
                setD(await api.gabrielConfig(m))
              }}>{m === 'desligado' ? 'Desligado' : m === 'observando' ? 'Só observando' : m === 'aprovacao' ? 'Com aprovação' : 'Automático'}</button>
            ))}
          </div>
          <div className="etiqueta" style={{ margin: '8px 0 0' }}>
            {d.modo === 'observando' ? 'Aprende o seu jeito lendo as conversas que o Leo lê. Não responde ninguém.'
              : d.modo === 'aprovacao' ? 'Escreve a resposta que você daria; você aprova/edita aqui antes de ir.'
              : d.modo === 'automatico' ? 'Responde sozinho, como você, os contatos liberados.' : 'Parado.'}
            {' '}Lidas: {d.conversas_lidas} msgs · {d.aprendidos} coisas aprendidas sobre você.
          </div>
        </Hud>

        <Hud titulo="Para aprovar" icone={<Inbox size={14} />} extra={<span className="contagem">{d.fila.length}</span>}>
          {d.fila.length === 0 && <div className="vazio">Nada esperando aprovação.</div>}
          {d.fila.map(f => <ItemFila key={f.id} f={f} aoMudar={carregar} aprender={false} />)}
        </Hud>

        <Simulador aoMudar={carregar} agente="gabriel" dica="Você é um amigo/contato falando com o Gabriel. Veja se ele responde como você." />
      </div>

      <div className="atend-coluna">
        <Hud titulo="Contatos que ele responde" icone={<UserRound size={14} />} extra={<span className="contagem">{d.contatos.length}</span>}>
          <div className="etiqueta" style={{ marginBottom: 6 }}>Só estes recebem resposta do Gabriel (quando o modo permitir). Todo o resto ele só lê para aprender.</div>
          <form style={{ display: 'flex', gap: 6, marginBottom: 6 }} onSubmit={async e => {
            e.preventDefault(); await api.observacaoAdd('gabriel', novo.numero, novo.nome, 'incluir'); setNovo({ nome: '', numero: '' }); void carregar()
          }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Nome" placeholder="Nome" value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} /></div>
            <div className="campo" style={{ flex: 1.2, margin: 0 }}><input aria-label="Número" placeholder="55 11 9…" inputMode="tel" value={novo.numero} onChange={e => setNovo({ ...novo, numero: e.target.value })} /></div>
            <button className="botao" style={{ width: 'auto' }} disabled={novo.numero.replace(/\D/g, '').length < 10} aria-label="Liberar contato"><Plus size={14} /></button>
          </form>
          {d.contatos.length === 0 && <div className="vazio">Ninguém liberado ainda.</div>}
          {d.contatos.map(c => (
            <div className="item" key={c.id}>
              <div><div className="item-titulo">{c.nome || 'sem nome'}</div><div className="etiqueta">+{c.numero}</div></div>
              <button aria-label={`Remover ${c.nome || c.numero}`} onClick={async () => { await api.observacaoDel(c.id); void carregar() }}><Trash2 size={13} /></button>
            </div>
          ))}
        </Hud>

        <Hud titulo="O que ele sabe do seu jeito" icone={<Sparkles size={14} />}>
          {d.estilo ? <div className="item-texto" style={{ whiteSpace: 'pre-wrap' }}>{d.estilo}</div>
            : <div className="vazio">Ainda aprendendo. Aprove o que aparecer em “Leo aprendeu” (tela do Leo) — o Gabriel usa o mesmo aprendizado.</div>}
        </Hud>
      </div>
    </div>
  )
}
