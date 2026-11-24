-- E-mail que nao e Google (Uni5, Locaweb, Outlook...): IMAP para ler e SMTP para responder
CREATE TABLE IF NOT EXISTS app.mail_accounts (
  email        text PRIMARY KEY,
  instance     text,
  username     text NOT NULL,
  password_enc text NOT NULL,
  imap_host    text NOT NULL,
  imap_port    int  NOT NULL DEFAULT 993,
  smtp_host    text NOT NULL,
  smtp_port    int  NOT NULL DEFAULT 587,
  last_uid     bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
