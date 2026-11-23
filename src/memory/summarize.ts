import { generateObject } from 'ai';
import { z } from 'zod';
import { loadPrompt } from '../agents/prompts.js';
import { getThread, setThread } from '../domain/repo.js';
import type { Message } from '../domain/types.js';
import { q } from '../lib/db.js';
import { addCost, costUsd, withFallback } from '../lib/llm.js';
import { fence } from '../lib/util.js';
import { historyText } from './context.js';

const Item = z.object({ o_que: z.string(), quando: z.string().nullable(), por: z.string().nullable() });
const Promise_ = z.object({ o_que: z.string(), prazo: z.string().nullable(), por: z.string().nullable() });

const SummaryOut = z.object({
  summary: z.string().max(2500),
  facts: z.object({
    cliente: z.object({ empresa: z.string().nullable(), segmento: z.string().nullable(), cidade: z.string().nullable() }),
    equipamentos: z.array(z.object({ modelo: z.string(), serial: z.string().nullable(), desde: z.string().nullable() })),
    interesse: z.array(z.string()),
    decisoes: z.array(Item),
    promessas: z.array(Promise_),
    pendencias: z.array(z.string()),
    sentimento: z.string(),
  }),
});

/** Atualiza summary e facts da thread com as mensagens novas desde o ultimo resumo. */
export async function summarizeThread(threadId: string) {
  const thread = await getThread(threadId);
  if (!thread) return;
  const msgs = await q<Message>(
    `SELECT * FROM messages WHERE thread_id = $1 AND status <> 'DRAFT' ORDER BY created_at DESC LIMIT $2`,
    [threadId, Math.max(12, thread.msgs_since_summary + 4)],
  );
  if (!msgs.length) return;
  const r = await withFallback('summary', ({ model }) =>
    generateObject({
      model,
      schema: SummaryOut,
      system: loadPrompt('resumo'),
      prompt: [
        fence('resumo_anterior', thread.summary ?? '(nenhum)'),
        fence('fatos_atuais', JSON.stringify(thread.facts ?? {})),
        fence('mensagens_novas', historyText(msgs.reverse())),
      ].join('\n\n'),
      maxRetries: 1,
    }),
  );
  // garantia em codigo: promessas antigas nao somem sem decisao explicita do modelo de cumprir/cancelar
  const old = ((thread.facts as any)?.promessas ?? []) as Array<{ o_que: string }>;
  const kept = r.object.facts.promessas;
  for (const p of old) {
    if (!kept.some((k) => k.o_que === p.o_que) && !r.object.summary.toLowerCase().includes('cumprid') && !r.object.summary.toLowerCase().includes('cancelad')) {
      kept.push(p as any);
    }
  }
  await setThread(threadId, { summary: r.object.summary, facts: r.object.facts, msgs_since_summary: 0 });
  await addCost(costUsd(r.modelSpec, r.usage.inputTokens, r.usage.outputTokens));
}
