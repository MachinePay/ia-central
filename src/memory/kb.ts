import { embed, embedMany } from 'ai';
import { q } from '../lib/db.js';
import { env } from '../lib/env.js';
import { embeddingModel } from '../lib/llm.js';

export type Chunk = { id: string; title: string; content: string; source: string; kind: string; company_slug: string | null };

const toVec = (v: number[]) => `[${v.join(',')}]`;

export async function embedText(text: string): Promise<number[] | undefined> {
  if (!env.OPENAI_API_KEY) return undefined;
  const { embedding } = await embed({ model: embeddingModel(), value: text.slice(0, 8000) });
  return embedding;
}

/**
 * Busca hibrida: vetorial + palavra-chave (codigos como "E-102" se perdem na vetorial).
 * Junta as duas listas por Reciprocal Rank Fusion.
 */
/** instance: so o que foi aprendido neste numero + o que foi escrito no painel para todos (instance NULL). */
export async function searchKnowledge(query: string, company: string | null, k = 5, kinds?: string[], instance?: string): Promise<Chunk[]> {
  const filters = `active AND kind <> 'persona' AND ($2::text IS NULL OR company_slug IS NULL OR company_slug = $2) AND ($3::text[] IS NULL OR kind = ANY($3))
    AND (instance IS NULL OR instance = $5)`;
  const vec = await embedText(query).catch(() => undefined);
  const vectorRows = vec
    ? await q<Chunk>(
        `SELECT id, title, content, source, kind, company_slug FROM knowledge_chunks
          WHERE ${filters} AND embedding IS NOT NULL AND $4::int IS NULL ORDER BY embedding <=> $1::vector LIMIT 10`,
        [toVec(vec), company, kinds ?? null, null, instance ?? ''],
      )
    : [];
  const codes = query.match(/\b[A-Z]{1,4}-?\d{2,5}\b/g) ?? [];
  const keywordRows = await q<Chunk>(
    `SELECT id, title, content, source, kind, company_slug FROM knowledge_chunks
      WHERE ${filters} AND (search @@ websearch_to_tsquery('portuguese', $1) OR (cardinality($4::text[]) > 0 AND content ILIKE ANY($4)))
      ORDER BY ts_rank(search, websearch_to_tsquery('portuguese', $1)) DESC LIMIT 10`,
    [query, company, kinds ?? null, codes.map((c) => `%${c}%`), instance ?? ''],
  );
  const score = new Map<string, { c: Chunk; s: number }>();
  for (const [list, w] of [[vectorRows, 1], [keywordRows, 1.2]] as const) {
    list.forEach((c, i) => {
      const cur = score.get(c.id) ?? { c, s: 0 };
      cur.s += w / (60 + i);
      score.set(c.id, cur);
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.c);
}

/** Gera embeddings que faltam (depois da migracao ou de inserir conhecimento novo). */
export async function backfillEmbeddings(batch = 64): Promise<number> {
  if (!env.OPENAI_API_KEY) return 0;
  const rows = await q<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM knowledge_chunks WHERE embedding IS NULL AND active LIMIT $1`, [batch],
  );
  if (!rows.length) return 0;
  const { embeddings } = await embedMany({ model: embeddingModel(), values: rows.map((r) => `${r.title}\n${r.content}`.slice(0, 8000)) });
  for (const [i, r] of rows.entries()) await q(`UPDATE knowledge_chunks SET embedding = $2::vector WHERE id = $1`, [r.id, toVec(embeddings[i])]);
  return rows.length;
}

export async function addKnowledge(o: { title: string; content: string; source: string; kind?: string; company?: string | null; instance?: string | null }) {
  await q(
    `INSERT INTO knowledge_chunks (title, content, source, kind, company_slug, instance) VALUES ($1, $2, $3, $4, $5, $6)`,
    [o.title, o.content, o.source, o.kind ?? 'faq', o.company ?? null, o.instance ?? null],
  );
}
