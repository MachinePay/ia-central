import { q } from '../lib/db.js';
import { searchKnowledge } from './kb.js';

/**
 * "Como essa pessoa escreve": mensagens reais que a pessoa/equipe mandou por este numero
 * + o que o aprendiz anotou sobre o estilo. Cache de 10 min por numero.
 */
const cache = new Map<string, { at: number; text: string }>();

export async function styleFor(instance: string, company: string | null): Promise<string> {
  const key = `${instance}|${company ?? ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.text;
  const examples = await q<{ content: string }>(
    `SELECT content FROM (
       SELECT DISTINCT ON (left(m.content, 60)) m.content, m.created_at FROM app.messages m JOIN app.threads t ON t.id = m.thread_id
        WHERE m.sender = 'HUMAN' AND t.instance = $1 AND length(m.content) BETWEEN 2 AND 400 AND left(m.content, 1) <> '['
          AND m.content !~* '(senha|pix:|cpf|cnpj|\\d{3}\\.\\d{3}\\.\\d{3})'
          -- mensagens do robo antigo (n8n) tambem sairam por este numero: nao sao o jeito da pessoa
          AND m.content !~* '(assistente|🤖|intelig[eê]ncia artificial|\\mia\\M|\\mbot\\M|rob[oô]|atendimento autom|📝 rascunho|aprova[cç][aã]o #|\\[aprova)'
          AND m.content !~ '^\\s*[•\\-\\*] '
        ORDER BY left(m.content, 60), m.created_at DESC) x
     ORDER BY created_at DESC LIMIT 30`,
    [instance],
  );
  const sample = examples.reverse().map((e) => `- ${e.content.replace(/⁣/g, '').replace(/\n/g, ' / ').slice(0, 220)}`);
  const notes = await q<{ title: string; content: string }>(
    `SELECT title, content FROM app.knowledge_chunks WHERE active AND kind = 'estilo' AND ($1::text IS NULL OR company_slug IS NULL OR company_slug = $1)
        AND content !~* '(assistente|rob[oô]|\\mia\\M)'
      ORDER BY updated_at DESC LIMIT 6`,
    [company],
  );
  const text = [
    sample.length ? `Mensagens reais que você mandou por este número (copie o jeito, não o conteúdo):\n${sample.join('\n')}` : '',
    notes.length ? `Anotações sobre o seu jeito de atender:\n${notes.map((n) => `- ${n.content.slice(0, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  cache.set(key, { at: Date.now(), text });
  return text;
}

/** O que voce sabe sobre o assunto da mensagem: procedimentos, regras e respostas aprendidas. */
export async function knowledgeFor(text: string, company: string | null): Promise<{ text: string; evidence: string[] }> {
  if (text.trim().length < 3) return { text: '', evidence: [] };
  const chunks = await searchKnowledge(text.slice(0, 500), company, 5, ['procedimento', 'politica', 'faq', 'produto', 'contato', 'manual']).catch(() => []);
  if (!chunks.length) return { text: '', evidence: [] };
  return {
    text: chunks.map((c) => `### ${c.title}${c.company_slug ? ` (${c.company_slug})` : ''}\n${c.content}`).join('\n\n'),
    evidence: chunks.map((c) => c.content),
  };
}
