-- Pagina de e-mail: tudo o que chegou em cada conta (inclusive o que a IA nao respondeu) e as regras de cada IA
CREATE TABLE IF NOT EXISTS app.emails (
  id          bigserial PRIMARY KEY,
  instance    text NOT NULL,          -- numero (IA) dona da conta
  account     text NOT NULL,          -- o e-mail que recebeu
  message_id  text NOT NULL UNIQUE,
  from_email  text,
  from_name   text,
  subject     text,
  snippet     text,
  received_at timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL,          -- ia | guardado | apagado | filtrado
  notified    boolean NOT NULL DEFAULT false,
  rule_id     bigint,
  detail      text,
  thread_id   uuid
);
CREATE INDEX IF NOT EXISTS emails_instance_idx ON app.emails (instance, received_at DESC);

CREATE TABLE IF NOT EXISTS app.email_rules (
  id         bigserial PRIMARY KEY,
  instance   text NOT NULL,
  kind       text NOT NULL,           -- from | domain | subject
  pattern    text NOT NULL,
  action     text NOT NULL,           -- reply | delete | notify | ignore
  active     boolean NOT NULL DEFAULT true,
  hits       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_rules_instance_idx ON app.email_rules (instance);
