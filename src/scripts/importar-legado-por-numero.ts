/**
 * Traz do sistema antigo (schema "nucleo") o que cada IA aprendeu, cada coisa para o NUMERO certo:
 *   leo -> nucleo | gabriel -> gabriel | joao -> joao | suporte -> suporte
 *  1. Memorias/aprendizados (nucleo.conhecimento.agente) -> app.knowledge_chunks.instance (inclui as pessoais)
 *  2. Registro das conversas (nucleo.conversas) -> app.messages, so o que a pessoa e o contato escreveram
 *     (o que o robo antigo respondeu fica de fora: nao e o jeito da pessoa)
 *  3. Perfis de contato (nucleo.perfis_contato) -> app.contacts.treatment (jeito com aquele contato)
 * Idempotente: pode rodar de novo sem duplicar.
 */
import { pool } from '../lib/db.js';

// uma conexao so: a tabela temporaria precisa estar na mesma sessao
const client = await pool.connect();
const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await client.query(text, params as any[])).rows as T[];

const AGENT_TO_INSTANCE = `CASE WHEN {a} LIKE 'leo%' OR {a} = 'ia-pessoal' THEN 'nucleo' WHEN {a} LIKE 'gabriel%' THEN 'gabriel'
  WHEN {a} LIKE 'suporte%' THEN 'suporte' WHEN {a} LIKE 'joao%' OR {a} IN ('humano', 'cliente') THEN 'joao' END`;
const inst = (col: string) => AGENT_TO_INSTANCE.replaceAll('{a}', col);
// telefone: so digitos, com 55 e nono digito (mesma regra do sistema novo)
const PHONE = (col: string) => `(SELECT CASE WHEN length(d) IN (10, 11) THEN '55' || d ELSE d END FROM (SELECT regexp_replace(split_part(${col}, ' ', 1), '\\D', '', 'g') AS d) x)`;
const FIX9 = (col: string) => `CASE WHEN length(${col}) = 12 AND left(${col}, 2) = '55' AND substr(${col}, 5, 1) ~ '[6-9]' THEN left(${col}, 4) || '9' || substr(${col}, 5) ELSE ${col} END`;

async function exists(t: string) { return (await q<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t]))[0]?.ok; }
async function hasColumn(t: string, c: string) {
  return (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'nucleo' AND table_name = $1 AND column_name = $2`, [t, c])).length > 0;
}
const report: Record<string, number | string> = {};

// ------------------------------------------------------------------ 1. memorias e aprendizados por numero
if (await exists('nucleo.conhecimento')) {
  const agenteCol = (await hasColumn('conhecimento', 'agente')) ? 'k.agente' : `coalesce(k.metadata->>'agente', CASE WHEN k.dominio = 'pessoal' THEN 'leo' ELSE 'joao' END)`;
  const r1 = await client.query(
    `INSERT INTO app.knowledge_chunks (company_slug, kind, source, title, content, legacy_ref, active, updated_at, instance)
     SELECT nullif(k.metadata->>'empresa', ''),
            CASE WHEN k.dominio = 'pessoal' THEN 'memoria' ELSE 'faq' END,
            'legado:' || coalesce(k.origem, 'conhecimento') || ':' || ${agenteCol},
            coalesce(nullif(k.titulo, ''), left(k.conteudo, 80)), k.conteudo, 'conhecimento:' || k.id, true, k.criado_em,
            ${inst(agenteCol)}
       FROM nucleo.conhecimento k
      WHERE k.aprovado AND ${inst(agenteCol)} IS NOT NULL
     ON CONFLICT (legacy_ref) DO UPDATE SET instance = EXCLUDED.instance, kind = EXCLUDED.kind, source = EXCLUDED.source`,
  );
  report.memorias_e_aprendizados = r1.rowCount ?? 0;
  const byInst = await q(`SELECT instance, kind, count(*)::int n FROM app.knowledge_chunks WHERE legacy_ref LIKE 'conhecimento:%' GROUP BY 1, 2 ORDER BY 1, 2`);
  report.por_numero = byInst.map((x: any) => `${x.instance}/${x.kind}: ${x.n}`).join(' · ');
}

// ------------------------------------------------------------------ 2. registro das conversas -> mensagens de cada numero
if (await exists('nucleo.conversas')) {
  const instCol = (await hasColumn('conversas', 'instancia')) ? `coalesce(c.instancia, ${inst('c.agente')})` : inst('c.agente');
  await q(`DROP TABLE IF EXISTS pg_temp.leg`);
  await q(
    `CREATE TEMP TABLE leg AS
     SELECT c.id, ${instCol} AS instance, ${FIX9(PHONE('c.contato'))} AS phone,
            nullif(substring(c.contato from '\\((.*)\\)'), '') AS name, c.papel, c.mensagem, c.criado_em
       FROM nucleo.conversas c
      WHERE c.canal = 'whatsapp' AND c.papel IN ('humano', 'usuario') AND c.agente NOT IN ('ia-pessoal', 'dono')
        AND length(c.mensagem) BETWEEN 1 AND 2000 AND c.mensagem !~ '^\\[(audio|imagem|video|documento|sticker)\\]$'`,
  );
  await q(`DELETE FROM leg WHERE instance IS NULL OR length(phone) < 10`);
  report.mensagens_lidas = (await q<{ n: number }>(`SELECT count(*)::int n FROM leg`))[0].n;
  await client.query(
    `INSERT INTO app.contacts (phone, name) SELECT DISTINCT ON (phone) phone, name FROM leg ORDER BY phone, (name IS NULL)
     ON CONFLICT (phone) DO UPDATE SET name = coalesce(app.contacts.name, EXCLUDED.name)`,
  );
  await client.query(
    `INSERT INTO app.threads (contact_id, channel, instance, external_id, created_at, updated_at)
     SELECT ct.id, 'WHATSAPP', l.instance, l.phone || '@s.whatsapp.net', min(l.criado_em), max(l.criado_em)
       FROM leg l JOIN app.contacts ct ON ct.phone = l.phone GROUP BY ct.id, l.instance, l.phone
     ON CONFLICT (channel, instance, external_id) DO NOTHING`,
  );
  const ins = await client.query(
    `INSERT INTO app.messages (thread_id, external_id, direction, sender, status, content, created_at, learned_at)
     SELECT t.id, 'legado:conversas:' || l.id, CASE WHEN l.papel = 'humano' THEN 'OUTBOUND' ELSE 'INBOUND' END::app.direction,
            CASE WHEN l.papel = 'humano' THEN 'HUMAN' END::app.agent, CASE WHEN l.papel = 'humano' THEN 'SENT' ELSE 'DONE' END,
            l.mensagem, l.criado_em, now()
       FROM leg l JOIN app.threads t ON t.channel = 'WHATSAPP' AND t.instance = l.instance AND t.external_id = l.phone || '@s.whatsapp.net'
     ON CONFLICT (external_id) DO NOTHING`,
  );
  report.mensagens_importadas = ins.rowCount ?? 0;
  // threads que so tem historico antigo nao podem parecer conversa de hoje
  await q(
    `UPDATE app.threads t SET updated_at = x.last FROM (
       SELECT thread_id, max(created_at) AS last FROM app.messages GROUP BY thread_id) x
      WHERE x.thread_id = t.id AND t.last_inbound_at IS NULL AND t.last_outbound_at IS NULL AND t.updated_at > x.last`,
  );
  const per = await q(`SELECT instance, count(*) FILTER (WHERE papel = 'humano')::int AS da_pessoa, count(*)::int AS total FROM leg GROUP BY 1 ORDER BY 1`);
  report.conversas_por_numero = per.map((x: any) => `${x.instance}: ${x.da_pessoa} da pessoa / ${x.total}`).join(' · ');
}

// ------------------------------------------------------------------ 3. perfis de contato -> jeito com cada contato
if (await exists('nucleo.perfis_contato')) {
  const r3 = await client.query(
    `WITH p AS (
       SELECT DISTINCT ON (ph) ${FIX9(PHONE('numero'))} AS ph, nome, relacao, tom, resumo, cuidados, atualizado_em
         FROM nucleo.perfis_contato ORDER BY ph, editado_manual DESC, atualizado_em DESC)
     UPDATE app.contacts c SET
       treatment = concat_ws(E'\\n', 'Relação: ' || p.relacao, CASE WHEN p.tom <> '' THEN 'Tom: ' || p.tom END,
                             CASE WHEN p.resumo <> '' THEN 'Quem é: ' || p.resumo END, CASE WHEN p.cuidados <> '' THEN 'Cuidados: ' || p.cuidados END),
       treatment_at = p.atualizado_em,
       role = CASE WHEN p.relacao IN ('amigo', 'familia', 'namorada_conjuge') THEN 'PESSOAL' ELSE c.role END,
       name = coalesce(c.name, p.nome)
      FROM p WHERE c.phone = p.ph AND c.treatment IS NULL AND NOT c.treatment_manual`,
  );
  report.jeito_com_contatos = r3.rowCount ?? 0;
}

console.table(report);
client.release();
await pool.end();
