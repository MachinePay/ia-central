-- =====================================================================
-- IA Central - MONITOR v2: tempo de resposta, Render e Vercel, avisos para os admins
-- Idempotente.
-- =====================================================================

ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS tipo            text NOT NULL DEFAULT 'http';   -- http | plataforma
ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS origem          text NOT NULL DEFAULT 'manual'; -- manual | render | vercel
ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS externo_id      text;     -- ex: render:srv-123:deploy
ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS painel_url      text;     -- link do painel da plataforma
ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS ultimo_tempo_ms int;      -- tempo de resposta do ultimo check
ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS visto_em        timestamptz; -- ultima vez que a plataforma listou
-- status_esperado 0 = qualquer resposta abaixo de 400 (aceita redirecionamento)
ALTER TABLE nucleo.sistemas ALTER COLUMN status_esperado SET DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS sistemas_externo ON nucleo.sistemas (externo_id) WHERE externo_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Plataformas mandam a lista do que existe na conta. Para cada item:
--   * cria/atualiza o "sistema" do deploy (tipo plataforma) e devolve o check dele
--   * se tiver URL publica, cria/atualiza um sistema http para o monitor bater nela
-- itens: [{origem, externo_id, nome, ok, detalhe, painel_url, url}]
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.sincronizar_plataformas(itens jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    it  jsonb;
    sid int;
    checks jsonb := '[]';
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(itens, '[]')) LOOP
        INSERT INTO nucleo.sistemas (nome, grupo, url, tipo, origem, externo_id, painel_url, status_esperado, falhas_para_alertar, visto_em)
        VALUES (it->>'nome', it->>'origem', coalesce(it->>'painel_url', '-'), 'plataforma', it->>'origem',
                it->>'externo_id', it->>'painel_url', 0, 1, now())
        ON CONFLICT (externo_id) WHERE externo_id IS NOT NULL
        DO UPDATE SET nome = EXCLUDED.nome, painel_url = EXCLUDED.painel_url, url = EXCLUDED.url, visto_em = now()
        RETURNING id INTO sid;
        IF (SELECT ativo FROM nucleo.sistemas WHERE id = sid) THEN
            checks := checks || jsonb_build_array(jsonb_build_object(
                'sistema_id', sid, 'ok', (it->>'ok')::boolean, 'detalhe', it->>'detalhe'));
        END IF;

        IF coalesce(it->>'url', '') <> '' THEN
            INSERT INTO nucleo.sistemas (nome, grupo, url, tipo, origem, externo_id, painel_url, status_esperado, visto_em)
            VALUES (it->>'nome_site', it->>'origem', it->>'url', 'http', it->>'origem',
                    (it->>'externo_id') || ':site', it->>'painel_url', 0, now())
            ON CONFLICT (externo_id) WHERE externo_id IS NOT NULL
            DO UPDATE SET url = EXCLUDED.url, nome = EXCLUDED.nome, painel_url = EXCLUDED.painel_url, visto_em = now();
        END IF;
    END LOOP;
    RETURN checks;
END $$;

-- ---------------------------------------------------------------------
-- registrar_checks v2: guarda tempo de resposta e avisa tambem os ADMINS
-- (canal 'usuario': o n8n entrega por WhatsApp ou Telegram, o que a pessoa tiver)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.registrar_checks(checks jsonb)
RETURNS TABLE (
    incidente_id int, sistema text, evento text,
    contato_id int, canal text, destino text, mensagem text
)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
    c   jsonb;
    s   nucleo.sistemas%ROWTYPE;
    ok  boolean;
    det text;
    ev  text;
    inc int;
    tms int;
    onde text;
BEGIN
    FOR c IN SELECT * FROM jsonb_array_elements(checks) LOOP
        SELECT * INTO s FROM nucleo.sistemas WHERE id = (c->>'sistema_id')::int FOR UPDATE;
        CONTINUE WHEN NOT FOUND;
        ok  := (c->>'ok')::boolean;
        det := left(c->>'detalhe', 500);
        tms := (c->>'tempo_ms')::int;
        ev  := NULL;

        IF ok THEN
            IF s.estado = 'falha' THEN
                ev := 'voltou';
                UPDATE nucleo.incidentes SET fim = now()
                 WHERE sistema_id = s.id AND fim IS NULL
                 RETURNING id INTO inc;
            END IF;
            UPDATE nucleo.sistemas SET estado = 'ok', falhas_seguidas = 0, ultimo_tempo_ms = tms,
                   ultimo_detalhe = det, ultimo_check = now(), caiu_em = NULL
             WHERE id = s.id;
        ELSE
            UPDATE nucleo.sistemas SET falhas_seguidas = falhas_seguidas + 1, ultimo_tempo_ms = tms,
                   ultimo_detalhe = det, ultimo_check = now()
             WHERE id = s.id;
            IF s.estado <> 'falha' AND s.falhas_seguidas + 1 >= s.falhas_para_alertar THEN
                ev := 'caiu';
                UPDATE nucleo.sistemas SET estado = 'falha', caiu_em = now() WHERE id = s.id;
                INSERT INTO nucleo.incidentes (sistema_id, detalhe) VALUES (s.id, det)
                RETURNING id INTO inc;
            END IF;
        END IF;

        IF ev IS NOT NULL THEN
            onde := CASE s.origem WHEN 'render' THEN 'Render' WHEN 'vercel' THEN 'Vercel' ELSE NULL END;
            RETURN QUERY
            WITH dest AS (
                -- contatos do escalonamento (Telegram/WhatsApp direto)
                SELECT DISTINCT ct.id AS cid, e.canal AS can,
                       CASE e.canal WHEN 'telegram' THEN ct.telegram_chat_id
                                    WHEN 'whatsapp' THEN ct.whatsapp
                                    ELSE ct.email END AS dst
                  FROM nucleo.escalonamento e
                  JOIN nucleo.contatos ct ON ct.id = e.contato_id AND ct.ativo
                 WHERE e.grupo IN (s.grupo, 'geral') AND e.ordem = 1
                UNION
                -- todos os admins ativos: WhatsApp se tiver, senao Telegram
                SELECT NULL::int,
                       CASE WHEN u.whatsapp IS NOT NULL THEN 'whatsapp' ELSE 'telegram' END,
                       coalesce(u.whatsapp, u.telegram_chat_id)
                  FROM nucleo.usuarios u
                 WHERE u.papel = 'admin' AND u.ativo AND (u.whatsapp IS NOT NULL OR u.telegram_chat_id IS NOT NULL)
            ), msg AS (
                SELECT CASE ev
                         WHEN 'caiu' THEN
                           '🔴 ' || s.nome || CASE WHEN s.tipo = 'plataforma' THEN ' com PROBLEMA' ELSE ' está FORA DO AR' END ||
                           coalesce(' (' || onde || ')', '') || E'\n' ||
                           CASE WHEN s.tipo = 'http' THEN 'URL: ' || s.url || E'\n' ELSE '' END ||
                           'Detalhe: ' || coalesce(det,'-') ||
                           coalesce(E'\n' || 'Painel: ' || s.painel_url, '')
                         ELSE
                           '🟢 ' || s.nome || ' VOLTOU ao normal' || coalesce(' (' || onde || ')', '') || E'\n' ||
                           'Ficou com problema por ' ||
                           coalesce(to_char(now() - s.caiu_em, 'HH24"h"MI"min"'), '?')
                       END AS txt
            ), ins AS (
                INSERT INTO nucleo.alertas AS a (incidente_id, contato_id, canal, destino, mensagem)
                SELECT inc, d.cid, d.can, d.dst, m.txt
                  FROM dest d, msg m
                 WHERE d.dst IS NOT NULL
                RETURNING a.incidente_id, a.contato_id, a.canal, a.destino, a.mensagem
            )
            SELECT ins.incidente_id, s.nome, ev, ins.contato_id, ins.canal, ins.destino, ins.mensagem
              FROM ins;
        END IF;
    END LOOP;
END $$;
