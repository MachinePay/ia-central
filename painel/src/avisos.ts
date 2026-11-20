// Avisos deste aparelho: quando aumenta o numero de conversas/respostas esperando voce, mostra uma notificacao
// do sistema (com o painel aberto, mesmo em outra aba ou minimizado) e poe o numero no titulo da aba.
import { useEffect, useRef, useState } from 'react'

const CHAVE = 'nucleo.avisos'
const TITULO = document.title

const suportado = () => typeof window !== 'undefined' && 'Notification' in window
const lerPref = () => { try { return localStorage.getItem(CHAVE) === '1' } catch { return false } }
const gravarPref = (v: boolean) => { try { localStorage.setItem(CHAVE, v ? '1' : '0') } catch { /* modo privado */ } }

let registro: Promise<ServiceWorkerRegistration | null> | null = null
function swRegistro() {
  if (!registro) {
    registro = 'serviceWorker' in navigator
      ? navigator.serviceWorker.register('/sw.js').then(r => r, () => null)
      : Promise.resolve(null)
  }
  return registro
}

async function notificar(titulo: string, corpo: string) {
  const r = await swRegistro()
  const opcoes: NotificationOptions = { body: corpo, icon: '/icone.svg', badge: '/icone.svg', tag: 'nucleo-atendimento' }
  try {
    if (r) await r.showNotification(titulo, opcoes)
    else new Notification(titulo, opcoes)
  } catch { /* navegador recusou */ }
}

export function useAvisos(esperando: number | undefined) {
  const [ligado, setLigado] = useState(() => suportado() && lerPref() && Notification.permission === 'granted')
  const anterior = useRef<number | undefined>(undefined)

  // numero no titulo da aba
  useEffect(() => { document.title = esperando ? `(${esperando}) ${TITULO}` : TITULO }, [esperando])

  useEffect(() => {
    const antes = anterior.current
    anterior.current = esperando
    if (!ligado || esperando == null || antes == null || esperando <= antes) return
    const novos = esperando - antes
    void notificar('Atendimento precisa de você',
      `${novos === 1 ? 'Uma conversa nova está' : `${novos} conversas novas estão`} esperando uma pessoa ou sua aprovação (${esperando} no total).`)
  }, [esperando, ligado])

  async function alternar() {
    if (!suportado()) return { ok: false, motivo: 'Este navegador não mostra notificações.' }
    if (ligado) { setLigado(false); gravarPref(false); return { ok: true } }
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    if (p !== 'granted') return { ok: false, motivo: 'Permissão negada. Libere as notificações do site nas configurações do navegador.' }
    await swRegistro()
    setLigado(true); gravarPref(true)
    void notificar('Avisos ligados', 'Você será avisado aqui quando uma conversa precisar de você.')
    return { ok: true }
  }

  return { ligado, alternar, suportado: suportado() }
}
