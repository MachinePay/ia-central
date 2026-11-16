-- =====================================================================
-- IA Central - PUXAR MENSAGENS NOVAS: a mesma mensagem nunca e processada duas vezes
-- (o botao "Puxar mensagens novas" reenvia o que a Evolution guardou; o que ja foi lido e ignorado). Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS nucleo.mensagens_vistas (
    id text PRIMARY KEY,
    em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mensagens_vistas_em ON nucleo.mensagens_vistas (em);

-- true = primeira vez que vemos essa mensagem (segue); false = repetida (para)
CREATE OR REPLACE FUNCTION nucleo.msg_nova(p_id text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
    IF coalesce(p_id, '') = '' THEN RETURN true; END IF;
    INSERT INTO nucleo.mensagens_vistas (id) VALUES (p_id) ON CONFLICT DO NOTHING RETURNING true INTO ok;
    IF random() < 0.01 THEN DELETE FROM nucleo.mensagens_vistas WHERE em < now() - interval '30 days'; END IF;
    RETURN coalesce(ok, false);
END $$;
