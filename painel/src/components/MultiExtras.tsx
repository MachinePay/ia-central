// Atendimento multiempresa: regras (horario, volta para a IA, resumo do dia), perguntas sem resposta,
// desempenho por empresa e nota da equipe em cada resposta da IA.
import { useState } from 'react'
import { BarChart3, CalendarClock, HelpCircle, RotateCcw, Save, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { api, type ConversaMultiDetalhe, type HorarioMulti, type ModoIA, type Multi } from '../api'
import { Hud, MODO, haQuanto } from './ui'
import { avisar, confirmar } from '../alerta'

const erroDe = (e: unknown) => (e instanceof Error ? e.message : 'Falhou')
const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
const HORARIO_PADRAO: HorarioMulti = { ativo: false, inicio: '09:00', fim: '18:00', dias: [1, 2, 3, 4, 5], modo_dentro: 'aprovacao', modo_fora: 'automatico' }
const MODOS_HORARIO: ModoIA[] = ['observando', 'aprovacao', 'automatico']

// ------------------------------------------------------------------ regras de atendimento
export function RegrasAtendimento({ m, aoMudar }: { m: Multi; aoMudar: (m: Multi) => void }) {
  const [h, setH] = useState<HorarioMulti>({ ...HORARIO_PADRAO, ...(m.horario ?? {}) })
  const [rel, setRel] = useState(m.relatorio ?? { ativo: true, hora: 18 })
  const [ocupado, setOcupado] = useState(false)
  async function salvar(d: Parameters<typeof api.multiConfig>[0], ok = 'Salvo') {
    setOcupado(true)
    try { aoMudar(await api.multiConfig(d)); avisar(ok) } catch (e) { avisar('Não salvou', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  const mudouHorario = JSON.stringify(h) !== JSON.stringify({ ...HORARIO_PADRAO, ...(m.horario ?? {}) })
  return (
    <Hud titulo="Regras de atendimento" icone={<CalendarClock size={14} />}>
      <div className="campo" style={{ margin: 0 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={h.ativo} onChange={e => setH({ ...h, ativo: e.target.checked })} style={{ width: 'auto' }} />
          Usar horário de atendimento
        </label>
      </div>
      {h.ativo && <>
        <div className="modos" style={{ margin: '8px 0' }}>
          {DIAS.map((d, i) => {
            const n = i + 1, on = h.dias.includes(n)
            return <button key={d} className={on ? 'ativo' : ''} onClick={() => setH({ ...h, dias: on ? h.dias.filter(x => x !== n) : [...h.dias, n].sort() })}>{d}</button>
          })}
        </div>
        <div className="linha-2">
          <div className="campo"><label>Das</label><input type="time" value={h.inicio} onChange={e => setH({ ...h, inicio: e.target.value })} /></div>
          <div className="campo"><label>Até</label><input type="time" value={h.fim} onChange={e => setH({ ...h, fim: e.target.value })} /></div>
        </div>
        <div className="linha-2">
          <div className="campo"><label>Dentro do horário</label>
            <select value={h.modo_dentro} onChange={e => setH({ ...h, modo_dentro: e.target.value as ModoIA })}>
              {MODOS_HORARIO.map(x => <option key={x} value={x}>{MODO[x].rotulo}</option>)}
            </select></div>
          <div className="campo"><label>Fora do horário</label>
            <select value={h.modo_fora} onChange={e => setH({ ...h, modo_fora: e.target.value as ModoIA })}>
              {MODOS_HORARIO.map(x => <option key={x} value={x}>{MODO[x].rotulo}</option>)}
            </select></div>
        </div>
      </>}
      <div className="etiqueta" style={{ marginBottom: 8 }}>
        {h.ativo ? 'A chave geral desligada continua desligando tudo. Fora dela, vale o modo de dentro ou de fora do horário.'
          : 'Sem horário: vale sempre o modo da chave geral.'}
        {m.modo_agora && m.no_horario != null && <> Agora: <b>{MODO[m.modo_agora]?.rotulo}</b> ({m.no_horario ? 'dentro' : 'fora'} do horário).</>}
      </div>
      {mudouHorario && <button className="botao" disabled={ocupado || (h.ativo && h.dias.length === 0)} onClick={() => salvar({ horario: h })}><Save size={14} /> Salvar horário</button>}

      <div className="campo" style={{ margin: '14px 0 0' }}>
        <label htmlFor="multi-volta">Conversa que uma pessoa assumiu volta para a IA depois de</label>
        <select id="multi-volta" value={m.humano_minutos ?? 30} disabled={ocupado} onChange={e => salvar({ humano_minutos: +e.target.value })}>
          {[10, 30, 60, 120, 240, 480, 1440].map(x => <option key={x} value={x}>{x < 60 ? `${x} min` : `${x / 60} h`} sem a equipe escrever</option>)}
        </select>
      </div>
      <button className="botao secundario" style={{ marginTop: 8 }} disabled={ocupado || !m.com_pessoa}
        onClick={async () => {
          if (!(await confirmar({ titulo: 'Devolver todas para a IA?', botao: 'Devolver', texto: `As <b>${m.com_pessoa}</b> conversas com uma pessoa voltam para a IA agora.` }))) return
          setOcupado(true)
          try { aoMudar(await api.multiDevolverTodas()); avisar('Devolvidas para a IA') }
          catch (e) { avisar('Não devolveu', 'error', erroDe(e)) } finally { setOcupado(false) }
        }}><RotateCcw size={14} /> Devolver todas para a IA ({m.com_pessoa ?? 0})</button>

      <div className="campo" style={{ margin: '14px 0 0' }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={rel.ativo} style={{ width: 'auto' }} disabled={ocupado}
            onChange={e => { const r = { ...rel, ativo: e.target.checked }; setRel(r); salvar({ relatorio: r }) }} />
          Mandar o resumo do dia no meu WhatsApp às
          <select value={rel.hora} style={{ width: 'auto' }} disabled={ocupado || !rel.ativo}
            onChange={e => { const r = { ...rel, hora: +e.target.value }; setRel(r); salvar({ relatorio: r }) }}>
            {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}h</option>)}
          </select>
        </label>
      </div>
      {m.resumo_hoje && (
        <details style={{ marginTop: 6 }}>
          <summary className="etiqueta">Ver o resumo de hoje</summary>
          <div className="item-texto" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{m.resumo_hoje.replace(/\*/g, '')}</div>
        </details>
      )}
      <div className="etiqueta" style={{ marginTop: 6 }}>Só vai se houve conversa no dia. Sai pelo número do Leo (ou outro conectado).</div>
    </Hud>
  )
}

// ------------------------------------------------------------------ perguntas que a IA nao soube responder
export function PerguntasSemResposta({ m, aoMudar }: { m: Multi; aoMudar: (m: Multi) => void }) {
  const lista = m.lacunas ?? []
  return (
    <Hud titulo={`Perguntas sem resposta${lista.length ? ` (${lista.length})` : ''}`} icone={<HelpCircle size={14} />}>
      <div className="etiqueta" style={{ marginBottom: 8 }}>
        A IA passou estas para a equipe porque a base não tinha a informação. Responda uma vez: vira informação da empresa e a IA passa a responder sozinha.
      </div>
      {lista.length === 0 && <div className="vazio">Nenhuma pergunta pendente ✓</div>}
      {lista.map(l => <ItemLacuna key={l.id} l={l} empresas={m.empresas.filter(e => e.ativo)} aoMudar={aoMudar} />)}
    </Hud>
  )
}

function ItemLacuna({ l, empresas, aoMudar }: { l: NonNullable<Multi['lacunas']>[number]; empresas: Multi['empresas']; aoMudar: (m: Multi) => void }) {
  const [resposta, setResposta] = useState('')
  const [empresa, setEmpresa] = useState<number | ''>(l.empresa_id ?? (empresas.length === 1 ? empresas[0].id : ''))
  const [ocupado, setOcupado] = useState(false)
  async function enviar(ignorar = false) {
    setOcupado(true)
    try { aoMudar(await api.multiLacuna({ id: l.id, ignorar, resposta, empresa_id: empresa || undefined })); avisar(ignorar ? 'Ignorada' : 'A IA aprendeu ✓') }
    catch (e) { avisar('Não salvou', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  return (
    <div className="fila-item">
      <div className="etiqueta">{l.empresa || 'Empresa não definida'} · {l.vezes > 1 ? `${l.vezes} vezes · ` : ''}{haQuanto(l.ultima)}</div>
      <div className="fila-pergunta">“{l.pergunta}”</div>
      {!l.empresa_id && empresas.length > 1 && (
        <div className="campo" style={{ margin: '6px 0' }}>
          <select value={empresa} onChange={e => setEmpresa(e.target.value ? +e.target.value : '')} aria-label="Empresa">
            <option value="">De qual empresa?</option>
            {empresas.map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
          </select>
        </div>
      )}
      <div className="campo" style={{ margin: '6px 0' }}>
        <textarea rows={2} value={resposta} onChange={e => setResposta(e.target.value)} placeholder="A resposta certa (vale para as próximas vezes)" aria-label="Resposta" />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="botao" style={{ flex: 1 }} disabled={ocupado || !resposta.trim() || !empresa} onClick={() => enviar()}><Save size={14} /> Ensinar</button>
        <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} onClick={() => enviar(true)} aria-label="Ignorar"><X size={14} /></button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ desempenho por empresa (7 dias)
export function Desempenho({ m }: { m: Multi }) {
  const d = m.desempenho
  if (!d) return null
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
  const tempo = (s: number | null) => (s == null ? '—' : s < 60 ? `${s}s` : `${Math.round(s / 60)} min`)
  return (
    <Hud titulo={`Desempenho (${d.dias} dias)`} icone={<BarChart3 size={14} />}>
      {d.linhas.length === 0 && <div className="vazio">Nenhuma conversa de cliente nesse período.</div>}
      {d.linhas.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tabela-simples" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--texto-3)' }}>
                <th>Empresa</th><th>Conversas</th><th>IA resolveu</th><th>P/ equipe</th><th>Tempo</th><th>Notas</th><th>Sem resposta</th>
              </tr>
            </thead>
            <tbody>
              {d.linhas.map(l => (
                <tr key={l.empresa} style={{ borderTop: '1px solid var(--linha)' }}>
                  <td style={{ padding: '6px 4px' }}>{l.empresa}</td>
                  <td>{l.conversas}</td>
                  <td title={`${l.resolvidas_ia} de ${l.conversas}`}>{pct(l.resolvidas_ia, l.conversas)}</td>
                  <td>{l.encaminhadas}</td>
                  <td>{tempo(l.tempo_medio_s)}</td>
                  <td>{l.positivas || l.negativas ? `👍 ${l.positivas} · 👎 ${l.negativas}` : '—'}</td>
                  <td>{l.sem_resposta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="etiqueta" style={{ marginTop: 6 }}>“IA resolveu” = a IA respondeu e ninguém da equipe precisou entrar. Tempo = média até a resposta da IA.</div>
    </Hud>
  )
}

// ------------------------------------------------------------------ nota numa resposta da IA
export function AvaliarResposta({ id, nota, aoMudar }: { id: number; nota?: 1 | -1 | null; aoMudar: (d: ConversaMultiDetalhe) => void }) {
  const [corrigir, setCorrigir] = useState(false)
  const [texto, setTexto] = useState('')
  const [ocupado, setOcupado] = useState(false)
  async function enviar(n: 1 | -1, correcao = '') {
    setOcupado(true)
    try { aoMudar(await api.multiAvaliar(id, n, correcao)); setCorrigir(false); setTexto(''); avisar(correcao ? 'A IA aprendeu a resposta certa ✓' : 'Obrigado!') }
    catch (e) { avisar('Não salvou', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, marginLeft: 6, verticalAlign: 'middle' }}>
      <button className="botao-mini" disabled={ocupado} aria-label="Boa resposta" title="Boa resposta"
        style={nota === 1 ? { color: 'var(--verde, #3ddc84)' } : undefined} onClick={() => enviar(1)}><ThumbsUp size={11} /></button>
      <button className="botao-mini" disabled={ocupado} aria-label="Resposta ruim" title="Resposta ruim: ensinar a certa"
        style={nota === -1 ? { color: 'var(--vermelho, #ff5c7a)' } : undefined} onClick={() => setCorrigir(c => !c)}><ThumbsDown size={11} /></button>
      {corrigir && (
        <span className="campo" style={{ display: 'flex', gap: 4, flexBasis: '100%', margin: '4px 0 0' }}>
          <input style={{ minWidth: 0, flex: 1 }} value={texto} onChange={e => setTexto(e.target.value)} placeholder="Qual seria a resposta certa? (opcional)" aria-label="Resposta certa" />
          <button className="botao-mini" disabled={ocupado} onClick={() => enviar(-1, texto)}>salvar</button>
        </span>
      )}
    </span>
  )
}
