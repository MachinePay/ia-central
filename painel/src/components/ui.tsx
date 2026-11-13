import type { CSSProperties, ReactNode } from 'react'
import { Brain, Headset, LifeBuoy, UserRound, type LucideIcon } from 'lucide-react'
import type { AgenteId, SaudeAgente, WhatsappStatus } from '../api'

// ------------------------------------------------------------------ identidade fixa de cada IA
// Cada IA tem SEMPRE a mesma cor e o mesmo icone em todo o painel: nao tem como confundir qual voce esta mexendo.
export interface InfoAgente {
  id: AgenteId; nome: string; papel: string; cor: string; icone: LucideIcon
  numero: string; instancia: 'nucleo' | 'joao' | 'suporte'; resumo: string
}
export const AGENTES: Record<AgenteId, InfoAgente> = {
  leo: {
    id: 'leo', nome: 'Leo 2.0', papel: 'IA master · sua IA pessoal', cor: '#36f1ff', icone: Brain,
    numero: 'Seu número (conversa “Você”)', instancia: 'nucleo',
    resumo: 'Fala com você, lê suas conversas para aprender seu jeito e supervisiona as outras IAs.',
  },
  joao: {
    id: 'joao', nome: 'João', papel: 'Vendedor', cor: '#3dffa8', icone: Headset,
    numero: 'Chip do João', instancia: 'joao',
    resumo: 'Atende clientes de vendas no chip dele e aprende com quem responde por esse número.',
  },
  suporte: {
    id: 'suporte', nome: 'Suporte24hrs', papel: 'Suporte técnico', cor: '#ffa43d', icone: LifeBuoy,
    numero: 'Chip do suporte', instancia: 'suporte',
    resumo: 'Resolve problemas e responde “o sistema caiu?”. Aprende com as respostas do suporte.',
  },
  gabriel: {
    id: 'gabriel', nome: 'Gabriel', papel: 'Seu clone', cor: '#ff2bd6', icone: UserRound,
    numero: 'Seu número (só contatos liberados)', instancia: 'nucleo',
    resumo: 'Responde como você, só para os contatos que você liberar. Aprende seu jeito com o Leo.',
  },
}
export const ORDEM: AgenteId[] = ['leo', 'joao', 'suporte', 'gabriel']

// variaveis CSS que pintam tudo dentro com a cor da IA
export function corDe(a: AgenteId | null): CSSProperties | undefined {
  if (!a) return undefined
  const c = AGENTES[a].cor
  return {
    '--ciano': c,
    '--linha': `color-mix(in srgb, ${c} 20%, transparent)`,
    '--linha-forte': `color-mix(in srgb, ${c} 50%, transparent)`,
    '--brilho': `0 0 18px color-mix(in srgb, ${c} 38%, transparent)`,
  } as CSSProperties
}

export const MODO: Record<string, { rotulo: string; texto: string }> = {
  ativo: { rotulo: 'Sempre ativo', texto: 'Conversa com você e lê as conversas permitidas para aprender.' },
  desligado: { rotulo: 'Desligada', texto: 'Não lê nem responde ninguém.' },
  observando: { rotulo: 'Só observando', texto: 'Lê as conversas e aprende. Não responde ninguém.' },
  aprovacao: { rotulo: 'Com aprovação', texto: 'Escreve a resposta, mas só envia depois que você aprova.' },
  automatico: { rotulo: 'Automática', texto: 'Responde sozinha.' },
}

// ------------------------------------------------------------------ saude: um estado so, claro
export type Estado = 'ok' | 'erro' | 'whatsapp' | 'parada' | 'carregando'
export function estadoDe(s: SaudeAgente | undefined, wa: WhatsappStatus['estado'] | undefined): Estado {
  if (!s) return 'carregando'
  if (s.ultimo_erro && !s.ultimo_erro.visto && s.erros_24h > 0) return 'erro'
  if (s.modo === 'desligado') return 'parada'
  if (wa && wa !== 'open') return 'whatsapp'
  return 'ok'
}
export const ROTULO_ESTADO: Record<Estado, string> = {
  ok: 'Funcionando', erro: 'Falhou', whatsapp: 'WhatsApp desconectado', parada: 'Desligada', carregando: 'Verificando…',
}

// o que fazer para cada motivo de erro (o banco ja traduz o erro tecnico em motivo)
export function comoResolver(motivo: string): string {
  const m = motivo.toLowerCase()
  if (m.includes('chave')) return 'Gere uma chave nova em platform.openai.com/api-keys e troque OPENAI_API_KEY no Render (Environment). O serviço reinicia sozinho.'
  if (m.includes('credito') || m.includes('limite')) return 'Adicione crédito em platform.openai.com → Settings → Billing. Volta a funcionar na hora.'
  if (m.includes('whatsapp desconectado')) return 'Abra Configurar → WhatsApp desta IA e leia o QR code de novo.'
  if (m.includes('conectar em um servico')) return 'Algum serviço do Render está fora (Evolution, banco). Veja em Sistemas; se ficar assim, reinicie o serviço no Render.'
  if (m.includes('demorou')) return 'Costuma ser passageiro (OpenAI lenta). Se repetir muito, me avise.'
  if (m.includes('grande demais')) return 'A conversa ficou longa demais. Comece uma conversa nova; se for no WhatsApp, a IA se recupera sozinha na próxima.'
  if (m.includes('modelo')) return 'O modelo configurado não está disponível na sua conta OpenAI. Verifique o acesso aos modelos na OpenAI.'
  if (m.includes('loop')) return 'A IA tentou usar ferramentas demais. Reformule a pergunta; se repetir, me mande o detalhe técnico.'
  if (m.includes('nao devolveu') || m.includes('não devolveu')) return 'A IA respondeu vazio. Geralmente é passageiro; se repetir, veja o detalhe técnico.'
  if (m.includes('aprender')) return 'O aprendizado dessa conversa fica para a próxima rodada (a cada 15 min). Se repetir, veja o motivo.'
  return 'Abra o detalhe técnico abaixo. Se repetir, copie e me mande.'
}

// ------------------------------------------------------------------ pecas
export const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
export function haQuanto(iso: string | null | undefined) {
  if (!iso) return 'nunca'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  return `há ${Math.floor(s / 86400)} d`
}

export function Hud({ titulo, icone, extra, children, className = '' }: { titulo: string; icone?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`hud ${className}`}>
      <div className="hud-titulo"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{icone}{titulo}</span>{extra}</div>
      <div className="hud-corpo">{children}</div>
    </section>
  )
}

export function Avatar({ a, tamanho = 40 }: { a: AgenteId; tamanho?: number }) {
  const I = AGENTES[a].icone
  return <span className="avatar-ia" style={{ ...corDe(a), width: tamanho, height: tamanho }}><I size={Math.round(tamanho * 0.48)} /></span>
}

export function Pilula({ estado }: { estado: Estado }) {
  return <span className={`pilula ${estado}`}><i />{ROTULO_ESTADO[estado]}</span>
}

export function Numero({ valor, rotulo, destaque }: { valor: ReactNode; rotulo: string; destaque?: 'alerta' | 'erro' }) {
  return <div className={`numero ${destaque || ''}`}><b>{valor}</b><span>{rotulo}</span></div>
}

export function BotaoMini({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="botao-mini" {...p}>{children}</button>
}
