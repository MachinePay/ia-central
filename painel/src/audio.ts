// Audio do painel: um unico AudioContext (desbloqueado no primeiro toque, exigencia do iPhone),
// gravacao do microfone e reproducao da voz da IA. Os dois passam por um "analisador" que
// diz o volume atual para o orbe pulsar junto.

let ctx: AudioContext | null = null
let analisador: AnalyserNode | null = null
const amostras = new Uint8Array(256)

export function contexto(): AudioContext {
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new C()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function ligarAnalisador(origem: AudioNode) {
  const c = contexto()
  analisador = c.createAnalyser()
  analisador.fftSize = 512
  analisador.smoothingTimeConstant = 0.7
  origem.connect(analisador)
}

/** Volume atual 0..1 (microfone gravando ou IA falando). */
export function nivel(): number {
  if (!analisador) return 0
  analisador.getByteTimeDomainData(amostras)
  let soma = 0
  for (const v of amostras) { const x = (v - 128) / 128; soma += x * x }
  return Math.min(1, Math.sqrt(soma / amostras.length) * 3.2)
}

// ---------------------------------------------------------------- gravacao
function tipoSuportado(): string {
  const tipos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return tipos.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? ''
}

export interface Gravacao { parar: () => Promise<Blob>; cancelar: () => void }

export async function gravar(): Promise<Gravacao> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microfone indisponivel. No celular, abra o painel por HTTPS.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const fonte = contexto().createMediaStreamSource(stream)
  ligarAnalisador(fonte)
  const tipo = tipoSuportado()
  const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined)
  const pedacos: BlobPart[] = []
  rec.ondataavailable = e => { if (e.data.size) pedacos.push(e.data) }
  rec.start(250)

  const encerrar = () => {
    stream.getTracks().forEach(t => t.stop())
    fonte.disconnect()
    analisador = null
  }
  return {
    parar: () => new Promise<Blob>(resolve => {
      rec.onstop = () => { encerrar(); resolve(new Blob(pedacos, { type: (rec.mimeType || tipo || 'audio/webm').split(';')[0] })) }
      rec.stop()
    }),
    cancelar: () => { rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); encerrar() },
  }
}

// ---------------------------------------------------------------- fala
let tocando: AudioBufferSourceNode | null = null

export async function tocar(mp3: ArrayBuffer): Promise<void> {
  pararFala()
  const c = contexto()
  const buffer = await c.decodeAudioData(mp3.slice(0))
  const fonte = c.createBufferSource()
  fonte.buffer = buffer
  ligarAnalisador(fonte)
  analisador!.connect(c.destination)
  tocando = fonte
  await new Promise<void>(resolve => {
    fonte.onended = () => { if (tocando === fonte) { tocando = null; analisador = null } resolve() }
    fonte.start()
  })
}

export function pararFala() {
  if (tocando) { try { tocando.stop() } catch { /* ja parou */ } tocando = null; analisador = null }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

/** Voz do proprio navegador: usada se a voz da OpenAI falhar. */
export function falarNavegador(texto: string): Promise<void> {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve()
    const u = new SpeechSynthesisUtterance(texto)
    u.lang = 'pt-BR'
    u.rate = 1.05
    const voz = window.speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith('pt'))
    if (voz) u.voice = voz
    u.onend = () => resolve()
    u.onerror = () => resolve()
    window.speechSynthesis.speak(u)
  })
}
