// Escritorio 3D: a "estacao" da IA Central. O Leo (o chefe) e o nucleo no centro; cada IA tem a sua ilha,
// com a mesma cor do resto do painel. Linhas de dados ligam o chefe a cada equipe. Clique numa ilha para ver tudo.
import { useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Edges, Grid, Html, OrbitControls, QuadraticBezierLine, RoundedBox, Sparkles, Stars } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { AlertTriangle, ArrowRight, Move3d, Server, X } from 'lucide-react'
import type { AgenteId, Resumo, Saude, SaudeAgente } from '../api'
import { AGENTES, MODO, Pilula, comoResolver, corDe, estadoDe, haQuanto, type Estado } from './ui'
import type { Aba, StatusWa } from './Agentes'

type Alvo = AgenteId | 'sistemas'
const POS: Record<Alvo, [number, number, number]> = {
  leo: [0, 0, 0], joao: [-11, 0, -3], suporte: [11, 0, -3], gabriel: [-6.5, 0, 10.5], sistemas: [6.5, 0, 10.5],
}
const VERMELHO = '#ff3d6e'
const CINZA = '#3a4658'

// ------------------------------------------------------------------ um robo trabalhando
function Robo({ pos, cor, estado, fase, grande = false }: { pos: [number, number, number]; cor: string; estado: Estado; fase: number; grande?: boolean }) {
  const g = useRef<THREE.Group>(null)
  const tela = useRef<THREE.MeshStandardMaterial>(null)
  const parado = estado === 'parada'
  const corTela = estado === 'erro' ? VERMELHO : parado ? CINZA : cor
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + fase
    if (g.current) {
      g.current.position.y = pos[1] + (parado ? 0 : Math.abs(Math.sin(t * 3)) * 0.04)
      g.current.rotation.y = parado ? 0 : Math.sin(t * 0.6) * 0.25
    }
    if (tela.current) tela.current.emissiveIntensity = estado === 'erro' ? 1.2 + Math.sin(t * 8) * 0.8 : parado ? 0.05 : 0.9 + Math.sin(t * 2) * 0.25
  })
  const s = grande ? 1.35 : 1
  return (
    <group position={[pos[0], 0, pos[2]]}>
      {/* mesa */}
      <mesh position={[0, 0.55, -0.45]} castShadow><boxGeometry args={[1.3 * s, 0.07, 0.65]} /><meshStandardMaterial color="#141c2c" metalness={0.6} roughness={0.35} /></mesh>
      <mesh position={[0, 0.27, -0.45]}><boxGeometry args={[0.08, 0.5, 0.08]} /><meshStandardMaterial color="#0c1220" /></mesh>
      {/* monitor */}
      <mesh position={[0, 0.92, -0.68]}><boxGeometry args={[0.95 * s, 0.55, 0.04]} /><meshStandardMaterial ref={tela} color="#05070d" emissive={corTela} emissiveIntensity={0.9} /></mesh>
      {/* robo */}
      <group ref={g} position={[0, pos[1], 0.15]} scale={s}>
        <mesh position={[0, 0.5, 0]}><capsuleGeometry args={[0.22, 0.38, 6, 12]} /><meshStandardMaterial color={parado ? '#2a3240' : '#d9e4f2'} metalness={0.3} roughness={0.4} /></mesh>
        <mesh position={[0, 1.02, 0]}><sphereGeometry args={[0.21, 20, 20]} /><meshStandardMaterial color={parado ? '#2a3240' : '#eef4ff'} metalness={0.2} roughness={0.3} /></mesh>
        <mesh position={[0, 1.04, -0.17]}><boxGeometry args={[0.3, 0.09, 0.06]} /><meshStandardMaterial color="#000" emissive={corTela} emissiveIntensity={1.6} /></mesh>
      </group>
    </group>
  )
}

// ------------------------------------------------------------------ alerta flutuante quando a IA falhou
function Alerta({ y }: { y: number }) {
  const m = useRef<THREE.Mesh>(null)
  const luz = useRef<THREE.PointLight>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (m.current) { m.current.rotation.y = t * 2; m.current.position.y = y + Math.sin(t * 3) * 0.15 }
    if (luz.current) luz.current.intensity = 6 + Math.sin(t * 8) * 5
  })
  return (
    <>
      <mesh ref={m} position={[0, y, 0]}><octahedronGeometry args={[0.45]} /><meshStandardMaterial color={VERMELHO} emissive={VERMELHO} emissiveIntensity={2} /></mesh>
      <pointLight ref={luz} position={[0, 1.5, 0]} color={VERMELHO} distance={9} />
    </>
  )
}

// ------------------------------------------------------------------ ilha de uma IA
function Ilha({ a, s, estado, selecionado, aoClicar }: { a: AgenteId; s: SaudeAgente | undefined; estado: Estado; selecionado: boolean; aoClicar: () => void }) {
  const info = AGENTES[a]
  const cor = info.cor
  const mesas = a === 'gabriel' ? 1 : 3
  const [over, setOver] = useState(false)
  const borda = estado === 'erro' ? VERMELHO : cor
  return (
    <group position={POS[a]}
      onClick={e => { e.stopPropagation(); aoClicar() }}
      onPointerOver={e => { e.stopPropagation(); setOver(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setOver(false); document.body.style.cursor = '' }}>
      <RoundedBox args={[7, 0.45, 5]} radius={0.18} position={[0, 0, 0]} receiveShadow>
        <meshStandardMaterial color="#0b1222" metalness={0.5} roughness={0.5} emissive={cor} emissiveIntensity={selecionado || over ? 0.16 : 0.06} />
        <Edges color={borda} threshold={20} />
      </RoundedBox>
      <mesh position={[0, 0.235, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[6.6, 4.6]} /><meshBasicMaterial color={cor} transparent opacity={selecionado ? 0.12 : 0.05} />
      </mesh>
      {Array.from({ length: mesas }).map((_, i) => (
        <Robo key={i} pos={[(i - (mesas - 1) / 2) * 2.1, 0.23, 0.4]} cor={cor} estado={estado} fase={i * 1.7} grande={a === 'gabriel'} />
      ))}
      {estado === 'erro' && <Alerta y={2.9} />}
      <pointLight position={[0, 2.2, 0]} color={cor} intensity={selecionado ? 9 : 4} distance={8} />
      <Html position={[0, 3.9, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
        <button className={`rotulo-3d ${estado} ${selecionado ? 'sel' : ''}`} style={corDe(a)} onClick={aoClicar}>
          <b>{info.nome}</b>
          <span className="rotulo-papel">{info.papel}</span>
          <span className="rotulo-linha"><Pilula estado={estado} /></span>
          {s && <span className="rotulo-nums"><i>{s.lidas_24h}<small>leu</small></i><i>{s.respostas_24h}<small>resp.</small></i><i>{s.aprendidos}<small>sabe</small></i></span>}
        </button>
      </Html>
    </group>
  )
}

// ------------------------------------------------------------------ o chefe: nucleo do Leo
function NucleoLeo({ estado, selecionado, aoClicar, s }: { estado: Estado; selecionado: boolean; aoClicar: () => void; s: SaudeAgente | undefined }) {
  const orbe = useRef<THREE.Group>(null)
  const anel1 = useRef<THREE.Mesh>(null)
  const anel2 = useRef<THREE.Mesh>(null)
  const cor = estado === 'erro' ? VERMELHO : AGENTES.leo.cor
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (orbe.current) { orbe.current.rotation.y = t * 0.4; orbe.current.position.y = 3 + Math.sin(t * 1.2) * 0.2 }
    if (anel1.current) anel1.current.rotation.set(Math.PI / 2 + Math.sin(t * 0.5) * 0.3, 0, t * 0.6)
    if (anel2.current) anel2.current.rotation.set(Math.PI / 3, t * 0.8, 0)
  })
  return (
    <group onClick={e => { e.stopPropagation(); aoClicar() }}
      onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}>
      {/* plataforma hexagonal em degraus */}
      <mesh position={[0, 0.2, 0]}><cylinderGeometry args={[4.4, 4.7, 0.4, 6]} /><meshStandardMaterial color="#0a1020" metalness={0.6} roughness={0.4} /><Edges color={cor} /></mesh>
      <mesh position={[0, 0.55, 0]}><cylinderGeometry args={[3, 3.3, 0.35, 6]} /><meshStandardMaterial color="#0d1730" metalness={0.6} roughness={0.35} emissive={cor} emissiveIntensity={0.08} /><Edges color={cor} /></mesh>
      <mesh position={[0, 0.75, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.2, 1.35, 64]} /><meshBasicMaterial color={cor} transparent opacity={0.8} /></mesh>
      {/* orbe = o Leo */}
      <group ref={orbe} position={[0, 3, 0]}>
        <mesh><sphereGeometry args={[0.85, 48, 48]} /><meshStandardMaterial color={cor} emissive={cor} emissiveIntensity={1.4} transparent opacity={0.85} /></mesh>
        <mesh><icosahedronGeometry args={[1.25, 1]} /><meshBasicMaterial color={cor} wireframe transparent opacity={0.45} /></mesh>
        <mesh ref={anel1}><torusGeometry args={[1.7, 0.03, 8, 96]} /><meshBasicMaterial color={cor} /></mesh>
        <mesh ref={anel2}><torusGeometry args={[2.05, 0.02, 8, 96]} /><meshBasicMaterial color="#7b5cff" /></mesh>
      </group>
      {/* feixe de luz do chao ao orbe */}
      <mesh position={[0, 1.8, 0]}><cylinderGeometry args={[0.08, 0.6, 2, 24, 1, true]} /><meshBasicMaterial color={cor} transparent opacity={0.18} side={THREE.DoubleSide} /></mesh>
      <pointLight position={[0, 3, 0]} color={cor} intensity={selecionado ? 30 : 18} distance={16} />
      <Sparkles count={40} scale={[5, 3, 5]} position={[0, 3, 0]} size={2} speed={0.4} color={cor} />
      {estado === 'erro' && <Alerta y={5.2} />}
      <Html position={[0, 6.8, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
        <button className={`rotulo-3d chefe ${estado} ${selecionado ? 'sel' : ''}`} style={corDe('leo')} onClick={aoClicar}>
          <span className="rotulo-papel">O CHEFE</span>
          <b>Leo 2.0</b>
          <span className="rotulo-linha"><Pilula estado={estado} /></span>
          {s && <span className="rotulo-nums"><i>{s.lidas_24h}<small>leu</small></i><i>{s.respostas_24h}<small>resp.</small></i><i>{s.aprendidos}<small>sabe</small></i></span>}
        </button>
      </Html>
    </group>
  )
}

// ------------------------------------------------------------------ servidores (sistemas monitorados)
function Servidores({ r, selecionado, aoClicar }: { r: Resumo | null; selecionado: boolean; aoClicar: () => void }) {
  const sist = (r?.sistemas || []).filter(x => x.ativo).slice(0, 8)
  const fora = sist.filter(x => x.estado === 'falha').length
  const cor = fora ? VERMELHO : '#9b8cff'
  const racks = Math.max(3, sist.length)
  return (
    <group position={POS.sistemas} onClick={e => { e.stopPropagation(); aoClicar() }}
      onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}>
      <RoundedBox args={[8, 0.45, 4]} radius={0.18}>
        <meshStandardMaterial color="#0b1222" metalness={0.5} roughness={0.5} emissive={cor} emissiveIntensity={selecionado ? 0.15 : 0.05} />
        <Edges color={cor} threshold={20} />
      </RoundedBox>
      {Array.from({ length: racks }).map((_, i) => {
        const x = sist[i]
        const led = !x ? CINZA : x.estado === 'falha' ? VERMELHO : x.estado === 'ok' ? '#3dffa8' : '#ffd23d'
        const px = (i - (racks - 1) / 2) * (7 / racks)
        return (
          <group key={i} position={[px, 1.25, 0]}>
            <mesh><boxGeometry args={[0.6, 2, 0.9]} /><meshStandardMaterial color="#10182a" metalness={0.7} roughness={0.3} /></mesh>
            {[0.6, 0.2, -0.2, -0.6].map(y => (
              <mesh key={y} position={[0, y, 0.46]}><boxGeometry args={[0.42, 0.06, 0.02]} /><meshStandardMaterial color={led} emissive={led} emissiveIntensity={1.8} /></mesh>
            ))}
          </group>
        )
      })}
      <pointLight position={[0, 2.5, 1.5]} color={cor} intensity={5} distance={8} />
      <Html position={[0, 3.8, 0]} center distanceFactor={14} zIndexRange={[20, 0]}>
        <button className={`rotulo-3d ${fora ? 'erro' : 'ok'} ${selecionado ? 'sel' : ''}`} style={{ ['--ciano' as string]: '#9b8cff' }} onClick={aoClicar}>
          <b>Sistemas</b>
          <span className="rotulo-papel">{sist.length ? `${sist.length - fora} de ${sist.length} no ar` : 'nenhum monitorado'}</span>
        </button>
      </Html>
    </group>
  )
}

// ------------------------------------------------------------------ linha de dados chefe -> equipe, com pacotes viajando
function Ligacao({ ate, cor, ativo, erro }: { ate: [number, number, number]; cor: string; ativo: boolean; erro: boolean }) {
  const linha = useRef<{ material: { dashOffset: number } } | null>(null)
  const pacotes = useRef<THREE.Group>(null)
  const inicio = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const fim = useMemo(() => new THREE.Vector3(ate[0] * 0.78, 0.9, ate[2] * 0.78), [ate])
  const meio = useMemo(() => new THREE.Vector3(ate[0] * 0.4, 3.2, ate[2] * 0.4), [ate])
  const curva = useMemo(() => new THREE.QuadraticBezierCurve3(inicio, meio, fim), [inicio, meio, fim])
  const c = erro ? VERMELHO : cor
  useFrame(({ clock }, d) => {
    if (linha.current) linha.current.material.dashOffset -= d * (ativo ? 1.2 : 0.3)
    pacotes.current?.children.forEach((p, i) => {
      const t = (clock.elapsedTime * (ativo ? 0.35 : 0.12) + i / 3) % 1
      p.position.copy(curva.getPoint(t))
    })
  })
  return (
    <>
      <QuadraticBezierLine ref={linha as never} start={inicio} end={fim} mid={meio} color={c} lineWidth={1.6} dashed dashScale={6} dashSize={0.6} gapSize={0.4} transparent opacity={0.8} />
      <group ref={pacotes}>
        {[0, 1, 2].map(i => <mesh key={i}><sphereGeometry args={[0.09, 10, 10]} /><meshBasicMaterial color={c} /></mesh>)}
      </group>
    </>
  )
}

// ------------------------------------------------------------------ camera: voa ate o que foi clicado
function Camera({ alvo, controles }: { alvo: Alvo | null; controles: React.RefObject<OrbitControlsImpl> }) {
  const { camera, size } = useThree()
  const indo = useRef(0)
  const ultimo = useRef<Alvo | null | undefined>(undefined)   // undefined: posiciona logo ao abrir
  useFrame((_, d) => {
    const c = controles.current
    if (!c) return
    if (alvo !== ultimo.current) { ultimo.current = alvo; indo.current = 1.6 }
    if (indo.current <= 0) return
    indo.current -= d
    const p = alvo ? POS[alvo] : [0, 0, 0]
    const foco = new THREE.Vector3(p[0], alvo === 'leo' ? 2 : 1, alvo ? p[2] : 2)
    const dir = alvo && alvo !== 'leo' ? new THREE.Vector3(p[0], 0, p[2]).normalize() : new THREE.Vector3(0, 0, 1)
    const dist = alvo ? (alvo === 'leo' ? 15 : 13) : 30
    const destino = alvo ? foco.clone().add(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, alvo === 'leo' ? 7 : 8.5, 0))
      : new THREE.Vector3(0, 19, 26).multiplyScalar(size.width < size.height ? 1.6 : size.width < 900 ? 1.3 : 1)
    const k = 1 - Math.pow(0.02, d)
    c.target.lerp(foco, k)
    camera.position.lerp(destino, k)
    c.update()
  })
  return null
}

// ------------------------------------------------------------------ tela
export default function Escritorio3D({ saude, wa, r, abrir }: { saude: Saude | null; wa: StatusWa; r: Resumo | null; abrir: (a: AgenteId, aba?: Aba) => void }) {
  const [sel, setSel] = useState<Alvo | null>(null)
  const controles = useRef<OrbitControlsImpl>(null)
  const dado = (a: AgenteId) => saude?.agentes.find(x => x.agente === a)
  const est = (a: AgenteId) => estadoDe(dado(a), wa[AGENTES[a].instancia])
  const fora = (r?.sistemas || []).filter(x => x.ativo && x.estado === 'falha')
  const longe = window.innerWidth < 760 ? 1.6 : window.innerWidth < 1100 ? 1.3 : 1   // celular: camera mais longe para caber tudo

  return (
    <div className="escritorio">
      <Canvas camera={{ position: [0, 19 * longe, 26 * longe], fov: 45 }} dpr={[1, 2]} onPointerMissed={() => setSel(null)} gl={{ antialias: true }}>
        <color attach="background" args={['#03050b']} />
        <fog attach="fog" args={["#03050b", 40, 110]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[10, 20, 10]} intensity={0.6} />
        <Stars radius={90} depth={40} count={1800} factor={3} fade speed={0.6} />
        <Grid position={[0, -0.25, 0]} infiniteGrid cellSize={1} sectionSize={5} cellColor="#0e3341" sectionColor="#1b6f86" fadeDistance={55} fadeStrength={1.6} />

        <NucleoLeo estado={est('leo')} s={dado('leo')} selecionado={sel === 'leo'} aoClicar={() => setSel('leo')} />
        {(['joao', 'suporte', 'gabriel'] as const).map(a => {
          const s = dado(a), e = est(a)
          return (
            <group key={a}>
              <Ligacao ate={POS[a]} cor={AGENTES[a].cor} ativo={(s?.respostas_24h || 0) + (s?.lidas_24h || 0) > 0} erro={e === 'erro'} />
              <Ilha a={a} s={s} estado={e} selecionado={sel === a} aoClicar={() => setSel(a)} />
            </group>
          )
        })}
        <Ligacao ate={POS.sistemas} cor="#9b8cff" ativo erro={fora.length > 0} />
        <Servidores r={r} selecionado={sel === 'sistemas'} aoClicar={() => setSel('sistemas')} />

        <OrbitControls ref={controles} makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={1.32} minDistance={7} maxDistance={75}
          autoRotate={!sel} autoRotateSpeed={0.35} />
        <Camera alvo={sel} controles={controles} />
      </Canvas>

      <div className="escritorio-dica"><Move3d size={14} /> arraste para girar · role para aproximar · clique numa equipe</div>

      {sel && sel !== 'sistemas' && <Detalhe a={sel} s={dado(sel)} estado={est(sel)} wa={wa[AGENTES[sel].instancia]} abrir={abrir} fechar={() => setSel(null)} />}
      {sel === 'sistemas' && (
        <div className="detalhe-3d" style={{ ['--ciano' as string]: '#9b8cff' }}>
          <button className="detalhe-fechar" onClick={() => setSel(null)} aria-label="Fechar"><X size={16} /></button>
          <div className="detalhe-topo"><span className="avatar-ia" style={{ width: 40, height: 40 }}><Server size={19} /></span><div><b>Sistemas</b><span>Sites e serviços monitorados</span></div></div>
          {(r?.sistemas || []).filter(x => x.ativo).map(x => (
            <div className="cartao-linha" key={x.nome}><span>{x.nome}</span><b className={x.estado === 'falha' ? 'vermelho' : x.estado === 'ok' ? 'verde' : ''}>{x.estado === 'falha' ? 'FORA' : x.estado === 'ok' ? 'no ar' : '?'}</b></div>
          ))}
          {!(r?.sistemas || []).length && <div className="vazio">Nenhum sistema monitorado.</div>}
        </div>
      )}
    </div>
  )
}

function Detalhe({ a, s, estado, wa, abrir, fechar }: { a: AgenteId; s: SaudeAgente | undefined; estado: Estado; wa: string | undefined; abrir: (a: AgenteId, aba?: Aba) => void; fechar: () => void }) {
  const info = AGENTES[a]
  const I = info.icone
  return (
    <div className="detalhe-3d" style={corDe(a)}>
      <button className="detalhe-fechar" onClick={fechar} aria-label="Fechar"><X size={16} /></button>
      <div className="detalhe-topo">
        <span className="avatar-ia" style={{ width: 44, height: 44 }}><I size={21} /></span>
        <div><b>{info.nome}</b><span>{info.papel}</span></div>
      </div>
      <Pilula estado={estado} />
      <p className="detalhe-resumo">{info.resumo}</p>
      <div className="cartao-linha"><span>Modo</span><b>{s ? MODO[s.modo]?.rotulo || s.modo : '…'}</b></div>
      <div className="cartao-linha"><span>WhatsApp</span><b className={wa === 'open' ? 'verde' : 'vermelho'}>{wa === 'open' ? 'conectado' : wa ? 'desconectado' : '…'}</b></div>
      <div className="cartao-linha"><span>Última atividade</span><b>{haQuanto(s?.ultima_atividade)}</b></div>
      {s && (
        <div className="cartao-numeros" style={{ margin: '8px 0' }}>
          <div><b>{s.lidas_24h}</b><span>leu 24h</span></div>
          <div><b>{s.respostas_24h}</b><span>respondeu</span></div>
          <div><b>{s.aprendidos}</b><span>sabe</span></div>
          <div><b>{s.aprendeu_24h || 0}</b><span>novos 24h</span></div>
        </div>
      )}
      {estado === 'erro' && s?.ultimo_erro && (
        <div className="alerta-erro" style={{ padding: 10, marginBottom: 8 }}>
          <AlertTriangle size={16} />
          <div><b>{s.ultimo_erro.titulo}</b><span>{comoResolver(s.ultimo_erro.titulo)}</span></div>
        </div>
      )}
      <button className="botao" onClick={() => abrir(a, estado === 'erro' ? 'erros' : 'visao')}>Abrir {info.nome} <ArrowRight size={14} /></button>
      {s && s.pendentes > 0 && (
        <button className="botao secundario" style={{ marginTop: 8 }} onClick={() => abrir(a, 'aprovar')}>
          {`${s.pendentes} para aprovar`}
        </button>
      )}
    </div>
  )
}
