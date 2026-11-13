-- =====================================================================
-- IA Central - DOIS NUMEROS: Leo 2.0 (numero pessoal do dono, instancia "nucleo") e
-- Joao (chip do vendedor, instancia "joao"). Cada um le conversas conforme o filtro:
--   <agente>_observar: todos | exceto (todos menos a lista) | somente (so a lista)
-- e aprende: Joao -> base da empresa (sugestoes); Leo -> memoria do dono (sugestoes).
-- Idempotente.
-- =====================================================================

INSERT INTO nucleo.config VALUES ('whatsapp_instancias', '{"nucleo": "leo", "joao": "joao"}') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('leo_observar', '"somente"') ON CONFLICT DO NOTHING;
-- Joao herda o filtro antigo (clientes cadastrados = somente; todos = todos)
INSERT INTO nucleo.config
SELECT 'joao_observar', to_jsonb(CASE WHEN coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_observar'), 'todos') = 'clientes'
                                      THEN 'somente' ELSE 'todos' END)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS nucleo.observacao_lista (
    id        serial PRIMARY KEY,
    agente    text NOT NULL CHECK (agente IN ('leo','joao')),
    numero    text NOT NULL,
    nome      text,
    regra     text NOT NULL CHECK (regra IN ('incluir','excluir')),
    criado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agente, numero)
);

CREATE TABLE IF NOT EXISTS nucleo.aprendiz_progresso (
    agente text NOT NULL,
    chave  text NOT NULL,
    ate    timestamptz NOT NULL,
    PRIMARY KEY (agente, chave)
);

CREATE OR REPLACE FUNCTION nucleo.papel_instancia(p_instancia text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT valor->>coalesce(p_instancia, 'nucleo') FROM nucleo.config WHERE chave = 'whatsapp_instancias'), 'leo')
$$;

-- O agente pode ler a conversa com este numero?
CREATE OR REPLACE FUNCTION nucleo.pode_observar(p_agente text, p_numero text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    modo text := coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = p_agente || '_observar'), 'somente');
    regra text;
BEGIN
    SELECT l.regra INTO regra FROM nucleo.observacao_lista l
     WHERE l.agente = p_agente AND nucleo.variantes_numero(l.numero) && nucleo.variantes_numero(p_numero) LIMIT 1;
    IF modo = 'todos' THEN RETURN true; END IF;
    IF modo = 'exceto' THEN RETURN coalesce(regra, '') <> 'excluir'; END IF;
    -- somente: o que esta na lista como incluir (para o Joao, cliente cadastrado tambem conta)
    RETURN coalesce(regra, '') = 'incluir'
        OR (p_agente = 'joao' AND EXISTS (SELECT 1 FROM nucleo.clientes c WHERE c.whatsapp NOT LIKE 'teste%'
                                           AND nucleo.variantes_numero(c.whatsapp) && nucleo.variantes_numero(p_numero)));
END $$;

-- Leo guardando uma conversa do numero pessoal (de_mim = o dono escrevendo)
CREATE OR REPLACE FUNCTION nucleo.leo_observar(p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_dono text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE dono_id int;
BEGIN
    IF NOT nucleo.pode_observar('leo', p_numero) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'Leo nao le este contato');
    END IF;
    SELECT id INTO dono_id FROM nucleo.usuario_por_whatsapp(p_dono);
    IF dono_id IS NULL THEN
        SELECT id INTO dono_id FROM nucleo.usuarios WHERE papel = 'admin' AND ativo ORDER BY id LIMIT 1;
    END IF;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || CASE WHEN p_de_mim OR coalesce(p_nome, '') = '' THEN '' ELSE ' (' || p_nome || ')' END,
            'leo-observa', CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END,
            coalesce(nullif(p_texto, ''), '[' || p_tipo || ']'), dono_id);
    RETURN jsonb_build_object('saida', 0, 'motivo', CASE WHEN p_de_mim THEN 'Leo leu sua mensagem (aprendizado)' ELSE 'Leo leu a mensagem do contato' END);
END $$;

-- ---------------------------------------------------------------------
-- ENTRADA v3: decide pela instancia (numero) que recebeu
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS nucleo.whatsapp_entrada(text, text, text, text, boolean, boolean, text);
CREATE OR REPLACE FUNCTION nucleo.whatsapp_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text,
    p_de_mim boolean DEFAULT false, p_conversa_propria boolean DEFAULT false, p_msg_id text DEFAULT NULL,
    p_instancia text DEFAULT 'nucleo', p_dono text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    u      nucleo.usuarios%ROWTYPE;
    papel  text := nucleo.papel_instancia(p_instancia);
    gat    text := lower(nucleo.whatsapp_config()->>'gatilho');
    texto  text := coalesce(p_texto, '');
    r      jsonb;
BEGIN
    -- 1) nunca responder/aprender com a propria IA
    IF p_msg_id IS NOT NULL AND EXISTS (SELECT 1 FROM nucleo.whatsapp_enviadas WHERE id = p_msg_id) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;
    IF p_de_mim AND texto LIKE '🤖%' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    -- 2) CHIP DO JOAO: tudo e cliente (le conforme o filtro; responde conforme o atendimento)
    IF papel = 'joao' THEN
        IF NOT nucleo.pode_observar('joao', p_numero) THEN
            RETURN jsonb_build_object('saida', 0, 'motivo', 'Joao nao le este contato');
        END IF;
        r := nucleo.atendimento_entrada(p_numero, p_nome, texto, p_tipo, p_de_mim, 'dedicado');
        RETURN r || jsonb_build_object('instancia', p_instancia);
    END IF;

    -- 3) NUMERO DO LEO (pessoal do dono)
    IF p_de_mim AND NOT p_conversa_propria THEN          -- o dono escrevendo para alguem
        RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, true, p_dono);
    END IF;
    SELECT * INTO u FROM nucleo.usuario_por_whatsapp(p_numero);
    IF u.id IS NULL THEN                                  -- contato qualquer escrevendo para o dono
        RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, false, p_dono);
    END IF;
    IF NOT p_conversa_propria THEN                         -- outro usuario do sistema
        IF p_tipo = 'audio' OR lower(ltrim(texto)) NOT LIKE gat || '%' THEN
            RETURN nucleo.leo_observar(p_numero, p_nome, texto, p_tipo, false, p_dono);
        END IF;
        texto := ltrim(substr(ltrim(texto), length(gat) + 1), ' ,:');
    END IF;

    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero), 'ia-pessoal', 'usuario',
            coalesce(nullif(texto,''), '[' || p_tipo || ']'), u.id);
    RETURN jsonb_build_object('saida', 1, 'instancia', p_instancia,
        'usuario_id', u.id, 'nome', u.nome, 'papel', u.papel, 'texto', texto,
        'sessionId', 'u' || u.id || ':whatsapp',
        'canal', CASE WHEN p_tipo = 'audio' THEN 'whatsapp (audio: a resposta tambem vai em audio)' ELSE 'whatsapp' END);
END $$;

-- ---------------------------------------------------------------------
-- APRENDIZ v2: Joao (base da empresa) + Leo (memoria do dono)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_todos(p_limite int DEFAULT 10)
RETURNS TABLE (tipo text, chave text, dono_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT 'joao', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes(p_limite) p
    UNION ALL
    SELECT 'leo', x.contato, x.usuario_id,
           (SELECT string_agg(CASE v.papel WHEN 'humano' THEN 'DONO' ELSE 'CONTATO' END || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas c2
                     WHERE c2.agente = 'leo-observa' AND split_part(c2.contato, ' ', 1) = x.contato
                     ORDER BY c2.criado_em DESC LIMIT 40) v)
      FROM (SELECT split_part(c.contato, ' ', 1) AS contato, max(c.usuario_id) AS usuario_id
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'leo' AND pr.chave = split_part(c.contato, ' ', 1)
             WHERE c.agente = 'leo-observa' AND c.papel = 'humano' AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1 ORDER BY max(c.criado_em) DESC LIMIT p_limite) x
$$;

-- memoria atual do dono (para o aprendiz nao repetir)
CREATE OR REPLACE FUNCTION nucleo.memoria_resumo(p_usuario int) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || coalesce(titulo, '') || ': ' || left(conteudo, 160), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE usuario_id = p_usuario ORDER BY criado_em DESC LIMIT 80) k
$$;

CREATE OR REPLACE FUNCTION nucleo.aprendiz_leo_salvar(p_dono int, p_contato text, p_itens jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; it jsonb;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata)
        VALUES (p_dono, 'pessoal', left(it->>'titulo', 120), it->>'conteudo', 'observacao_leo', false,
                jsonb_build_object('contato', p_contato));
        n := n + 1;
    END LOOP;
    INSERT INTO nucleo.aprendiz_progresso VALUES ('leo', p_contato, now())
    ON CONFLICT (agente, chave) DO UPDATE SET ate = now();
    RETURN n;
END $$;

-- jeito de falar do dono (aprovado) para o Leo usar nas respostas
CREATE OR REPLACE FUNCTION nucleo.estilo_dono(p_usuario int) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg(conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE usuario_id = p_usuario AND aprovado AND (titulo ILIKE 'jeito de%' OR titulo ILIKE 'como resolve%')
             ORDER BY criado_em DESC LIMIT 6) k
$$;

CREATE OR REPLACE FUNCTION nucleo.estilo_joao() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg(conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE usuario_id IS NULL AND aprovado AND titulo ILIKE 'jeito de%' ORDER BY criado_em DESC LIMIT 4) k
$$;

-- painel: filtros dos dois + o que o Leo aprendeu
CREATE OR REPLACE FUNCTION nucleo.observacao_painel(p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'leo',  jsonb_build_object('modo', coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'leo_observar'), 'somente'),
                    'lista', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'nome', nome, 'regra', regra) ORDER BY nome, numero)
                                         FROM nucleo.observacao_lista WHERE agente = 'leo'), '[]')),
        'joao', jsonb_build_object('modo', coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'joao_observar'), 'todos'),
                    'lista', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'nome', nome, 'regra', regra) ORDER BY nome, numero)
                                         FROM nucleo.observacao_lista WHERE agente = 'joao'), '[]')),
        'leo_sugestoes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'titulo', titulo, 'conteudo', conteudo,
                    'contato', metadata->>'contato', 'criado_em', criado_em) ORDER BY criado_em DESC)
                FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND NOT aprovado AND origem = 'observacao_leo'), '[]'),
        'leo_conversas_lidas', (SELECT count(*) FROM nucleo.conversas WHERE agente = 'leo-observa'))
$$;
