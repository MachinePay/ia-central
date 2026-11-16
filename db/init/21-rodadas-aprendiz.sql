-- =====================================================================
-- IA Central - RODADAS DO APRENDIZ: cada vez que o aprendiz roda, guarda por IA quantas conversas e
-- mensagens leu, quantos itens aprendeu, quanto custou (estimado) e quanto tempo levou.
-- Aparece na aba Aprendizado de cada IA. Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS nucleo.aprendiz_rodadas (
    id         bigserial PRIMARY KEY,
    em         timestamptz NOT NULL DEFAULT now(),
    origem     text NOT NULL DEFAULT 'automatico',   -- automatico (de hora em hora) | painel (aprender agora)
    agente     text NOT NULL,
    conversas  int NOT NULL DEFAULT 0,
    mensagens  int NOT NULL DEFAULT 0,
    itens      int NOT NULL DEFAULT 0,
    erros      int NOT NULL DEFAULT 0,
    custo      numeric NOT NULL DEFAULT 0,
    duracao_ms int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS aprendiz_rodadas_agente ON nucleo.aprendiz_rodadas (agente, em DESC);

CREATE OR REPLACE FUNCTION nucleo.rodada_registrar(p jsonb) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE a jsonb; n int := 0;
BEGIN
    FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p->'agentes', '[]')) LOOP
        CONTINUE WHEN coalesce(a->>'agente', '') NOT IN ('leo', 'gabriel', 'joao', 'suporte');
        INSERT INTO nucleo.aprendiz_rodadas (origem, agente, conversas, mensagens, itens, erros, custo, duracao_ms)
        VALUES (coalesce(nullif(p->>'origem', ''), 'automatico'), a->>'agente',
                coalesce((a->>'conversas')::int, 0), coalesce((a->>'mensagens')::int, 0), coalesce((a->>'itens')::int, 0),
                coalesce((a->>'erros')::int, 0),
                nucleo.preco_estimado(a->>'modelo', coalesce((a->>'entrada')::int, 0), coalesce((a->>'saida')::int, 0), 0),
                coalesce((p->>'duracao_ms')::int, 0));
        n := n + 1;
    END LOOP;
    DELETE FROM nucleo.aprendiz_rodadas WHERE em < now() - interval '90 days';
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION nucleo.rodadas_agente(p_agente text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'rodadas', coalesce((SELECT jsonb_agg(to_jsonb(r) - 'agente' ORDER BY r.em DESC)
                               FROM (SELECT * FROM nucleo.aprendiz_rodadas WHERE agente = p_agente ORDER BY em DESC LIMIT 30) r), '[]'),
        'total_7d', (SELECT jsonb_build_object('rodadas', count(*), 'conversas', coalesce(sum(conversas), 0),
                            'mensagens', coalesce(sum(mensagens), 0), 'itens', coalesce(sum(itens), 0), 'custo', coalesce(sum(custo), 0))
                       FROM nucleo.aprendiz_rodadas WHERE agente = p_agente AND em > now() - interval '7 days'))
$$;
