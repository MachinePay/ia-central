import { q } from '../lib/db.js';
import { instanceRole } from '../lib/env.js';
import { searchKnowledge } from './kb.js';
import { getPersonaProfile, HUMAN_TEXT_FILTER } from './persona.js';

/**
 * "Como essa pessoa escreve": o perfil de escrita da pessoa do numero + mensagens reais dela.
 * No numero pessoal (papel GABRIEL) so vale o jeito dele; nos numeros de atendimento entram tambem
 * as anotacoes de estilo que o aprendiz fez da equipe. Cache de 10 min por numero.
 */
const cache = new Map<string, { at: number; text: string }>();
export const clearStyleCache = () => cache.clear();

export async function styleFor(instance: string, company: string | null): Promise<string> {
  const key = `${instance}|${company ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.text;
  const personal = instanceRole(instance) === 'GABRIEL';
  const [profile, examples] = await Promise.all([
    getPersonaProfile(instance),
    q<{ content: string }>(
      `SELECT content FROM (
         SELECT DISTINCT ON (left(m.content, 60)) m.content, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id
          WHERE m.sender = 'HUMAN' AND t.instance = $1 AND ${HUMAN_TEXT_FILTER}
          ORDER BY left(m.content, 60), m.created_at DESC) x
       ORDER BY created_at DESC LIMIT $2`,
      [instance, personal ? 50 : 30],
    ),
  ]);
  const notes = personal ? [] : await q<{ content: string }>(
    `SELECT content FROM knowledge_chunks WHERE active AND kind = 'estilo' AND instance = $2
        AND ($1::text IS NULL OR company_slug IS NULL OR company_slug = $1)
        AND content !~* '(assistente|rob[oô]|\\mia\\M)'
      ORDER BY updated_at DESC LIMIT 6`,
    [company, instance],
  );
  const text = [
    profile ? `Seu jeito de escrever (siga à risca):\n${profile.content}` : '',
    examples.length ? `Mensagens reais que você mandou (copie o jeito, não o conteúdo):\n${examples.reverse().map((e) => `- ${e.content.replace(/⁣/g, '').replace(/\n/g, ' / ').slice(0, 220)}`).join('\n')}` : '',
    notes.length ? `Anotações sobre o jeito da equipe atender:\n${notes.map((n) => `- ${n.content.slice(0, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  cache.set(key, { at: Date.now(), text });
  return text;
}

/** O que voce sabe sobre o assunto da mensagem: procedimentos, regras e respostas aprendidas. */
export async function knowledgeFor(text: string, company: string | null, instance: string): Promise<{ text: string; evidence: string[] }> {
  if (text.trim().length < 3) return { text: '', evidence: [] };
  const chunks = await searchKnowledge(text.slice(0, 500), company, 5, ['procedimento', 'politica', 'faq', 'produto', 'contato', 'manual'], instance).catch(() => []);
  if (!chunks.length) return { text: '', evidence: [] };
  return {
    text: chunks.map((c) => `### ${c.title}${c.company_slug ? ` (${c.company_slug})` : ''}\n${c.content}`).join('\n\n'),
    evidence: chunks.map((c) => c.content),
  };
}
