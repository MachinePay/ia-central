-- =====================================================================
-- IA Central - AGENTES: Joao (vendas, chip "joao"), Suporte24hrs (suporte, chip "suporte")
-- e Gabriel (clone do dono, responde contatos liberados no numero pessoal "nucleo").
-- Tudo comeca SO OBSERVANDO (aprende, nao responde). Cada agente tem modo, alcance,
-- filtro de leitura, fila de aprovacao, base/estilo aprendidos.
-- Substitui as funcoes de atendimento das 06/07 (que eram so do Joao). Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------- config por agente
INSERT INTO nucleo.config SELECT 'joao_modo', coalesce((SELECT valor FROM nucleo.config WHERE chave = 'atendimento_modo'), '"observando"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config SELECT 'joao_alcance', coalesce((SELECT valor FROM nucleo.config WHERE chave = 'atendimento_alcance'), '"selecionados"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config SELECT 'joao_persona', to_jsonb(coalesce((SELECT valor->>'persona' FROM nucleo.config WHERE chave = 'atendimento_empresa'), 'João')) ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('suporte_modo', '"observando"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('suporte_alcance', '"selecionados"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('suporte_persona', '"Suporte24hrs"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('suporte_observar', '"todos"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('gabriel_modo', '"observando"') ON CONFLICT DO NOTHING;
-- todos comecam so observando (pedido do dono): aplica uma vez
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_todos_observando') THEN
        UPDATE nucleo.config SET valor = '"observando"' WHERE chave IN ('joao_modo', 'suporte_modo', 'gabriel_modo', 'atendimento_modo');
        INSERT INTO nucleo.config VALUES ('migracao_todos_observando', 'true');
    END IF;
END $$;
UPDATE nucleo.config SET valor = valor || '{"suporte": "suporte"}'::jsonb WHERE chave = 'whatsapp_instancias' AND NOT (valor ? 'suporte');

ALTER TABLE nucleo.observacao_lista DROP CONSTRAINT IF EXISTS observacao_lista_agente_check;
ALTER TABLE nucleo.observacao_lista ADD CONSTRAINT observacao_lista_agente_check CHECK (agente IN ('leo','joao','suporte','gabriel'));

ALTER TABLE nucleo.clientes         ADD COLUMN IF NOT EXISTS suporte_responde      boolean NOT NULL DEFAULT false;
ALTER TABLE nucleo.clientes         ADD COLUMN IF NOT EXISTS suporte_aprendido_ate timestamptz;
ALTER TABLE nucleo.conversas        ADD COLUMN IF NOT EXISTS instancia text;
ALTER TABLE nucleo.atendimento_fila ADD COLUMN IF NOT EXISTS agente text NOT NULL DEFAULT 'joao';
ALTER TABLE nucleo.atendimento_fila ADD COLUMN IF NOT EXISTS numero text;
ALTER TABLE nucleo.atendimento_fila ADD COLUMN IF NOT EXISTS nome   text;

CREATE OR REPLACE FUNCTION nucleo.cfg(p_chave text, p_padrao text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = p_chave), p_padrao) $$;

CREATE OR REPLACE FUNCTION nucleo.instancia_do_agente(p_agente text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_agente WHEN 'joao' THEN 'joao' WHEN 'suporte' THEN 'suporte' ELSE 'nucleo' END $$;

CREATE OR REPLACE FUNCTION nucleo.area_do_agente(p_agente text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_agente WHEN 'suporte' THEN 'suporte' ELSE 'comercial' END $$;

CREATE OR REPLACE FUNCTION nucleo.agente_config(p_agente text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'agente',   p_agente,
        'modo',     nucleo.cfg(p_agente || '_modo', 'observando'),
        'alcance',  nucleo.cfg(p_agente || '_alcance', 'selecionados'),
        'observar', nucleo.cfg(p_agente || '_observar', 'todos'),
        'persona',  nucleo.cfg(p_agente || '_persona', CASE p_agente WHEN 'suporte' THEN 'Suporte24hrs' ELSE 'João' END),
        'empresa',  coalesce((SELECT valor FROM nucleo.config WHERE chave = 'atendimento_empresa'), '{}'::jsonb)
                    || jsonb_build_object('persona', nucleo.cfg(p_agente || '_persona', CASE p_agente WHEN 'suporte' THEN 'Suporte24hrs' ELSE 'João' END)))
$$;

-- ---------------------------------------------------------------- entrada de cliente (Joao / Suporte)
CREATE OR REPLACE FUNCTION nucleo.agente_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_modo_whats text, p_agente text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    cfg   jsonb := nucleo.agente_config(p_agente);
    amodo text := cfg->>'modo';
    inst  text := nucleo.instancia_do_agente(p_agente);
    c     record;
    msg   text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
    libera boolean;
BEGIN
    IF amodo = 'desligado' THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'agente desligado'); END IF;

    SELECT * INTO c FROM nucleo.clientes
     WHERE whatsapp NOT LIKE 'teste%' AND nucleo.variantes_numero(whatsapp) && nucleo.variantes_numero(p_numero) LIMIT 1;
    IF NOT FOUND THEN
        IF p_de_mim AND p_modo_whats <> 'dedicado' THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa pessoal'); END IF;
        c := nucleo.cliente_por_whatsapp(p_numero, CASE WHEN p_de_mim THEN NULL ELSE p_nome END);
    END IF;

    -- a propria IA voltando pelo webhook nao e humano
    IF p_de_mim AND EXISTS (SELECT 1 FROM nucleo.conversas
         WHERE cliente_id = c.id AND papel = 'ia' AND criado_em > now() - interval '10 minutes'
           AND regexp_replace(mensagem, '[*_~\s]', '', 'g') = regexp_replace(msg, '[*_~\s]', '', 'g')) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero), CASE WHEN p_de_mim THEN 'humano' ELSE 'cliente' END,
            CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, c.id, inst);
    UPDATE nucleo.clientes SET ultimo_contato = now(), nome = coalesce(nome, CASE WHEN p_de_mim THEN NULL ELSE nullif(p_nome, '') END)
     WHERE id = c.id;
    IF p_de_mim THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'resposta humana registrada (aprendizado)'); END IF;

    libera := CASE p_agente WHEN 'suporte' THEN c.suporte_responde ELSE c.ia_responde END;
    IF amodo IN ('aprovacao', 'automatico') AND (cfg->>'alcance' = 'todos' OR libera) THEN
        RETURN jsonb_build_object('saida', 2, 'agente', p_agente, 'cliente_id', c.id,
            'nome', coalesce(c.nome, nullif(p_nome, ''), 'cliente'), 'numero', nucleo.so_digitos(p_numero),
            'texto', p_texto, 'sessionId', 'c' || c.id || ':' || p_agente);
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', 'observando (agente nao responde este cliente)');
END $$;

-- ---------------------------------------------------------------- resposta de um agente: envia ou vai para a fila
CREATE OR REPLACE FUNCTION nucleo.agente_registrar(
    p_cliente int, p_pergunta text, p_rascunho text, p_agente text, p_numero text, p_nome text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    modo text := nucleo.cfg(p_agente || '_modo', 'observando');
    fid  int;
    num  text := coalesce(p_numero, (SELECT whatsapp FROM nucleo.clientes WHERE id = p_cliente));
    auto boolean := modo = 'automatico';
BEGIN
    INSERT INTO nucleo.atendimento_fila (cliente_id, pergunta, rascunho, resposta_final, status, agente, numero, nome)
    VALUES (p_cliente, p_pergunta, p_rascunho, CASE WHEN auto THEN p_rascunho END,
            CASE WHEN auto THEN 'automatica' ELSE 'pendente' END, p_agente, nucleo.so_digitos(num), p_nome)
    RETURNING id INTO fid;
    IF auto THEN
        INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
        VALUES ('whatsapp', nucleo.so_digitos(coalesce(num, '')), p_agente, 'ia', p_rascunho, p_cliente, nucleo.instancia_do_agente(p_agente));
    END IF;
    RETURN jsonb_build_object('fila_id', fid, 'enviar', auto, 'numero', num, 'texto', p_rascunho, 'modo', modo,
        'agente', p_agente, 'instancia', nucleo.instancia_do_agente(p_agente),
        'avisar', CASE WHEN auto THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(whatsapp) FROM nucleo.usuarios
                   WHERE papel = 'admin' AND ativo AND whatsapp IS NOT NULL), '[]') END);
END $$;

-- admin aprovou: envia (n8n) e aprende (Joao/Suporte: base da empresa | Gabriel: memoria do dono)
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
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem)
        VALUES (p_revisor, 'pessoal', 'Resposta aprovada do Gabriel',
                'Mensagem recebida: ' || f.pergunta || E'\n' || 'O Gabriel respondeu: ' || f.resposta_final, 'resposta_aprovada');
    ELSE
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem)
        VALUES (NULL, f.area, left(f.pergunta, 90),
                'Pergunta de cliente: ' || f.pergunta || E'\n' || 'Resposta aprovada: ' || f.resposta_final, 'resposta_aprovada');
    END IF;
    RETURN jsonb_build_object('numero', num, 'texto', f.resposta_final, 'cliente_id', f.cliente_id,
                              'agente', f.agente, 'instancia', nucleo.instancia_do_agente(f.agente));
END $$;

-- ---------------------------------------------------------------- painel de um agente (Joao ou Suporte)
CREATE OR REPLACE FUNCTION nucleo.agente_painel(p_agente text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'config', nucleo.agente_config(p_agente),
        'fila', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
            SELECT f.id, f.pergunta, f.rascunho, f.criado_em, coalesce(c.nome, f.nome) AS nome, coalesce(c.whatsapp, f.numero) AS whatsapp
              FROM nucleo.atendimento_fila f LEFT JOIN nucleo.clientes c ON c.id = f.cliente_id
             WHERE f.status = 'pendente' AND f.agente = p_agente ORDER BY f.criado_em LIMIT 30) x), '[]'),
        'chamados', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em DESC) FROM (
            SELECT h.id, h.area, h.titulo, h.descricao, h.prioridade, h.criado_em, c.nome, c.whatsapp
              FROM nucleo.chamados h LEFT JOIN nucleo.clientes c ON c.id = h.cliente_id
             WHERE h.status = 'aberto' AND (CASE p_agente WHEN 'suporte' THEN h.area IN ('suporte','sistemico','humano')
                                                          ELSE h.area IN ('comercial','humano') END)
             ORDER BY h.criado_em DESC LIMIT 30) x), '[]'),
        'clientes', coalesce((SELECT jsonb_agg(x ORDER BY x.ultimo_contato DESC) FROM (
            SELECT c.id, c.nome, c.whatsapp, c.empresa, c.interesse, c.etapa, c.ultimo_contato,
                   CASE p_agente WHEN 'suporte' THEN c.suporte_responde ELSE c.ia_responde END AS ia_responde,
                   (SELECT count(*) FROM nucleo.conversas v WHERE v.cliente_id = c.id AND coalesce(v.instancia, 'joao') = nucleo.instancia_do_agente(p_agente)) AS mensagens,
                   (SELECT count(*) FROM nucleo.conversas v WHERE v.cliente_id = c.id AND v.papel = 'humano'
                       AND coalesce(v.instancia, 'joao') = nucleo.instancia_do_agente(p_agente)) AS respostas_humanas
              FROM nucleo.clientes c WHERE c.whatsapp NOT LIKE 'teste%'
               AND EXISTS (SELECT 1 FROM nucleo.conversas v WHERE v.cliente_id = c.id AND coalesce(v.instancia, 'joao') = nucleo.instancia_do_agente(p_agente))
             ORDER BY c.ultimo_contato DESC LIMIT 50) x), '[]'),
        'base', coalesce((SELECT jsonb_agg(x ORDER BY x.dominio, x.criado_em DESC) FROM (
            SELECT id, dominio, titulo, conteudo, origem, criado_em FROM nucleo.conhecimento
             WHERE usuario_id IS NULL AND aprovado AND dominio IN (nucleo.area_do_agente(p_agente), 'geral')
             ORDER BY criado_em DESC LIMIT 200) x), '[]'),
        'sugestoes', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em DESC) FROM (
            SELECT k.id, k.dominio, k.titulo, k.conteudo, k.criado_em, cl.nome AS cliente
              FROM nucleo.conhecimento k LEFT JOIN nucleo.clientes cl ON cl.id = (k.metadata->>'cliente_id')::int
             WHERE k.usuario_id IS NULL AND NOT k.aprovado AND k.origem = 'observacao'
               AND coalesce(k.metadata->>'agente', 'joao') = p_agente
             ORDER BY k.criado_em DESC LIMIT 100) x), '[]'),
        'sistemas', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'publico', publico) ORDER BY nome)
              FROM nucleo.sistemas WHERE tipo = 'http'), '[]'))
$$;

-- ---------------------------------------------------------------- aprendiz por agente (aprende MUITO)
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_agente(p_limite int, p_agente text)
RETURNS TABLE (cliente_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT c.id,
           (SELECT string_agg(CASE v.papel WHEN 'usuario' THEN 'CLIENTE' WHEN 'humano' THEN 'ATENDENTE HUMANO' ELSE 'IA' END
                              || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas WHERE cliente_id = c.id
                       AND coalesce(instancia, 'joao') = nucleo.instancia_do_agente(p_agente)
                     ORDER BY criado_em DESC LIMIT 60) v)
      FROM nucleo.clientes c
     WHERE EXISTS (SELECT 1 FROM nucleo.conversas v
                    WHERE v.cliente_id = c.id AND v.papel = 'humano'
                      AND coalesce(v.instancia, 'joao') = nucleo.instancia_do_agente(p_agente)
                      AND v.criado_em > coalesce(CASE p_agente WHEN 'suporte' THEN c.suporte_aprendido_ate ELSE c.aprendido_ate END,
                                                 '-infinity'::timestamptz))
     ORDER BY c.ultimo_contato DESC
     LIMIT p_limite
$$;

CREATE OR REPLACE FUNCTION nucleo.aprendiz_salvar_agente(p_cliente int, p_itens jsonb, p_agente text)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; it jsonb;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata)
        VALUES (NULL,
                CASE WHEN it->>'area' IN ('suporte','comercial','geral') THEN it->>'area' ELSE nucleo.area_do_agente(p_agente) END,
                left(it->>'titulo', 120), it->>'conteudo', 'observacao', false,
                jsonb_build_object('cliente_id', p_cliente, 'agente', p_agente));
        n := n + 1;
    END LOOP;
    IF p_agente = 'suporte' THEN UPDATE nucleo.clientes SET suporte_aprendido_ate = now() WHERE id = p_cliente;
    ELSE UPDATE nucleo.clientes SET aprendido_ate = now() WHERE id = p_cliente; END IF;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_todos(p_limite int DEFAULT 25)
RETURNS TABLE (tipo text, chave text, dono_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT 'joao', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'joao') p
    UNION ALL
    SELECT 'suporte', p.cliente_id::text, NULL::int, p.transcricao FROM nucleo.aprendiz_pendentes_agente(p_limite, 'suporte') p
    UNION ALL
    SELECT 'leo', x.contato, x.usuario_id,
           (SELECT string_agg(CASE v.papel WHEN 'humano' THEN 'DONO' WHEN 'ia' THEN 'IA' ELSE 'CONTATO' END || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas c2
                     WHERE c2.agente IN ('leo-observa', 'gabriel') AND split_part(c2.contato, ' ', 1) = x.contato
                     ORDER BY c2.criado_em DESC LIMIT 60) v)
      FROM (SELECT split_part(c.contato, ' ', 1) AS contato, max(c.usuario_id) AS usuario_id
              FROM nucleo.conversas c
              LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'leo' AND pr.chave = split_part(c.contato, ' ', 1)
             WHERE c.agente = 'leo-observa' AND c.papel = 'humano' AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz)
             GROUP BY 1 ORDER BY max(c.criado_em) DESC LIMIT p_limite) x
$$;

-- jeito de escrever aprendido de cada agente (Joao: comercial; Suporte: suporte)
CREATE OR REPLACE FUNCTION nucleo.estilo_agente(p_agente text) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg(conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE usuario_id IS NULL AND aprovado AND titulo ILIKE 'jeito de%'
               AND (dominio = nucleo.area_do_agente(p_agente) OR (dominio = 'geral' AND coalesce(metadata->>'agente', 'joao') = p_agente))
             ORDER BY criado_em DESC LIMIT 4) k
$$;

-- ---------------------------------------------------------------- GABRIEL (numero pessoal, contatos liberados)
CREATE OR REPLACE FUNCTION nucleo.gabriel_pode_responder(p_numero text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT nucleo.cfg('gabriel_modo', 'observando') IN ('aprovacao', 'automatico')
       AND EXISTS (SELECT 1 FROM nucleo.observacao_lista l WHERE l.agente = 'gabriel' AND l.regra = 'incluir'
                    AND nucleo.variantes_numero(l.numero) && nucleo.variantes_numero(p_numero))
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
        'conversas_lidas', (SELECT count(*) FROM nucleo.conversas WHERE agente = 'leo-observa'),
        'aprendidos', (SELECT count(*) FROM nucleo.conhecimento WHERE usuario_id = p_usuario AND aprovado))
$$;

-- Leo/Gabriel no numero pessoal: a propria resposta do Gabriel voltando nao e o dono escrevendo
CREATE OR REPLACE FUNCTION nucleo.leo_observar(p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_dono text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE dono_id int; msg text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
BEGIN
    IF NOT (nucleo.pode_observar('leo', p_numero)
            OR EXISTS (SELECT 1 FROM nucleo.observacao_lista l WHERE l.agente = 'gabriel'
                        AND nucleo.variantes_numero(l.numero) && nucleo.variantes_numero(p_numero))) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'Leo nao le este contato');
    END IF;
    IF p_de_mim AND EXISTS (SELECT 1 FROM nucleo.conversas
         WHERE agente = 'gabriel' AND papel = 'ia' AND split_part(contato, ' ', 1) = nucleo.so_digitos(p_numero)
           AND criado_em > now() - interval '10 minutes'
           AND regexp_replace(mensagem, '[*_~\s]', '', 'g') = regexp_replace(msg, '[*_~\s]', '', 'g')) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA (Gabriel)');
    END IF;
    SELECT id INTO dono_id FROM nucleo.usuario_por_whatsapp(p_dono);
    IF dono_id IS NULL THEN SELECT id INTO dono_id FROM nucleo.usuarios WHERE papel = 'admin' AND ativo ORDER BY id LIMIT 1; END IF;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || CASE WHEN p_de_mim OR coalesce(p_nome, '') = '' THEN '' ELSE ' (' || p_nome || ')' END,
            'leo-observa', CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, dono_id, 'nucleo');
    -- contato liberado para o Gabriel: ele responde (aprovacao ou automatico)
    IF NOT p_de_mim AND nucleo.gabriel_pode_responder(p_numero) THEN
        RETURN jsonb_build_object('saida', 2, 'agente', 'gabriel', 'cliente_id', NULL, 'dono_id', dono_id,
            'nome', coalesce(nullif(p_nome, ''), (SELECT nome FROM nucleo.observacao_lista WHERE agente = 'gabriel'
                     AND nucleo.variantes_numero(numero) && nucleo.variantes_numero(p_numero) LIMIT 1), 'contato'),
            'numero', nucleo.so_digitos(p_numero), 'texto', p_texto, 'sessionId', 'g:' || nucleo.so_digitos(p_numero));
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', CASE WHEN p_de_mim THEN 'Leo leu sua mensagem (aprendizado)' ELSE 'Leo leu a mensagem do contato' END);
END $$;

-- ---------------------------------------------------------------- entrada v4: Leo/Gabriel, Joao, Suporte
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
BEGIN
    IF p_msg_id IS NOT NULL AND EXISTS (SELECT 1 FROM nucleo.whatsapp_enviadas WHERE id = p_msg_id) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;
    IF p_de_mim AND texto LIKE '🤖%' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    -- chips de atendimento: Joao (vendas) e Suporte24hrs
    IF papel IN ('joao', 'suporte') THEN
        IF NOT nucleo.pode_observar(papel, p_numero) THEN
            RETURN jsonb_build_object('saida', 0, 'motivo', papel || ' nao le este contato');
        END IF;
        RETURN nucleo.agente_entrada(p_numero, p_nome, texto, p_tipo, p_de_mim, 'dedicado', papel)
               || jsonb_build_object('instancia', p_instancia);
    END IF;

    -- numero pessoal: Leo (conversa "Voce" e /ia) + Gabriel (contatos liberados)
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

-- resumo para o Leo supervisionar: agora por agente
CREATE OR REPLACE FUNCTION nucleo.atendimento_resumo(p_usuario int, p_dias int DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := '{}'; a text;
BEGIN
    PERFORM nucleo.exigir_admin(p_usuario);
    FOREACH a IN ARRAY ARRAY['joao', 'suporte', 'gabriel'] LOOP
        r := r || jsonb_build_object(a, jsonb_build_object(
            'modo', nucleo.cfg(a || '_modo', 'observando'),
            'mensagens_recebidas', (SELECT count(*) FROM nucleo.conversas WHERE papel = 'usuario' AND criado_em > now() - make_interval(days => p_dias)
                                     AND CASE a WHEN 'gabriel' THEN agente = 'leo-observa' ELSE coalesce(instancia, 'joao') = nucleo.instancia_do_agente(a) AND cliente_id IS NOT NULL END),
            'respostas_humanas', (SELECT count(*) FROM nucleo.conversas WHERE papel = 'humano' AND criado_em > now() - make_interval(days => p_dias)
                                     AND CASE a WHEN 'gabriel' THEN agente = 'leo-observa' ELSE coalesce(instancia, 'joao') = nucleo.instancia_do_agente(a) AND cliente_id IS NOT NULL END),
            'respostas_da_ia', (SELECT count(*) FROM nucleo.conversas WHERE papel = 'ia' AND criado_em > now() - make_interval(days => p_dias)
                                     AND agente = a OR (a <> 'gabriel' AND papel = 'ia' AND coalesce(instancia,'joao') = nucleo.instancia_do_agente(a) AND cliente_id IS NOT NULL AND criado_em > now() - make_interval(days => p_dias))),
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

-- painel de leitura: filtros do Leo, Joao e Suporte + contatos do Gabriel + o que o Leo aprendeu
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
      FROM unnest(ARRAY['leo', 'joao', 'suporte']) a
$$;

-- nome que o Gabriel usa (o clone do dono)
INSERT INTO nucleo.config VALUES ('gabriel_nome', '"Gabriel"') ON CONFLICT DO NOTHING;

-- aprendiz do Leo/Gabriel: o tipo vem classificado (jeito_de_falar | como_resolve | fato) e vira prefixo do titulo
CREATE OR REPLACE FUNCTION nucleo.aprendiz_leo_salvar(p_dono int, p_contato text, p_itens jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; it jsonb; prefixo text;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        prefixo := CASE it->>'tipo' WHEN 'jeito_de_falar' THEN 'Jeito de falar: ' WHEN 'como_resolve' THEN 'Como resolve: ' ELSE '' END;
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata)
        VALUES (p_dono, 'pessoal', left(prefixo || coalesce(it->>'titulo', ''), 120), it->>'conteudo', 'observacao_leo', false,
                jsonb_build_object('contato', p_contato, 'tipo', it->>'tipo'));
        n := n + 1;
    END LOOP;
    INSERT INTO nucleo.aprendiz_progresso VALUES ('leo', p_contato, now())
    ON CONFLICT (agente, chave) DO UPDATE SET ate = now();
    RETURN n;
END $$;

-- jeito do dono: tudo que foi aprovado como jeito de falar / como resolve (mais itens = imitacao melhor)
CREATE OR REPLACE FUNCTION nucleo.estilo_dono(p_usuario int) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- ' || conteudo, E'\n'), '')
      FROM (SELECT conteudo FROM nucleo.conhecimento
             WHERE usuario_id = p_usuario AND aprovado
               AND (titulo ILIKE 'jeito de%' OR titulo ILIKE 'como resolve%' OR metadata->>'tipo' IN ('jeito_de_falar', 'como_resolve'))
             ORDER BY criado_em DESC LIMIT 20) k
$$;
