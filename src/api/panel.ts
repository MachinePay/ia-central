import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { decideApproval } from '../approvals/approvals.js';
import { connectionState } from '../channels/whatsapp/evolution.js';
import { deliver } from '../delivery.js';
import { getThread, setThread } from '../domain/repo.js';
import type { Agent } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { EDITABLE_SETTINGS, env, instanceRoles, personaFor, setting, type EditableSetting } from '../lib/env.js';
import { buildPersonaProfile, countPersonaMessages, getPersonaProfile, savePersonaProfile } from '../memory/persona.js';
import { EVENTS_CHANNEL } from '../lib/events.js';
import { costToday } from '../lib/llm.js';
import { normalizePhone } from '../lib/phone.js';
import { cancelPendingRespond } from '../lib/queues.js';
import { keys, redis, redisOptions } from '../lib/redis.js';
import { saveSetting } from '../lib/settings.js';
import { addKnowledge } from '../memory/kb.js';
import { checkUrl } from '../sentinela/collectors/urls.js';
import { costSummary } from '../sentinela/costs.js';
import { ack, resolveManually } from '../sentinela/incidents.js';
import { sendAlert } from '../sentinela/notify.js';
import { login, requireAuth } from './auth.js';

const user = (req: any): string => req.user ?? 'painel';
const bad = (reply: any, msg: string, code = 400) => reply.code(code).send({ error: msg });

export async function panelRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ login
  app.post('/api/login', async (req, reply) => {
    const b = z.object({ user: z.string(), password: z.string() }).safeParse(req.body);
    if (!b.success) return bad(reply, 'Informe usuário e senha.');
    const token = await login(req.ip, b.data.user, b.data.password);
    if (!token) return bad(reply, 'Usuário ou senha incorretos.', 401);
    return { token, user: b.data.user };
  });

  app.register(async (api) => {
    api.addHook('onRequest', requireAuth);

    // ---------------------------------------------------------------- inicio
    api.get('/api/summary', async () => {
      const [approvals, incidents, unanswered, promises, today, events, takeovers] = await Promise.all([
        q(`SELECT a.id, a.code, a.action, a.requested_by, a.created_at, coalesce(c.name, c.phone, c.email) AS contact, a.thread_id
             FROM app.pending_approvals a JOIN app.threads t ON t.id = a.thread_id JOIN app.contacts c ON c.id = t.contact_id
            WHERE a.status = 'PENDING' ORDER BY a.created_at`),
        q(`SELECT id, severity, title, status, opened_at FROM sentinela.incidents WHERE status <> 'RESOLVED' ORDER BY severity DESC, opened_at`),
        q(`SELECT t.id, t.instance, coalesce(c.name, c.phone, c.email) AS contact, t.last_inbound_at
             FROM app.threads t JOIN app.contacts c ON c.id = t.contact_id
            WHERE t.last_inbound_at > now() - interval '3 days' AND t.last_inbound_at < now() - interval '1 hour'
              AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)
            ORDER BY t.last_inbound_at LIMIT 20`),
        q(`SELECT t.id AS thread_id, coalesce(c.name, c.phone, c.email) AS contact, p->>'o_que' AS what, p->>'prazo' AS due
             FROM app.threads t JOIN app.contacts c ON c.id = t.contact_id, jsonb_array_elements(coalesce(t.facts->'promessas', '[]')) p
            WHERE (p->>'prazo') ~ '^\\d{4}-\\d{2}-\\d{2}$' AND (p->>'prazo')::date <= current_date LIMIT 20`),
        one(`SELECT
               (SELECT count(DISTINCT thread_id)::int FROM app.messages WHERE direction = 'INBOUND' AND created_at::date = current_date) AS conversations,
               (SELECT coalesce(avg(latency_ms), 0)::int FROM app.agent_runs WHERE created_at::date = current_date AND latency_ms > 0) AS avg_latency_ms,
               (SELECT count(*)::int FROM sentinela.incidents WHERE opened_at::date = current_date) AS incidents,
               (SELECT count(*)::int FROM app.agent_runs WHERE created_at::date = current_date AND outcome IN ('DRAFT','SENT')) AS replies`),
        redis.lrange('painel:events:log', 0, 49),
        countTakeovers(),
      ]);
      return {
        needsYou: { approvals, incidents, unanswered, promises, takeovers },
        today: { ...(today as object), costUsd: await costToday() },
        timeline: events.map((e) => JSON.parse(e)),
      };
    });

    // ---------------------------------------------------------------- conversas
    api.get('/api/threads', async (req) => {
      const f = req.query as Record<string, string | undefined>;
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };
      if (f.channel) add(`t.channel = $?::app.channel`, f.channel);
      if (f.instance) add(`t.instance = ANY(string_to_array($?, ','))`, f.instance);
      if (f.agent) add(`t.active_agent::text = ANY(string_to_array($?, ','))`, f.agent);
      if (f.status) add(`t.status::text = ANY(string_to_array($?, ','))`, f.status);
      if (f.stage) add(`c.crm_stage::text = ANY(string_to_array($?, ','))`, f.stage);
      if (f.tag) add(`$? = ANY(c.tags)`, f.tag);
      if (f.pending === '1') where.push(`EXISTS (SELECT 1 FROM app.pending_approvals a WHERE a.thread_id = t.id AND a.status = 'PENDING')`);
      if (f.unanswered === '1') where.push(`t.last_inbound_at IS NOT NULL AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)`);
      if (f.since) add(`coalesce(t.last_inbound_at, t.updated_at) > now() - make_interval(hours => $?::int)`, Number(f.since));
      if (f.q) add(`(c.name ILIKE $? OR c.phone LIKE '%' || regexp_replace($?, '\\D', '', 'g') || '%' OR c.email ILIKE $?
                     OR EXISTS (SELECT 1 FROM app.messages m2 WHERE m2.thread_id = t.id AND m2.content ILIKE $?))`.replace(/\$\?/g, `$${params.length + 1}`), `%${f.q}%`);
      if (f.cursor) add(`coalesce(lm.created_at, t.updated_at) < $?::timestamptz`, f.cursor);
      const rows = await q(
        `SELECT t.id, t.channel, t.instance, t.active_agent, t.status, t.company_slug, t.subject,
                c.id AS contact_id, coalesce(c.name, c.phone, c.email) AS contact, c.phone, c.email, c.tags, c.crm_stage, c.role,
                lm.content AS last_content, lm.direction AS last_direction, lm.sender AS last_sender, lm.status AS last_status,
                coalesce(lm.created_at, t.updated_at) AS last_at,
                (SELECT count(*)::int FROM app.pending_approvals a WHERE a.thread_id = t.id AND a.status = 'PENDING') AS pending,
                (t.last_inbound_at IS NOT NULL AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)) AS unanswered
           FROM app.threads t JOIN app.contacts c ON c.id = t.contact_id
           LEFT JOIN LATERAL (SELECT content, direction, sender, status, created_at FROM app.messages m
                               WHERE m.thread_id = t.id ORDER BY created_at DESC LIMIT 1) lm ON true
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY coalesce(lm.created_at, t.updated_at) DESC LIMIT 50`,
        params,
      );
      const flags = rows.length ? await redis.mget(rows.map((r: any) => keys.takeover(r.id))) : [];
      let out = rows.map((r: any, i) => ({ ...r, last_content: String(r.last_content ?? '').replace(/^⁣/, '').slice(0, 140), takeover: !!flags[i] }));
      if (f.takeover === '1') out = out.filter((r) => r.takeover);
      return { items: out, nextCursor: rows.length === 50 ? (rows[49] as any).last_at : null };
    });

    api.get<{ Params: { id: string } }>('/api/threads/:id', async (req, reply) => {
      const thread = await getThread(req.params.id);
      if (!thread) return bad(reply, 'Conversa não encontrada.', 404);
      const [contact, messages, approvals, tickets, runs, other, takeover] = await Promise.all([
        one(`SELECT * FROM app.contacts WHERE id = $1`, [thread.contact_id]),
        q(`SELECT id, direction, sender, status, content, media, metadata - 'raw' AS metadata, created_at FROM app.messages
            WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 200`, [thread.id]),
        q(`SELECT * FROM app.pending_approvals WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 10`, [thread.id]),
        q(`SELECT * FROM app.tickets WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 10`, [thread.contact_id]),
        q(`SELECT id, agent, model, outcome, latency_ms, cost_usd, route, tool_calls, error, created_at FROM app.agent_runs
            WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 15`, [thread.id]),
        q(`SELECT id, channel, instance, summary, updated_at FROM app.threads WHERE contact_id = $1 AND id <> $2`, [thread.contact_id, thread.id]),
        redis.ttl(keys.takeover(thread.id)),
      ]);
      return {
        thread, contact, approvals, tickets, runs, otherThreads: other,
        takeover: takeover === -1 ? { on: true, until: null } : takeover > 0 ? { on: true, until: new Date(Date.now() + takeover * 1000) } : { on: false },
        messages: messages.reverse().map((m: any) => ({ ...m, content: String(m.content).replace(/^⁣/, '') })),
      };
    });

    // assumir (bots em silencio ate devolver) / devolver
    api.post<{ Params: { id: string } }>('/api/threads/:id/takeover', async (req, reply) => {
      const thread = await getThread(req.params.id);
      if (!thread) return bad(reply, 'Conversa não encontrada.', 404);
      await redis.set(keys.takeover(thread.id), user(req));
      await cancelPendingRespond(thread.id);
      return { ok: true };
    });
    api.post<{ Params: { id: string } }>('/api/threads/:id/release', async (req, reply) => {
      const b = z.object({ agent: z.enum(['JOAO', 'CLARA', 'GABRIEL']).optional() }).parse(req.body ?? {});
      const thread = await getThread(req.params.id);
      if (!thread) return bad(reply, 'Conversa não encontrada.', 404);
      await redis.del(keys.takeover(thread.id));
      await setThread(thread.id, { status: 'OPEN', ...(b.agent ? { active_agent: b.agent, pending_handoff: null } : {}) });
      return { ok: true };
    });
    api.post<{ Params: { id: string } }>('/api/threads/:id/status', async (req, reply) => {
      const b = z.object({ status: z.enum(['OPEN', 'PAUSED', 'CLOSED']) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Status inválido.');
      await setThread(req.params.id, { status: b.data.status });
      return { ok: true };
    });
    // escrever como humano: sai na hora e coloca a conversa com voce por 2 h
    api.post<{ Params: { id: string } }>('/api/threads/:id/send', async (req, reply) => {
      const b = z.object({ text: z.string().min(1).max(4000) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Escreva a mensagem.');
      const thread = await getThread(req.params.id);
      if (!thread) return bad(reply, 'Conversa não encontrada.', 404);
      if (!(await redis.exists(keys.takeover(thread.id)))) await redis.set(keys.takeover(thread.id), user(req), 'EX', 7200);
      await cancelPendingRespond(thread.id);
      await deliver({ thread, agent: 'HUMAN', text: b.data.text, force: true });
      return { ok: true };
    });
    api.patch<{ Params: { id: string } }>('/api/threads/:id/facts', async (req, reply) => {
      const b = z.object({ facts: z.record(z.string(), z.unknown()).optional(), summary: z.string().max(3000).optional() }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      await setThread(req.params.id, { ...(b.data.facts ? { facts: b.data.facts } : {}), ...(b.data.summary !== undefined ? { summary: b.data.summary } : {}) });
      return { ok: true };
    });

    // rascunho da IA: enviar (com edicao opcional) ou descartar
    api.post<{ Params: { id: string } }>('/api/messages/:id/send', async (req, reply) => {
      const b = z.object({ text: z.string().max(4000).optional() }).parse(req.body ?? {});
      const m = await one<{ id: string; thread_id: string; sender: Agent; status: string; content: string }>(`SELECT * FROM app.messages WHERE id = $1`, [req.params.id]);
      if (!m || m.status !== 'DRAFT') return bad(reply, 'Esse rascunho já foi usado ou não existe.');
      const thread = (await getThread(m.thread_id))!;
      await q(`UPDATE app.messages SET status = 'DRAFT_DISCARDED' WHERE id = $1`, [m.id]);
      await deliver({ thread, agent: m.sender ?? 'HUMAN', text: (b.text ?? m.content).trim(), force: true });
      return { ok: true };
    });
    api.post<{ Params: { id: string } }>('/api/messages/:id/discard', async (req) => {
      await q(`UPDATE app.messages SET status = 'DRAFT_DISCARDED' WHERE id = $1 AND status = 'DRAFT'`, [req.params.id]);
      return { ok: true };
    });

    api.patch<{ Params: { id: string } }>('/api/contacts/:id', async (req, reply) => {
      const b = z.object({
        name: z.string().max(200).nullable().optional(), company: z.string().max(200).nullable().optional(),
        role: z.enum(['CLIENTE', 'LEAD', 'FORNECEDOR', 'PARCEIRO', 'PESSOAL']).optional(), tags: z.array(z.string().max(40)).max(20).optional(),
        notes: z.string().max(2000).nullable().optional(), crm_stage: z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'CUSTOMER', 'LOST']).optional(),
        opted_out: z.boolean().optional(),
      }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      const cols = Object.entries(b.data).filter(([, v]) => v !== undefined);
      if (!cols.length) return { ok: true };
      await q(
        `UPDATE app.contacts SET ${cols.map(([k], i) => `${k} = $${i + 2}${k === 'crm_stage' ? '::app.crm_stage' : ''}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [req.params.id, ...cols.map(([, v]) => v)],
      );
      return { ok: true };
    });

    // ---------------------------------------------------------------- aprovacoes
    api.get('/api/approvals', async (req) => {
      const status = (req.query as any).status ?? 'PENDING';
      return q(
        `SELECT a.*, coalesce(c.name, c.phone, c.email) AS contact, c.company, c.crm_stage, t.channel, t.instance, t.summary
           FROM app.pending_approvals a JOIN app.threads t ON t.id = a.thread_id JOIN app.contacts c ON c.id = t.contact_id
          WHERE ($1 = 'ALL' OR a.status = $1) ORDER BY a.created_at DESC LIMIT 100`,
        [status],
      );
    });
    api.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (req, reply) => {
      const b = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'EDIT']), text: z.string().max(4000).optional() }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Decisão inválida.');
      try {
        return { status: await decideApproval(req.params.id, b.data.decision, b.data.text) };
      } catch (e: any) {
        return bad(reply, e.message);
      }
    });

    // ---------------------------------------------------------------- agentes
    api.get('/api/agents', async () => {
      const stats = await q(
        `SELECT agent,
                count(*)::int AS runs,
                count(*) FILTER (WHERE created_at::date = current_date)::int AS runs_today,
                count(*) FILTER (WHERE outcome = 'DRAFT')::int AS drafts,
                count(*) FILTER (WHERE outcome = 'SENT')::int AS sent,
                count(*) FILTER (WHERE outcome = 'APPROVAL')::int AS approvals,
                count(*) FILTER (WHERE outcome = 'ERROR')::int AS errors,
                count(*) FILTER (WHERE outcome = 'SILENT')::int AS silent,
                count(*) FILTER (WHERE jsonb_array_length(coalesce(route->'handoffs', '[]')) > 0)::int AS handoffs,
                coalesce(avg(latency_ms) FILTER (WHERE latency_ms > 0), 0)::int AS avg_latency_ms,
                coalesce(sum(cost_usd), 0)::float AS cost_usd,
                coalesce(sum(cost_usd) FILTER (WHERE created_at::date = current_date), 0)::float AS cost_today
           FROM app.agent_runs WHERE created_at > now() - interval '7 days' GROUP BY agent`,
      );
      const active = await q(`SELECT active_agent AS agent, count(*)::int AS n FROM app.threads WHERE last_inbound_at > now() - interval '24 hours' GROUP BY 1`);
      return { stats, active };
    });

    // base de conhecimento
    api.get('/api/knowledge', async (req) => {
      const f = req.query as Record<string, string | undefined>;
      return q(
        `SELECT id, company_slug, instance, kind, source, title, content, active, updated_at, embedding IS NOT NULL AS indexed FROM app.knowledge_chunks
          WHERE ($1::text IS NULL OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR company_slug = $3) AND ($4::text IS NULL OR source LIKE $4 || '%')
            AND ($5::text IS NULL OR instance = $5 OR ($5 = '*' AND instance IS NULL)) AND active AND kind <> 'persona'
          ORDER BY updated_at DESC LIMIT 300`,
        [f.q || null, f.kind || null, f.company || null, f.source || null, f.instance || null],
      );
    });
    const KnowledgeBody = z.object({
      title: z.string().min(2).max(200), content: z.string().min(2).max(4000),
      kind: z.enum(['produto', 'politica', 'faq', 'procedimento', 'contato', 'estilo', 'manual']).default('faq'),
      company_slug: z.string().nullable().optional(),
      instance: z.string().nullable().optional(),   // null = todos os numeros
    });
    api.post('/api/knowledge', async (req, reply) => {
      const b = KnowledgeBody.safeParse(req.body);
      if (!b.success) return bad(reply, 'Preencha título e conteúdo.');
      await addKnowledge({ title: b.data.title, content: b.data.content, kind: b.data.kind, company: b.data.company_slug ?? null, instance: b.data.instance ?? null, source: `painel:${user(req)}` });
      return { ok: true };
    });
    api.patch<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
      const b = KnowledgeBody.partial().safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      await q(
        `UPDATE app.knowledge_chunks SET title = coalesce($2, title), content = coalesce($3, content), kind = coalesce($4, kind),
           company_slug = CASE WHEN $5 THEN $6 ELSE company_slug END,
           instance = CASE WHEN $7 THEN $8 ELSE instance END,
           embedding = CASE WHEN $3 IS NOT NULL AND $3 <> content THEN NULL ELSE embedding END, updated_at = now() WHERE id = $1`,
        [req.params.id, b.data.title ?? null, b.data.content ?? null, b.data.kind ?? null, b.data.company_slug !== undefined, b.data.company_slug ?? null, b.data.instance !== undefined, b.data.instance ?? null],
      );
      return { ok: true };
    });
    api.delete<{ Params: { id: string } }>('/api/knowledge/:id', async (req) => {
      await q(`UPDATE app.knowledge_chunks SET active = false, updated_at = now() WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });
    api.get('/api/knowledge/gaps', async () =>
      q(`SELECT g.*, (SELECT coalesce(c.name, c.phone) FROM app.threads t JOIN app.contacts c ON c.id = t.contact_id WHERE t.id = g.thread_id) AS contact
           FROM app.knowledge_gaps g WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`));
    api.post<{ Params: { id: string } }>('/api/knowledge/gaps/:id/answer', async (req, reply) => {
      const b = z.object({ answer: z.string().min(2).max(4000) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Escreva a resposta.');
      const g = await one<{ question: string; company_slug: string | null; instance: string | null }>(`SELECT * FROM app.knowledge_gaps WHERE id = $1`, [req.params.id]);
      if (!g) return bad(reply, 'Pergunta não encontrada.', 404);
      await addKnowledge({ title: g.question.slice(0, 200), content: b.data.answer, kind: 'faq', company: g.company_slug, instance: g.instance, source: `painel:${user(req)}` });
      await q(`UPDATE app.knowledge_gaps SET resolved_at = now() WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });
    api.post<{ Params: { id: string } }>('/api/knowledge/gaps/:id/dismiss', async (req) => {
      await q(`UPDATE app.knowledge_gaps SET resolved_at = now() WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });

    api.get('/api/companies', async () => q(`SELECT * FROM app.companies ORDER BY id`));
    api.patch<{ Params: { slug: string } }>('/api/companies/:slug', async (req, reply) => {
      const b = z.object({
        name: z.string().max(100).optional(), description: z.string().max(2000).optional(), topics: z.string().max(1000).optional(),
        site: z.string().max(300).nullable().optional(), catalog_url: z.string().max(500).nullable().optional(), active: z.boolean().optional(),
      }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      const cols = Object.entries(b.data).filter(([, v]) => v !== undefined);
      if (cols.length) await q(`UPDATE app.companies SET ${cols.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE slug = $1`, [req.params.slug, ...cols.map(([, v]) => v)]);
      return { ok: true };
    });

    // ---------------------------------------------------------------- sentinela
    api.get('/api/sentinela/incidents', async (req) => {
      const status = (req.query as any).status ?? 'ACTIVE';
      return q(
        `SELECT * FROM sentinela.incidents WHERE ($1 = 'ALL' OR ($1 = 'ACTIVE' AND status <> 'RESOLVED') OR status = $1)
          ORDER BY (status = 'RESOLVED'), opened_at DESC LIMIT 200`,
        [status],
      );
    });
    api.get<{ Params: { id: string } }>('/api/sentinela/incidents/:id', async (req, reply) => {
      const inc = await one(`SELECT * FROM sentinela.incidents WHERE id = $1`, [Number(req.params.id)]);
      if (!inc) return bad(reply, 'Incidente não encontrado.', 404);
      const [events, observations] = await Promise.all([
        q(`SELECT * FROM sentinela.incident_events WHERE incident_id = $1 ORDER BY created_at`, [inc.id]),
        q(`SELECT kind, value, status, details, observed_at FROM sentinela.observations WHERE resource_id = $1
            AND observed_at > $2::timestamptz - interval '2 hours' ORDER BY observed_at LIMIT 500`, [inc.resource_id, inc.opened_at]),
      ]);
      return { incident: inc, events, observations };
    });
    api.post<{ Params: { id: string } }>('/api/sentinela/incidents/:id/ack', async (req) => ({ ok: !!(await ack(Number(req.params.id), user(req))) }));
    api.post<{ Params: { id: string } }>('/api/sentinela/incidents/:id/resolve', async (req) => {
      const b = z.object({ rootCause: z.string().max(1000).optional() }).parse(req.body ?? {});
      return { ok: !!(await resolveManually(Number(req.params.id), user(req), b.rootCause)) };
    });
    api.get('/api/sentinela/resources', async () =>
      q(`SELECT * FROM sentinela.resources ORDER BY (status = 'SUSPENDED'), source, name`));

    const MonitorBody = z.object({
      name: z.string().min(1).max(120), url: z.string().url(), method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
      expect_status: z.array(z.number().int()).default([200]), max_latency_ms: z.number().int().min(200).max(60000).default(5000),
      must_contain: z.array(z.string().max(200)).default([]), must_not_contain: z.array(z.string().max(200)).default([]),
      interval_sec: z.number().int().min(60).max(86400).default(60), failures_to_alert: z.number().int().min(1).max(20).default(3),
      linked_resource: z.string().nullable().optional(), enabled: z.boolean().default(true),
    });
    api.get('/api/sentinela/monitors', async () => q(`SELECT * FROM sentinela.monitors ORDER BY name`));
    api.post('/api/sentinela/monitors', async (req, reply) => {
      const b = MonitorBody.safeParse(req.body);
      if (!b.success) return bad(reply, 'Confira o nome e o endereço (com https://).');
      const m = b.data;
      const row = await one(
        `INSERT INTO sentinela.monitors (name, url, method, expect_status, max_latency_ms, must_contain, must_not_contain, interval_sec, failures_to_alert, linked_resource, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (url, method) DO UPDATE SET name = EXCLUDED.name, enabled = true RETURNING *`,
        [m.name, m.url, m.method, m.expect_status, m.max_latency_ms, m.must_contain, m.must_not_contain, m.interval_sec, m.failures_to_alert, m.linked_resource ?? null, m.enabled],
      );
      return row;
    });
    api.patch<{ Params: { id: string } }>('/api/sentinela/monitors/:id', async (req, reply) => {
      const b = MonitorBody.partial().safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      const cols = Object.entries(b.data).filter(([, v]) => v !== undefined);
      if (cols.length) await q(`UPDATE sentinela.monitors SET ${cols.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [req.params.id, ...cols.map(([, v]) => v)]);
      return { ok: true };
    });
    api.delete<{ Params: { id: string } }>('/api/sentinela/monitors/:id', async (req) => {
      await q(`DELETE FROM sentinela.monitors WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });
    api.post('/api/sentinela/check', async (req, reply) => {
      const b = MonitorBody.pick({ url: true }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Informe um endereço com https://');
      return checkUrl({ url: b.data.url, method: 'GET', expect_status: [200], max_latency_ms: 5000, must_contain: [], must_not_contain: [] });
    });
    api.get('/api/sentinela/series', async (req) => {
      const f = req.query as Record<string, string>;
      return q(
        `SELECT extract(epoch from observed_at)::bigint AS t, value, status FROM sentinela.observations
          WHERE resource_id = $1 AND kind = $2 AND observed_at > now() - make_interval(hours => $3::int) ORDER BY observed_at`,
        [f.resource, f.kind ?? 'http_check', Number(f.hours ?? 24)],
      );
    });
    api.get('/api/sentinela/uptime', async () =>
      q(`SELECT resource_id,
                round(100.0 * count(*) FILTER (WHERE status <> 'FAIL' AND observed_at > now() - interval '24 hours') / nullif(count(*) FILTER (WHERE observed_at > now() - interval '24 hours'), 0), 2) AS d1,
                round(100.0 * count(*) FILTER (WHERE status <> 'FAIL') / nullif(count(*), 0), 2) AS d7
           FROM sentinela.observations WHERE kind = 'http_check' AND observed_at > now() - interval '7 days' GROUP BY resource_id`));

    // contatos de alerta
    api.get('/api/sentinela/contacts', async () => q(`SELECT id, name, phone, role, groups, min_severity, sources, quiet_start, quiet_end, escalation_level, verified_at, active FROM sentinela.contacts ORDER BY name`));
    const ContactBody = z.object({
      name: z.string().min(1).max(100), phone: z.string().min(8).max(20),
      role: z.enum(['OWNER', 'ENGINEER', 'FINANCE', 'CLIENT_VIEWER']).default('ENGINEER'),
      min_severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('WARNING'),
      sources: z.array(z.enum(['RENDER', 'VERCEL', 'URL', 'SELF', 'COST'])).default([]),
      quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), quiet_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      escalation_level: z.number().int().min(1).max(2).default(1), active: z.boolean().default(true),
    });
    api.post('/api/sentinela/contacts', async (req, reply) => {
      const b = ContactBody.safeParse(req.body);
      if (!b.success) return bad(reply, 'Confira nome e telefone.');
      const c = b.data;
      const phone = normalizePhone(c.phone);
      const codeNum = String(Math.floor(100000 + Math.random() * 900000));
      const row = await one(
        `INSERT INTO sentinela.contacts (name, phone, role, min_severity, sources, quiet_start, quiet_end, escalation_level, active, verify_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (phone) DO NOTHING RETURNING id`,
        [c.name, phone, c.role, c.min_severity, c.sources, c.quiet_start ?? null, c.quiet_end ?? null, c.escalation_level, c.active, codeNum],
      );
      if (!row) return bad(reply, 'Esse número já está cadastrado.');
      await sendAlert(phone, `Olá, ${c.name}! Você foi cadastrado para receber alertas do Sentinela da SelfMachine. Para confirmar, responda com o código: ${codeNum}`).catch(() => undefined);
      return { ok: true, note: 'Código enviado por WhatsApp. O contato passa a receber alertas depois de responder o código.' };
    });
    api.patch<{ Params: { id: string } }>('/api/sentinela/contacts/:id', async (req, reply) => {
      const b = ContactBody.omit({ phone: true }).partial().safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      const cols = Object.entries(b.data).filter(([, v]) => v !== undefined);
      if (cols.length) await q(`UPDATE sentinela.contacts SET ${cols.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [req.params.id, ...cols.map(([, v]) => v)]);
      return { ok: true };
    });
    api.delete<{ Params: { id: string } }>('/api/sentinela/contacts/:id', async (req) => {
      await q(`DELETE FROM sentinela.contacts WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });

    // ---------------------------------------------------------------- custos
    api.get('/api/costs', async () => {
      const [summary, byAgent, byContact, priceBook, fixed, budgets, resources] = await Promise.all([
        costSummary(),
        q(`SELECT agent, coalesce(sum(cost_usd), 0)::float usd FROM app.agent_runs WHERE created_at >= date_trunc('month', now()) GROUP BY agent ORDER BY 2 DESC`),
        q(`SELECT coalesce(c.name, c.phone, c.email) AS contact, coalesce(sum(a.cost_usd), 0)::float usd, count(*)::int runs
             FROM app.agent_runs a JOIN app.threads t ON t.id = a.thread_id JOIN app.contacts c ON c.id = t.contact_id
            WHERE a.created_at >= date_trunc('month', now()) GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
        q(`SELECT * FROM sentinela.price_book ORDER BY provider, usd_per_month`),
        q(`SELECT * FROM sentinela.fixed_costs ORDER BY name`),
        q(`SELECT * FROM sentinela.budgets`),
        q(`SELECT name, meta->>'plan' AS plan, status FROM sentinela.resources WHERE source = 'RENDER' AND status <> 'SUSPENDED' ORDER BY name`),
      ]);
      return { summary, byAgent, byContact, priceBook, fixed, budgets, renderServices: resources };
    });
    api.put('/api/costs/budget', async (req, reply) => {
      const b = z.object({ provider: z.string().default('TOTAL'), monthly_usd: z.number().min(0) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Valor inválido.');
      await q(`INSERT INTO sentinela.budgets (provider, monthly_usd) VALUES ($1, $2) ON CONFLICT (provider) DO UPDATE SET monthly_usd = EXCLUDED.monthly_usd`, [b.data.provider, b.data.monthly_usd]);
      return { ok: true };
    });
    api.put('/api/costs/price', async (req, reply) => {
      const b = z.object({ provider: z.string(), item: z.string(), usd_per_month: z.number().min(0) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Valor inválido.');
      await q(`INSERT INTO sentinela.price_book (provider, item, usd_per_month) VALUES ($1, $2, $3) ON CONFLICT (provider, item) DO UPDATE SET usd_per_month = EXCLUDED.usd_per_month`, [b.data.provider, b.data.item, b.data.usd_per_month]);
      return { ok: true };
    });
    api.post('/api/costs/fixed', async (req, reply) => {
      const b = z.object({ name: z.string().min(1).max(100), usd_per_month: z.number().min(0) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Informe nome e valor.');
      await q(`INSERT INTO sentinela.fixed_costs (name, usd_per_month) VALUES ($1, $2)`, [b.data.name, b.data.usd_per_month]);
      return { ok: true };
    });
    api.delete<{ Params: { id: string } }>('/api/costs/fixed/:id', async (req) => {
      await q(`DELETE FROM sentinela.fixed_costs WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });

    // ---------------------------------------------------------------- jeito de escrever de cada numero
    api.get('/api/personas', async () => Promise.all([...instanceRoles()].filter(([, r]) => r !== 'OFF').map(async ([instance, role]) => {
      const p = await getPersonaProfile(instance);
      return { instance, role, persona: personaFor(instance), profile: p?.content ?? '', updatedAt: p?.updated_at ?? null, messages: await countPersonaMessages(instance) };
    })));
    api.post<{ Params: { instance: string } }>('/api/personas/:instance/rebuild', async (req, reply) => {
      try {
        const guide = await buildPersonaProfile(req.params.instance);
        if (!guide) return bad(reply, 'Ainda há poucas mensagens suas neste número (mínimo 15). Continue usando o WhatsApp normalmente e tente de novo.');
        return { profile: guide };
      } catch (e: any) {
        return bad(reply, `Não consegui gerar agora: ${e.message}`);
      }
    });
    api.put<{ Params: { instance: string } }>('/api/personas/:instance', async (req, reply) => {
      const b = z.object({ profile: z.string().min(10).max(4000) }).safeParse(req.body);
      if (!b.success) return bad(reply, 'Escreva o jeito de escrever (mínimo 10 caracteres).');
      await savePersonaProfile(req.params.instance, b.data.profile, `painel:${user(req)}`);
      return { ok: true };
    });

    // ---------------------------------------------------------------- configuracoes
    api.get('/api/settings', async () => {
      const instances = await Promise.all([...instanceRoles()].map(async ([name, role]) => {
        let state = 'desconhecido';
        try { state = await connectionState(name); } catch { /* Evolution fora */ }
        return { name, role, state };
      }));
      const values = Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, setting(k)]));
      return {
        values, instances,
        info: {
          approvalInstance: env.APPROVAL_INSTANCE, gabrielPhone: env.GABRIEL_PERSONAL_PHONE, models: { agent: env.LLM_AGENT_MODEL, router: env.LLM_ROUTER_MODEL, small: env.LLM_SMALL_MODEL },
          integrations: {
            openai: !!env.OPENAI_API_KEY, anthropic: !!env.ANTHROPIC_API_KEY, render: !!env.RENDER_API_KEY, vercel: !!env.VERCEL_TOKEN,
            gmail: !!env.GMAIL_ACCOUNT, renderKeyEnd: env.RENDER_API_KEY.slice(-4), vercelKeyEnd: env.VERCEL_TOKEN.slice(-4),
          },
        },
      };
    });
    api.put('/api/settings', async (req, reply) => {
      const b = z.record(z.string(), z.string().max(3000)).safeParse(req.body);
      if (!b.success) return bad(reply, 'Dados inválidos.');
      for (const [k, v] of Object.entries(b.data)) {
        if (!(EDITABLE_SETTINGS as readonly string[]).includes(k)) return bad(reply, `Ajuste desconhecido: ${k}`);
        if (k === 'SEND_MODE' && !['draft', 'auto'].includes(v)) return bad(reply, 'Modo de envio inválido.');
        if (k === 'WA_INSTANCES' && !/^([\w-]+:(ATENDIMENTO|GABRIEL|OBSERVAR|OFF),?)+$/.test(v)) return bad(reply, 'Papéis inválidos.');
        await saveSetting(k as EditableSetting, v, user(req));
      }
      return { ok: true };
    });

    // ---------------------------------------------------------------- busca global
    api.get('/api/search', async (req) => {
      const term = String((req.query as any).q ?? '').trim();
      if (term.length < 2) return { contacts: [], messages: [], incidents: [], knowledge: [] };
      const like = `%${term}%`;
      const [contacts, messages, incidents, knowledge] = await Promise.all([
        q(`SELECT c.id, coalesce(c.name, c.phone, c.email) AS name, c.phone, c.company,
                  (SELECT t.id FROM app.threads t WHERE t.contact_id = c.id ORDER BY t.updated_at DESC LIMIT 1) AS thread_id
             FROM app.contacts c WHERE c.name ILIKE $1 OR c.phone LIKE $2 OR c.email ILIKE $1 OR c.company ILIKE $1
            ORDER BY similarity(coalesce(c.name, ''), $3) DESC LIMIT 8`, [like, `%${term.replace(/\D/g, '') || term}%`, term]),
        q(`SELECT m.thread_id, left(m.content, 160) AS snippet, m.created_at, coalesce(c.name, c.phone) AS contact
             FROM app.messages m JOIN app.threads t ON t.id = m.thread_id JOIN app.contacts c ON c.id = t.contact_id
            WHERE m.content ILIKE $1 ORDER BY m.created_at DESC LIMIT 8`, [like]),
        q(`SELECT id, title, status, severity FROM sentinela.incidents WHERE title ILIKE $1 OR ('#i-' || lpad(id::text, 3, '0')) ILIKE $1 OR id::text = $2 ORDER BY opened_at DESC LIMIT 5`, [like, term.replace(/\D/g, '')]),
        q(`SELECT id, title, kind FROM app.knowledge_chunks WHERE active AND (title ILIKE $1 OR content ILIKE $1) LIMIT 5`, [like]),
      ]);
      return { contacts, messages, incidents, knowledge };
    });

    // ---------------------------------------------------------------- tempo real (SSE)
    api.get('/api/events', async (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
        'x-accel-buffering': 'no', 'access-control-allow-origin': String(req.headers.origin ?? '*'),
      });
      const write = (raw: string) => {
        const e = JSON.parse(raw);
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      // reconexao: manda o que perdeu
      const last = Number(req.headers['last-event-id'] ?? (req.query as any).last ?? 0);
      if (last) {
        const log = await redis.lrange('painel:events:log', 0, 499);
        for (const raw of log.reverse()) if (JSON.parse(raw).id > last) write(raw);
      }
      res.write(`event: ready\ndata: {}\n\n`);
      clients.add(write);
      const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
      req.raw.on('close', () => { clients.delete(write); clearInterval(ping); });
    });
  });
}

// um assinante do Redis por processo, repassando para todos os navegadores conectados
const clients = new Set<(raw: string) => void>();
let sub: Redis | undefined;
export function startEventFanout() {
  if (sub) return;
  sub = new Redis(redisOptions());
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on('message', (_ch, raw) => { for (const c of clients) c(raw); });
}

async function countTakeovers(): Promise<number> {
  let cursor = '0';
  let n = 0;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'takeover:*', 'COUNT', 500);
    cursor = next;
    n += batch.length;
  } while (cursor !== '0');
  return n;
}
