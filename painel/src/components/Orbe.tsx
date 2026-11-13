import { useEffect, useRef } from 'react'
import { nivel } from '../audio'

export type EstadoOrbe = 'parado' | 'ouvindo' | 'pensando' | 'falando'

const CORES: Record<EstadoOrbe, [string, string, string]> = {
  parado:   ['#36f1ff', '#3b5bff', '#7b5cff'],
  ouvindo:  ['#ff2bd6', '#ff5577', '#7b5cff'],
  pensando: ['#7b5cff', '#36f1ff', '#ff2bd6'],
  falando:  ['#36f1ff', '#7ef8ff', '#3dffa8'],
}
const ROTULO: Record<EstadoOrbe, string> = {
  parado: 'online', ouvindo: 'ouvindo', pensando: 'processando', falando: 'falando',
}

interface Particula { a: number; r: number; v: number; t: number; anel: number }

/** Nucleo de energia: esfera + aneis + particulas. Reage ao volume (microfone ou voz da IA). */
export function Orbe({ estado, tamanho }: { estado: EstadoOrbe; tamanho: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const estadoRef = useRef(estado)
  estadoRef.current = estado

  useEffect(() => {
    const canvas = ref.current!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = tamanho * dpr
    canvas.height = tamanho * dpr
    const g = canvas.getContext('2d')!
    g.scale(dpr, dpr)
    const c = tamanho / 2
    const R = tamanho * 0.2

    const particulas: Particula[] = Array.from({ length: 90 }, (_, i) => ({
      a: Math.random() * Math.PI * 2,
      r: R * (1.45 + Math.random() * 0.9),
      v: (0.002 + Math.random() * 0.006) * (i % 2 ? 1 : -1),
      t: 0.6 + Math.random() * 1.6,
      anel: i % 3,
    }))

    let quadro = 0
    let energia = 0
    let giro = 0
    let ultimo = performance.now()
    const reduzido = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const desenhar = (agora: number) => {
      const dt = Math.min(50, agora - ultimo) / 16.67
      ultimo = agora
      const st = estadoRef.current
      const [c1, c2, c3] = CORES[st]
      const alvo = st === 'pensando' ? 0.35 + 0.15 * Math.sin(agora / 180) : st === 'parado' ? 0.08 + 0.04 * Math.sin(agora / 900) : nivel()
      energia += (alvo - energia) * 0.18 * dt
      const vel = st === 'pensando' ? 3.2 : st === 'parado' ? 0.6 : 1.4
      giro += 0.004 * vel * dt * (reduzido ? 0.2 : 1)

      g.clearRect(0, 0, tamanho, tamanho)
      g.globalCompositeOperation = 'lighter'

      // halo
      const halo = g.createRadialGradient(c, c, R * 0.2, c, c, R * (2.6 + energia * 1.4))
      halo.addColorStop(0, c1 + '55')
      halo.addColorStop(0.4, c2 + '22')
      halo.addColorStop(1, 'transparent')
      g.fillStyle = halo
      g.fillRect(0, 0, tamanho, tamanho)

      // aneis tracejados
      const aneis = [
        { r: R * 1.35, larg: 2, tr: [14, 10], cor: c1, sentido: 1 },
        { r: R * 1.75, larg: 1.2, tr: [3, 9], cor: c3, sentido: -1.4 },
        { r: R * 2.15, larg: 1, tr: [40, 18, 4, 18], cor: c2, sentido: 0.7 },
      ]
      for (const a of aneis) {
        g.save()
        g.translate(c, c)
        g.rotate(giro * a.sentido * 6)
        g.beginPath()
        g.arc(0, 0, a.r * (1 + energia * 0.12), 0, Math.PI * 2)
        g.setLineDash(a.tr)
        g.lineWidth = a.larg
        g.strokeStyle = a.cor + 'aa'
        g.shadowColor = a.cor
        g.shadowBlur = 10
        g.stroke()
        g.restore()
      }

      // ondas de som em volta da esfera
      g.save()
      g.translate(c, c)
      g.beginPath()
      const pontos = 96
      for (let i = 0; i <= pontos; i++) {
        const ang = (i / pontos) * Math.PI * 2
        const ond = Math.sin(ang * 6 + agora / 220) * Math.sin(ang * 3 - agora / 400)
        const rr = R * (1.08 + energia * 0.55 * (0.5 + 0.5 * ond))
        const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr
        i ? g.lineTo(x, y) : g.moveTo(x, y)
      }
      g.closePath()
      g.lineWidth = 1.6
      g.strokeStyle = c1 + 'cc'
      g.shadowColor = c1
      g.shadowBlur = 16
      g.stroke()
      g.restore()

      // esfera
      const esfera = g.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.05, c, c, R * (1 + energia * 0.25))
      esfera.addColorStop(0, '#ffffff')
      esfera.addColorStop(0.18, c1)
      esfera.addColorStop(0.62, c2 + 'cc')
      esfera.addColorStop(1, c3 + '00')
      g.fillStyle = esfera
      g.beginPath()
      g.arc(c, c, R * (1 + energia * 0.25), 0, Math.PI * 2)
      g.fill()

      // particulas
      for (const p of particulas) {
        p.a += p.v * dt * (1 + energia * 4) * (st === 'pensando' ? 2.5 : 1)
        const rr = p.r * (1 + energia * 0.35)
        const x = c + Math.cos(p.a) * rr
        const y = c + Math.sin(p.a) * rr * (0.55 + p.anel * 0.2)
        g.fillStyle = [c1, c2, c3][p.anel] + 'dd'
        g.beginPath()
        g.arc(x, y, p.t * (1 + energia), 0, Math.PI * 2)
        g.fill()
      }
      g.globalCompositeOperation = 'source-over'
      quadro = requestAnimationFrame(desenhar)
    }
    quadro = requestAnimationFrame(desenhar)
    return () => cancelAnimationFrame(quadro)
  }, [tamanho])

  return (
    <div className="orbe-area" style={{ width: tamanho, height: tamanho }}>
      <canvas ref={ref} style={{ width: tamanho, height: tamanho }} aria-hidden="true" />
      <div className={`orbe-estado ${estado}`}>{ROTULO[estado]}</div>
    </div>
  )
}
