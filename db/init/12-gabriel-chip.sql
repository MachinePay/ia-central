-- =====================================================================
-- IA Central - 4 NUMEROS: cada IA no seu proprio WhatsApp.
--   nucleo  -> Leo 2.0 (voce fala com ele; le as conversas desse numero para aprender)
--   gabriel -> Gabriel (seu clone: le tudo desse numero para aprender seu jeito; responde so os liberados)
--   joao    -> Joao (vendas)      suporte -> Suporte24hrs
-- Trocar o numero de uma IA = desconectar e conectar outro no painel (Configurar > WhatsApp).
-- Idempotente.
-- =====================================================================

UPDATE nucleo.config SET valor = valor || '{"gabriel": "gabriel"}'::jsonb
 WHERE chave = 'whatsapp_instancias' AND NOT (valor ? 'gabriel');
-- o Gabriel le TODAS as conversas do numero dele (da para tirar contatos: "todos menos")
INSERT INTO nucleo.config VALUES ('gabriel_observar', '"todos"') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION nucleo.instancia_do_agente(p_agente text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_agente WHEN 'joao' THEN 'joao' WHEN 'suporte' THEN 'suporte' WHEN 'gabriel' THEN 'gabriel' ELSE 'nucleo' END
$$;

-- ---------------------------------------------------------------- Gabriel no numero dele
CREATE OR REPLACE FUNCTION nucleo.gabriel_entrada(p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_dono text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE dono_id int; msg text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
BEGIN
    IF NOT nucleo.pode_observar('gabriel', p_numero) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'Gabriel nao le este contato');
    END IF;
    -- a propria resposta do Gabriel voltando nao e o dono escrevendo
    IF p_de_mim AND EXISTS (SELECT 1 FROM nucleo.conversas
         WHERE agente = 'gabriel' AND papel = 'ia' AND split_part(contato, ' ', 1) = nucleo.so_digitos(p_numero)
           AND criado_em > now() - interval '10 minutes'
           AND regexp_replace(mensagem, '[*_~\s]', '', 'g') = regexp_replace(msg, '[*_~\s]', '', 'g')) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA (Gabriel)');
    END IF;
    SELECT id INTO dono_id FROM nucleo.usuarios WHERE papel = 'admin' AND ativo ORDER BY id LIMIT 1;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || CASE WHEN p_de_mim OR coalesce(p_nome, '') = '' THEN '' ELSE ' (' || p_nome || ')' END,
            'gabriel-observa', CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, dono_id, 'gabriel');
    IF NOT p_de_mim AND nucleo.gabriel_pode_responder(p_numero) THEN
        RETURN jsonb_build_object('saida', 2, 'agente', 'gabriel', 'cliente_id', NULL, 'dono_id', dono_id,
            'nome', coalesce(nullif(p_nome, ''), (SELECT nome FROM nucleo.observacao_lista WHERE agente = 'gabriel'
                     AND nucleo.variantes_numero(numero) && nucleo.variantes_numero(p_numero) LIMIT 1), 'contato'),
            'numero', nucleo.so_digitos(p_numero), 'texto', p_texto, 'sessionId', 'g:' || nucleo.so_digitos(p_numero));
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', CASE WHEN p_de_mim THEN 'Gabriel aprendeu com a sua mensagem' ELSE 'Gabriel leu a mensagem do contato' END);
END $$;

-- ---------------------------------------------------------------- Leo: so le (o Gabriel saiu deste numero)
CREATE OR REPLACE FUNCTION nucleo.leo_observar(p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_dono text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE dono_id int; msg text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
BEGIN
    IF NOT nucleo.pode_observar('leo', p_numero) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'Leo nao le este contato');
    END IF;
    SELECT id INTO dono_id FROM nucleo.usuario_por_whatsapp(p_dono);
    IF dono_id IS NULL THEN SELECT id INTO dono_id FROM nucleo.usuarios WHERE papel = 'admin' AND ativo ORDER BY id LIMIT 1; END IF;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || CASE WHEN p_de_mim OR coalesce(p_nome, '') = '' THEN '' ELSE ' (' || p_nome || ')' END,
            'leo-observa', CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, dono_id, 'nucleo');
    RETURN jsonb_build_object('saida', 0, 'motivo', CASE WHEN p_de_mim THEN 'Leo leu sua mensagem (aprendizado)' ELSE 'Leo leu a mensagem do contato' END);
END $$;

-- ---------------------------------------------------------------- entrada v5: 4 numeros
CREATE OR REPLACE FUNCTION nucleo.whatsapp_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text,
    p_de_mim boolean DEFAULT false, p_conversa_propria boolean DEFAULT false, p_msg_id text DEFAULT NULL,
    p_instancia text DEFAULT 'nucleo', p_dono text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    u      record;
    papel  text := nucleo.papel_instancia(p_instancia);
    gat    text := lower(nucleo.whatsapp_config()->>'gatilho');
    texto  text := coalesce(p_texto, '');
BEGIN
    IF p_msg_id IS NOT NULL AND EXISTS (SELECT 1 FROM nucleo.whatsapp_enviadas WHERE id = p_msg_id) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;
    IF p_de_mim AND texto LIKE '🤖%' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    IF papel IN ('joao', 'suporte') THEN
        IF NOT nucleo.pode_observar(papel, p_numero) THEN
            RETURN jsonb_build_object('saida', 0, 'motivo', papel || ' nao le este contato');
        END IF;
        RETURN nucleo.agente_entrada(p_numero, p_nome, texto, p_tipo, p_de_mim, 'dedicado', papel)
               || jsonb_build_object('instancia', p_instancia);
    END IF;

    IF papel = 'gabriel' THEN
        IF p_conversa_propria THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa consigo mesmo no numero do Gabriel'); END IF;
        RETURN nucleo.gabriel_entrada(p_numero, p_nome, texto, p_tipo, p_de_mim, p_dono) || jsonb_build_object('instancia', p_instancia);
    END IF;

    -- numero do Leo: conversa "Voce" (e /ia) fala com o Leo; o resto ele le para aprender
    IF p_de_mim AND NOT p_conversa_propria THEN
        RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, true, p_dono) || jsonb_build_object('instancia', p_instancia);
    END IF;
    SELECT * INTO u FROM nucleo.usuario_por_whatsapp(p_numero);
    IF u.id IS NULL THEN
        RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, false, p_dono) || jsonb_build_object('instancia', p_instancia);
    END IF;
    IF NOT p_conversa_propria THEN
        IF p_tipo = 'audio' OR lower(ltrim(texto)) NOT LIKE gat || '%' THEN
            RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, false, p_dono) || jsonb_build_object('instancia', p_instancia);
        END IF;
        texto := ltrim(substr(ltrim(texto), length(gat) + 1), ' ,:');
    END IF;

    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero), 'ia-pessoal', 'usuario', coalesce(nullif(texto,''), '[' || p_tipo || ']'), u.id, p_instancia);
    RETURN jsonb_build_object('saida', 1, 'instancia', p_instancia,
        'usuario_id', u.id, 'nome', u.nome, 'papel', u.papel, 'texto', texto,
        'sessionId', 'u' || u.id || ':whatsapp',
        'canal', CASE WHEN p_tipo = 'audio' THEN 'whatsapp (audio: a resposta tambem vai em audio)' ELSE 'whatsapp' END);
END $$;

-- ---------------------------------------------------------------- aprendiz: conversas do numero do Gabriel tambem ensinam o seu jeito
-- chave "g:<numero>" = conversa do numero do Gabriel (progresso separado do Leo)
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_todos(p_limite int DEFAULT 25)
RETURNS TABLE (tipo text, chave text, dono_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT 'joao', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'joao') p
    UNION ALL
    SELECT 'suporte', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'suporte') p
    UNION ALL
    SELECT 'leo', CASE WHEN x.fonte = 'gabriel-observa' THEN 'g:' ELSE '' END || x.contato, x.usuario_id,
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

CREATE OR REPLACE FUNCTION nucleo.gabriel_painel(p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo', nucleo.cfg('gabriel_modo', 'observando'),
        'contatos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'nome', nome) ORDER BY nome, numero)
                                FROM nucleo.observacao_lista WHERE agente = 'gabriel' AND regra = 'incluir'), '[]'),
        'fila', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
            SELECT id, pergunta, rascunho, criado_em, nome, numero AS whatsapp FROM nucleo.atendimento_fila
             WHERE status = 'pendente' AND agente = 'gabriel' ORDER BY criado_em LIMIT 30) x), '[]'),
        'estilo', nucleo.estilo_dono(p_usuario),
        'conversas_lidas', (SELECT count(*) FROM nucleo.conversas WHERE agente IN ('gabriel-observa', 'leo-observa')),
        'aprendidos', (SELECT count(*) FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND aprovado))
$$;

-- filtro de leitura das 4 IAs
CREATE OR REPLACE FUNCTION nucleo.observacao_painel(p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_object_agg(a, jsonb_build_object(
               'modo', nucleo.cfg(a || '_observar', CASE a WHEN 'leo' THEN 'somente' ELSE 'todos' END),
               'lista', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'nome', nome, 'regra', regra) ORDER BY nome, numero)
                                    FROM nucleo.observacao_lista WHERE agente = a), '[]')))
           || jsonb_build_object(
               'leo_sugestoes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'titulo', titulo, 'conteudo', conteudo,
                       'contato', metadata->>'contato', 'criado_em', criado_em) ORDER BY criado_em DESC)
                   FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND NOT aprovado AND origem = 'observacao_leo'), '[]'),
               'leo_conversas_lidas', (SELECT count(*) FROM nucleo.conversas WHERE agente = 'leo-observa'))
      FROM unnest(ARRAY['leo', 'joao', 'suporte', 'gabriel']) a
$$;

-- resumo para o Leo supervisionar
CREATE OR REPLACE FUNCTION nucleo.atendimento_resumo(p_usuario int, p_dias int DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := '{}'; a text;
BEGIN
    PERFORM nucleo.exigir_admin(p_usuario);
    FOREACH a IN ARRAY ARRAY['joao', 'suporte', 'gabriel'] LOOP
        r := r || jsonb_build_object(a, jsonb_build_object(
            'modo', nucleo.cfg(a || '_modo', 'observando'),
            'mensagens_recebidas', (SELECT count(*) FROM nucleo.conversas WHERE papel = 'usuario' AND criado_em > now() - make_interval(days => p_dias)
                                     AND CASE a WHEN 'gabriel' THEN agente = 'gabriel-observa' ELSE coalesce(instancia, 'joao') = nucleo.instancia_do_agente(a) AND cliente_id IS NOT NULL END),
            'respostas_humanas', (SELECT count(*) FROM nucleo.conversas WHERE papel = 'humano' AND criado_em > now() - make_interval(days => p_dias)
                                     AND CASE a WHEN 'gabriel' THEN agente = 'gabriel-observa' ELSE coalesce(instancia, 'joao') = nucleo.instancia_do_agente(a) AND cliente_id IS NOT NULL END),
            'respostas_da_ia', (SELECT count(*) FROM nucleo.conversas WHERE papel = 'ia' AND criado_em > now() - make_interval(days => p_dias)
                                     AND (agente = a OR (a <> 'gabriel' AND coalesce(instancia,'joao') = nucleo.instancia_do_agente(a) AND cliente_id IS NOT NULL))),
            'aguardando_aprovacao', (SELECT count(*) FROM nucleo.atendimento_fila WHERE status = 'pendente' AND agente = a),
            'sugestoes_para_revisar', CASE a WHEN 'gabriel' THEN (SELECT count(*) FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND NOT aprovado AND origem = 'observacao_leo')
                                       ELSE (SELECT count(*) FROM nucleo.conhecimento WHERE usuario_id IS NULL AND NOT aprovado AND origem = 'observacao' AND coalesce(metadata->>'agente','joao') = a) END));
    END LOOP;
    RETURN r || jsonb_build_object('periodo_dias', p_dias,
        'chamados_abertos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'area', h.area, 'titulo', h.titulo, 'prioridade', h.prioridade,
                'cliente', c.nome, 'aberto_em', to_char(h.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')))
            FROM nucleo.chamados h LEFT JOIN nucleo.clientes c ON c.id = h.cliente_id WHERE h.status = 'aberto'), '[]'),
        'leads_recentes', coalesce((SELECT jsonb_agg(x) FROM (
            SELECT nome, empresa, interesse, etapa FROM nucleo.clientes WHERE etapa IN ('lead', 'cliente') AND whatsapp NOT LIKE 'teste%'
             ORDER BY ultimo_contato DESC LIMIT 10) x), '[]'));
END $$;
