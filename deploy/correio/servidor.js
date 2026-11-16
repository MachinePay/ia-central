// IA Central - CORREIO: o n8n nao fala IMAP/SMTP/CalDAV sozinho; este servico pequeno faz isso por ele.
// So escuta na rede interna (Render: 127.0.0.1 dentro do conteiner do n8n | local: servico "correio" do compose).
// Nao guarda nada: recebe a conta (com a senha) em cada chamada e devolve o resultado.
//   POST /imap/testar   { imap, smtp?, caldav? }                 -> { ok, erro? }
//   POST /imap/ler      { imap, cursor: {uidvalidity, uid}, max } -> { itens, cursor }   (nunca marca como lido)
//   POST /imap/rascunho { imap, mensagem }                         -> { ok }   (pasta Rascunhos)
//   POST /smtp/enviar   { smtp, imap?, mensagem }                  -> { ok, id }   (e copia em Enviados)
//   POST /caldav/ler    { caldav, de, ate }                        -> { itens }
//   POST /caldav/criar  { caldav, evento }                         -> { ok, id }
'use strict'
const http = require('node:http')
const crypto = require('node:crypto')
const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')
const nodemailer = require('nodemailer')
const MailComposer = require('nodemailer/lib/mail-composer')

const PORTA = +(process.env.CORREIO_PORTA || 5690)
const HOST = process.env.CORREIO_HOST || '127.0.0.1'
const TEXTO_MAX = 4000

function cliente(imap) {
  return new ImapFlow({
    host: imap.host, port: +imap.porta || 993, secure: imap.seguro !== undefined ? !!imap.seguro : (+imap.porta || 993) === 993,   // outras portas: STARTTLS se houver
    auth: { user: imap.usuario, pass: imap.senha }, logger: false,
    tls: { rejectUnauthorized: imap.verificar_certificado !== false }, socketTimeout: 60000,
  })
}

async function comImap(imap, fn) {
  const c = cliente(imap)
  await c.connect()
  try { return await fn(c) } finally { try { await c.logout() } catch { c.close() } }
}

function transporte(smtp) {
  const porta = +smtp.porta || 465
  return nodemailer.createTransport({
    host: smtp.host, port: porta, secure: smtp.seguro !== undefined ? !!smtp.seguro : porta === 465,
    auth: { user: smtp.usuario, pass: smtp.senha }, tls: { rejectUnauthorized: smtp.verificar_certificado !== false },
  })
}

const so = (s, n = TEXTO_MAX) => String(s || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, n)

async function pastaEspecial(c, uso, nomes) {
  const lista = await c.list()
  return (lista.find(p => p.specialUse === uso) || lista.find(p => nomes.includes(String(p.path).toLowerCase())) || {}).path
}

async function montar(m) {
  const msg = new MailComposer({
    from: m.de, to: m.para, cc: m.cc || undefined, subject: m.assunto, text: m.texto,
    inReplyTo: m.in_reply_to || undefined, references: m.referencias || m.in_reply_to || undefined,
    messageId: `<${crypto.randomUUID()}@${String(m.de || 'ia').split('@').pop().replace(/[>\s]/g, '') || 'ia'}>`,
  })
  return msg.compile().build()
}

// ---------------------------------------------------------------- IMAP
async function imapLer({ imap, cursor = {}, max = 15 }) {
  return comImap(imap, async c => {
    const caixa = await c.mailboxOpen('INBOX', { readOnly: true })   // so leitura: nunca muda a flag de lida
    const validade = String(caixa.uidValidity)
    let desde = cursor.uidvalidity === validade ? +cursor.uid || 0 : 0
    const itens = []
    let ultimo = desde
    if (!desde) {
      // primeira vez: so as ultimas mensagens de 2 dias (nao le a caixa inteira)
      const uids = (await c.search({ since: new Date(Date.now() - 2 * 864e5) }, { uid: true })) || []
      const escolhidos = uids.slice(-max)
      ultimo = uids.length ? Math.max(...uids) : (caixa.uidNext ? caixa.uidNext - 1 : 0)
      if (!escolhidos.length) return { itens, cursor: { uidvalidity: validade, uid: ultimo } }
      desde = Math.min(...escolhidos) - 1
    }
    for await (const m of c.fetch(`${desde + 1}:*`, { uid: true, source: true, internalDate: true }, { uid: true })) {
      if (m.uid <= desde) continue          // "N:*" sempre devolve a ultima, mesmo antiga
      ultimo = Math.max(ultimo, m.uid)
      if (itens.length >= max) continue
      const p = await simpleParser(m.source)
      itens.push({
        ext_id: String(m.uid), de: p.from ? p.from.text : '', para: p.to ? [].concat(p.to).map(x => x.text).join(', ') : '',
        assunto: p.subject || '', texto: so(p.text || (p.html ? String(p.html).replace(/<[^>]+>/g, ' ') : '')),
        quando: (p.date || m.internalDate || new Date()).toISOString(), message_id: p.messageId || '',
        referencias: [].concat(p.references || []).join(' '),
        automatico: !!(p.headers.get('list-unsubscribe') || p.headers.get('auto-submitted') || /no-?reply|mailer-daemon/i.test(p.from ? p.from.text : '')),
      })
    }
    return { itens, cursor: { uidvalidity: validade, uid: ultimo } }
  })
}

async function imapRascunho({ imap, mensagem }) {
  const bruto = await montar(mensagem)
  return comImap(imap, async c => {
    let pasta = await pastaEspecial(c, '\\Drafts', ['drafts', 'rascunhos', 'inbox.drafts', 'inbox.rascunhos'])
    if (!pasta) { await c.mailboxCreate('Drafts'); pasta = 'Drafts' }   // servidor sem pasta de rascunhos: cria
    await c.append(pasta, bruto, ['\\Draft', '\\Seen'])
    return { ok: true, pasta }
  })
}

async function smtpEnviar({ smtp, imap, mensagem }) {
  const bruto = await montar(mensagem)
  const info = await transporte(smtp).sendMail({ envelope: { from: mensagem.de, to: [].concat(mensagem.para, mensagem.cc || []).join(',') }, raw: bruto })
  let copia = false
  if (imap) {   // guarda uma copia em Enviados (muitos servidores nao fazem sozinhos)
    try {
      await comImap(imap, async c => {
        const pasta = await pastaEspecial(c, '\\Sent', ['sent', 'enviados', 'inbox.sent', 'inbox.enviados', 'sent items', 'itens enviados'])
        if (pasta) { await c.append(pasta, bruto, ['\\Seen']); copia = true }
      })
    } catch { /* enviou; so a copia falhou */ }
  }
  return { ok: true, id: info.messageId || '', copia_enviados: copia }
}

async function testar({ imap, smtp, caldav }) {
  const r = { ok: true, imap: false, smtp: null, caldav: null }
  await comImap(imap, async c => { await c.mailboxOpen('INBOX', { readOnly: true }); r.imap = true })
  if (smtp && smtp.host) { await transporte(smtp).verify(); r.smtp = true }
  if (caldav && caldav.url) { await caldavLer({ caldav, de: new Date().toISOString(), ate: new Date(Date.now() + 864e5).toISOString() }); r.caldav = true }
  return r
}

// ---------------------------------------------------------------- CalDAV (agenda do dominio proprio, se o provedor tiver)
function authCaldav(caldav) { return 'Basic ' + Buffer.from(`${caldav.usuario}:${caldav.senha}`).toString('base64') }
const ics = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

function lerIcs(texto) {
  const linhas = String(texto).replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const evs = []
  let atual = null
  for (const l of linhas) {
    if (l === 'BEGIN:VEVENT') atual = {}
    else if (l === 'END:VEVENT') { if (atual) evs.push(atual); atual = null }
    else if (atual) {
      const i = l.indexOf(':'); if (i < 0) continue
      const chave = l.slice(0, i).split(';')[0].toUpperCase()
      const valor = l.slice(i + 1).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
      if (!(chave in atual)) atual[chave] = valor
    }
  }
  return evs
}

function dataIcs(v) {
  if (!v) return ''
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?/)
  if (!m) return v
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`
}

async function caldavLer({ caldav, de, ate }) {
  const corpo = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${ics(de)}" end="${ics(ate)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`
  const r = await fetch(caldav.url, { method: 'REPORT', body: corpo,
    headers: { Authorization: authCaldav(caldav), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' } })
  if (!r.ok) throw new Error(`CalDAV respondeu ${r.status}`)
  const xml = await r.text()
  const blocos = [...xml.matchAll(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/g)]
    .map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#13;/g, ''))
  const itens = []
  for (const b of blocos) for (const e of lerIcs(b)) {
    itens.push({ ext_id: e.UID || crypto.createHash('sha1').update(b).digest('hex'), titulo: e.SUMMARY || '(sem titulo)',
      inicio: dataIcs(e.DTSTART), fim: dataIcs(e.DTEND), local: e.LOCATION || '', descricao: so(e.DESCRIPTION || '', 800) })
  }
  return { itens }
}

async function caldavCriar({ caldav, evento }) {
  const uid = crypto.randomUUID()
  const esc = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
  const local = d => String(d).replace(/[-:]/g, '').slice(0, 15)   // 2026-11-20T15:00 -> 20261120T1500 (horario de Brasilia)
  const corpo = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IA Central//PT-BR', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${ics(new Date())}`,
    `DTSTART;TZID=America/Sao_Paulo:${local(evento.inicio).padEnd(15, '0')}`, `DTEND;TZID=America/Sao_Paulo:${local(evento.fim || evento.inicio).padEnd(15, '0')}`,
    `SUMMARY:${esc(evento.titulo)}`, evento.local ? `LOCATION:${esc(evento.local)}` : '', evento.descricao ? `DESCRIPTION:${esc(evento.descricao)}` : '',
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n')
  const url = caldav.url.replace(/\/?$/, '/') + uid + '.ics'
  const r = await fetch(url, { method: 'PUT', body: corpo, headers: { Authorization: authCaldav(caldav), 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' } })
  if (!r.ok) throw new Error(`CalDAV respondeu ${r.status} ao criar o evento`)
  return { ok: true, id: uid }
}

// ---------------------------------------------------------------- servidor
const ROTAS = {
  '/imap/testar': testar, '/imap/ler': imapLer, '/imap/rascunho': imapRascunho, '/smtp/enviar': smtpEnviar,
  '/caldav/ler': caldavLer, '/caldav/criar': caldavCriar,
}

function motivo(e) {
  const t = String((e && (e.responseText || e.response || e.message)) || e)
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535|LOGIN failed/i.test(t)) return 'Usuario ou senha recusados pelo servidor de e-mail'
  if (/ENOTFOUND|getaddrinfo/i.test(t)) return 'Servidor nao encontrado (confira o endereco)'
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(t)) return 'Servidor nao respondeu (confira endereco e porta)'
  if (/certificate|self.signed|CERT_/i.test(t)) return 'Certificado do servidor invalido'
  return t.slice(0, 300)
}

http.createServer((req, res) => {
  const fim = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && req.url === '/saude') return fim(200, { ok: true })
  const fn = ROTAS[req.url]
  if (req.method !== 'POST' || !fn) return fim(404, { erro: 'rota desconhecida' })
  let corpo = ''
  req.on('data', d => { corpo += d; if (corpo.length > 5e6) req.destroy() })
  req.on('end', async () => {
    try { fim(200, await fn(JSON.parse(corpo || '{}'))) } catch (e) { fim(200, { ok: false, erro: motivo(e) }) }
  })
}).listen(PORTA, HOST, () => console.log(`[correio] ouvindo em ${HOST}:${PORTA}`))
