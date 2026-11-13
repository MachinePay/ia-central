-- =====================================================================
-- IA Central - AUDIO (inclusive longo): enquanto um audio da conversa esta sendo transcrito, o lote espera.
-- Assim, se a pessoa manda um audio e escreve "analisa isso", a IA responde tudo junto, depois de ouvir.
-- (A marca vence sozinha em 10 min, caso a transcricao quebre no meio.) Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS nucleo.audio_pendente (
    id        bigserial PRIMARY KEY,
    base      text NOT NULL,                  -- instancia:numero
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_pendente_base ON nucleo.audio_pendente (base, criado_em);

CREATE OR REPLACE FUNCTION nucleo.audio_marcar(p_base text) RETURNS bigint
LANGUAGE sql AS $$
    DELETE FROM nucleo.audio_pendente WHERE criado_em < now() - interval '10 minutes';
    INSERT INTO nucleo.audio_pendente (base) VALUES (p_base) RETURNING id
$$;

CREATE OR REPLACE FUNCTION nucleo.audio_desmarcar(p_id bigint) RETURNS boolean
LANGUAGE sql AS $$
    DELETE FROM nucleo.audio_pendente WHERE id = p_id RETURNING true
$$;

-- fecha o lote so se esta e a ultima mensagem E nao tem audio dessa conversa ainda sendo transcrito
CREATE OR REPLACE FUNCTION nucleo.lote_fechar(p_chave text, p_id bigint)
RETURNS TABLE (texto text, quantidade int) LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM nucleo.lote_mensagens l WHERE l.chave = p_chave AND NOT l.fechado AND l.id > p_id) THEN
        RETURN;   -- chegou mensagem mais nova: a execucao dela responde por todas
    END IF;
    IF EXISTS (SELECT 1 FROM nucleo.audio_pendente a
                WHERE a.base = split_part(p_chave, ':', 1) || ':' || split_part(p_chave, ':', 2)
                  AND a.criado_em > now() - interval '10 minutes') THEN
        RETURN;   -- tem audio sendo transcrito: a execucao do audio responde por tudo quando terminar
    END IF;
    RETURN QUERY
    WITH f AS (
        UPDATE nucleo.lote_mensagens l SET fechado = true
         WHERE l.chave = p_chave AND NOT l.fechado AND l.id <= p_id
        RETURNING l.id, l.texto
    )
    SELECT string_agg(f.texto, E'\n' ORDER BY f.id), count(*)::int FROM f HAVING count(*) > 0;
    DELETE FROM nucleo.lote_mensagens WHERE fechado AND criado_em < now() - interval '2 days';
END $$;
