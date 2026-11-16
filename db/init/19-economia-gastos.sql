-- =====================================================================
-- IA Central - ECONOMIA E GASTOS
--  - aprendiz le SO as mensagens que ainda nao leu (as suas e as da pessoa), nunca reler o que ja aprendeu
--  - contexto do que a IA ja sabe: 30 itens (era 80)
--  - teto diario de gasto: passou do limite, o aprendiz pausa ate o dia seguinte (as respostas continuam)
--  - gasto por dia: valor real da OpenAI (chave admin) + estimativa propria (aprendiz e audios)
-- Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------- janela: so o que ainda nao foi lido
CREATE OR REPLACE FUNCTION nucleo.transcricao_janela(p_tipo text, p_a text, p_b text, p_ate timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
    WITH base AS (
        SELECT c.* FROM nucleo.conversas c WHERE CASE p_tipo
            WHEN 'cliente' THEN c.cliente_id = p_a::int AND coalesce(c.instancia, 'joao') = p_b
            WHEN 'contato' THEN c.agente IN (p_b, CASE p_b WHEN 'gabriel-observa' THEN 'gabriel' ELSE '-' END)
                                AND split_part(c.contato, ' ', 1) = p_a
            WHEN 'dono' THEN c.agente = p_a
            WHEN 'leo' THEN c.usuario_id = p_a::int AND c.cliente_id IS NULL
                            AND (c.agente = 'ia-pessoal' OR (c.papel = 'ia' AND coalesce(c.agente, '') NOT LIKE '%-dono'
                                 AND coalesce(c.agente, '') NOT IN ('gabriel', 'leo-observa', 'gabriel-observa')))
            ELSE false END
    ), novas AS (
        SELECT * FROM base WHERE criado_em > coalesce(p_ate, '-infinity'::timestamptz) ORDER BY criado_em DESC LIMIT 40
    ), antes AS (
        SELECT * FROM base WHERE false   -- nada do que ja foi lido volta (economia)
    ), rotulo AS (
        SELECT v.*, v.criado_em > coalesce(p_ate, '-infinity'::timestamptz) AS nova,
               CASE p_tipo
                   WHEN 'cliente' THEN CASE v.papel WHEN 'usuario' THEN 'CLIENTE' WHEN 'humano' THEN 'ATENDENTE HUMANO' ELSE 'IA' END
                   WHEN 'contato' THEN CASE v.papel WHEN 'humano' THEN 'DONO' WHEN 'ia' THEN 'IA' ELSE 'CONTATO' END
                   WHEN 'dono' THEN CASE v.papel WHEN 'humano' THEN 'DONO' ELSE 'IA' END
                   ELSE CASE v.papel WHEN 'usuario' THEN 'DONO' ELSE 'IA' END END AS quem
          FROM (SELECT * FROM novas UNION ALL SELECT * FROM antes) v
    )
    SELECT CASE WHEN EXISTS (SELECT 1 FROM rotulo WHERE NOT nova)
                THEN '(contexto, ja aprendido antes:)' || E'\n'
                     || (SELECT string_agg(quem || ': ' || mensagem, E'\n' ORDER BY criado_em) FROM rotulo WHERE NOT nova)
                     || E'\n--- MENSAGENS NOVAS (aprenda com estas) ---\n'
                ELSE '' END
        || coalesce((SELECT string_agg(quem || ': ' || mensagem, E'\n' ORDER BY criado_em) FROM rotulo WHERE nova), '')
$$;

CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_agente(p_limite int, p_agente text)
RETURNS TABLE (cliente_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT c.id, nucleo.transcricao_janela('cliente', c.id::text, nucleo.instancia_do_agente(p_agente),
                     CASE p_agente WHEN 'suporte' THEN c.suporte_aprendido_ate ELSE c.aprendido_ate END)
      FROM nucleo.clientes c
     WHERE EXISTS (SELECT 1 FROM nucleo.conversas v
                    WHERE v.cliente_id = c.id AND v.papel = 'humano'
                      AND coalesce(v.instancia, 'joao') = nucleo.instancia_do_agente(p_agente)
                      AND v.criado_em > coalesce(CASE p_agente WHEN 'suporte' THEN c.suporte_aprendido_ate ELSE c.aprendido_ate END,
                                                 '-infinity'::timestamptz))
     ORDER BY c.ultimo_contato DESC
     LIMIT p_limite
$$;

CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_todos(p_limite int DEFAULT 25)
RETURNS TABLE (tipo text, chave text, dono_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT 'joao', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'joao') p
    UNION ALL
    SELECT 'suporte', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'suporte') p
    UNION ALL
    SELECT CASE WHEN x.fonte = 'gabriel-observa' THEN 'gabriel' ELSE 'leo' END,
           CASE WHEN x.fonte = 'gabriel-observa' THEN 'g:' ELSE '' END || x.contato, x.usuario_id,
           nucleo.transcricao_janela('contato', x.contato, x.fonte, x.ate)
      FROM (SELECT c.agente AS fonte, split_part(c.contato, ' ', 1) AS contato, max(c.usuario_id) AS usuario_id, max(pr.ate) AS ate
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'leo'
                    AND pr.chave = CASE WHEN c.agente = 'gabriel-observa' THEN 'g:' ELSE '' END || split_part(c.contato, ' ', 1)
             WHERE c.agente IN ('leo-observa', 'gabriel-observa') AND c.papel = 'humano' AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1, 2 ORDER BY max(c.criado_em) DESC LIMIT p_limite) x
    UNION ALL
    SELECT d.ia, 'dono:' || d.ia, d.usuario_id, nucleo.transcricao_janela('dono', d.ia || '-dono', '', d.ate)
      FROM (SELECT replace(c.agente, '-dono', '') AS ia, max(c.usuario_id) AS usuario_id, max(pr.ate) AS ate
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'dono' AND pr.chave = 'dono:' || replace(c.agente, '-dono', '')
             WHERE c.agente IN ('joao-dono', 'suporte-dono', 'gabriel-dono') AND c.papel = 'humano'
               AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1) d
    UNION ALL
    SELECT 'leo', 'dono:leo:' || l.usuario_id, l.usuario_id, nucleo.transcricao_janela('leo', l.usuario_id::text, '', l.ate)
      FROM (SELECT c.usuario_id, max(pr.ate) AS ate
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'dono' AND pr.chave = 'dono:leo:' || c.usuario_id
             WHERE c.agente = 'ia-pessoal' AND c.papel = 'usuario' AND c.usuario_id IS NOT NULL
               AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1) l
$$;

-- contexto menor (30 itens)
CREATE OR REPLACE FUNCTION nucleo.memoria_resumo(p_usuario int) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || coalesce(titulo, '') || ': ' || left(conteudo, 160), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND agente = 'leo' ORDER BY criado_em DESC LIMIT 30) k
$$;
CREATE OR REPLACE FUNCTION nucleo.base_resumo_agente(p_agente text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- [' || dominio || '] ' || coalesce(titulo, '') || ': ' || left(conteudo, 160), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE usuario_id IS NULL AND agente = p_agente ORDER BY criado_em DESC LIMIT 30) k
$$;

-- ---------------------------------------------------------------- uso estimado (o que da para medir aqui)
CREATE TABLE IF NOT EXISTS nucleo.uso_ia (
    id       bigserial PRIMARY KEY,
    em       timestamptz NOT NULL DEFAULT now(),
    tipo     text NOT NULL,           -- aprendiz | transcricao
    agente   text,
    modelo   text,
    entrada  int NOT NULL DEFAULT 0,  -- tokens
    saida    int NOT NULL DEFAULT 0,
    segundos numeric NOT NULL DEFAULT 0,
    custo    numeric NOT NULL DEFAULT 0   -- USD (estimado pela tabela de precos abaixo)
);
CREATE INDEX IF NOT EXISTS uso_ia_em ON nucleo.uso_ia (em);

-- precos (USD) usados na estimativa: por 1M tokens de entrada/saida, ou por minuto de audio
CREATE OR REPLACE FUNCTION nucleo.preco_estimado(p_modelo text, p_entrada int, p_saida int, p_segundos numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_modelo = 'gpt-5' THEN p_entrada * 1.25 / 1e6 + p_saida * 10.0 / 1e6
        WHEN p_modelo = 'gpt-5-mini' THEN p_entrada * 0.25 / 1e6 + p_saida * 2.0 / 1e6
        WHEN p_modelo = 'gpt-5-nano' THEN p_entrada * 0.05 / 1e6 + p_saida * 0.4 / 1e6
        WHEN p_modelo = 'gpt-4o-mini-transcribe' THEN p_segundos / 60 * 0.003
        WHEN p_modelo = 'whisper-1' THEN p_segundos / 60 * 0.006
        ELSE p_entrada * 0.25 / 1e6 + p_saida * 2.0 / 1e6 END
$$;

CREATE OR REPLACE FUNCTION nucleo.uso_registrar(p_tipo text, p_agente text, p_modelo text, p_entrada int, p_saida int, p_segundos numeric)
RETURNS int LANGUAGE sql AS $$
    INSERT INTO nucleo.uso_ia (tipo, agente, modelo, entrada, saida, segundos, custo)
    VALUES (p_tipo, p_agente, p_modelo, coalesce(p_entrada, 0), coalesce(p_saida, 0), coalesce(p_segundos, 0),
            nucleo.preco_estimado(p_modelo, coalesce(p_entrada, 0), coalesce(p_saida, 0), coalesce(p_segundos, 0)));
    DELETE FROM nucleo.uso_ia WHERE em < now() - interval '120 days';
    SELECT 1
$$;

-- ---------------------------------------------------------------- gasto real (API de custos da OpenAI, chave admin)
CREATE TABLE IF NOT EXISTS nucleo.gastos_openai (
    dia           date NOT NULL,
    item          text NOT NULL,     -- ex.: "gpt-5-mini, input"
    valor         numeric NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dia, item)
);

CREATE OR REPLACE FUNCTION nucleo.gastos_salvar(p_itens jsonb) RETURNS int
LANGUAGE sql AS $$
    INSERT INTO nucleo.gastos_openai (dia, item, valor)
    SELECT (x->>'dia')::date, coalesce(nullif(x->>'item', ''), 'outros'), sum((x->>'valor')::numeric)
      FROM jsonb_array_elements(coalesce(p_itens, '[]')) x GROUP BY 1, 2
    ON CONFLICT (dia, item) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now();
    SELECT jsonb_array_length(coalesce(p_itens, '[]'))
$$;

INSERT INTO nucleo.config VALUES ('limite_gasto_dia', '2') ON CONFLICT DO NOTHING;   -- USD por dia

-- gasto de hoje (horario de Brasilia): o maior entre o real da OpenAI e a estimativa propria
CREATE OR REPLACE FUNCTION nucleo.gasto_hoje() RETURNS numeric
LANGUAGE sql STABLE AS $$
    SELECT greatest(
        coalesce((SELECT sum(valor) FROM nucleo.gastos_openai WHERE dia = (now() AT TIME ZONE 'UTC')::date), 0),
        coalesce((SELECT sum(custo) FROM nucleo.uso_ia WHERE em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'), 0))
$$;

-- o aprendiz pode rodar? (passou do teto: pausa e avisa uma vez por dia)
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pode_rodar() RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE lim numeric := coalesce((SELECT (valor #>> '{}')::numeric FROM nucleo.config WHERE chave = 'limite_gasto_dia'), 2);
        g numeric := nucleo.gasto_hoje();
BEGIN
    IF lim <= 0 OR g < lim THEN RETURN true; END IF;
    IF NOT EXISTS (SELECT 1 FROM nucleo.eventos WHERE agente = 'aprendiz' AND titulo LIKE 'Aprendiz pausado%'
                    AND criado_em > date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') THEN
        PERFORM nucleo.registrar_evento('aprendiz', 'aviso',
            'Aprendiz pausado hoje: gasto chegou no limite de US$ ' || to_char(lim, 'FM990.00') || ' (volta amanha)',
            'Gasto de hoje: US$ ' || to_char(g, 'FM990.00') || '. As IAs continuam respondendo; so o aprendizado pausa. Mude o limite em Gastos.', '{}');
    END IF;
    RETURN false;
END $$;

-- painel: gasto por dia (ultimos 30), por modelo, hoje, mes
CREATE OR REPLACE FUNCTION nucleo.painel_gastos() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    WITH dias AS (SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo')::date - 29, (now() AT TIME ZONE 'America/Sao_Paulo')::date, '1 day')::date AS dia),
    real AS (SELECT dia, sum(valor) AS v FROM nucleo.gastos_openai GROUP BY 1),
    est AS (SELECT (em AT TIME ZONE 'America/Sao_Paulo')::date AS dia, sum(custo) AS v,
                   sum(custo) FILTER (WHERE tipo = 'aprendiz') AS aprendiz, sum(custo) FILTER (WHERE tipo = 'transcricao') AS audio
              FROM nucleo.uso_ia GROUP BY 1)
    SELECT jsonb_build_object(
        'fonte', CASE WHEN EXISTS (SELECT 1 FROM nucleo.gastos_openai WHERE atualizado_em > now() - interval '1 day') THEN 'openai' ELSE 'estimativa' END,
        'atualizado_em', (SELECT max(atualizado_em) FROM nucleo.gastos_openai),
        'limite', coalesce((SELECT (valor #>> '{}')::numeric FROM nucleo.config WHERE chave = 'limite_gasto_dia'), 2),
        'hoje', nucleo.gasto_hoje(),
        'aprendiz_pausado', nucleo.gasto_hoje() >= coalesce((SELECT (valor #>> '{}')::numeric FROM nucleo.config WHERE chave = 'limite_gasto_dia'), 2)
                            AND coalesce((SELECT (valor #>> '{}')::numeric FROM nucleo.config WHERE chave = 'limite_gasto_dia'), 2) > 0,
        'dias', (SELECT jsonb_agg(jsonb_build_object('dia', d.dia, 'real', r.v, 'estimado', coalesce(e.v, 0),
                        'aprendiz', coalesce(e.aprendiz, 0), 'audio', coalesce(e.audio, 0)) ORDER BY d.dia)
                   FROM dias d LEFT JOIN real r ON r.dia = d.dia LEFT JOIN est e ON e.dia = d.dia),
        'por_item', coalesce((SELECT jsonb_agg(jsonb_build_object('item', item, 'valor', v) ORDER BY v DESC)
                   FROM (SELECT item, sum(valor) AS v FROM nucleo.gastos_openai
                          WHERE dia > (now() AT TIME ZONE 'UTC')::date - 30 GROUP BY 1) x), '[]'),
        -- o que da para medir aqui, por IA e funcao (aprendiz e audios; as respostas nao sao medidas por IA)
        'por_uso', coalesce((SELECT jsonb_agg(jsonb_build_object('agente', agente, 'tipo', tipo, 'valor', v, 'vezes', n, 'segundos', seg) ORDER BY v DESC)
                   FROM (SELECT coalesce(nullif(agente, ''), 'outros') AS agente, tipo, sum(custo) AS v, count(*) AS n, sum(segundos) AS seg
                           FROM nucleo.uso_ia WHERE em > now() - interval '30 days' GROUP BY 1, 2) x), '[]'),
        'erro_openai', (SELECT valor->>'erro' FROM nucleo.config WHERE chave = 'gastos_status'),
        'lido_em', (SELECT valor->>'em' FROM nucleo.config WHERE chave = 'gastos_status'),
        'mes', coalesce((SELECT sum(valor) FROM nucleo.gastos_openai WHERE date_trunc('month', dia) = date_trunc('month', now() AT TIME ZONE 'UTC')), 0),
        'mes_estimado', coalesce((SELECT sum(custo) FROM nucleo.uso_ia WHERE date_trunc('month', em AT TIME ZONE 'America/Sao_Paulo') = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')), 0))
$$;

-- ultima leitura do gasto na OpenAI: deu certo ou o motivo do erro (mostrado na pagina Gastos)
CREATE OR REPLACE FUNCTION nucleo.gastos_status(p_erro text) RETURNS int
LANGUAGE sql AS $$
    INSERT INTO nucleo.config VALUES ('gastos_status', jsonb_build_object('erro', nullif(p_erro, ''), 'em', now()))
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
    SELECT 1
$$;
