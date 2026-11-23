-- Permissao por numero E por contato: a conversa (contato + numero) diz se a IA daquele numero responde e se responde sozinha.
ALTER TABLE app.threads ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app.threads ADD COLUMN IF NOT EXISTS ai_auto boolean NOT NULL DEFAULT false;

-- o que era tag no contato (BOT/AUTO) vira permissao nas conversas dele
UPDATE app.threads t SET ai_enabled = true FROM app.contacts c WHERE c.id = t.contact_id AND 'BOT' = ANY(c.tags);
UPDATE app.threads t SET ai_auto = true FROM app.contacts c WHERE c.id = t.contact_id AND 'AUTO' = ANY(c.tags);

-- a caixinha da conversa passa a ser a unica fonte: as tags antigas saem
UPDATE app.contacts SET tags = array_remove(array_remove(tags, 'BOT'), 'AUTO') WHERE tags && ARRAY['BOT', 'AUTO'];
