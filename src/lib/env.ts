import { z } from 'zod';

const bool = z.string().optional().transform((v) => v === 'true' || v === '1');
const list = z.string().optional().transform((v) => (v ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string(),
  DB_SCHEMA: z.string().default('app'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  EVOLUTION_BASE_URL: z.string().default('http://localhost:8080'),
  EVOLUTION_API_KEY: z.string().default(''),
  EVOLUTION_WEBHOOK_TOKEN: z.string().min(12, 'EVOLUTION_WEBHOOK_TOKEN precisa ter 12+ caracteres'),
  WA_INSTANCES: z.string().default(''),

  GMAIL_ACCOUNT: z.string().default(''),
  GMAIL_CLIENT_ID: z.string().default(''),
  GMAIL_CLIENT_SECRET: z.string().default(''),
  GMAIL_REFRESH_TOKEN: z.string().default(''),
  GMAIL_PUBSUB_TOPIC: z.string().default(''),
  GMAIL_PUSH_AUDIENCE: z.string().default(''),
  GMAIL_PUSH_SERVICE_ACCOUNT: z.string().default(''),

  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_ROUTER_MODEL: z.string().default('openai:gpt-5-mini'),
  LLM_AGENT_MODEL: z.string().default('openai:gpt-5'),
  LLM_SMALL_MODEL: z.string().default('openai:gpt-5-mini'),
  LLM_SUMMARY_MODEL: z.string().default('openai:gpt-5-mini'),
  LLM_VISION_MODEL: z.string().default('openai:gpt-5-mini'),
  LLM_FALLBACK_MODEL: z.string().default(''),
  LLM_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  GABRIEL_PERSONAL_PHONE: z.string().default(''),
  APPROVAL_INSTANCE: z.string().default(''),

  MAX_AUTO_DISCOUNT_PERCENT: z.coerce.number().default(5),
  DAILY_COST_LIMIT_USD: z.coerce.number().default(5),
  BUSINESS_HOURS: z.string().default('seg-sex 08:00-18:00'),
  TIMEZONE: z.string().default('America/Sao_Paulo'),

  SEND_MODE: z.enum(['draft', 'auto']).default('draft'),
  AUTO_SEND_AGENTS: list,
  SHADOW_NOTIFY: bool,

  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default(''),
});

const withScheme = (u: string) => (/^https?:\/\//.test(u) ? u : `http://${u}`); // Render entrega "host:porta"

// no Render o segredo antigo do webhook continua no grupo "ia-central-segredos"
const parsed = schema.parse({
  ...process.env,
  EVOLUTION_WEBHOOK_TOKEN: process.env.EVOLUTION_WEBHOOK_TOKEN || process.env.WHATSAPP_WEBHOOK_SEGREDO,
});
export const env = {
  ...parsed,
  EVOLUTION_BASE_URL: withScheme(parsed.EVOLUTION_BASE_URL),
  // endereco que a Evolution usa para chamar a API (rede interna no Render); padrao = PUBLIC_URL
  WEBHOOK_BASE_URL: withScheme(process.env.WEBHOOK_BASE_URL || parsed.PUBLIC_URL),
};
export type Env = typeof env;

export type InstanceRole = 'ATENDIMENTO' | 'GABRIEL' | 'OFF';

/** "joao:ATENDIMENTO,gabriel:GABRIEL" -> Map */
export function instanceRoles(): Map<string, InstanceRole> {
  const m = new Map<string, InstanceRole>();
  for (const part of env.WA_INSTANCES.split(',')) {
    const [name, role] = part.split(':').map((s) => s?.trim());
    if (!name) continue;
    const r = (role ?? 'ATENDIMENTO').toUpperCase();
    m.set(name, r === 'GABRIEL' || r === 'OFF' ? r : 'ATENDIMENTO');
  }
  return m;
}

export function instanceRole(name: string): InstanceRole {
  return instanceRoles().get(name) ?? 'OFF';
}

/** Instancia que fala com o Gabriel real (aprovacoes, alertas). */
export function approvalInstance(): string | undefined {
  if (env.APPROVAL_INSTANCE) return env.APPROVAL_INSTANCE;
  for (const [name, role] of instanceRoles()) if (role === 'ATENDIMENTO') return name;
  return undefined;
}
