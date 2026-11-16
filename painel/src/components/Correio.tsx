// E-mail e agenda de cada IA: conectar contas (Google, Microsoft, dominio proprio), ver o que ela leu
// e aprovar o que ela propoe (resposta/rascunho de e-mail e eventos). Nada e executado sem voce aprovar.
import { useState } from 'react'
import { CalendarDays, Check, FileText, KeyRound, LogIn, Mail, RefreshCw, Send, Server, Trash2, X } from 'lucide-react'
import { api, type AgenteId, type ContaCorreio, type Correio, type DadosImap, type DadosProposta, type PropostaCorreio, type ProvedorCorreio } from '../api'
import { AGENTES, BotaoMini, Hud, fmt, haQuanto } from './ui'
import { avisar, confirmar } from '../alerta'

const ROTULO_TIPO: Record<ContaCorreio['tipo'], string> = { google: 'Google', microsoft: 'Outlook', imap: 'Domínio próprio' }
const NOME_PROV: Record<ProvedorCorreio, string> = { google: 'Google', microsoft: 'Microsoft (Outlook)' }
const erroDe = (e: unknown) => (e instanceof Error ? e.message : 'Falhou')

// endereco que o Google/Microsoft chamam depois do login (tem que estar cadastrado no app)
export function redirectOAuth(p: ProvedorCorreio) {
  const h = window.location.hostname
  const base = h === 'localhost' || h === '127.0.0.1' ? 'http://localhost:5678' : window.location.origin
  return `${base}/webhook/oauth/${p}`
}

// volta do login: mostra o resultado e limpa o endereco. Devolve true se veio do login.
export function voltaDoLogin(): boolean {
  const q = new URLSearchParams(window.location.search)
  if (!q.has('correio') && !q.has('correio_erro')) return false
  if (q.get('correio') === 'ok') avisar('E-mail conectado ✓', 'success', q.get('conta') || '')
  else avisar('Não consegui conectar o e-mail', 'error', q.get('correio_erro') || '')
  window.history.replaceState(null, '', window.location.pathname)
  return true
}

function ConectarOAuth({ a, p, cor, setCor }: { a: AgenteId; p: ProvedorCorreio; cor: Correio; setCor: (c: Correio) => void }) {
  const app = cor.apps[p]
  const [editar, setEditar] = useState(!app)
  const [cid, setCid] = useState(app?.client_id || '')
  const [seg, setSeg] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const uri = redirectOAuth(p)
  async function salvar(e: React.FormEvent) {
    e.preventDefault(); setOcupado(true)
    try { setCor(await api.correioApp(a, p, cid.trim(), seg.trim())); setSeg(''); setEditar(false); avisar('Chaves do app salvas ✓') }
    catch (err) { avisar('Não salvou', 'error', erroDe(err)) } finally { setOcupado(false) }
  }
  async function entrar() {
    setOcupado(true)
    try { const r = await api.correioConectar(a, p, uri, window.location.origin + window.location.pathname); window.location.href = r.url }
    catch (err) { avisar('Não deu para conectar', 'error', erroDe(err)); setOcupado(false) }
  }
  return (
    <div className="fila-item" style={{ marginTop: 8 }}>
      {editar ? (
        <form onSubmit={salvar}>
          <div className="etiqueta" style={{ marginBottom: 6 }}>
            <KeyRound size={11} /> Chaves do app {p === 'google' ? 'do Google Cloud' : 'do Azure'} usadas por {AGENTES[a].nome}.{' '}
            {p === 'google' ? 'Google Cloud → APIs e serviços → Credenciais → ID do cliente OAuth (Aplicativo da Web).'
              : 'Azure → Registros de aplicativo → ID do aplicativo (cliente) e Certificados e segredos → segredo do cliente (o “Valor”).'}
          </div>
          <div className="etiqueta" style={{ marginBottom: 8 }}>
            URI de redirecionamento para cadastrar no app: <code style={{ wordBreak: 'break-all' }}>{uri}</code>{' '}
            <BotaoMini type="button" onClick={() => { void navigator.clipboard?.writeText(uri); avisar('Copiado ✓') }}>copiar</BotaoMini>
          </div>
          <div className="campo"><label htmlFor={`cid-${a}-${p}`}>Client ID</label>
            <input id={`cid-${a}-${p}`} autoComplete="off" value={cid} onChange={e => setCid(e.target.value)} /></div>
          <div className="campo"><label htmlFor={`seg-${a}-${p}`}>Client secret{app ? ' (vazio = manter o atual)' : ''}</label>
            <input id={`seg-${a}-${p}`} type="password" autoComplete="new-password" value={seg} onChange={e => setSeg(e.target.value)} /></div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="botao" style={{ width: 'auto', flex: 1 }} disabled={ocupado || !cid.trim() || (!app && !seg.trim())}>Salvar chaves</button>
            {app && <button type="button" className="botao secundario" style={{ width: 'auto' }} onClick={() => setEditar(false)}>Cancelar</button>}
          </div>
        </form>
      ) : (
        <>
          <button className="botao" disabled={ocupado} onClick={entrar}><LogIn size={14} /> Entrar com {NOME_PROV[p]}</button>
          <div className="etiqueta" style={{ marginTop: 8 }}>
            Você vai para o login {p === 'google' ? 'do Google' : 'da Microsoft'}, escolhe a conta e aceita as permissões
            (ler e-mails, criar rascunhos/enviar e mexer na agenda). Depois volta para cá. Dá para conectar várias contas.
          </div>
          <div className="etiqueta" style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            App salvo ({(app?.client_id || '').slice(0, 14)}…)
            <BotaoMini onClick={() => setEditar(true)}>trocar chaves</BotaoMini>
            <BotaoMini onClick={async () => {
              if (!(await confirmar({ titulo: 'Apagar as chaves do app?', texto: `Contas ${NOME_PROV[p]} desta IA param de ser lidas até você salvar chaves de novo.`, botao: 'Apagar', perigo: true }))) return
              setCor(await api.correioAppApagar(a, p)); setCid(''); setEditar(true)
            }}>apagar</BotaoMini>
          </div>
        </>
      )}
    </div>
  )
}

function ConectarImap({ a, setCor, aoFim }: { a: AgenteId; setCor: (c: Correio) => void; aoFim: () => void }) {
  const [d, setD] = useState<DadosImap>({ email: '', senha: '', imap_host: '', imap_porta: '993', smtp_host: '', smtp_porta: '465', caldav_url: '', usuario: '' })
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState('')
  const campo = (k: keyof DadosImap, rotulo: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="campo" style={{ flex: 1, minWidth: 120 }}>
      <label htmlFor={`imap-${a}-${k}`}>{rotulo}</label>
      <input id={`imap-${a}-${k}`} autoComplete="off" value={d[k] || ''} onChange={e => setD({ ...d, [k]: e.target.value })} {...extra} />
    </div>
  )
  async function salvar(e: React.FormEvent) {
    e.preventDefault(); setOcupado(true); setErro('')
    try {
      const r = await api.correioImap(a, d)
      if (r.painel) setCor(r.painel)
      if (r.ok) { avisar('E-mail conectado ✓', 'success', d.email); aoFim() } else setErro(r.erro || 'Não conectou')
    } catch (err) { setErro(erroDe(err)) } finally { setOcupado(false) }
  }
  return (
    <form className="fila-item" style={{ marginTop: 8 }} onSubmit={salvar}>
      <div className="etiqueta" style={{ marginBottom: 8 }}>
        <Server size={11} /> Para e-mail no seu domínio (ex.: @girakids.com). Os endereços dos servidores estão no painel do seu provedor
        (Uni5: área de e-mail → configurar no celular/Outlook). A senha fica guardada criptografada.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {campo('email', 'E-mail', { type: 'email', placeholder: 'voce@girakids.com' })}
        {campo('senha', 'Senha', { type: 'password', autoComplete: 'new-password' })}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {campo('imap_host', 'Servidor IMAP (receber)', { placeholder: 'imap.seudominio.com' })}
        <div style={{ width: 80 }}>{campo('imap_porta', 'Porta', { inputMode: 'numeric' })}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {campo('smtp_host', 'Servidor SMTP (enviar)', { placeholder: 'smtp.seudominio.com' })}
        <div style={{ width: 80 }}>{campo('smtp_porta', 'Porta', { inputMode: 'numeric' })}</div>
      </div>
      {campo('caldav_url', 'Agenda CalDAV (opcional)', { placeholder: 'https://… (se o provedor tiver agenda)' })}
      {campo('usuario', 'Usuário (só se for diferente do e-mail)')}
      {erro && <div className="aviso erro">{erro}</div>}
      <button className="botao" disabled={ocupado || !d.email || !d.senha || !d.imap_host}>{ocupado ? 'Testando…' : 'Conectar e testar'}</button>
    </form>
  )
}

function LinhaConta({ c, setCor }: { c: ContaCorreio; setCor: (c: Correio) => void }) {
  const [ocupado, setOcupado] = useState(false)
  const estado = c.estado === 'ok' ? `lida ${haQuanto(c.ultima_leitura)} · ${c.lidos} itens guardados`
    : c.estado === 'testando' ? 'testando a conexão…' : `com problema: ${c.erro || 'erro'}`
  return (
    <div className="item">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="item-titulo" style={{ overflowWrap: 'anywhere' }}>{c.tipo === 'imap' ? <Server size={12} /> : <Mail size={12} />} {c.email}
          <span className="etiqueta"> · {ROTULO_TIPO[c.tipo]}{c.tem_agenda ? ' + agenda' : ''}</span></div>
        <div className="etiqueta" style={{ color: c.estado === 'erro' ? 'var(--vermelho, #ff7a93)' : undefined }}>{estado}</div>
        <div style={{ display: 'flex', gap: 14, marginTop: 4, flexWrap: 'wrap' }}>
          <label className="etiqueta" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={c.ler_email} onChange={async e => setCor(await api.correioConta(c.id, { ler_email: e.target.checked }))} /> ler e-mails</label>
          {c.tem_agenda && <label className="etiqueta" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={c.ler_agenda} onChange={async e => setCor(await api.correioConta(c.id, { ler_agenda: e.target.checked }))} /> ler agenda</label>}
        </div>
      </div>
      <button aria-label={`Testar ${c.email}`} title="Testar conexão" disabled={ocupado} onClick={async () => {
        setOcupado(true)
        try { const r = await api.correioTestar(c.id); if (r.painel) setCor(r.painel); r.ok ? avisar('Conexão ok ✓', 'success', c.email) : avisar('Conexão falhou', 'error', r.erro || '') }
        catch (e) { avisar('Conexão falhou', 'error', erroDe(e)) } finally { setOcupado(false) }
      }}><RefreshCw size={13} /></button>
      <button aria-label={`Desconectar ${c.email}`} title="Desconectar" onClick={async () => {
        if (!(await confirmar({ titulo: 'Desconectar este e-mail?', texto: `<b>${c.email}</b> deixa de ser lido e as sugestões pendentes dele somem. O que a IA já aprendeu continua.`, botao: 'Desconectar', perigo: true }))) return
        setCor(await api.correioDesconectar(c.id))
      }}><Trash2 size={13} /></button>
    </div>
  )
}

export function EmailAgenda({ a, cor, setCor, recarregar }: { a: AgenteId; cor: Correio | null; setCor: (c: Correio) => void; recarregar: () => void }) {
  const [abrir, setAbrir] = useState<ProvedorCorreio | 'imap' | null>(null)
  const [lendo, setLendo] = useState(false)
  if (!cor) return <Hud titulo="4 · E-mail e agenda" icone={<Mail size={14} />}><div className="vazio">Carregando…</div></Hud>
  const info = AGENTES[a]
  const n = cor.contas.length
  const resumo = n === 0 ? `${info.nome} ainda não lê nenhum e-mail.`
    : `${info.nome} lê ${n} conta${n === 1 ? '' : 's'} de e-mail${cor.contas.some(c => c.tem_agenda) ? ' e agenda' : ''}, aprende só para ela e sugere respostas e eventos para você aprovar.`
  return (
    <Hud titulo="4 · E-mail e agenda" icone={<Mail size={14} />} extra={<span className="contagem">{n}</span>}>
      <div className="resumo-config">{resumo}</div>
      {cor.contas.map(c => <LinhaConta key={c.id} c={c} setCor={setCor} />)}
      <div className="etiqueta" style={{ margin: '12px 0 6px' }}>CONECTAR {n ? 'OUTRA CONTA' : 'UMA CONTA'}</div>
      <div className="modos">
        {(['google', 'microsoft', 'imap'] as const).map(x => (
          <button key={x} className={abrir === x ? 'ativo' : ''} onClick={() => setAbrir(abrir === x ? null : x)}>
            {x === 'google' ? 'Gmail / Google' : x === 'microsoft' ? 'Outlook / Microsoft' : 'Domínio próprio'}
          </button>
        ))}
      </div>
      {(abrir === 'google' || abrir === 'microsoft') && <ConectarOAuth key={abrir} a={a} p={abrir} cor={cor} setCor={setCor} />}
      {abrir === 'imap' && <ConectarImap a={a} setCor={setCor} aoFim={() => setAbrir(null)} />}
      {n > 0 && (
        <button className="botao secundario" style={{ marginTop: 10 }} disabled={lendo} onClick={async () => {
          setLendo(true)
          try {
            const r = await api.correioLer(a)
            if (r.ok) avisar(r.lidos ? `Leu ${r.lidos} e-mail(s)/evento(s) novos ✓` : 'Nada novo para ler', 'success', r.itens ? `Aprendeu ${r.itens} coisa(s)` : undefined)
            else avisar('Não consegui ler agora', 'error', r.erro)
          } catch (e) { avisar('Não consegui ler agora', 'error', erroDe(e)) } finally { setLendo(false); recarregar() }
        }}><RefreshCw size={14} /> {lendo ? 'Lendo…' : 'Ler agora'}</button>
      )}
      <div className="etiqueta" style={{ marginTop: 8 }}>
        Lê de hora em hora só o que chegou de novo (não marca nada como lido, não apaga nada). Respostas e eventos que a IA sugerir
        aparecem em <b>Aprovar</b>: nada é enviado nem marcado sem você aprovar.
      </div>
    </Hud>
  )
}

function ItemProposta({ p, cor, setCor }: { p: PropostaCorreio; cor: Correio; setCor: (c: Correio) => void }) {
  const [d, setD] = useState<DadosProposta>(p.dados)
  const [conv, setConv] = useState((p.dados.convidados || []).join(', '))
  const agendas = cor.contas.filter(c => c.tem_agenda)
  const [conta, setConta] = useState(p.conta_id)
  const [ocupado, setOcupado] = useState(false)
  const email = p.tipo === 'email'
  async function aprovar(modo: 'enviar' | 'rascunho' | 'criar') {
    if (modo === 'enviar' && !(await confirmar({ titulo: 'Enviar este e-mail?', texto: `De <b>${p.conta}</b> para <b>${(d.para || '').replace(/</g, '&lt;')}</b>.`, botao: 'Enviar' }))) return
    setOcupado(true)
    try {
      const dados = email ? d : { ...d, convidados: conv.split(/[,;\s]+/).map(x => x.trim()).filter(x => x.includes('@')) }
      const r = await api.correioAprovar(p.id, modo, dados, email ? undefined : conta)
      if (r.ok) avisar(r.resultado || 'Feito ✓'); else avisar('Não deu certo', 'error', r.erro || '')
      if (r.painel) setCor(r.painel)
    } catch (e) { avisar('Não deu certo', 'error', erroDe(e)) } finally { setOcupado(false) }
  }
  const f = (k: keyof DadosProposta, rotulo: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="campo" style={{ flex: 1, minWidth: 140, margin: '0 0 8px' }}>
      <label htmlFor={`p${p.id}-${k}`}>{rotulo}</label>
      <input id={`p${p.id}-${k}`} value={String(d[k] ?? '')} onChange={e => setD({ ...d, [k]: e.target.value })} {...extra} />
    </div>
  )
  return (
    <div className="fila-item">
      <div className="etiqueta">{email ? <Mail size={11} /> : <CalendarDays size={11} />} {email ? 'Resposta de e-mail' : 'Evento na agenda'} · {p.conta} · {fmt(p.criado_em)}</div>
      {p.item_assunto && (
        <details style={{ margin: '6px 0' }}>
          <summary className="fila-pergunta" style={{ cursor: 'pointer' }}>“{p.item_assunto}” <span className="etiqueta">de {p.item_de}{p.item_quando ? ` · ${fmt(p.item_quando)}` : ''}</span></summary>
          <div className="etiqueta" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 220, overflow: 'auto' }}>{p.item_texto}</div>
        </details>
      )}
      {p.motivo && <div className="etiqueta" style={{ marginBottom: 8 }}>Por quê: {p.motivo}</div>}
      {p.status === 'falhou' && <div className="aviso erro">Falhou: {p.resultado}. Corrija e tente de novo.</div>}
      {p.status === 'executando' && <div className="aviso">Executando…</div>}
      {email ? (
        <>
          {f('para', 'Para')}
          {f('assunto', 'Assunto')}
          <div className="campo" style={{ margin: '0 0 8px' }}>
            <label htmlFor={`p${p.id}-corpo`}>Texto (edite se quiser)</label>
            <textarea id={`p${p.id}-corpo`} rows={6} value={d.corpo || ''} onChange={e => setD({ ...d, corpo: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="botao" style={{ width: 'auto', flex: 1 }} disabled={ocupado || !d.corpo?.trim() || !d.para?.trim()} onClick={() => aprovar('enviar')}><Send size={14} /> Enviar</button>
            <button className="botao secundario" style={{ width: 'auto', flex: 1 }} disabled={ocupado || !d.corpo?.trim()} onClick={() => aprovar('rascunho')}><FileText size={14} /> Só salvar rascunho</button>
            <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} aria-label="Descartar"
              onClick={async () => setCor(await api.correioRejeitar(p.id))}><X size={14} /></button>
          </div>
        </>
      ) : (
        <>
          {f('titulo', 'Título')}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {f('inicio', 'Início', { type: 'datetime-local' })}
            {f('fim', 'Fim', { type: 'datetime-local' })}
          </div>
          {f('local', 'Local')}
          <div className="campo" style={{ margin: '0 0 8px' }}>
            <label htmlFor={`p${p.id}-conv`}>Convidados (recebem convite)</label>
            <input id={`p${p.id}-conv`} placeholder="e-mails separados por vírgula (ou vazio)" value={conv} onChange={e => setConv(e.target.value)} />
          </div>
          <div className="campo" style={{ margin: '0 0 8px' }}>
            <label htmlFor={`p${p.id}-agenda`}>Criar na agenda de</label>
            <select id={`p${p.id}-agenda`} value={conta} onChange={e => setConta(+e.target.value)}>
              {agendas.map(c => <option key={c.id} value={c.id}>{c.email} ({ROTULO_TIPO[c.tipo]})</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="botao" style={{ width: 'auto', flex: 1 }} disabled={ocupado || !d.titulo?.trim() || !d.inicio} onClick={() => aprovar('criar')}><Check size={14} /> Criar evento</button>
            <button className="botao secundario" style={{ width: 'auto' }} disabled={ocupado} aria-label="Descartar"
              onClick={async () => setCor(await api.correioRejeitar(p.id))}><X size={14} /></button>
          </div>
        </>
      )}
    </div>
  )
}

export function FilaCorreio({ cor, setCor }: { cor: Correio | null; setCor: (c: Correio) => void }) {
  if (!cor || (cor.contas.length === 0 && cor.propostas.length === 0)) return null
  return (
    <Hud titulo="E-mail e agenda esperando você" icone={<Mail size={14} />} extra={<span className="contagem">{cor.propostas.length}</span>}>
      <div className="etiqueta" style={{ marginBottom: 6 }}>A IA leu seus e-mails e sugere isto. Edite se quiser: só acontece quando você aprovar.</div>
      {cor.propostas.length === 0 && <div className="vazio">Nada esperando aprovação.</div>}
      {cor.propostas.map(p => <ItemProposta key={p.id} p={p} cor={cor} setCor={setCor} />)}
    </Hud>
  )
}

export function LidosCorreio({ cor }: { cor: Correio | null }) {
  if (!cor || cor.contas.length === 0) return null
  return (
    <Hud titulo="E-mails e agenda que ela leu" icone={<Mail size={14} />} extra={<span className="contagem">{cor.itens.length}</span>} className="leitor-correio">
      {cor.itens.length === 0 && <div className="vazio">Nada lido ainda. Use “Ler agora” em Configurar → 4.</div>}
      {cor.itens.map(i => (
        <div className="item" key={i.id}>
          {i.tipo === 'email' ? <Mail size={14} /> : <CalendarDays size={14} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="item-titulo" style={{ overflowWrap: 'anywhere' }}>{i.assunto || '(sem assunto)'}</div>
            <div className="etiqueta">
              {i.tipo === 'email' ? `de ${i.de || '?'} · ${fmt(i.quando || i.lido_em)}` : `${fmt(i.quando || '')}${i.local ? ' · ' + i.local : ''}`} · {i.conta}
              {i.aprendido ? '' : ' · ainda vai aprender'}
            </div>
            {i.resumo && <div className="etiqueta" style={{ marginTop: 3, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{i.resumo}</div>}
          </div>
        </div>
      ))}
    </Hud>
  )
}
