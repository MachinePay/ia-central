import { useState, type FormEvent, type ReactNode } from 'react'
import { Activity, Bell, Brain, Shield, Trash2, UserPlus, Users, Radio, RefreshCw, ExternalLink } from 'lucide-react'
import { api, type Resumo } from '../api'
import { PainelWhatsapp } from './Whatsapp'

const fmtHora = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
function haQuanto(iso: string | null) {
  if (!iso) return '—'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `há ${s}s`
  if (s < 3600) return `há ${Math.round(s / 60)}min`
  if (s < 86400) return `há ${Math.round(s / 3600)}h`
  return fmtHora(iso)
}

function Hud({ titulo, icone, contagem, children, className = '' }: { titulo: string; icone: ReactNode; contagem?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`hud ${className}`}>
      <div className="hud-titulo"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{icone}{titulo}</span>{contagem !== undefined && <span className="contagem">{contagem}</span>}</div>
      <div className="hud-corpo">{children}</div>
    </section>
  )
}

function Interruptor({ ligado, aoMudar, magenta, rotulo }: { ligado: boolean; aoMudar: (v: boolean) => void; magenta?: boolean; rotulo: string }) {
  return <button role="switch" aria-checked={ligado} aria-label={rotulo} className={`interruptor ${magenta ? 'magenta' : ''} ${ligado ? 'ligado' : ''}`} onClick={() => aoMudar(!ligado)} />
}

// ------------------------------------------------------------------ sistemas
const ROTULO_ORIGEM: Record<string, string> = { render: 'RENDER', vercel: 'VERCEL', manual: 'SITE' }

export function PainelSistemas({ r, aoMudar }: { r: Resumo; aoMudar?: () => void }) {
  const [verificando, setVerificando] = useState(false)
  const ok = r.sistemas.filter(s => s.ativo && s.estado === 'ok').length
  const falha = r.sistemas.filter(s => s.ativo && s.estado === 'falha').length
  const tempos = r.sistemas.filter(s => s.ativo && s.tipo === 'http' && s.tempo_ms != null).map(s => s.tempo_ms!)
  const media = tempos.length ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null

  async function verificar() {
    setVerificando(true)
    try { await api.verificar(); aoMudar?.() } finally { setVerificando(false) }
  }

  return (
    <>
      <Hud titulo="Sistemas" icone={<Activity size={14} />} contagem={
        <button className="botao-icone" style={{ width: 'auto', height: 22, padding: '0 8px', fontSize: 10, gap: 5, display: 'flex' }}
          onClick={verificar} disabled={verificando} title="Verificar tudo agora">
          <RefreshCw size={12} className={verificando ? 'girando' : ''} /> {verificando ? 'checando' : 'agora'}
        </button>}>
        <div className="medidor">
          <div className="ok"><b>{ok}</b><span className="etiqueta">ONLINE</span></div>
          <div className={falha ? 'falha' : ''}><b>{falha}</b><span className="etiqueta">FORA</span></div>
          <div><b style={{ fontSize: 18 }}>{media ?? '—'}</b><span className="etiqueta">MS MÉDIO</span></div>
        </div>
        {r.sistemas.length === 0 && <div className="vazio">Nenhum sistema. Peça: "monitora https://…"</div>}
        {r.sistemas.map(s => (
          <div className="sistema" key={s.id ?? s.nome}>
            <span className={`luz ${s.ativo ? s.estado : 'pausado'}`} />
            <div>
              <div className="sistema-nome">
                <span className={`origem ${s.origem ?? 'manual'}`}>{ROTULO_ORIGEM[s.origem ?? 'manual'] ?? 'SITE'}</span>
                {s.nome.replace(/^(Render|Vercel) · /, '')}
              </div>
              <div className="sistema-info">{!s.ativo ? 'pausado' : s.estado === 'falha' ? `fora ${haQuanto(s.caiu_em)} · ${s.detalhe ?? ''}` : `${s.detalhe ?? '—'} · ${haQuanto(s.ultimo_check)}`}</div>
            </div>
            {s.tipo === 'http' && s.tempo_ms != null && s.estado === 'ok' && (
              <span className={`tempo ${s.tempo_ms > 2500 ? 'lento' : ''}`}>{s.tempo_ms}ms</span>
            )}
            {s.painel_url && (
              <a className="botao-icone" style={{ width: 24, height: 24 }} href={s.painel_url} target="_blank" rel="noreferrer" aria-label={`Abrir ${s.nome} no painel da plataforma`}>
                <ExternalLink size={13} />
              </a>
            )}
          </div>
        ))}
      </Hud>
      <Hud titulo="Incidentes" icone={<Radio size={14} />}>
        {r.incidentes.length === 0 && <div className="vazio">Nenhuma queda registrada.</div>}
        {r.incidentes.map((i, k) => (
          <div className="item" key={k}>
            <span className={`luz ${i.fim ? 'ok' : 'falha'}`} style={{ marginTop: 5 }} />
            <div><div className="item-titulo">{i.nome}</div><div className="etiqueta">{fmtHora(i.inicio)} → {i.fim ? fmtHora(i.fim) : 'em aberto'}</div></div>
          </div>
        ))}
      </Hud>
    </>
  )
}

// ------------------------------------------------------------------ lembretes + memoria
export function PainelPessoal({ r, aoMudar }: { r: Resumo; aoMudar: () => void }) {
  return (
    <>
      <Hud titulo="Lembretes" icone={<Bell size={14} />} contagem={r.lembretes.length}>
        {r.lembretes.length === 0 && <div className="vazio">Nada agendado. Peça: "me lembra amanhã às 9h…"</div>}
        {r.lembretes.map(l => (
          <div className="item" key={l.id}>
            <div><div className="quando">{fmtHora(l.quando)}{l.contato ? ` · p/ ${l.contato}` : ''}</div><div className="item-texto">{l.texto}</div></div>
          </div>
        ))}
      </Hud>
      <Hud titulo="Memória" icone={<Brain size={14} />} contagem={r.total_memorias}>
        {r.memorias.length === 0 && <div className="vazio">Diga "guarda isso: …" para a IA lembrar.</div>}
        {r.memorias.map(m => (
          <div className="item" key={m.id}>
            <div>{m.titulo && <div className="item-titulo">{m.titulo}</div>}<div className="item-texto">{m.conteudo}</div></div>
            <button aria-label="Esquecer" title="Esquecer" onClick={async () => { await api.esquecer(m.id); aoMudar() }}><Trash2 size={14} /></button>
          </div>
        ))}
      </Hud>
    </>
  )
}

// ------------------------------------------------------------------ privacidade + admin
export function PainelControle({ r, aoMudar }: { r: Resumo; aoMudar: () => void }) {
  const adm = r.usuario.papel === 'admin'
  const [novo, setNovo] = useState({ nome: '', login: '', senha: '', papel: 'usuario' as 'usuario' | 'admin' })
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null)
  const [tg, setTg] = useState('')
  const [zap, setZap] = useState('')

  async function acao(f: () => Promise<unknown>, ok?: string) {
    setAviso(null)
    try { await f(); if (ok) setAviso({ tipo: 'ok', texto: ok }); aoMudar() }
    catch (e) { setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Falhou' }) }
  }
  async function criar(e: FormEvent) {
    e.preventDefault()
    await acao(() => api.criarUsuario(novo), `Usuário ${novo.login} criado`)
    setNovo({ nome: '', login: '', senha: '', papel: 'usuario' })
  }

  return (
    <>
      <Hud titulo="Privacidade" icone={<Shield size={14} />}>
        {aviso && <div className={`aviso ${aviso.tipo}`}>{aviso.texto}</div>}
        {adm && (
          <div className="chave">
            <div className="chave-texto"><b>Memória compartilhada</b><span>Todos que participam veem as ideias uns dos outros</span></div>
            <Interruptor rotulo="Memória compartilhada" magenta ligado={r.memoria_compartilhada} aoMudar={v => acao(() => api.configurar(v))} />
          </div>
        )}
        <div className="chave">
          <div className="chave-texto">
            <b>Participar</b>
            <span>{r.memoria_compartilhada ? 'Suas memórias entram na memória do time' : 'Vale quando o admin ligar a memória compartilhada'}{adm ? ' (como admin você sempre pode consultar todos)' : ''}</span>
          </div>
          <Interruptor rotulo="Participar da memória compartilhada" ligado={!!r.usuario.compartilha} aoMudar={v => acao(() => api.participar(v))} />
        </div>
        <div className="chave" style={{ display: 'block' }}>
          <div className="chave-texto" style={{ marginBottom: 8 }}><b>Meu Telegram</b><span>{r.usuario.telegram ? 'Conectado: lembretes e avisos chegam lá' : 'Informe seu chat_id para receber lembretes'}</span></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="chat_id do Telegram" placeholder="chat_id" inputMode="numeric" value={tg} onChange={e => setTg(e.target.value)} /></div>
            <button className="botao secundario" style={{ width: 'auto' }} disabled={!tg.trim()} onClick={() => acao(() => api.perfil({ telegram_chat_id: tg.trim() }), 'Telegram salvo').then(() => setTg(''))}>Salvar</button>
          </div>
        </div>
        <div className="chave" style={{ display: 'block' }}>
          <div className="chave-texto" style={{ marginBottom: 8 }}>
            <b>Meu WhatsApp</b>
            <span>{r.usuario.whatsapp ? `+${r.usuario.whatsapp}: mande mensagem ou áudio para o número da IA` : 'Cadastre seu número para conversar com a sua IA pelo WhatsApp'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="campo" style={{ flex: 1, margin: 0 }}><input aria-label="Meu número de WhatsApp" placeholder="55 11 98765-4321" inputMode="tel" value={zap} onChange={e => setZap(e.target.value)} /></div>
            <button className="botao secundario" style={{ width: 'auto' }} disabled={zap.replace(/\D/g, '').length < 10} onClick={() => acao(() => api.perfil({ whatsapp: zap }), 'WhatsApp salvo').then(() => setZap(''))}>Salvar</button>
          </div>
        </div>
      </Hud>

      {adm && <PainelWhatsapp />}

      {adm && r.usuarios && (
        <Hud titulo="Usuários" icone={<Users size={14} />} contagem={r.usuarios.length}>
          {r.usuarios.map(u => (
            <div className={`usuario-linha ${u.ativo ? '' : 'inativo'}`} key={u.id}>
              <div className={`avatar ${u.papel}`}>{u.nome.slice(0, 1).toUpperCase()}</div>
              <div className="info">
                <b>{u.nome}</b>
                <span className="etiqueta">@{u.login} · {u.papel} · {u.memorias} mem. · {u.compartilha ? 'compartilha' : 'privado'}</span>
              </div>
              {u.id !== r.usuario.id && (
                <Interruptor rotulo={`Ativar ${u.nome}`} ligado={u.ativo} aoMudar={v => acao(() => api.ativarUsuario(u.id, v))} />
              )}
            </div>
          ))}
          <form onSubmit={criar} style={{ marginTop: 14 }}>
            <div className="linha-2">
              <div className="campo"><label htmlFor="n-nome">Nome</label><input id="n-nome" value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} /></div>
              <div className="campo"><label htmlFor="n-login">Login</label><input id="n-login" autoCapitalize="none" required value={novo.login} onChange={e => setNovo({ ...novo, login: e.target.value })} /></div>
            </div>
            <div className="linha-2">
              <div className="campo"><label htmlFor="n-senha">Senha</label><input id="n-senha" type="password" autoComplete="new-password" minLength={6} required value={novo.senha} onChange={e => setNovo({ ...novo, senha: e.target.value })} /></div>
              <div className="campo"><label htmlFor="n-papel">Papel</label>
                <select id="n-papel" value={novo.papel} onChange={e => setNovo({ ...novo, papel: e.target.value as 'usuario' | 'admin' })}>
                  <option value="usuario">Usuário</option><option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <button className="botao"><UserPlus size={14} /> Criar usuário</button>
          </form>
        </Hud>
      )}
    </>
  )
}
