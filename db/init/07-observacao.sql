-- =====================================================================
-- IA Central - ATENDENTE APRENDIZ: observa conversas com clientes e aprende com as
-- respostas humanas; depois responde para clientes selecionados ou para todos.
--   atendimento_modo:     desligado | observando | aprovacao | automatico
--   atendimento_alcance:  selecionados (so clientes com ia_responde) | todos
--   atendimento_observar: clientes (so numeros cadastrados como cliente) | todos (inclui pessoais!)
-- O que o aprendiz extrai vira SUGESTAO (aprovado = false) ate o admin aprovar.
-- Idempotente.
-- =====================================================================

INSERT INTO nucleo.config VALUES ('atendimento_alcance', '"selecionados"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('atendimento_observar', '"clientes"') ON CONFLICT DO NOTHING;

ALTER TABLE nucleo.clientes  ADD COLUMN IF NOT EXISTS ia_responde   boolean NOT NULL DEFAULT false;
ALTER TABLE nucleo.clientes  ADD COLUMN IF NOT EXISTS aprendido_ate timestamptz;
ALTER TABLE nucleo.conversas ADD COLUMN IF NOT EXISTS cliente_id    int REFERENCES nucleo.clientes(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS conversas_cliente ON nucleo.conversas (cliente_id, criado_em) WHERE cliente_id IS NOT NULL;

-- config completa da atendente (substitui a da 06)
CREATE OR REPLACE FUNCTION nucleo.atendimento_config() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo',     coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_modo'), 'observando'),
        'alcance',  coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_alcance'), 'selecionados'),
        'observar', coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_observar'), 'clientes'),
        'empresa',  coalesce((SELECT valor FROM nucleo.config WHERE chave = 'atendimento_empresa'), '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------
-- Mensagem de/para um numero que nao e usuario.
--   p_de_mim = o dono do WhatsApp respondendo (resposta HUMANA: material de aprendizado)
-- Devolve saida 0 (so registra/ignora) ou 2 (manda para a atendente responder)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.atendimento_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_modo_whats text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    cfg   jsonb := nucleo.atendimento_config();
    amodo text := cfg->>'modo';
    c     record;
    msg   text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
BEGIN
    IF amodo = 'desligado' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'atendimento desligado');
    END IF;

    SELECT * INTO c FROM nucleo.clientes
     WHERE whatsapp NOT LIKE 'teste%' AND nucleo.variantes_numero(whatsapp) && nucleo.variantes_numero(p_numero)
     LIMIT 1;
    IF NOT FOUND THEN
        -- o dono falando com quem nao e cliente: conversa pessoal, nao le
        IF p_de_mim THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa pessoal'); END IF;
        -- chip dedicado: todo desconhecido e cliente | numero pessoal: so se "observar todos"
        IF p_modo_whats = 'dedicado' OR cfg->>'observar' = 'todos' THEN
            c := nucleo.cliente_por_whatsapp(p_numero, p_nome);
        ELSE
            RETURN jsonb_build_object('saida', 0, 'motivo', 'numero nao cadastrado (nao lido)');
        END IF;
    END IF;

    -- resposta que a propria IA mandou voltando pelo webhook: nao e humano
    IF p_de_mim AND EXISTS (
        SELECT 1 FROM nucleo.conversas
         WHERE cliente_id = c.id AND papel = 'ia' AND criado_em > now() - interval '10 minutes'
           AND regexp_replace(mensagem, '[*_~\s]', '', 'g') = regexp_replace(msg, '[*_~\s]', '', 'g')) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero),
            CASE WHEN p_de_mim THEN 'humano' ELSE 'cliente' END,
            CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, c.id);
    UPDATE nucleo.clientes SET ultimo_contato = now(), nome = coalesce(nome, CASE WHEN p_de_mim THEN NULL ELSE nullif(p_nome, '') END)
     WHERE id = c.id;

    IF p_de_mim THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'resposta humana registrada (aprendizado)');
    END IF;

    IF amodo IN ('aprovacao', 'automatico') AND (cfg->>'alcance' = 'todos' OR c.ia_responde) THEN
        RETURN jsonb_build_object('saida', 2, 'cliente_id', c.id, 'nome', coalesce(c.nome, nullif(p_nome, ''), 'cliente'),
            'texto', p_texto, 'sessionId', 'c' || c.id || ':whatsapp');
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', 'observando (IA nao responde este cliente)');
END $$;

-- ---------------------------------------------------------------------
-- APRENDIZ: conversas com respostas humanas novas desde a ultima vez
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes(p_limite int DEFAULT 10)
RETURNS TABLE (cliente_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT c.id,
           (SELECT string_agg(
                CASE v.papel WHEN 'usuario' THEN 'CLIENTE' WHEN 'humano' THEN 'ATENDENTE HUMANO' ELSE 'IA' END
                || ': ' || v.mensagem, E'\n' ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas
                     WHERE cliente_id = c.id ORDER BY criado_em DESC LIMIT 40) v)
      FROM nucleo.clientes c
     WHERE EXISTS (SELECT 1 FROM nucleo.conversas v
                    WHERE v.cliente_id = c.id AND v.papel = 'humano'
                      AND v.criado_em > coalesce(c.aprendido_ate, '-infinity'::timestamptz))
     ORDER BY c.ultimo_contato DESC
     LIMIT p_limite
$$;

-- o que ja existe na base (para o aprendiz nao repetir)
CREATE OR REPLACE FUNCTION nucleo.base_resumo() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce(string_agg('- [' || dominio || '] ' || coalesce(titulo, '') || ': ' || left(conteudo, 160), E'\n'), '(vazia)')
      FROM (SELECT * FROM nucleo.conhecimento WHERE usuario_id IS NULL AND dominio IN ('suporte','comercial','geral')
             ORDER BY criado_em DESC LIMIT 80) k
$$;

-- guarda as sugestoes extraidas de uma conversa e marca ate onde ja aprendeu
CREATE OR REPLACE FUNCTION nucleo.aprendiz_salvar(p_cliente int, p_itens jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; it jsonb;
BEGIN
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata)
        VALUES (NULL,
                CASE WHEN it->>'area' IN ('suporte','comercial','geral') THEN it->>'area' ELSE 'geral' END,
                left(it->>'titulo', 120), it->>'conteudo', 'observacao', false,
                jsonb_build_object('cliente_id', p_cliente));
        n := n + 1;
    END LOOP;
    UPDATE nucleo.clientes SET aprendido_ate = now() WHERE id = p_cliente;
    RETURN n;
END $$;

-- nome de quem atende (persona); so preenche se ainda nao tiver
UPDATE nucleo.config SET valor = valor || '{"persona": "Leo 2.0"}'::jsonb
 WHERE chave = 'atendimento_empresa' AND NOT (valor ? 'persona');

-- registra ids de mensagens que a IA enviou (usada pelo n8n)
CREATE OR REPLACE FUNCTION nucleo.whatsapp_registrar_ids(p_ids text[]) RETURNS void
LANGUAGE sql AS $$ INSERT INTO nucleo.whatsapp_enviadas (id) SELECT unnest(p_ids) ON CONFLICT DO NOTHING $$;
