-- e-mail que a regra mandou apagar e ja foi para a lixeira do webmail
ALTER TABLE app.emails ADD COLUMN IF NOT EXISTS trashed boolean NOT NULL DEFAULT false;
