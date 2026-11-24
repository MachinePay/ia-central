-- Uma conta de Gmail por numero (pessoa), conectada pelo painel com o login do Google
CREATE TABLE IF NOT EXISTS app.gmail_accounts (
  email text PRIMARY KEY,
  instance text,
  refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
