-- =====================================================================
-- IA Central - LOTE DE MENSAGENS: a IA espera a pessoa terminar de escrever.
-- Cada mensagem entra no lote da conversa; so a ULTIMA execucao (sem mensagem mais nova
-- depois de esperar) fecha o lote e responde UMA vez, lendo tudo junto.
-- lote_segundos: quanto esperar depois da ultima mensagem (padrao 12s). Idempotente.
-- =====================================================================

INSERT INTO nucleo.config VALUES ('lote_segundos', '12') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS nucleo.lote_mensagens (
    id        bigserial PRIMARY KEY,
    chave     text NOT NULL,              -- instancia:numero:agente
    texto     text NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),
    fechado   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS lote_aberto ON nucleo.lote_mensagens (chave, id) WHERE NOT fechado;

CREATE OR REPLACE FUNCTION nucleo.lote_adicionar(p_chave text, p_texto text)
RETURNS TABLE (id bigint, espera int) LANGUAGE sql AS $$
    INSERT INTO nucleo.lote_mensagens (chave, texto) VALUES (p_chave, coalesce(nullif(p_texto, ''), '(mensagem vazia)'))
    RETURNING id, least(60, greatest(3, coalesce((SELECT (valor #>> '{}')::int FROM nucleo.config WHERE chave = 'lote_segundos'), 12)))
$$;

-- devolve o texto juntado se esta execucao e a ultima do lote; senao, nada (outra execucao responde)
CREATE OR REPLACE FUNCTION nucleo.lote_fechar(p_chave text, p_id bigint)
RETURNS TABLE (texto text, quantidade int) LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM nucleo.lote_mensagens l WHERE l.chave = p_chave AND NOT l.fechado AND l.id > p_id) THEN
        RETURN;   -- chegou mensagem mais nova: a execucao dela responde por todas
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
