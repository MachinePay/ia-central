-- Login do cliente nos sistemas de venda (Girakids, PrimePlush), salvo no contato: o João confirma antes de tirar o pedido.
-- Formato: {"girakids": {"id": "...", "email": "...", "nome": "...", "documento": "..."}, "primeplush": {"documento": "...", "nome": "..."}}
ALTER TABLE app.contacts ADD COLUMN IF NOT EXISTS logins jsonb NOT NULL DEFAULT '{}'::jsonb;
