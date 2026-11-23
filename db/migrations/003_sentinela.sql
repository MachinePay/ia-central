-- Sentinela: monitoramento, incidentes, custos e alertas (schema proprio, le app.agent_runs para custo de LLM)
CREATE SCHEMA IF NOT EXISTS sentinela;

-- Recursos vigiados (servicos Render, projetos Vercel, monitores de URL, partes do proprio sistema)
CREATE TABLE IF NOT EXISTS sentinela.resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,                 -- RENDER, VERCEL, URL, SELF, COST
  external_id  text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT '',      -- web_service, static_site, project, monitor, whatsapp...
  url          text,
  status       text NOT NULL DEFAULT 'UNKNOWN', -- OK, WARN, FAIL, SUSPENDED, UNKNOWN
  meta         jsonb NOT NULL DEFAULT '{}',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

-- Monitores de URL cadastrados por voce
CREATE TABLE IF NOT EXISTS sentinela.monitors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  url               text NOT NULL,
  method            text NOT NULL DEFAULT 'GET',
  expect_status     int[] NOT NULL DEFAULT '{200}',
  max_latency_ms    int NOT NULL DEFAULT 5000,
  must_contain      text[] NOT NULL DEFAULT '{}',
  must_not_contain  text[] NOT NULL DEFAULT '{}',
  interval_sec      int NOT NULL DEFAULT 60,
  failures_to_alert int NOT NULL DEFAULT 3,
  linked_resource   text,                     -- ex.: render:srv-xxx / vercel:prj_xxx
  enabled           boolean NOT NULL DEFAULT true,
  silenced_until    timestamptz,
  consecutive_fail  int NOT NULL DEFAULT 0,
  last_status       text NOT NULL DEFAULT 'UNKNOWN',
  last_latency_ms   int,
  last_checked_at   timestamptz,
  ssl_expires_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url, method)
);

-- Observacoes brutas (30 dias)
CREATE TABLE IF NOT EXISTS sentinela.observations (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,
  resource_id  text NOT NULL,                 -- source:external_id
  kind         text NOT NULL,
  value        double precision,
  status       text NOT NULL,                 -- OK, WARN, FAIL
  details      jsonb,
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS obs_resource ON sentinela.observations (resource_id, kind, observed_at DESC);
CREATE INDEX IF NOT EXISTS obs_time ON sentinela.observations (observed_at);

CREATE TABLE IF NOT EXISTS sentinela.incidents (
  id           serial PRIMARY KEY,            -- #I-042
  key          text NOT NULL,                 -- regra + recurso
  rule_id      text NOT NULL,
  source       text NOT NULL,
  resource_id  text,
  severity     text NOT NULL,                 -- INFO, WARNING, CRITICAL
  status       text NOT NULL DEFAULT 'OPEN',  -- OPEN, ACKNOWLEDGED, RESOLVED
  title        text NOT NULL,
  detail       text,
  diagnosis    jsonb,
  hits         int NOT NULL DEFAULT 1,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  last_hit_at  timestamptz NOT NULL DEFAULT now(),
  notified_at  timestamptz,
  escalated_at timestamptz,
  acked_by     text,
  acked_at     timestamptz,
  resolved_at  timestamptz,
  root_cause   text
);
CREATE UNIQUE INDEX IF NOT EXISTS incident_open_key ON sentinela.incidents (key) WHERE status <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS incident_status ON sentinela.incidents (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS sentinela.incident_events (
  id          bigserial PRIMARY KEY,
  incident_id int NOT NULL REFERENCES sentinela.incidents(id) ON DELETE CASCADE,
  type        text NOT NULL,                  -- OPENED, UPDATED, NOTIFIED, ACKED, ESCALATED, RESOLVED, DIAGNOSIS, COMMAND
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Quem recebe alertas
CREATE TABLE IF NOT EXISTS sentinela.contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  phone            text NOT NULL UNIQUE,
  role             text NOT NULL DEFAULT 'ENGINEER',   -- OWNER, ENGINEER, FINANCE, CLIENT_VIEWER
  groups           text[] NOT NULL DEFAULT '{}',
  min_severity     text NOT NULL DEFAULT 'WARNING',
  sources          text[] NOT NULL DEFAULT '{}',       -- vazio = todas
  quiet_start      text,                               -- '22:00'
  quiet_end        text,                               -- '07:00'
  escalation_level int NOT NULL DEFAULT 1,
  verify_code      text,
  verified_at      timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Custos por dia
CREATE TABLE IF NOT EXISTS sentinela.cost_entries (
  provider   text NOT NULL,                   -- LLM, RENDER, VERCEL, FIXO...
  project    text NOT NULL DEFAULT '',
  day        date NOT NULL,
  amount_usd numeric(12, 4) NOT NULL,
  kind       text NOT NULL,                   -- MEASURED, ESTIMATED, INVOICE
  PRIMARY KEY (provider, project, day, kind)
);

CREATE TABLE IF NOT EXISTS sentinela.budgets (
  provider    text PRIMARY KEY,               -- TOTAL, LLM, RENDER, VERCEL
  monthly_usd numeric(12, 2) NOT NULL
);

-- Preco mensal por plano (estimativa da Render/Vercel)
CREATE TABLE IF NOT EXISTS sentinela.price_book (
  provider      text NOT NULL,
  item          text NOT NULL,
  usd_per_month numeric(12, 4) NOT NULL,
  PRIMARY KEY (provider, item)
);

CREATE TABLE IF NOT EXISTS sentinela.fixed_costs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  usd_per_month numeric(12, 2) NOT NULL,
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sentinela.heartbeats (
  id                 text PRIMARY KEY,
  expected_every_sec int NOT NULL,
  last_seen_at       timestamptz
);

-- Precos de referencia (USD/mes). Confira e ajuste no painel: sao estimativas.
INSERT INTO sentinela.price_book (provider, item, usd_per_month) VALUES
  ('RENDER', 'free', 0), ('RENDER', 'starter', 7), ('RENDER', 'standard', 25), ('RENDER', 'pro', 85),
  ('RENDER', 'pro_plus', 175), ('RENDER', 'pro_max', 225), ('RENDER', 'pro_ultra', 450),
  ('VERCEL', 'hobby', 0), ('VERCEL', 'pro', 20)
ON CONFLICT DO NOTHING;
