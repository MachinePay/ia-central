-- Provedor que bloqueia envio vindo da nuvem (ex.: Uni5): a conta le normal e as respostas vao para Rascunhos do webmail
ALTER TABLE app.mail_accounts ADD COLUMN IF NOT EXISTS smtp_ok boolean NOT NULL DEFAULT true;
