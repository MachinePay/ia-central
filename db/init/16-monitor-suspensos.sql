-- =====================================================================
-- IA Central - MONITOR SEM ALARME FALSO:
--  - servico SUSPENSO no Render (ou apagado no Render/Vercel) some do painel e do monitor sozinho;
--    se voltar a ficar ativo, reaparece sozinho.
--  - site descoberto automaticamente: qualquer resposta do servidor (< 500) conta como "no ar"
--    (API costuma responder 404 na pagina inicial) e o Render free pode demorar para acordar.
-- Idempotente.
-- =====================================================================

ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS oculto_auto boolean NOT NULL DEFAULT false;

-- o que ja estava cadastrado como site automatico passa a aceitar qualquer resposta < 500
UPDATE nucleo.sistemas SET status_esperado = -1, timeout_ms = greatest(timeout_ms, 45000)
 WHERE origem IN ('render', 'vercel') AND tipo = 'http' AND status_esperado = 0;

CREATE OR REPLACE FUNCTION nucleo.sincronizar_plataformas(itens jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    it  jsonb;
    sid int;
    checks jsonb := '[]';
    eid text;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(itens, '[]')) LOOP
        eid := it->>'externo_id';
        -- suspenso: some (deploy e site) ate voltar
        IF coalesce((it->>'suspenso')::boolean, false) THEN
            UPDATE nucleo.sistemas SET ativo = false, oculto_auto = true, estado = 'desconhecido', visto_em = now()
             WHERE externo_id IN (eid, eid || ':site');
            CONTINUE;
        END IF;

        INSERT INTO nucleo.sistemas (nome, grupo, url, tipo, origem, externo_id, painel_url, status_esperado, falhas_para_alertar, visto_em)
        VALUES (it->>'nome', it->>'origem', coalesce(it->>'painel_url', '-'), 'plataforma', it->>'origem',
                eid, it->>'painel_url', 0, 1, now())
        ON CONFLICT (externo_id) WHERE externo_id IS NOT NULL
        DO UPDATE SET nome = EXCLUDED.nome, painel_url = EXCLUDED.painel_url, url = EXCLUDED.url, visto_em = now()
        RETURNING id INTO sid;
        -- voltou depois de suspenso/apagado: reaparece
        UPDATE nucleo.sistemas SET ativo = true, oculto_auto = false WHERE id = sid AND oculto_auto;
        IF (SELECT ativo FROM nucleo.sistemas WHERE id = sid) THEN
            checks := checks || jsonb_build_array(jsonb_build_object(
                'sistema_id', sid, 'ok', (it->>'ok')::boolean, 'detalhe', it->>'detalhe'));
        END IF;

        IF coalesce(it->>'url', '') <> '' THEN
            INSERT INTO nucleo.sistemas (nome, grupo, url, tipo, origem, externo_id, painel_url, status_esperado, timeout_ms, visto_em)
            VALUES (it->>'nome_site', it->>'origem', it->>'url', 'http', it->>'origem',
                    eid || ':site', it->>'painel_url', -1, 45000, now())
            ON CONFLICT (externo_id) WHERE externo_id IS NOT NULL
            DO UPDATE SET url = EXCLUDED.url, nome = EXCLUDED.nome, painel_url = EXCLUDED.painel_url, visto_em = now(),
                          ativo = CASE WHEN nucleo.sistemas.oculto_auto THEN true ELSE nucleo.sistemas.ativo END,
                          oculto_auto = false;
        END IF;
    END LOOP;

    -- apagado na plataforma (nao aparece mais na conta): some. So quando a conta respondeu, para nao sumir tudo por erro de API.
    UPDATE nucleo.sistemas s SET ativo = false, oculto_auto = true, estado = 'desconhecido'
     WHERE s.origem IN ('render', 'vercel') AND s.externo_id NOT LIKE '%:conta' AND NOT s.oculto_auto
       AND s.visto_em < now() - interval '30 minutes'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(itens, '[]')) x
                    WHERE x->>'externo_id' = s.origem || ':conta' AND (x->>'ok')::boolean);
    RETURN checks;
END $$;

-- quem ja estava marcado como SUSPENSO pela versao antiga: some agora (volta sozinho se reativar)
UPDATE nucleo.sistemas SET ativo = false, oculto_auto = true, estado = 'desconhecido'
 WHERE origem = 'render' AND (ultimo_detalhe ILIKE '%SUSPENSO%'
    OR externo_id IN (SELECT externo_id || ':site' FROM nucleo.sistemas WHERE ultimo_detalhe ILIKE '%SUSPENSO%'));
