-- =====================================================================
-- IA Central - CADA IA COM A SUA PROPRIA INTELIGENCIA.
-- Todo conhecimento tem dono: leo | gabriel | joao | suporte. Uma IA nunca le o que e da outra.
-- Passar algo de uma IA para outra so quando voce pedir (admin_conhecimento_copiar / botao no painel).
-- Idempotente.
-- =====================================================================

ALTER TABLE nucleo.conhecimento ADD COLUMN IF NOT EXISTS agente text;
CREATE INDEX IF NOT EXISTS conhecimento_agente ON nucleo.conhecimento (agente, aprovado, criado_em DESC);

-- quem insere sem dizer o dono: memoria de pessoa -> leo; base da empresa -> pela area/metadata
CREATE OR REPLACE FUNCTION nucleo.conhecimento_dono() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.agente IS NULL OR NEW.agente NOT IN ('leo', 'gabriel', 'joao', 'suporte') THEN
        NEW.agente := CASE
            WHEN NEW.metadata->>'agente' IN ('leo', 'gabriel', 'joao', 'suporte') THEN NEW.metadata->>'agente'
            WHEN NEW.usuario_id IS NOT NULL THEN 'leo'
            WHEN NEW.dominio IN ('suporte', 'sistemico') THEN 'suporte'
            ELSE 'joao' END;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS conhecimento_dono ON nucleo.conhecimento;
CREATE TRIGGER conhecimento_dono BEFORE INSERT ON nucleo.conhecimento FOR EACH ROW EXECUTE FUNCTION nucleo.conhecimento_dono();

-- migracao (uma vez): da dono ao que ja existe. O "geral" era usado por Joao e Suporte juntos:
-- cada um fica com a sua copia, para ninguem perder o que ja sabia.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_memorias_separadas') THEN
        UPDATE nucleo.conhecimento SET agente = CASE
            WHEN metadata->>'agente' IN ('leo', 'gabriel', 'joao', 'suporte') THEN metadata->>'agente'
            WHEN usuario_id IS NOT NULL THEN 'leo'
            WHEN dominio IN ('suporte', 'sistemico') THEN 'suporte'
            ELSE 'joao' END
         WHERE agente IS NULL;
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata, agente)
        SELECT NULL, dominio, titulo, conteudo, origem, aprovado, metadata || '{"copiado_de": "joao"}', 'suporte'
          FROM nucleo.conhecimento WHERE usuario_id IS NULL AND dominio = 'geral' AND agente = 'joao' AND metadata->>'agente' IS NULL;
        INSERT INTO nucleo.config VALUES ('migracao_memorias_separadas', 'true');
    END IF;
END $$;

-- ---------------------------------------------------------------- LEO (memoria de cada pessoa) - so o que e do Leo
CREATE OR REPLACE FUNCTION nucleo.buscar_memoria(p_usuario int, p_busca text, p_escopo text DEFAULT 'minha')
RETURNS TABLE (id bigint, de text, titulo text, conteudo text, criado_em timestamptz, relevante boolean)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('portuguese',
               unaccent(regexp_replace(coalesce(p_busca,''), '[;,|[:space:]]+', ' or ', 'g'))) AS tsq
    ), c AS (
        SELECT k.id, u.nome AS de, k.titulo, k.conteudo, k.criado_em,
               to_tsvector('portuguese', unaccent(coalesce(k.titulo,'') || ' ' || k.conteudo)) AS doc
          FROM nucleo.conhecimento k
          JOIN nucleo.usuarios u ON u.id = k.usuario_id
         WHERE k.aprovado AND k.agente = 'leo' AND nucleo.pode_ver_memoria(p_usuario, k.usuario_id, coalesce(p_escopo,'minha'))
    )
    SELECT c.id, c.de, c.titulo, c.conteudo, c.criado_em, c.doc @@ q.tsq
      FROM c, q
     ORDER BY c.doc @@ q.tsq DESC, ts_rank(c.doc, q.tsq) DESC, c.criado_em DESC
     LIMIT 20
$$;

CREATE OR REPLACE FUNCTION nucleo.memoria_resumo(p_usuario int) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || coalesce(titulo, '') || ': ' || left(conteudo, 160), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND agente = 'leo' ORDER BY criado_em DESC LIMIT 80) k
$$;

CREATE OR REPLACE FUNCTION nucleo.estilo_dono(p_usuario int) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE usuario_id = p_usuario AND agente = 'leo' AND aprovado
               AND (titulo ILIKE 'jeito de%' OR titulo ILIKE 'como resolve%' OR metadata->>'tipo' IN ('jeito_de_falar', 'como_resolve'))
             ORDER BY criado_em DESC LIMIT 20) k
$$;

-- ---------------------------------------------------------------- GABRIEL - inteligencia propria
CREATE OR REPLACE FUNCTION nucleo.buscar_memoria_gabriel(p_busca text)
RETURNS TABLE (titulo text, conteudo text, relevante boolean)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('portuguese',
               unaccent(regexp_replace(coalesce(p_busca,''), '[;,|[:space:]]+', ' or ', 'g'))) AS tsq
    ), c AS (
        SELECT k.titulo, k.conteudo, k.criado_em, to_tsvector('portuguese', unaccent(coalesce(k.titulo,'') || ' ' || k.conteudo)) AS doc
          FROM nucleo.conhecimento k WHERE k.agente = 'gabriel' AND k.aprovado
    )
    SELECT c.titulo, c.conteudo, c.doc @@ q.tsq FROM c, q
     ORDER BY c.doc @@ q.tsq DESC, ts_rank(c.doc, q.tsq) DESC, c.criado_em DESC LIMIT 20
$$;

CREATE OR REPLACE FUNCTION nucleo.memoria_gabriel(p_limite int DEFAULT 60) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || coalesce(titulo, '') || ': ' || left(conteudo, 200), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE agente = 'gabriel' AND aprovado ORDER BY criado_em DESC LIMIT p_limite) k
$$;

CREATE OR REPLACE FUNCTION nucleo.estilo_gabriel() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE agente = 'gabriel' AND aprovado
               AND (titulo ILIKE 'jeito de%' OR titulo ILIKE 'como resolve%' OR metadata->>'tipo' IN ('jeito_de_falar', 'como_resolve'))
             ORDER BY criado_em DESC LIMIT 20) k
$$;

-- o que o aprendiz do Gabriel tirou de uma conversa do numero dele
CREATE OR REPLACE FUNCTION nucleo.aprendiz_gabriel_salvar(p_dono int, p_chave text, p_itens jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; it jsonb; prefixo text;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        prefixo := CASE it->>'tipo' WHEN 'jeito_de_falar' THEN 'Jeito de falar: ' WHEN 'como_resolve' THEN 'Como resolve: ' ELSE '' END;
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata, agente)
        VALUES (p_dono, 'pessoal', left(prefixo || coalesce(it->>'titulo', ''), 120), it->>'conteudo', 'observacao_gabriel', false,
                jsonb_build_object('contato', replace(p_chave, 'g:', ''), 'tipo', it->>'tipo'), 'gabriel');
        n := n + 1;
    END LOOP;
    INSERT INTO nucleo.aprendiz_progresso VALUES ('leo', p_chave, now())
    ON CONFLICT (agente, chave) DO UPDATE SET ate = now();
    RETURN n;
END $$;

-- conversas para aprender: Leo (numero dele) e Gabriel (numero dele) separados
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_todos(p_limite int DEFAULT 25)
RETURNS TABLE (tipo text, chave text, dono_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT 'joao', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'joao') p
    UNION ALL
    SELECT 'suporte', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'suporte') p
    UNION ALL
    SELECT CASE WHEN x.fonte = 'gabriel-observa' THEN 'gabriel' ELSE 'leo' END,
           CASE WHEN x.fonte = 'gabriel-observa' THEN 'g:' ELSE '' END || x.contato, x.usuario_id,
           (SELECT string_agg(CASE v.papel WHEN 'humano' THEN 'DONO' WHEN 'ia' THEN 'IA' ELSE 'CONTATO' END || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas c2
                     WHERE c2.agente IN (x.fonte, CASE WHEN x.fonte = 'gabriel-observa' THEN 'gabriel' ELSE '-' END)
                       AND split_part(c2.contato, ' ', 1) = x.contato
                     ORDER BY c2.criado_em DESC LIMIT 60) v)
      FROM (SELECT c.agente AS fonte, split_part(c.contato, ' ', 1) AS contato, max(c.usuario_id) AS usuario_id
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'leo'
                    AND pr.chave = CASE WHEN c.agente = 'gabriel-observa' THEN 'g:' ELSE '' END || split_part(c.contato, ' ', 1)
             WHERE c.agente IN ('leo-observa', 'gabriel-observa') AND c.papel = 'humano' AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1, 2 ORDER BY max(c.criado_em) DESC LIMIT p_limite) x
$$;

-- ---------------------------------------------------------------- JOAO e SUPORTE - cada um a sua base
CREATE OR REPLACE FUNCTION nucleo.agente_da_area(p_area text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_area IN ('suporte', 'sistemico') THEN 'suporte' ELSE 'joao' END $$;

CREATE OR REPLACE FUNCTION nucleo.buscar_base(p_area text, p_busca text)
RETURNS TABLE (id bigint, area text, titulo text, conteudo text, relevante boolean)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('portuguese',
               unaccent(regexp_replace(coalesce(p_busca,''), '[;,|[:space:]]+', ' or ', 'g'))) AS tsq
    ), c AS (
        SELECT k.id, k.dominio, k.titulo, k.conteudo, k.criado_em,
               to_tsvector('portuguese', unaccent(coalesce(k.titulo,'') || ' ' || k.conteudo)) AS doc
          FROM nucleo.conhecimento k
         WHERE k.usuario_id IS NULL AND k.aprovado AND k.agente = nucleo.agente_da_area(p_area)
    )
    SELECT c.id, c.dominio, c.titulo, c.conteudo, c.doc @@ q.tsq
      FROM c, q
     ORDER BY c.doc @@ q.tsq DESC, ts_rank(c.doc, q.tsq) DESC, c.criado_em DESC
     LIMIT 12
$$;

DROP FUNCTION IF EXISTS nucleo.base_resumo_agente(text);
CREATE OR REPLACE FUNCTION nucleo.base_resumo_agente(p_agente text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- [' || dominio || '] ' || coalesce(titulo, '') || ': ' || left(conteudo, 160), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE usuario_id IS NULL AND agente = p_agente ORDER BY criado_em DESC LIMIT 80) k
$$;

CREATE OR REPLACE FUNCTION nucleo.estilo_agente(p_agente text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg(conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE usuario_id IS NULL AND aprovado AND titulo ILIKE 'jeito de%' AND agente = p_agente
             ORDER BY criado_em DESC LIMIT 4) k
$$;

-- resposta aprovada ensina SO a IA que escreveu
CREATE OR REPLACE FUNCTION nucleo.atendimento_aprovar(p_fila int, p_revisor int, p_texto text, p_area text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f nucleo.atendimento_fila%ROWTYPE; num text;
BEGIN
    UPDATE nucleo.atendimento_fila
       SET status = 'enviada', resposta_final = coalesce(nullif(p_texto,''), rascunho),
           area = coalesce(nullif(p_area,''), area, nucleo.area_do_agente(agente)), revisado_por = p_revisor, revisado_em = now()
     WHERE id = p_fila AND status = 'pendente'
     RETURNING * INTO f;
    IF NOT FOUND THEN RETURN NULL; END IF;
    num := coalesce(f.numero, (SELECT whatsapp FROM nucleo.clientes WHERE id = f.cliente_id));
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
    VALUES ('whatsapp', coalesce(num, ''), f.agente, 'ia', f.resposta_final, f.cliente_id, nucleo.instancia_do_agente(f.agente));
    IF f.agente = 'gabriel' THEN
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, agente)
        VALUES (p_revisor, 'pessoal', 'Resposta aprovada do Gabriel',
                'Mensagem recebida: ' || f.pergunta || E'\n' || 'O Gabriel respondeu: ' || f.resposta_final, 'resposta_aprovada', true, 'gabriel');
    ELSE
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, agente)
        VALUES (NULL, f.area, left(f.pergunta, 90),
                'Pergunta de cliente: ' || f.pergunta || E'\n' || 'Resposta aprovada: ' || f.resposta_final, 'resposta_aprovada', true,
                CASE WHEN f.agente IN ('joao', 'suporte') THEN f.agente ELSE nucleo.agente_da_area(f.area) END);
    END IF;
    RETURN jsonb_build_object('numero', num, 'texto', f.resposta_final, 'cliente_id', f.cliente_id,
                              'agente', f.agente, 'instancia', nucleo.instancia_do_agente(f.agente));
END $$;

-- ---------------------------------------------------------------- passar conhecimento de uma IA para outra (so quando voce pede)
CREATE OR REPLACE FUNCTION nucleo.conhecimento_copiar(p_id bigint, p_para text, p_admin int) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE k nucleo.conhecimento%ROWTYPE; novo bigint;
BEGIN
    IF p_para NOT IN ('leo', 'gabriel', 'joao', 'suporte') THEN RETURN NULL; END IF;
    SELECT * INTO k FROM nucleo.conhecimento WHERE id = p_id;
    IF NOT FOUND OR k.agente = p_para THEN RETURN NULL; END IF;
    INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata, agente)
    VALUES (CASE WHEN p_para IN ('leo', 'gabriel') THEN p_admin END,
            CASE WHEN p_para IN ('leo', 'gabriel') THEN 'pessoal' WHEN p_para = 'suporte' THEN 'suporte' ELSE 'comercial' END,
            k.titulo, k.conteudo, 'copiado', true, coalesce(k.metadata, '{}') || jsonb_build_object('copiado_de', k.agente), p_para)
    RETURNING id INTO novo;
    RETURN novo;
END $$;

-- ---------------------------------------------------------------- painel: cada IA mostra so o que e dela
CREATE OR REPLACE FUNCTION nucleo.agente_feed(p_agente text, p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'conversas', coalesce((SELECT jsonb_agg(x ORDER BY x.ultima DESC) FROM (
            SELECT split_part(v.contato, ' ', 1) AS numero,
                   max(coalesce(c.nome, nullif(substring(v.contato from '\((.*)\)'), ''))) AS nome,
                   count(*) AS mensagens, max(v.criado_em) AS ultima,
                   (array_agg(v.papel ORDER BY v.criado_em DESC))[1] AS ultimo_papel,
                   (array_agg(left(v.mensagem, 160) ORDER BY v.criado_em DESC))[1] AS ultima_mensagem,
                   jsonb_agg(jsonb_build_object('papel', v.papel, 'texto', left(v.mensagem, 500), 'em', v.criado_em) ORDER BY v.criado_em) AS historico
              FROM (SELECT * FROM nucleo.conversas
                     WHERE criado_em > now() - interval '14 days' AND CASE p_agente
                        WHEN 'leo' THEN agente IN ('leo-observa', 'ia-pessoal') OR (papel = 'ia' AND usuario_id IS NOT NULL AND cliente_id IS NULL AND agente NOT IN ('gabriel', 'gabriel-observa'))
                        WHEN 'gabriel' THEN agente IN ('gabriel-observa', 'gabriel')
                        ELSE cliente_id IS NOT NULL AND coalesce(instancia, 'joao') = nucleo.instancia_do_agente(p_agente) END
                     ORDER BY criado_em DESC LIMIT 600) v
              LEFT JOIN nucleo.clientes c ON c.id = v.cliente_id
             GROUP BY 1 ORDER BY max(v.criado_em) DESC LIMIT 40) x), '[]'),
        'aprendizado', coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'titulo', k.titulo, 'conteudo', k.conteudo, 'area', k.dominio,
                    'aprovado', k.aprovado, 'origem', k.origem, 'em', k.criado_em) ORDER BY k.criado_em DESC)
            FROM (SELECT * FROM nucleo.conhecimento
                   WHERE agente = p_agente AND (p_agente NOT IN ('leo') OR usuario_id = p_usuario)
                   ORDER BY criado_em DESC LIMIT 200) k), '[]'),
        'eventos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nivel', nivel, 'titulo', titulo, 'detalhe', detalhe,
                    'contexto', contexto, 'visto', visto, 'em', criado_em) ORDER BY criado_em DESC)
            FROM (SELECT * FROM nucleo.eventos WHERE agente = p_agente ORDER BY criado_em DESC LIMIT 50) e), '[]'))
$$;

CREATE OR REPLACE FUNCTION nucleo.painel_saude(p_usuario int) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE r jsonb := '[]'; a text; lidas int; resp int; pend int; sug int; aprend int; ult timestamptz; ev jsonb; erros int;
BEGIN
    FOREACH a IN ARRAY ARRAY['leo', 'joao', 'suporte', 'gabriel'] LOOP
        IF a = 'leo' THEN
            SELECT count(*) FILTER (WHERE agente = 'leo-observa'), count(*) FILTER (WHERE agente = 'ia-pessoal' AND papel = 'ia' OR (papel = 'ia' AND usuario_id IS NOT NULL AND agente NOT IN ('gabriel'))),
                   max(criado_em) INTO lidas, resp, ult
              FROM nucleo.conversas WHERE criado_em > now() - interval '24 hours' AND (agente IN ('leo-observa', 'ia-pessoal') OR (papel = 'ia' AND usuario_id IS NOT NULL AND agente <> 'gabriel'));
            pend := 0;
        ELSIF a = 'gabriel' THEN
            SELECT count(*) FILTER (WHERE papel <> 'ia'), count(*) FILTER (WHERE papel = 'ia'), max(criado_em) INTO lidas, resp, ult
              FROM nucleo.conversas WHERE criado_em > now() - interval '24 hours' AND agente IN ('gabriel-observa', 'gabriel');
            SELECT count(*) INTO pend FROM nucleo.atendimento_fila WHERE status = 'pendente' AND agente = 'gabriel';
        ELSE
            SELECT count(*) FILTER (WHERE papel <> 'ia'), count(*) FILTER (WHERE papel = 'ia'), max(criado_em) INTO lidas, resp, ult
              FROM nucleo.conversas WHERE criado_em > now() - interval '24 hours' AND cliente_id IS NOT NULL
               AND coalesce(instancia, 'joao') = nucleo.instancia_do_agente(a);
            SELECT count(*) INTO pend FROM nucleo.atendimento_fila WHERE status = 'pendente' AND agente = a;
        END IF;
        SELECT count(*) FILTER (WHERE NOT aprovado), count(*) FILTER (WHERE aprovado) INTO sug, aprend
          FROM nucleo.conhecimento WHERE agente = a AND (a <> 'leo' OR usuario_id = p_usuario);
        SELECT count(*) INTO erros FROM nucleo.eventos WHERE agente = a AND nivel = 'erro' AND criado_em > now() - interval '24 hours';
        SELECT jsonb_build_object('id', id, 'titulo', titulo, 'detalhe', detalhe, 'em', criado_em, 'visto', visto) INTO ev
          FROM nucleo.eventos WHERE agente = a AND nivel = 'erro' ORDER BY criado_em DESC LIMIT 1;
        r := r || jsonb_build_array(jsonb_build_object(
            'agente', a,
            'modo', CASE a WHEN 'leo' THEN 'ativo' ELSE nucleo.cfg(a || '_modo', 'observando') END,
            'instancia', nucleo.instancia_do_agente(a),
            'lidas_24h', coalesce(lidas, 0), 'respostas_24h', coalesce(resp, 0),
            'pendentes', coalesce(pend, 0), 'sugestoes', coalesce(sug, 0), 'aprendidos', coalesce(aprend, 0),
            'ultima_atividade', ult, 'erros_24h', coalesce(erros, 0), 'ultimo_erro', ev));
    END LOOP;
    RETURN jsonb_build_object('agentes', r,
        'outros_erros', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'agente', agente, 'titulo', titulo, 'detalhe', detalhe, 'em', criado_em))
            FROM (SELECT * FROM nucleo.eventos WHERE agente NOT IN ('leo','joao','suporte','gabriel') AND nivel = 'erro' AND NOT visto
                   ORDER BY criado_em DESC LIMIT 10) e), '[]'),
        'sistemas_fora', (SELECT count(*) FROM nucleo.sistemas WHERE ativo AND estado = 'falha'),
        'chamados_abertos', (SELECT count(*) FROM nucleo.chamados WHERE status = 'aberto'));
END $$;

CREATE OR REPLACE FUNCTION nucleo.gabriel_painel(p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo', nucleo.cfg('gabriel_modo', 'observando'),
        'contatos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'nome', nome) ORDER BY nome, numero)
                                FROM nucleo.observacao_lista WHERE agente = 'gabriel' AND regra = 'incluir'), '[]'),
        'fila', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
            SELECT id, pergunta, rascunho, criado_em, nome, numero AS whatsapp FROM nucleo.atendimento_fila
             WHERE status = 'pendente' AND agente = 'gabriel' ORDER BY criado_em LIMIT 30) x), '[]'),
        'estilo', nucleo.estilo_gabriel(),
        'conversas_lidas', (SELECT count(*) FROM nucleo.conversas WHERE agente = 'gabriel-observa'),
        'aprendidos', (SELECT count(*) FROM nucleo.conhecimento WHERE agente = 'gabriel' AND aprovado))
$$;

CREATE OR REPLACE FUNCTION nucleo.observacao_painel(p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_object_agg(a, jsonb_build_object(
               'modo', nucleo.cfg(a || '_observar', CASE a WHEN 'leo' THEN 'somente' ELSE 'todos' END),
               'lista', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'nome', nome, 'regra', regra) ORDER BY nome, numero)
                                    FROM nucleo.observacao_lista WHERE agente = a), '[]')))
           || jsonb_build_object(
               'leo_sugestoes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'titulo', titulo, 'conteudo', conteudo,
                       'contato', metadata->>'contato', 'criado_em', criado_em) ORDER BY criado_em DESC)
                   FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND agente = 'leo' AND NOT aprovado AND origem = 'observacao_leo'), '[]'),
               'leo_conversas_lidas', (SELECT count(*) FROM nucleo.conversas WHERE agente = 'leo-observa'))
      FROM unnest(ARRAY['leo', 'joao', 'suporte', 'gabriel']) a
$$;

-- ---------------------------------------------------------------- audio: a IA vai ler esta conversa? (so entao transcreve)
CREATE OR REPLACE FUNCTION nucleo.whatsapp_vai_ler(p_instancia text, p_numero text, p_de_mim boolean, p_propria boolean)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE papel text := nucleo.papel_instancia(p_instancia);
BEGIN
    IF papel IN ('joao', 'suporte') THEN RETURN nucleo.pode_observar(papel, p_numero); END IF;
    IF papel = 'gabriel' THEN RETURN NOT coalesce(p_propria, false) AND nucleo.pode_observar('gabriel', p_numero); END IF;
    RETURN coalesce(p_propria, false)
        OR EXISTS (SELECT 1 FROM nucleo.usuario_por_whatsapp(p_numero) x WHERE x.id IS NOT NULL)
        OR nucleo.pode_observar('leo', p_numero);
END $$;
