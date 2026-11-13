-- =====================================================================
-- IA Central - CONVERSA "VOCE" EM CADA NUMERO: voce manda mensagem para o proprio numero de uma IA
-- (conversa "Voce" do WhatsApp dela) e a IA daquele numero responde para voce e aprende com o que voce ensina.
--   Leo -> Leo | Joao -> Joao | Suporte24hrs -> Suporte24hrs | Gabriel -> Gabriel
-- Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION nucleo.admin_principal() RETURNS int
LANGUAGE sql STABLE AS $$ SELECT id FROM nucleo.usuarios WHERE papel = 'admin' AND ativo ORDER BY id LIMIT 1 $$;

-- voce escreveu na conversa "Voce" do numero de uma IA (Joao, Suporte ou Gabriel)
CREATE OR REPLACE FUNCTION nucleo.dono_entrada(p_agente text, p_numero text, p_texto text, p_tipo text, p_instancia text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE dono record;
BEGIN
    SELECT id, nome INTO dono FROM nucleo.usuarios WHERE id = nucleo.admin_principal();
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || ' (Você)', p_agente || '-dono', 'humano',
            coalesce(nullif(p_texto, ''), '[' || p_tipo || ']'), dono.id, p_instancia);
    RETURN jsonb_build_object('saida', 2, 'agente', p_agente, 'dono', true, 'cliente_id', NULL, 'dono_id', dono.id,
        'nome', coalesce(split_part(dono.nome, ' ', 1), 'chefe'), 'numero', nucleo.so_digitos(p_numero),
        'texto', p_texto, 'sessionId', 'dono:' || p_agente, 'instancia', p_instancia);
END $$;

-- a resposta da IA para voce: sempre vai (nao depende do modo nem de aprovacao)
CREATE OR REPLACE FUNCTION nucleo.agente_responder_dono(p_agente text, p_numero text, p_texto text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || ' (Você)', p_agente || '-dono', 'ia', p_texto,
            nucleo.admin_principal(), nucleo.instancia_do_agente(p_agente));
    RETURN jsonb_build_object('enviar', true, 'dono', true, 'numero', nucleo.so_digitos(p_numero), 'texto', p_texto,
                              'agente', p_agente, 'instancia', nucleo.instancia_do_agente(p_agente));
END $$;

-- ---------------------------------------------------------------- entrada v6
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

    -- conversa "Voce" no numero do Joao / Suporte / Gabriel: a IA daquele numero fala com voce
    IF papel IN ('joao', 'suporte', 'gabriel') AND p_conversa_propria THEN
        RETURN nucleo.dono_entrada(papel, p_numero, texto, p_tipo, p_instancia);
    END IF;

    IF papel IN ('joao', 'suporte') THEN
        IF NOT nucleo.pode_observar(papel, p_numero) THEN
            RETURN jsonb_build_object('saida', 0, 'motivo', papel || ' nao le este contato');
        END IF;
        RETURN nucleo.agente_entrada(p_numero, p_nome, texto, p_tipo, p_de_mim, 'dedicado', papel)
               || jsonb_build_object('instancia', p_instancia);
    END IF;

    IF papel = 'gabriel' THEN
        RETURN nucleo.gabriel_entrada(p_numero, p_nome, texto, p_tipo, p_de_mim, p_dono) || jsonb_build_object('instancia', p_instancia);
    END IF;

    -- numero do Leo: conversa "Voce" (e /ia) fala com o Leo; o resto ele le para aprender
    IF p_de_mim AND NOT p_conversa_propria THEN
        RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, true, p_dono) || jsonb_build_object('instancia', p_instancia);
    END IF;
    SELECT * INTO u FROM nucleo.usuario_por_whatsapp(p_numero);
    -- conversa "Voce" do numero do Leo e sempre o admin, mesmo que esse numero nao seja o do perfil dele
    IF u.id IS NULL AND p_conversa_propria THEN
        SELECT * INTO u FROM nucleo.usuarios WHERE id = nucleo.admin_principal();
    END IF;
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

-- ---------------------------------------------------------------- aprender com o que voce ensina na conversa com cada IA
-- chave "dono:<ia>" (Joao/Suporte/Gabriel) e "dono:leo:<usuario>" (Leo, conversas com cada pessoa)
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
    UNION ALL
    -- voce conversando direto com Joao / Suporte / Gabriel (conversa "Voce" do numero deles)
    SELECT d.ia, 'dono:' || d.ia, d.usuario_id,
           (SELECT string_agg(CASE v.papel WHEN 'humano' THEN 'DONO' ELSE 'IA' END || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas c2 WHERE c2.agente = d.ia || '-dono' ORDER BY c2.criado_em DESC LIMIT 60) v)
      FROM (SELECT replace(c.agente, '-dono', '') AS ia, max(c.usuario_id) AS usuario_id
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'dono' AND pr.chave = 'dono:' || replace(c.agente, '-dono', '')
             WHERE c.agente IN ('joao-dono', 'suporte-dono', 'gabriel-dono') AND c.papel = 'humano'
               AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1) d
    UNION ALL
    -- voce conversando com o Leo (WhatsApp ou painel)
    SELECT 'leo', 'dono:leo:' || l.usuario_id, l.usuario_id,
           (SELECT string_agg(CASE v.papel WHEN 'usuario' THEN 'DONO' ELSE 'IA' END || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas c2 WHERE c2.usuario_id = l.usuario_id AND c2.cliente_id IS NULL
                       AND (c2.agente = 'ia-pessoal' OR (c2.papel = 'ia' AND coalesce(c2.agente, '') NOT LIKE '%-dono' AND coalesce(c2.agente, '') NOT IN ('gabriel', 'leo-observa', 'gabriel-observa')))
                     ORDER BY c2.criado_em DESC LIMIT 60) v)
      FROM (SELECT c.usuario_id
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'dono' AND pr.chave = 'dono:leo:' || c.usuario_id
             WHERE c.agente = 'ia-pessoal' AND c.papel = 'usuario' AND c.usuario_id IS NOT NULL
               AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1) l
$$;

-- o que voce ensinou conversando com a IA: vale na hora, so para aquela IA
CREATE OR REPLACE FUNCTION nucleo.aprendiz_dono_salvar(p_ia text, p_chave text, p_dono int, p_itens jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; it jsonb; prefixo text;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        IF p_ia IN ('leo', 'gabriel') THEN
            prefixo := CASE it->>'tipo' WHEN 'jeito_de_falar' THEN 'Jeito de falar: ' WHEN 'como_resolve' THEN 'Como resolve: ' ELSE '' END;
            INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata, agente)
            VALUES (p_dono, 'pessoal', left(prefixo || coalesce(it->>'titulo', ''), 120), it->>'conteudo', 'ensinado_pelo_dono', true,
                    jsonb_build_object('tipo', it->>'tipo'), p_ia);
        ELSE
            INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata, agente)
            VALUES (NULL, CASE WHEN it->>'area' IN ('suporte', 'comercial', 'geral') THEN it->>'area' ELSE nucleo.area_do_agente(p_ia) END,
                    left(it->>'titulo', 120), it->>'conteudo', 'ensinado_pelo_dono', true, jsonb_build_object('agente', p_ia), p_ia);
        END IF;
        n := n + 1;
    END LOOP;
    INSERT INTO nucleo.aprendiz_progresso VALUES ('dono', p_chave, now())
    ON CONFLICT (agente, chave) DO UPDATE SET ate = now();
    RETURN n;
END $$;

-- "O que leu" de cada IA tambem mostra a sua conversa com ela
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
                        WHEN 'leo' THEN agente IN ('leo-observa', 'ia-pessoal') OR (papel = 'ia' AND usuario_id IS NOT NULL AND cliente_id IS NULL
                                        AND agente NOT IN ('gabriel', 'gabriel-observa') AND agente NOT LIKE '%-dono')
                        WHEN 'gabriel' THEN agente IN ('gabriel-observa', 'gabriel', 'gabriel-dono')
                        ELSE (cliente_id IS NOT NULL AND coalesce(instancia, 'joao') = nucleo.instancia_do_agente(p_agente))
                             OR agente = p_agente || '-dono' END
                     ORDER BY criado_em DESC LIMIT 600) v
              LEFT JOIN nucleo.clientes c ON c.id = v.cliente_id
             GROUP BY 1 ORDER BY max(v.criado_em) DESC LIMIT 40) x), '[]'),
        'aprendizado', coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'titulo', k.titulo, 'conteudo', k.conteudo, 'area', k.dominio,
                    'aprovado', k.aprovado, 'origem', k.origem, 'em', k.criado_em,
                    'de', coalesce((SELECT cl.nome FROM nucleo.clientes cl WHERE cl.id = (k.metadata->>'cliente_id')::int), k.metadata->>'contato'),
                    'copiado_de', k.metadata->>'copiado_de') ORDER BY k.criado_em DESC)
            FROM (SELECT * FROM nucleo.conhecimento
                   WHERE agente = p_agente AND (p_agente NOT IN ('leo') OR usuario_id = p_usuario)
                   ORDER BY criado_em DESC LIMIT 200) k), '[]'),
        'eventos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nivel', nivel, 'titulo', titulo, 'detalhe', detalhe,
                    'contexto', contexto, 'visto', visto, 'em', criado_em) ORDER BY criado_em DESC)
            FROM (SELECT * FROM nucleo.eventos WHERE agente = p_agente ORDER BY criado_em DESC LIMIT 50) e), '[]'))
$$;
