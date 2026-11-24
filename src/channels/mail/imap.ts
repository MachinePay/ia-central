import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import type { InboundEvent } from '../../domain/types.js';
import { one, q } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { AGENT_HEADER, cleanBody, htmlToText } from '../gmail/gmail.js';

/**
 * E-mail que nao e Google (ex.: Uni5, Locaweb, Hostinger, Outlook): IMAP para ler, SMTP para responder.
 * As conversas usam o mesmo canal de e-mail do Gmail (channel GMAIL), com a conta como "instance".
 */
export type MailAccount = {
  email: string; instance: string | null; username: string; password_enc: string;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; last_uid: string | null;
};

// ------------------------------------------------------------------ senha guardada criptografada
const key = () => createHash('sha256').update(`mail|${env.SESSION_SECRET || env.EVOLUTION_WEBHOOK_TOKEN}`).digest();
export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(enc: string): string {
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ------------------------------------------------------------------ servidores
const KNOWN: Array<{ mx: RegExp; imap: string; smtp: string; smtpPort?: number }> = [
  { mx: /uni5\.net$/i, imap: 'imap.uni5.net', smtp: 'smtp.uni5.net', smtpPort: 587 },
  { mx: /locaweb\.com\.br$/i, imap: 'email-ssl.com.br', smtp: 'email-ssl.com.br', smtpPort: 465 },
  { mx: /hostinger\.com$/i, imap: 'imap.hostinger.com', smtp: 'smtp.hostinger.com', smtpPort: 465 },
  { mx: /(outlook|protection\.outlook)\.com$/i, imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
  { mx: /zoho\.com$/i, imap: 'imap.zoho.com', smtp: 'smtp.zoho.com', smtpPort: 465 },
  { mx: /titan\.email$/i, imap: 'imap.titan.email', smtp: 'smtp.titan.email', smtpPort: 465 },
];

/** Descobre os servidores pelo provedor do dominio (MX). Sem palpite conhecido: imap./smtp. do proprio dominio. */
export async function guessServers(email: string): Promise<{ imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; provider: string }> {
  const domain = email.split('@')[1] ?? '';
  let mx = '';
  try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0]?.exchange ?? ''; } catch { /* sem MX */ }
  const k = KNOWN.find((x) => x.mx.test(mx));
  if (k) return { imap_host: k.imap, imap_port: 993, smtp_host: k.smtp, smtp_port: k.smtpPort ?? 587, provider: mx };
  return { imap_host: `imap.${domain}`, imap_port: 993, smtp_host: `smtp.${domain}`, smtp_port: 587, provider: mx || 'desconhecido' };
}

const imapClient = (a: Pick<MailAccount, 'imap_host' | 'imap_port' | 'username'>, password: string) =>
  new ImapFlow({ host: a.imap_host, port: a.imap_port, secure: a.imap_port === 993, auth: { user: a.username, pass: password }, logger: false, socketTimeout: 60_000 });
const smtpClient = (a: Pick<MailAccount, 'smtp_host' | 'smtp_port' | 'username'>, password: string) =>
  nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: a.smtp_port === 465, auth: { user: a.username, pass: password }, connectionTimeout: 20_000 });

/** Testa entrar no IMAP e no SMTP antes de salvar (mensagem clara se falhar). */
export async function testAccount(a: Pick<MailAccount, 'imap_host' | 'imap_port' | 'smtp_host' | 'smtp_port' | 'username'>, password: string) {
  const imap = imapClient(a, password);
  try {
    await imap.connect();
    await imap.logout();
  } catch (e: any) {
    throw new Error(`Não entrou no IMAP (${a.imap_host}:${a.imap_port}): ${e.responseText ?? e.message}`);
  }
  try {
    await smtpClient(a, password).verify();
  } catch (e: any) {
    throw new Error(`Entrou para ler, mas não no envio (SMTP ${a.smtp_host}:${a.smtp_port}): ${e.response ?? e.message}`);
  }
}

export async function saveAccount(o: { email: string; instance: string; username: string; password: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number }) {
  await q(
    `INSERT INTO app.mail_accounts (email, instance, username, password_enc, imap_host, imap_port, smtp_host, smtp_port)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (email) DO UPDATE SET instance = EXCLUDED.instance, username = EXCLUDED.username, password_enc = EXCLUDED.password_enc,
       imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, last_uid = NULL`,
    [o.email.toLowerCase(), o.instance, o.username, encrypt(o.password), o.imap_host, o.imap_port, o.smtp_host, o.smtp_port],
  );
}

export const mailAccounts = () => q<MailAccount>(`SELECT * FROM app.mail_accounts ORDER BY created_at`).catch(() => [] as MailAccount[]);
export const mailAccount = (email: string) => one<MailAccount>(`SELECT * FROM app.mail_accounts WHERE email = $1`, [email.toLowerCase()]);

// ------------------------------------------------------------------ leitura
const addr = (v: ParsedMail['from']) => (Array.isArray(v) ? v[0] : v)?.value?.[0];

/** Filtros anti-loop (iguais aos do Gmail). */
function skipReason(m: ParsedMail, account: string): { reason: string; ownSent?: boolean } | undefined {
  const from = (addr(m.from)?.address ?? '').toLowerCase();
  if (from === account) return { reason: 'enviado pela conta', ownSent: !m.headers.get(AGENT_HEADER.toLowerCase()) };
  const auto = String(m.headers.get('auto-submitted') ?? '').toLowerCase();
  if (auto && auto !== 'no') return { reason: 'resposta automatica' };
  if (/^(bulk|list|junk)$/i.test(String(m.headers.get('precedence') ?? ''))) return { reason: 'precedence' };
  if (m.headers.get('list-unsubscribe') || m.headers.get('list-id')) return { reason: 'newsletter' };
  if (/(no-?reply|mailer-daemon|postmaster)@/i.test(from)) return { reason: 'noreply' };
  return undefined;
}

const refsOf = (m: ParsedMail): string[] => (Array.isArray(m.references) ? m.references : m.references ? String(m.references).split(/\s+/) : []).filter(Boolean);

export function toEvent(m: ParsedMail, account: string): InboundEvent {
  const refs = refsOf(m);
  const msgId = m.messageId ?? `<sem-id-${Date.now()}@${account}>`;
  const root = refs[0] ?? m.inReplyTo ?? msgId; // conversa = primeira mensagem do fio
  const body = m.text || htmlToText(String(m.html || ''));
  const files = (m.attachments ?? []).filter((a) => a.contentDisposition !== 'inline').map((a) => `[Anexo "${a.filename ?? 'arquivo'}", não processado]`);
  const from = addr(m.from);
  return {
    channel: 'GMAIL',
    instance: account,
    externalMessageId: `mail:${account}:${msgId}`,
    externalThreadId: root,
    sender: { email: (from?.address ?? '').toLowerCase(), name: from?.name || undefined },
    content: [cleanBody(body), ...files].filter(Boolean).join('\n'),
    media: [],
    needsMedia: false,
    metadata: { subject: m.subject ?? '', messageIdHeader: msgId, inReplyTo: m.inReplyTo, references: refs },
    receivedAt: (m.date ?? new Date()).toISOString(),
  };
}

/**
 * Busca as mensagens novas da caixa de entrada (UID maior que o ultimo visto).
 * Na primeira vez so marca o ponto de partida: nao responde e-mail antigo.
 */
export async function pollAccount(a: MailAccount, onMessage: (ev: InboundEvent) => Promise<void>, onOwnSent: (threadKey: string, text: string, id: string) => Promise<void>) {
  const imap = imapClient(a, decrypt(a.password_enc));
  await imap.connect();
  const lock = await imap.getMailboxLock('INBOX');
  try {
    const box = imap.mailbox as { uidNext: number } | false;
    const next = box ? box.uidNext : 1;
    if (a.last_uid === null) {
      await q(`UPDATE app.mail_accounts SET last_uid = $2 WHERE email = $1`, [a.email, next - 1]);
      return;
    }
    let last = Number(a.last_uid);
    if (next - 1 <= last) return;
    for await (const msg of imap.fetch({ uid: `${last + 1}:*` }, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= last || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const skip = skipReason(parsed, a.email);
      if (!skip) await onMessage(toEvent(parsed, a.email));
      else if (skip.ownSent) {
        const ev = toEvent(parsed, a.email);
        await onOwnSent(ev.externalThreadId, ev.content, ev.externalMessageId);
      }
      last = Math.max(last, msg.uid);
      await q(`UPDATE app.mail_accounts SET last_uid = $2 WHERE email = $1`, [a.email, last]);
    }
  } finally {
    lock.release();
    await imap.logout().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ envio
export async function sendMail(account: string, o: { fromName: string; to: string; subject: string; inReplyTo?: string; references?: string; text: string; html: string; agent: string }): Promise<string | undefined> {
  const a = await mailAccount(account);
  if (!a) throw new Error(`conta de e-mail nao conectada: ${account}`);
  const password = decrypt(a.password_enc);
  const info = await smtpClient(a, password).sendMail({
    from: { name: o.fromName, address: a.email }, to: o.to, subject: o.subject, text: o.text, html: o.html,
    inReplyTo: o.inReplyTo, references: o.references, headers: { [AGENT_HEADER]: o.agent },
  });
  // copia na pasta de enviados, para aparecer no webmail (melhor esforco)
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const mc = nodemailer.createTransport({ streamTransport: true, buffer: true });
      mc.sendMail({ from: { name: o.fromName, address: a.email }, to: o.to, subject: o.subject, text: o.text, html: o.html, inReplyTo: o.inReplyTo, references: o.references, messageId: info.messageId, headers: { [AGENT_HEADER]: o.agent } },
        (err, r) => (err ? reject(err) : resolve(r.message as Buffer)));
    });
    const imap = imapClient(a, password);
    await imap.connect();
    const boxes = await imap.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent') ?? boxes.find((b) => /^(sent|enviad|itens enviados)/i.test(b.name));
    if (sent) await imap.append(sent.path, raw, ['\\Seen']);
    await imap.logout();
  } catch (e) {
    logger.debug({ err: String(e) }, 'copia em enviados nao feita');
  }
  return info.messageId;
}
