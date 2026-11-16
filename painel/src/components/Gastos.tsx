import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, DollarSign, RefreshCw, Save } from 'lucide-react'
import { api, type Gastos as DadosGastos } from '../api'
import { BotaoMini, Hud, Numero, haQuanto } from './ui'
import { avisar } from '../alerta'

const usd = (v: number | null | undefined, casas = 2) => `US$ ${(v ?? 0).toFixed(casas).replace('.', ',')}`
const diaCurto = (iso: string) => { const [, m, d] = iso.split('-'); return `${d}/${m}` }

// ------------------------------------------------------------------ grafico: uma barra por dia + linha do teto
function GraficoDias({ g }: { g: DadosGastos }) {
  const [foco, setFoco] = useState<number | null>(null)
  const dias = g.dias.map(d => ({ ...d, valor: d.real ?? d.estimado, exato: d.real != null }))
  const max = Math.max(g.limite || 0, ...dias.map(d => d.valor), 0.5)
  const topo = Math.ceil(max * 1.15 * 2) / 2                        // escala arredondada em 0,50
  const W = 720, H = 240, esq = 44, dir = 8, cima = 12, baixo = 26
  const larg = (W - esq - dir) / dias.length
  const y = (v: number) => cima + (H - cima - baixo) * (1 - v / topo)
  const ticks = [0, topo / 2, topo]
  const f = foco != null ? dias[foco] : null
  return (
    <div className="grafico-gastos">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gasto por dia nos últimos 30 dias" onMouseLeave={() => setFoco(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={esq} x2={W - dir} y1={y(t)} y2={y(t)} className="grade-linha" />
            <text x={esq - 6} y={y(t) + 4} textAnchor="end" className="eixo-texto">{t.toFixed(t < 10 ? 2 : 0).replace('.', ',')}</text>
          </g>
        ))}
        {dias.map((d, i) => {
          const x = esq + i * larg, h = Math.max(0, y(0) - y(d.valor))
          return (
            <g key={d.dia} onMouseEnter={() => setFoco(i)} onClick={() => setFoco(i)}>
              <rect x={x} y={cima} width={larg} height={H - cima - baixo} fill="transparent" />
              {d.valor > 0 && (
                <path className={`barra ${d.exato ? '' : 'estimada'} ${foco === i ? 'ativa' : ''}`}
                  d={`M${x + 1} ${y(0)} V${y(0) - h + Math.min(4, h)} Q${x + 1} ${y(0) - h} ${x + 1 + Math.min(4, (larg - 2) / 2)} ${y(0) - h}
                      H${x + larg - 1 - Math.min(4, (larg - 2) / 2)} Q${x + larg - 1} ${y(0) - h} ${x + larg - 1} ${y(0) - h + Math.min(4, h)} V${y(0)} Z`} />
              )}
              {(i % 5 === 4 || i === dias.length - 1) && <text x={x + larg / 2} y={H - 8} textAnchor="middle" className="eixo-texto">{diaCurto(d.dia)}</text>}
            </g>
          )
        })}
        <line x1={esq} x2={W - dir} y1={y(0)} y2={y(0)} className="eixo-linha" />
        {g.limite > 0 && (
          <g>
            <line x1={esq} x2={W - dir} y1={y(g.limite)} y2={y(g.limite)} className="linha-teto" />
            <text x={esq + 6} y={y(g.limite) - 5} textAnchor="start" className="eixo-texto teto">teto {usd(g.limite)}/dia</text>
          </g>
        )}
      </svg>
      {f && (
        <div className="dica-grafico" style={{ left: `${((esq + (foco! + 0.5) * larg) / W) * 100}%` }}>
          <b>{diaCurto(f.dia)}</b>
          <span>{usd(f.valor)} {f.exato ? '(OpenAI)' : '(estimado)'}</span>
          {(f.aprendiz > 0 || f.audio > 0) && <span className="etiqueta">aprendiz {usd(f.aprendiz, 3)} · áudio {usd(f.audio, 3)}</span>}
        </div>
      )}
      <div className="legenda-gastos">
        <span><i className="amostra" /> gasto do dia {g.fonte === 'openai' ? '(valor real da OpenAI)' : ''}</span>
        <span><i className="amostra estimada" /> estimativa (sem o valor da OpenAI)</span>
        {g.limite > 0 && <span><i className="amostra teto" /> teto diário</span>}
      </div>
    </div>
  )
}

export function Gastos() {
  const [g, setG] = useState<DadosGastos | null>(null)
  const [limite, setLimite] = useState('')
  const [salvo, setSalvo] = useState('')
  const [buscando, setBuscando] = useState(false)
  const carregar = useCallback(async () => {
    try { const r = await api.gastos(); setG(r); setLimite(l => l || String(r.limite)) } catch { /* tenta de novo */ }
  }, [])
  useEffect(() => { void carregar(); const t = setInterval(carregar, 60000); return () => clearInterval(t) }, [carregar])
  if (!g) return <div className="pagina"><div className="vazio">Carregando gastos…</div></div>

  const ult7 = g.dias.slice(-7).reduce((a, d) => a + (d.real ?? d.estimado), 0)
  return (
    <div className="pagina">
      <h1 className="titulo-pagina"><DollarSign size={22} /> Gastos com IA</h1>
      {g.aprendiz_pausado && (
        <div className="alerta-erro"><AlertTriangle size={20} /><div>
          <b>Aprendiz pausado hoje: o gasto chegou no teto de {usd(g.limite)}.</b>
          <span>As IAs continuam respondendo normalmente; só o aprendizado volta amanhã. Aumente o teto abaixo se quiser.</span>
        </div></div>
      )}
      <div className="numeros">
        <Numero valor={usd(g.hoje)} rotulo="hoje" destaque={g.limite > 0 && g.hoje >= g.limite ? 'erro' : g.limite > 0 && g.hoje >= g.limite * 0.8 ? 'alerta' : undefined} />
        <Numero valor={usd(ult7)} rotulo="últimos 7 dias" />
        <Numero valor={usd(g.fonte === 'openai' ? g.mes : g.mes_estimado)} rotulo={`este mês${g.fonte === 'openai' ? '' : ' (estimado)'}`} />
        <Numero valor={g.limite > 0 ? usd(g.limite) : 'sem teto'} rotulo="teto por dia (aprendiz)" />
      </div>
      <Hud titulo="Gasto por dia · últimos 30 dias" icone={<DollarSign size={14} />} extra={
        <BotaoMini disabled={buscando} onClick={async () => {
          setBuscando(true)
          try {
            await api.gastosAtualizar()
            const n = await api.gastos(); setG(n)
            if (n.erro_openai) avisar('Não consegui ler a OpenAI', 'error', n.erro_openai); else avisar('Gasto atualizado ✓')
          }
          catch (e) { avisar('Não consegui atualizar', 'error', e instanceof Error ? e.message : '') }
          finally { setBuscando(false) }
        }}><RefreshCw size={12} className={buscando ? 'girando' : ''} /> {buscando ? 'buscando…' : 'atualizar agora'}</BotaoMini>}>
        <GraficoDias g={g} />
        {g.erro_openai && (
          <div className="aviso erro" style={{ marginTop: 10 }}>
            <b>Não consegui ler o gasto na OpenAI</b>{g.lido_em ? ` (${haQuanto(g.lido_em)})` : ''}: {g.erro_openai}
            <br />Confira se a chave é <b>Admin</b> (platform.openai.com → Settings → Organization → Admin keys, começa com <code>sk-admin-</code>)
            e se está no <b>ia-central-n8n</b> do Render como <code>OPENAI_ADMIN_KEY</code>.
          </div>
        )}
        {g.fonte !== 'openai' && !g.erro_openai && (
          <div className="aviso erro" style={{ marginTop: 10 }}>
            Mostrando só a <b>estimativa</b> (aprendiz e áudios). Para ver o gasto <b>exato</b> de tudo (inclusive as respostas das IAs):
            crie uma chave <b>Admin</b> em platform.openai.com → Settings → Organization → Admin keys e coloque no Render como <code>OPENAI_ADMIN_KEY</code>.
          </div>
        )}
      </Hud>
      <div className="duas-colunas">
        <Hud titulo="Onde foi o gasto (30 dias)">
          {g.por_item.length === 0 && <div className="vazio">Sem o detalhe da OpenAI ainda (precisa da chave Admin).</div>}
          {g.por_item.length > 0 && (
            <table className="tabela-gastos">
              <thead><tr><th>Item</th><th>Valor</th></tr></thead>
              <tbody>{g.por_item.map(i => <tr key={i.item}><td>{i.item}</td><td>{usd(i.valor)}</td></tr>)}</tbody>
            </table>
          )}
        </Hud>
        <Hud titulo="Teto diário">
          <div className="etiqueta" style={{ marginBottom: 8 }}>
            Quando o gasto do dia chega no teto, o <b>aprendiz pausa</b> até o dia seguinte e avisa em Erros. As respostas das IAs continuam. 0 = sem teto.
          </div>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={async e => {
            e.preventDefault(); setG(await api.gastosLimite(Number(limite.replace(',', '.')) || 0)); setSalvo('Salvo ✓'); setTimeout(() => setSalvo(''), 2000)
          }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Teto diário em dólares" inputMode="decimal" value={limite} onChange={e => setLimite(e.target.value)} /></div>
            <button className="botao" style={{ width: 'auto' }}><Save size={14} /> Salvar</button>
          </form>
          {salvo && <div className="aviso ok" style={{ marginTop: 8 }}>{salvo}</div>}
        </Hud>
      </div>
    </div>
  )
}
