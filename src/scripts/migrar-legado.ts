/**
 * Leva o que o sistema antigo aprendeu (schema "nucleo", que fica intacto) para o schema novo "app".
 * Idempotente: pode rodar quantas vezes quiser. Rode depois de `npm run db:migrate`.
 *   - nucleo.empresas            -> app.companies
 *   - nucleo.empresa_base        -> app.knowledge_chunks (ativos)
 *   - nucleo.conhecimento        -> app.knowledge_chunks (aprovados, dominio != pessoal)
 *   - nucleo.multi_lacunas       -> app.knowledge_gaps (nao resolvidas)
 *   - nucleo.clientes            -> app.contacts (CLIENTE/LEAD) + app.leads
 *   - nucleo.perfis_contato      -> app.contacts.notes (tom, resumo, cuidados) e papel PESSOAL para familia/amigos
 * Embeddings sao gerados depois pelo worker (job "embeddings").
 */
import { pool, q } from '../lib/db.js';
import { normalizePhone } from '../lib/phone.js';

async function exists(table: string) {
  const r = await q<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
  return r[0]?.ok;
}

async function count(sql: string, params: unknown[] = []) {
  const r = await pool.query(sql, params as any[]);
  return r.rowCount ?? 0;
}

const report: Record<string, number> = {};

if (await exists('nucleo.empresas')) {
  report.empresas = await count(
    `INSERT INTO app.companies (slug, name, description, topics, site, catalog_url, catalog_token_env, active)
     SELECT slug, nome, descricao, assuntos, site, nullif(catalogo_url, ''), nullif(catalogo_env, ''), ativo FROM nucleo.empresas
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, topics = EXCLUDED.topics,
       site = EXCLUDED.site, catalog_url = EXCLUDED.catalog_url, catalog_token_env = EXCLUDED.catalog_token_env, active = EXCLUDED.active`,
  );
}

if (await exists('nucleo.empresa_base')) {
  report.base_empresas = await count(
    `INSERT INTO app.knowledge_chunks (company_slug, kind, source, title, content, legacy_ref, active, updated_at)
     SELECT e.slug, b.tipo, 'legado:empresa_base' || coalesce(' (' || b.responsavel || ')', ''), b.titulo, b.conteudo,
            'empresa_base:' || b.id, b.ativo, b.atualizado_em
       FROM nucleo.empresa_base b JOIN nucleo.empresas e ON e.id = b.empresa_id
     ON CONFLICT (legacy_ref) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, kind = EXCLUDED.kind,
       active = EXCLUDED.active, updated_at = EXCLUDED.updated_at,
       embedding = CASE WHEN app.knowledge_chunks.content = EXCLUDED.content THEN app.knowledge_chunks.embedding END`,
  );
}

if (await exists('nucleo.conhecimento')) {
  report.conhecimento = await count(
    `INSERT INTO app.knowledge_chunks (company_slug, kind, source, title, content, legacy_ref, active, updated_at)
     SELECT nullif(metadata->>'empresa', ''), 'faq', 'legado:conhecimento:' || dominio || coalesce(':' || origem, ''),
            coalesce(nullif(titulo, ''), left(conteudo, 80)), conteudo, 'conhecimento:' || id, true, criado_em
       FROM nucleo.conhecimento WHERE aprovado AND dominio <> 'pessoal'
     ON CONFLICT (legacy_ref) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content`,
  );
}

if (await exists('nucleo.multi_lacunas')) {
  report.perguntas_sem_resposta = await count(
    `INSERT INTO app.knowledge_gaps (company_slug, question, created_at)
     SELECT e.slug, l.pergunta, l.criado_em FROM nucleo.multi_lacunas l LEFT JOIN nucleo.empresas e ON e.id = l.empresa_id
      WHERE l.resolvida_em IS NULL
        AND NOT EXISTS (SELECT 1 FROM app.knowledge_gaps g WHERE g.question = l.pergunta)`,
  );
}

if (await exists('nucleo.clientes')) {
  const rows = await q<{ whatsapp: string; nome: string | null; empresa: string | null; interesse: string | null; etapa: string; observacoes: string | null }>(
    `SELECT whatsapp, nome, empresa, interesse, etapa, observacoes FROM nucleo.clientes WHERE coalesce(whatsapp, '') <> ''`,
  );
  const stage: Record<string, string> = { novo: 'NEW', lead: 'QUALIFIED', cliente: 'CUSTOMER', perdido: 'LOST' };
  for (const r of rows) {
    const phone = normalizePhone(r.whatsapp);
    if (!phone) continue;
    const c = await q<{ id: string }>(
      `INSERT INTO app.contacts (phone, name, company, role, crm_stage, notes) VALUES ($1, $2, $3, $4, $5::app.crm_stage, $6)
       ON CONFLICT (phone) DO UPDATE SET name = coalesce(app.contacts.name, EXCLUDED.name), company = coalesce(app.contacts.company, EXCLUDED.company),
         role = CASE WHEN app.contacts.role = 'LEAD' THEN EXCLUDED.role ELSE app.contacts.role END
       RETURNING id`,
      [phone, r.nome, r.empresa, r.etapa === 'cliente' ? 'CLIENTE' : 'LEAD', stage[r.etapa] ?? 'NEW', r.observacoes],
    );
    if (r.interesse && c[0]) {
      await q(`INSERT INTO app.leads (contact_id, interest) VALUES ($1, $2) ON CONFLICT (contact_id) DO UPDATE SET interest = coalesce(app.leads.interest, EXCLUDED.interest)`, [c[0].id, r.interesse]);
    }
  }
  report.clientes = rows.length;
}

if (await exists('nucleo.perfis_contato')) {
  const rows = await q<{ numero: string; nome: string | null; relacao: string; tom: string | null; resumo: string | null; cuidados: string | null }>(
    `SELECT DISTINCT ON (numero) numero, nome, relacao, tom, resumo, cuidados FROM nucleo.perfis_contato ORDER BY numero, atualizado_em DESC`,
  );
  const pessoal = new Set(['amigo', 'familia', 'namorada_conjuge']);
  for (const r of rows) {
    const phone = normalizePhone(r.numero);
    if (!phone) continue;
    const notes = [r.tom && `Tom: ${r.tom}`, r.resumo && `Perfil: ${r.resumo}`, r.cuidados && `Cuidados: ${r.cuidados}`].filter(Boolean).join(' | ') || null;
    const role = pessoal.has(r.relacao) ? 'PESSOAL' : r.relacao === 'cliente' || r.relacao === 'cliente_antigo' ? 'CLIENTE' : r.relacao === 'trabalho' ? 'PARCEIRO' : 'LEAD';
    await q(
      `INSERT INTO app.contacts (phone, name, role, notes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET name = coalesce(app.contacts.name, EXCLUDED.name),
         notes = coalesce(app.contacts.notes, EXCLUDED.notes),
         role = CASE WHEN EXCLUDED.role = 'PESSOAL' THEN 'PESSOAL' ELSE app.contacts.role END`,
      [phone, r.nome, role, notes],
    );
  }
  report.perfis = rows.length;
}

console.table(report);
await pool.end();
