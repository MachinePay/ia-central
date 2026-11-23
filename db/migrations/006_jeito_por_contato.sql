-- Como o dono do numero trata cada contato (apelido, intimidade, tom), aprendido das mensagens ja mandadas a ele.
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS treatment text;
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS treatment_at timestamptz;
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS treatment_manual boolean NOT NULL DEFAULT false;
