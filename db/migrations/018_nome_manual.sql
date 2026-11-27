-- Nome corrigido a mao no painel: ganha do nome que vem do WhatsApp (que muitas vezes e o nome de perfil da pessoa, ex.: um emoji)
ALTER TABLE app.contact_names ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
