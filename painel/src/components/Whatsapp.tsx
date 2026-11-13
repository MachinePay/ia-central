import { useCallback, useEffect, useState } from 'react'
import { MessageCircle, QrCode, Smartphone, Unplug, RefreshCw } from 'lucide-react'
import { api, type WhatsappStatus } from '../api'

const ROTULO: Record<WhatsappStatus['estado'], string> = {
  open: 'Conectado', close: 'Desconectado', connecting: 'Aguardando leitura do QR',
  inexistente: 'Nunca conectado', erro: 'Evolution API fora do ar',
}

/** Admin: conecta o numero da IA no WhatsApp (QR code ou codigo de pareamento). */
export function PainelWhatsapp() {
  const [st, setSt] = useState<WhatsappStatus | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState('')
  const [numero, setNumero] = useState('')

  const chamar = useCallback(async (op: 'status' | 'conectar' | 'desconectar' | 'modo', extra: { numero?: string; modo?: 'pessoal' | 'dedicado' } = {}) => {
    setCarregando(true)
    setErro('')
    try { setSt(await api.whatsapp(op, extra)) }
    catch (e) { setErro(e instanceof Error ? e.message : 'Falhou') }
    finally { setCarregando(false) }
  }, [])

  useEffect(() => { void chamar('status') }, [chamar])
  // enquanto espera a leitura do QR, confere a cada 4s se conectou
  useEffect(() => {
    if (!st || st.estado === 'open' || !(st.qr || st.codigo)) return
    const t = setInterval(async () => {
      try {
        const s = await api.whatsapp('status')
        setSt(atual => (s.estado === 'open' ? s : atual ? { ...atual, estado: s.estado } : s))
      } catch { /* tenta de novo */ }
    }, 4000)
    return () => clearInterval(t)
  }, [st])

  const conectado = st?.estado === 'open'
  return (
    <section className="hud">
      <div className="hud-titulo">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><MessageCircle size={14} />WhatsApp</span>
        <button className="botao-icone" style={{ width: 24, height: 24 }} onClick={() => chamar('status')} aria-label="Atualizar status"><RefreshCw size={13} /></button>
      </div>
      <div className="hud-corpo">
        {erro && <div className="aviso erro">{erro}</div>}
        <div className="sistema" style={{ borderBottom: 0 }}>
          <span className={`luz ${conectado ? 'ok' : st?.estado === 'erro' ? 'falha' : 'desconhecido'}`} />
          <div>
            <div className="sistema-nome">{st ? ROTULO[st.estado] : 'Verificando…'}</div>
            {conectado && <div className="sistema-info">+{st?.numero}{st?.perfil ? ` · ${st.perfil}` : ''}</div>}
          </div>
        </div>

        {st?.config && (
          <div className="chave">
            <div className="chave-texto">
              <b>{st.config.modo === 'pessoal' ? 'Modo pessoal (meu número)' : 'Modo dedicado (chip da IA)'}</b>
              <span>{st.config.modo === 'pessoal'
                ? `A IA responde só na sua conversa "Você" e a usuários que comecem com ${st.config.gatilho}. Amigos e família não são lidos nem guardados.`
                : 'Todo usuário cadastrado conversa direto com a própria IA. Números desconhecidos ficam registrados.'}</span>
            </div>
            <button role="switch" aria-checked={st.config.modo === 'dedicado'} aria-label="Modo dedicado"
              className={`interruptor ${st.config.modo === 'dedicado' ? 'ligado' : ''}`} disabled={carregando}
              onClick={() => chamar('modo', { modo: st.config!.modo === 'pessoal' ? 'dedicado' : 'pessoal' })} />
          </div>
        )}

        {!conectado && st?.qr && (
          <div className="qr-caixa">
            <img src={st.qr} alt="QR code para conectar o WhatsApp" />
            <span className="etiqueta">WhatsApp → Aparelhos conectados → Conectar aparelho</span>
          </div>
        )}
        {!conectado && st?.codigo && (
          <div className="qr-caixa">
            <div className="codigo-pareamento">{st.codigo}</div>
            <span className="etiqueta">WhatsApp → Aparelhos conectados → Conectar com número de telefone</span>
          </div>
        )}

        {!conectado && (
          <>
            <button className="botao" disabled={carregando} onClick={() => chamar('conectar')}>
              <QrCode size={14} /> {carregando ? 'Gerando…' : st?.qr ? 'Novo QR code' : 'Conectar com QR code'}
            </button>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <div className="campo" style={{ flex: 1, margin: 0 }}>
                <input aria-label="Número do WhatsApp da IA" placeholder="ou pelo número: 55 11 9…" inputMode="tel" value={numero} onChange={e => setNumero(e.target.value)} />
              </div>
              <button className="botao secundario" style={{ width: 'auto' }} disabled={carregando || numero.replace(/\D/g, '').length < 10}
                onClick={() => chamar('conectar', { numero })} title="Gera um código para digitar no celular (útil se o painel está no próprio celular)">
                <Smartphone size={14} />
              </button>
            </div>
          </>
        )}
        {conectado && (
          <button className="botao secundario" disabled={carregando} onClick={() => { if (confirm('Desconectar o WhatsApp da IA?')) void chamar('desconectar') }}>
            <Unplug size={14} /> Desconectar
          </button>
        )}

        {st && st.desconhecidos.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="etiqueta" style={{ marginBottom: 4 }}>NÚMEROS NÃO CADASTRADOS (IGNORADOS)</div>
            {st.desconhecidos.map((d, i) => (
              <div className="item" key={i}>
                <div><div className="item-titulo">+{d.contato}</div><div className="item-texto">{d.mensagem}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
