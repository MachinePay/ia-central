-- "Você" veio do WhatsApp (conversa consigo mesmo) e nao e nome de contato: o painel mostra o nome certo por numero
UPDATE app.contacts SET name = NULL WHERE name ~* '^\s*(voc[eê]|you)\s*$';
