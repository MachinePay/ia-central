import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import Fastify from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { timingSafeEqual } from 'node:crypto';
import { connectionState, setWebhook } from '../channels/whatsapp/evolution.js';
import { pool } from '../lib/db.js';
import { env, instanceRoles } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { saveAgendaNames } from './agenda.js';
import { allQueues, ingestQueue } from '../lib/queues.js';
import { redis } from '../lib/redis.js';
import { startSettingsRefresh } from '../lib/settings.js';
import cors from '@fastify/cors';
import { panelRoutes, startEventFanout } from './panel.js';

const app = Fastify({ loggerInstance: logger, bodyLimit: 64 * 1024 * 1024, trustProxy: true }); // audio chega em base64

// painel (outro dominio): login por token no cabecalho, sem cookie
await app.register(cors, {
  origin: env.WEB_ORIGIN === '*' ? true : env.WEB_ORIGIN.split(',').map((s) => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
});
startSettingsRefresh();
startEventFanout();
await app.register(panelRoutes);

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// --------------------------------------------------------------- Evolution (WhatsApp)
app.post<{ Params: { instance: string }; Querystring: { token?: string } }>('/webhooks/evolution/:instance', async (req, reply) => {
  const token = String(req.headers['x-webhook-token'] ?? req.query.token ?? '');
  if (!safeEq(token, env.EVOLUTION_WEBHOOK_TOKEN)) return reply.code(401).send();
  const body = req.body as any;
  const event = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
  const instance = req.params.instance;

  if (event === 'connection.update') {
    const state = body?.data?.state;
    if (state && state !== 'open') logger.warn({ instance, state }, 'sessao do WhatsApp mudou de estado');
    await ingestQueue.add('wa-connection', { instance, state }, { removeOnComplete: 100 });
    return reply.send({ ok: true });
  }
  if (event === 'contacts.upsert' || event === 'contacts.set') {
    // nome salvo na agenda do celular deste numero
    const list = (Array.isArray(body.data) ? body.data : [body.data]).filter(Boolean);
    await saveAgendaNames(instance, list.map((c: any) => ({ jid: String(c.remoteJid ?? c.id ?? ''), name: String(c.pushName ?? c.name ?? '') }))).catch((e) => logger.warn({ err: String(e) }, 'nomes da agenda nao salvos'));
    return reply.send({ ok: true });
  }
  if (event !== 'messages.upsert') return reply.send({ ok: true });
  const data = Array.isArray(body.data) ? body.data[0] : body.data;
  const id = data?.key?.id;
  if (!id) return reply.send({ ok: true });
  await ingestQueue.add('whatsapp', { instance, data, owner: body.sender }, {
    jobId: `wa-${instance}-${id}`, // dedupe ja na fila
    removeOnComplete: 1000,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
  });
  return reply.send({ ok: true });
});

// --------------------------------------------------------------- Gmail (Pub/Sub push com OIDC)
const oidc = new OAuth2Client();
app.post('/webhooks/gmail', async (req, reply) => {
  const auth = String(req.headers.authorization ?? '');
  try {
    const ticket = await oidc.verifyIdToken({ idToken: auth.replace(/^Bearer\s+/i, ''), audience: env.GMAIL_PUSH_AUDIENCE || undefined });
    const p = ticket.getPayload();
    if (env.GMAIL_PUSH_SERVICE_ACCOUNT && p?.email !== env.GMAIL_PUSH_SERVICE_ACCOUNT) throw new Error('service account inesperada');
  } catch (e) {
    logger.warn({ err: String(e) }, 'push do Gmail recusado');
    return reply.code(401).send();
  }
  const msg = (req.body as any)?.message;
  const data = msg?.data ? JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')) : {};
  await ingestQueue.add('gmail-sync', { historyId: data.historyId, account: data.emailAddress }, {
    deduplication: { id: `gmail-sync-${String(data.emailAddress ?? '').replace(/[^\w.@-]/g, '')}`, ttl: 3000 },
    removeOnComplete: 100,
  });
  return reply.code(204).send();
});

// --------------------------------------------------------------- saude
app.get('/health', { logLevel: 'warn' }, async (_req, reply) => { // o Render chama a cada 5 s: nao poluir o log
  const checks: Record<string, string> = {};
  try { await pool.query('SELECT 1'); checks.db = 'ok'; } catch (e) { checks.db = String(e); }
  try { await redis.ping(); checks.redis = 'ok'; } catch (e) { checks.redis = String(e); }
  for (const [name, role] of instanceRoles()) {
    if (role === 'OFF') continue;
    try { checks[`whatsapp:${name}`] = await connectionState(name); } catch (e) { checks[`whatsapp:${name}`] = 'erro'; }
  }
  const ok = checks.db === 'ok' && checks.redis === 'ok';
  return reply.code(ok ? 200 : 503).send({ ok, checks });
});

// --------------------------------------------------------------- Bull Board (filas) com Basic Auth
const board = new FastifyAdapter();
createBullBoard({ queues: allQueues.map((qu) => new BullMQAdapter(qu)), serverAdapter: board });
board.setBasePath('/admin/queues');
app.register(async (scope) => {
  scope.addHook('onRequest', async (req, reply) => {
    const [user, pass] = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic\s+/i, ''), 'base64').toString().split(':');
    if (!env.ADMIN_PASSWORD || user !== env.ADMIN_USER || !safeEq(pass ?? '', env.ADMIN_PASSWORD)) {
      reply.header('www-authenticate', 'Basic realm="filas"').code(401).send();
    }
  });
  await scope.register(board.registerPlugin(), { prefix: '/admin/queues' });
});

app.listen({ port: env.PORT, host: '0.0.0.0' }).then(() => {
  // garante que cada numero manda tambem os contatos (nome salvo na agenda) para este sistema
  for (const [name, role] of instanceRoles()) if (role !== 'OFF') void setWebhook(name).catch((e) => logger.warn({ err: String(e), name }, 'webhook nao atualizado'));
}).catch((e) => {
  logger.fatal(e);
  process.exit(1);
});
