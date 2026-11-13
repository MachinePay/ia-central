import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Mic, Square, Volume2, VolumeX, Speaker } from 'lucide-react'
import { api, ErroApi, type Mensagem } from '../api'
import { gravar, tocar, pararFala, falarNavegador, contexto, type Gravacao } from '../audio'
import type { EstadoOrbe } from './Orbe'

interface Msg extends Mensagem { via?: 'voz'; erro?: boolean }

const SUGESTOES = [
  'Como estão meus sistemas?',
  'O que você lembra sobre mim?',
  'Me lembra amanhã às 9h de revisar as metas',
  'Junta as ideias do time sobre um tema',
]

/** Negrito (**x**) e quebras de linha; o resto fica como texto puro (sem HTML vindo da IA). */
function formatar(texto: string): ReactNode[] {
  return texto.split(/(\*\*[^*]+\*\*)/g).map((parte, i) =>
    parte.startsWith('**') && parte.endsWith('**') ? <strong key={i}>{parte.slice(2, -2)}</strong> : <span key={i}>{parte}</span>,
  )
}

export function Conversa({ sessao, estado, setEstado, aoSair, aoMudar }: {
  sessao: string
  estado: EstadoOrbe
  setEstado: (e: EstadoOrbe) => void
  aoSair: () => void
  aoMudar: () => void
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [texto, setTexto] = useState('')
  const [vozLigada, setVozLigada] = useState(() => { try { return localStorage.getItem('nucleo.voz') !== 'nao' } catch { return true } })
  const [gravando, setGravando] = useState(false)
  const gravacao = useRef<Gravacao | null>(null)
  const inicioToque = useRef(0)
  const fim = useRef<HTMLDivElement>(null)
  const ocupado = estado === 'pensando'

  useEffect(() => {
    api.historico(sessao).then(r => setMsgs(r.mensagens)).catch(tratarErro)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao])
  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, estado])
  useEffect(() => { try { localStorage.setItem('nucleo.voz', vozLigada ? 'sim' : 'nao') } catch { /* ok */ } }, [vozLigada])

  function tratarErro(e: unknown) {
    if (e instanceof ErroApi && e.status === 401) return aoSair()
    setMsgs(m => [...m, { papel: 'ia', texto: e instanceof Error ? e.message : 'Algo deu errado', erro: true }])
  }

  async function falar(t: string) {
    setEstado('falando')
    try {
      await tocar(await api.falar(t))
    } catch {
      await falarNavegador(t)   // sem voz da OpenAI: usa a voz do proprio aparelho
    } finally {
      setEstado('parado')
    }
  }

  async function responder(resposta: string) {
    setMsgs(m => [...m, { papel: 'ia', texto: resposta }])
    aoMudar()
    if (vozLigada) await falar(resposta)
    else setEstado('parado')
  }

  async function enviar(t: string) {
    const msg = t.trim()
    if (!msg || ocupado) return
    contexto() // desbloqueia o audio no toque (iPhone)
    pararFala()
    setTexto('')
    setMsgs(m => [...m, { papel: 'eu', texto: msg }])
    setEstado('pensando')
    try {
      const r = await api.chat(msg, sessao)
      await responder(r.resposta)
    } catch (e) {
      setEstado('parado')
      tratarErro(e)
    }
  }

  async function comecarGravacao() {
    contexto()
    pararFala()
    try {
      gravacao.current = await gravar()
      setGravando(true)
      setEstado('ouvindo')
    } catch (e) {
      setEstado('parado')
      tratarErro(e instanceof DOMException ? new Error('Permita o uso do microfone para falar com a IA.') : e)
    }
  }

  async function terminarGravacao() {
    const g = gravacao.current
    if (!g) return
    gravacao.current = null
    setGravando(false)
    setEstado('pensando')
    const blob = await g.parar()
    if (blob.size < 1500) { setEstado('parado'); return }   // toque acidental
    try {
      const r = await api.audio(blob, sessao)
      if (r.transcricao) setMsgs(m => [...m, { papel: 'eu', texto: r.transcricao, via: 'voz' }])
      if (r.resposta) await responder(r.resposta)
      else { setEstado('parado'); tratarErro(new Error(r.erro || 'Nao entendi o audio')) }
    } catch (e) {
      setEstado('parado')
      tratarErro(e)
    }
  }

  // toque rapido = liga (e o proximo toque envia) | segurar = grava enquanto segura (walkie-talkie)
  function apertou() {
    if (gravacao.current) { inicioToque.current = 0; void terminarGravacao(); return }
    if (ocupado) return
    inicioToque.current = Date.now()
    void comecarGravacao()
  }
  function soltou() {
    if (inicioToque.current && Date.now() - inicioToque.current > 450) void terminarGravacao()
    inicioToque.current = 0
  }

  return (
    <div className="conversa">
      <div className="mensagens">
        {msgs.length === 0 && !ocupado && (
          <div className="sugestoes">
            {SUGESTOES.map(s => <button key={s} onClick={() => enviar(s)}>{s}</button>)}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.papel} ${m.erro ? 'erro' : ''}`}>
            {m.via === 'voz' && <span className="via">◉ VOZ</span>}
            {formatar(m.texto)}
            {m.papel === 'ia' && !m.erro && (
              <div className="msg-acoes">
                <button onClick={() => { contexto(); void falar(m.texto) }} aria-label="Ouvir resposta"><Speaker size={12} /> ouvir</button>
              </div>
            )}
          </div>
        ))}
        {ocupado && <div className="msg ia"><span className="digitando"><i /><i /><i /></span></div>}
        <div ref={fim} />
      </div>

      <div className="hud compositor">
        <button
          className={`botao-mic ${gravando ? 'gravando' : ''}`}
          onPointerDown={apertou}
          onPointerUp={soltou}
          onPointerCancel={soltou}
          onContextMenu={e => e.preventDefault()}
          disabled={ocupado && !gravando}
          aria-label={gravando ? 'Parar e enviar' : 'Falar com a IA'}
        >
          {gravando ? <Square size={22} fill="currentColor" /> : <Mic size={26} />}
        </button>
        <textarea
          rows={1}
          placeholder={gravando ? 'Ouvindo… toque de novo para enviar' : 'Fale ou digite…'}
          value={texto}
          onChange={e => setTexto(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void enviar(texto) } }}
          disabled={gravando}
        />
        <button className={`botao-voz-resp ${vozLigada ? 'ligado' : ''}`} onClick={() => { setVozLigada(v => !v); pararFala() }}
          aria-label={vozLigada ? 'Desligar resposta falada' : 'Ligar resposta falada'} title="Resposta falada">
          {vozLigada ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
        <button className="botao-enviar" onClick={() => enviar(texto)} disabled={!texto.trim() || ocupado} aria-label="Enviar">
          <ArrowUp size={20} />
        </button>
      </div>
    </div>
  )
}
