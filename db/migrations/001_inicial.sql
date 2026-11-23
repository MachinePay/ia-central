-- SelfMachine Agents: schema "app" (o legado continua em "nucleo", so leitura, para a migracao).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE SCHEMA IF NOT EXISTS app;

DO $$ BEGIN
  CREATE TYPE app.channel AS ENUM ('WHATSAPP', 'GMAIL');
  CREATE TYPE app.agent AS ENUM ('LEO', 'JOAO', 'CLARA', 'GABRIEL', 'HUMAN');
  CREATE TYPE app.direction AS ENUM ('INBOUND', 'OUTBOUND');
  CREATE TYPE app.crm_stage AS ENUM ('NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'CUSTOMER', 'LOST');
  CREATE TYPE app.thread_status AS ENUM ('OPEN', 'PAUSED', 'WAITING_APPROVAL', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS app.companies (
  id          serial PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  topics      text NOT NULL DEFAULT '',      -- sinais de que a conversa e desta empresa
  site        text,
  catalog_url text,                          -- API de catalogo somente leitura
  catalog_token_env text,                    -- nome da variavel de ambiente com o token
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS app.contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text,
  phone      text UNIQUE,                    -- E.164 sem simbolos
  wa_jid     text UNIQUE,                    -- JID bruto (pode ser @lid)
  email      text UNIQUE,
  company    text,
  role       text NOT NULL DEFAULT 'LEAD',   -- CLIENTE, LEAD, FORNECEDOR, PARCEIRO, PESSOAL
  tags       text[] NOT NULL DEFAULT '{}',   -- VIP, INADIMPLENTE, BOT_GABRIEL...
  crm_stage  app.crm_stage NOT NULL DEFAULT 'NEW',
  notes      text,                           -- perfil aprendido (tom, cuidados)
  opted_out  boolean NOT NULL DEFAULT false,
  consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         uuid NOT NULL REFERENCES app.contacts(id) ON DELETE CASCADE,
  channel            app.channel NOT NULL,
  instance           text NOT NULL DEFAULT '',          -- instancia da Evolution ou conta do Gmail
  external_id        text NOT NULL,                     -- remoteJid ou threadId do Gmail
  subject            text,
  company_slug       text,
  active_agent       app.agent NOT NULL DEFAULT 'LEO',
  status             app.thread_status NOT NULL DEFAULT 'OPEN',
  summary            text,
  facts              jsonb NOT NULL DEFAULT '{}',
  pending_handoff    jsonb,
  agent_switches     jsonb NOT NULL DEFAULT '[]',        -- [{at, to}] para o limite de trocas
  msgs_since_summary int NOT NULL DEFAULT 0,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  last_bot_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, instance, external_id)
);
CREATE INDEX IF NOT EXISTS threads_contact ON app.threads (contact_id);

CREATE TABLE IF NOT EXISTS app.messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES app.threads(id) ON DELETE CASCADE,
  external_id  text UNIQUE,                    -- dedupe de webhook
  direction    app.direction NOT NULL,
  sender       app.agent,                      -- null = cliente
  status       text NOT NULL DEFAULT 'DONE',   -- inbound: PENDING_MEDIA/DONE; outbound: DRAFT/QUEUED/SENT/FAILED
  content      text NOT NULL DEFAULT '',
  media        jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}',
  delivered_at timestamptz,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread ON app.messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS app.agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     uuid NOT NULL REFERENCES app.threads(id) ON DELETE CASCADE,
  agent         app.agent NOT NULL,
  model         text NOT NULL,
  route         jsonb,                         -- nivel, decisao e saida do Leo
  tool_calls    jsonb NOT NULL DEFAULT '[]',
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd      numeric(10, 6) NOT NULL DEFAULT 0,
  latency_ms    int NOT NULL DEFAULT 0,
  outcome       text NOT NULL,                 -- SENT, DRAFT, DISCARDED, ESCALATED, APPROVAL, SILENT, ERROR
  reply         text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_thread ON app.agent_runs (thread_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_day ON app.agent_runs (created_at);

CREATE SEQUENCE IF NOT EXISTS app.approval_seq START 1;
CREATE TABLE IF NOT EXISTS app.pending_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE DEFAULT ('A-' || lpad(nextval('app.approval_seq')::text, 4, '0')),
  thread_id     uuid NOT NULL REFERENCES app.threads(id) ON DELETE CASCADE,
  requested_by  app.agent NOT NULL,
  action        text NOT NULL,                 -- DISCOUNT, CUSTOM_TERM, CONTRACT, DEADLINE, REFUND, PAYMENT_LINK
  payload       jsonb NOT NULL DEFAULT '{}',
  draft_reply   text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING', -- APPROVED, EDITED, REJECTED, EXPIRED
  notify_msg_id text,                          -- id da mensagem enviada ao Gabriel (para responder citando)
  reminded_at   timestamptz,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_status ON app.pending_approvals (status, created_at);

CREATE TABLE IF NOT EXISTS app.tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES app.contacts(id) ON DELETE CASCADE,
  thread_id    uuid REFERENCES app.threads(id) ON DELETE SET NULL,
  priority     text NOT NULL,                  -- LOW, MEDIUM, HIGH, CRITICAL
  category     text NOT NULL,                  -- HARDWARE, SOFTWARE, PAGAMENTO, ENTREGA
  summary      text NOT NULL,
  tested_steps jsonb,
  status       text NOT NULL DEFAULT 'OPEN',   -- OPEN, RESOLVED, ESCALATED
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.knowledge_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_slug text,                           -- null = vale para todas
  kind         text NOT NULL DEFAULT 'faq',    -- produto, politica, faq, procedimento, contato, manual, ticket
  source       text NOT NULL,                  -- manual, FAQ, legado:empresa_base, ticket resolvido...
  title        text NOT NULL,
  content      text NOT NULL,
  embedding    vector(1536),
  search       tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
  legacy_ref   text UNIQUE,                    -- ex.: empresa_base:12 (migracao idempotente)
  active       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_embedding ON app.knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kb_search ON app.knowledge_chunks USING gin (search);

CREATE TABLE IF NOT EXISTS app.leads (
  contact_id   uuid PRIMARY KEY REFERENCES app.contacts(id) ON DELETE CASCADE,
  business     text,
  volume       text,
  pain         text,
  deadline     text,
  decision_maker text,
  interest     text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.meetings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES app.contacts(id) ON DELETE CASCADE,
  thread_id   uuid REFERENCES app.threads(id) ON DELETE SET NULL,
  topic       text NOT NULL,
  preferred   text NOT NULL,                   -- preferencia do cliente; o Gabriel confirma o horario
  status      text NOT NULL DEFAULT 'REQUESTED',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.gmail_sync_state (
  account          text PRIMARY KEY,
  history_id       text NOT NULL,
  watch_expires_at timestamptz
);

-- Perguntas que a IA nao soube responder (vira conhecimento quando respondida)
CREATE TABLE IF NOT EXISTS app.knowledge_gaps (
  id           serial PRIMARY KEY,
  company_slug text,
  question     text NOT NULL,
  thread_id    uuid REFERENCES app.threads(id) ON DELETE SET NULL,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
