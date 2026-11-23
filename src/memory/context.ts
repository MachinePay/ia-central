import type { ModelMessage } from 'ai';
import { getContact, otherChannelSummary, recentMessages, unansweredBlock } from '../domain/repo.js';
import type { Agent, Contact, Message, Thread } from '../domain/types.js';
import { q } from '../lib/db.js';
import { fence } from '../lib/util.js';
import { maskSensitive } from '../guardrails/mask.js';

export type Company = { slug: string; name: string; description: string; topics: string; site: string | null; catalog_url: string | null; catalog_token_env: string | null };

export type ContextPack = {
  thread: Thread;
  contact: Contact;
  recent: Message[];
  block: Message[];
  blockText: string;
  otherChannel?: string;
  companies: Company[];
};

export async function buildContext(thread: Thread): Promise<ContextPack> {
  const contact = (await getContact(thread.contact_id))!;
  const [recent, block, otherChannel, companies] = await Promise.all([
    recentMessages(thread.id, 12),
    unansweredBlock(thread.id),
    otherChannelSummary(contact.id, thread.id),
    q<Company>(`SELECT slug, name, description, topics, site, catalog_url, catalog_token_env FROM companies WHERE active ORDER BY id`),
  ]);
  return { thread, contact, recent, block, blockText: block.map((m) => m.content).join('\n'), otherChannel, companies };
}

export function contactProfile(c: Contact): string {
  return JSON.stringify({
    nome: c.name, empresa: c.company, papel: c.role, estagio: c.crm_stage, tags: c.tags,
    canal: c.phone ? 'whatsapp' : 'email', observacoes: c.notes ?? undefined,
  });
}

export function companiesText(companies: Company[]): string {
  if (!companies.length) return '- SelfMachine';
  return companies.map((c) => `- ${c.slug}: ${c.name} — ${c.description}${c.topics ? ` (sinais: ${c.topics})` : ''}${c.site ? ` · site ${c.site}` : ''}`).join('\n');
}

const senderLabel = (a: Agent | null) => (a === 'HUMAN' ? '[EQUIPE]' : a ? `[${a}]` : '');

/** Historico como mensagens do modelo; conteudo do cliente sempre entre tags (nao confiavel). */
export function toModelMessages(recent: Message[], channel: Thread['channel']): ModelMessage[] {
  const tag = channel === 'GMAIL' ? 'email' : 'mensagem_cliente';
  const out: ModelMessage[] = [];
  for (const m of recent) {
    if (m.status === 'DRAFT') continue; // rascunho nao enviado: o cliente nao viu
    if (m.direction === 'INBOUND') {
      const quoted = m.metadata?.quotedText ? `(respondendo a: "${m.metadata.quotedText.slice(0, 200)}")\n` : '';
      out.push({ role: 'user', content: fence(tag, quoted + maskSensitive(m.content)) });
    } else {
      // o que os agentes mandaram aparece sem rotulo: para o cliente e tudo a mesma pessoa
      out.push({ role: 'assistant', content: m.sender === 'HUMAN' ? `[EQUIPE] ${m.content}` : m.content.replace(/^⁣/, '') });
    }
  }
  // o modelo precisa terminar numa mensagem do usuario
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
  if (!out.length) out.push({ role: 'user', content: fence(tag, '(sem mensagem)') });
  return out;
}

export function historyText(recent: Message[]): string {
  return recent
    .filter((m) => m.status !== 'DRAFT')
    .map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : senderLabel(m.sender) || 'BOT'}: ${maskSensitive(m.content).slice(0, 500)}`)
    .join('\n');
}
