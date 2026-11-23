-- Ajustes feitos pelo painel (sobrepoem as variaveis de ambiente sem precisar de deploy)
CREATE TABLE IF NOT EXISTS app.settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Busca: nomes com erro de digitacao e texto das mensagens
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS contacts_name_trgm ON app.contacts USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS messages_content_trgm ON app.messages USING gin (content gin_trgm_ops);
