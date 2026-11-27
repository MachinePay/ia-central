-- Ultima(s) mensagem(ns) do contato sao so encerramento ("valeu", "obrigado", "ok 👍"): a conversa nao fica "sem resposta".
-- NULL = ainda nao calculado (o worker preenche as conversas recentes ao subir).
ALTER TABLE app.threads ADD COLUMN IF NOT EXISTS last_inbound_closing boolean;
