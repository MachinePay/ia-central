import { google, gmail_v1 } from 'googleapis';
import { env } from '../../lib/env.js';
import type { InboundEvent, MediaItem } from '../../domain/types.js';

export const AGENT_HEADER = 'X-SelfMachine-Agent';

export const gmailEnabled = () => !!(env.GMAIL_ACCOUNT && env.GMAIL_REFRESH_TOKEN && env.GMAIL_CLIENT_ID);

let client: gmail_v1.Gmail | undefined;
export function gmail(): gmail_v1.Gmail {
  if (!client) {
    const auth = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
    client = google.gmail({ version: 'v1', auth });
  }
  return client;
}

export async function startWatch(): Promise<{ historyId: string; expiration: Date }> {
  const r = await gmail().users.watch({
    userId: 'me',
    requestBody: { topicName: env.GMAIL_PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'include' },
  });
  return { historyId: String(r.data.historyId), expiration: new Date(Number(r.data.expiration)) };
}

const header = (msg: gmail_v1.Schema$Message, name: string) =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

function decode(b64?: string | null) {
  return b64 ? Buffer.from(b64, 'base64url').toString('utf8') : '';
}

function walk(part: gmail_v1.Schema$MessagePart | undefined, out: { plain: string[]; html: string[]; attachments: gmail_v1.Schema$MessagePart[] }) {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) out.attachments.push(part);
  else if (part.mimeType === 'text/plain') out.plain.push(decode(part.body?.data));
  else if (part.mimeType === 'text/html') out.html.push(decode(part.body?.data));
  for (const p of part.parts ?? []) walk(p, out);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Remove historico citado e assinaturas longas: economiza muito token em threads longas. */
export function cleanBody(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(Em .{5,200} escreveu:|On .{5,200} wrote:|-----\s*Original Message|De: .+|From: .+@.+)\s*$/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(--|__)\s*$/.test(line)) break; // separador de assinatura
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
}

export type FilterResult = { skip: false } | { skip: true; reason: string; humanSent?: boolean };

/** Filtros anti-loop (obrigatorios). */
export function antiLoop(msg: gmail_v1.Schema$Message): FilterResult {
  const labels = msg.labelIds ?? [];
  const from = header(msg, 'From').toLowerCase();
  if (labels.includes('SENT') || from.includes(env.GMAIL_ACCOUNT.toLowerCase())) {
    return { skip: true, reason: 'enviado pela conta', humanSent: !header(msg, AGENT_HEADER) };
  }
  if (labels.includes('SPAM') || labels.includes('CATEGORY_PROMOTIONS')) return { skip: true, reason: 'spam/promocoes' };
  const auto = header(msg, 'Auto-Submitted').toLowerCase();
  if (auto && auto !== 'no') return { skip: true, reason: 'resposta automatica' };
  if (/^(bulk|list|junk)$/i.test(header(msg, 'Precedence'))) return { skip: true, reason: 'precedence' };
  if (header(msg, 'List-Unsubscribe') || header(msg, 'List-Id')) return { skip: true, reason: 'newsletter' };
  if (/(no-?reply|mailer-daemon|postmaster)@/i.test(from)) return { skip: true, reason: 'noreply' };
  return { skip: false };
}

export async function getMessage(id: string) {
  return (await gmail().users.messages.get({ userId: 'me', id, format: 'full' })).data;
}

export function parseAddress(v: string): { name?: string; email: string } {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() };
  return { email: v.trim().toLowerCase() };
}

export function toInboundEvent(msg: gmail_v1.Schema$Message): InboundEvent {
  const parts = { plain: [] as string[], html: [] as string[], attachments: [] as gmail_v1.Schema$MessagePart[] };
  walk(msg.payload, parts);
  const body = parts.plain.join('\n') || htmlToText(parts.html.join('\n')) || decode(msg.payload?.body?.data);
  const from = parseAddress(header(msg, 'From'));
  const media: MediaItem[] = parts.attachments.map((a) => ({
    kind: /pdf/i.test(a.mimeType ?? '') ? 'pdf' : /^image\//.test(a.mimeType ?? '') ? 'image' : 'other',
    description: '',
    mimeType: a.mimeType ?? undefined,
    fileName: a.filename ?? undefined,
  }));
  const needsMedia = media.some((m) => m.kind !== 'other');
  const others = media.filter((m) => m.kind === 'other').map((m) => `[Anexo "${m.fileName}", não processado]`);
  return {
    channel: 'GMAIL',
    instance: env.GMAIL_ACCOUNT,
    externalMessageId: `gm:${msg.id}`,
    externalThreadId: msg.threadId!,
    sender: { email: from.email, name: from.name },
    content: [cleanBody(body), ...others].filter(Boolean).join('\n'),
    media,
    needsMedia,
    metadata: {
      subject: header(msg, 'Subject'),
      messageIdHeader: header(msg, 'Message-ID') || header(msg, 'Message-Id'),
      inReplyTo: header(msg, 'In-Reply-To') || undefined,
      references: header(msg, 'References').split(/\s+/).filter(Boolean),
      raw: needsMedia ? { messageId: msg.id, attachments: parts.attachments.map((a) => ({ id: a.body?.attachmentId, mimeType: a.mimeType, filename: a.filename })) } : undefined,
    },
    receivedAt: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
  };
}

export async function getAttachment(messageId: string, attachmentId: string): Promise<string> {
  const r = await gmail().users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from(r.data.data ?? '', 'base64url').toString('base64');
}

function encodeHeader(v: string) {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`;
}

export function buildMime(o: { fromName: string; to: string; subject: string; inReplyTo?: string; references?: string; text: string; html: string; agent: string }) {
  const boundary = `sm_${Date.now().toString(36)}`;
  const lines = [
    `From: ${encodeHeader(o.fromName)} <${env.GMAIL_ACCOUNT}>`,
    `To: ${o.to}`,
    `Subject: ${encodeHeader(o.subject)}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    `${AGENT_HEADER}: ${o.agent}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(o.text).toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(o.html).toString('base64'),
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

export async function sendOrDraft(mode: 'send' | 'draft', raw: string, threadId: string): Promise<string | undefined> {
  if (mode === 'draft') {
    const r = await gmail().users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId } } });
    return r.data.message?.id ?? undefined;
  }
  const r = await gmail().users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
  return r.data.id ?? undefined;
}

/** Markdown simples -> HTML. */
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = md.trim().split(/\n{2,}/).map((b) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
      const tag = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul';
      return `<${tag}>${lines.map((l) => `<li>${esc(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</${tag}>`;
    }
    return `<p>${esc(b).replace(/\n/g, '<br>')}</p>`;
  });
  return blocks.join('\n').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

export const mdToText = (md: string) => md.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '');
