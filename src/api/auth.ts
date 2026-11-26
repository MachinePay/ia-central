import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../lib/env.js';
import { redis } from '../lib/redis.js';

const TTL_DAYS = 30;
const secret = () => env.SESSION_SECRET || createHmac('sha256', 'painel').update(`${env.ADMIN_PASSWORD}|${env.EVOLUTION_WEBHOOK_TOKEN}`).digest('hex');

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function issueToken(user: string): string {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + TTL_DAYS * 86_400_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): { u: string } | undefined {
  if (!token) return undefined;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return undefined;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return undefined;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? { u: data.u } : undefined;
}

export const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Login com atraso progressivo contra forca bruta (por IP). */
export async function login(ip: string, user: string, password: string): Promise<string | undefined> {
  const key = `login-fail:${ip}`;
  const fails = Number((await redis.get(key)) ?? 0);
  if (fails >= 10) return undefined;
  await new Promise((r) => setTimeout(r, 400 + fails * 300));
  const gabriel = isGabrielUser(user) && !!env.GABRIEL_PASSWORD && safeEq(password, env.GABRIEL_PASSWORD);
  const ok = gabriel || (!!env.ADMIN_PASSWORD && user === env.ADMIN_USER && safeEq(password, env.ADMIN_PASSWORD));
  if (!ok) {
    await redis.multi().incr(key).expire(key, 900).exec();
    return undefined;
  }
  await redis.del(key);
  return issueToken(gabriel ? env.GABRIEL_USER : user);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query as any)?.token;
  const session = verifyToken(token);
  if (!session) return reply.code(401).send({ error: 'Faça login de novo.' });
  (req as any).user = session.u;
}

/** Estado assinado para o retorno do login do Google (nao da para forjar qual numero recebe a conta). */
export function signState(data: string): string {
  const payload = Buffer.from(JSON.stringify({ d: data, exp: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function readState(state: string | undefined): string | undefined {
  if (!state) return undefined;
  const [payload, sig] = state.split('.');
  if (!payload || !sig || !safeEq(sig, sign(payload))) return undefined;
  const j = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return j.exp > Date.now() && typeof j.d === 'string' ? j.d : undefined;
}

// ------------------------------------------------------------------ conversas do Gabriel (numero pessoal)
export const isGabrielUser = (user: string) => !!env.GABRIEL_USER && user.trim().toUpperCase() === env.GABRIEL_USER.toUpperCase();

/** So o login do Gabriel ve as conversas do numero pessoal dele. */
export const hasGabrielKey = (req: FastifyRequest): boolean => isGabrielUser(String((req as any).user ?? ''));
