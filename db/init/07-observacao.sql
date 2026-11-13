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
        -- numero pessoal: o dono falando com quem nao e cliente = conversa pessoal, nao le
        IF p_de_mim AND p_modo_whats <> 'dedicado' THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa pessoal'); END IF;
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

-- nome do vendedor/atendente (persona) = Joao. (Leo 2.0 e a IA master, nao o atendente.)
-- Corrige uma vez quem ficou com "Leo 2.0" por engano; depois disso o nome e o que o admin escolher.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_persona_joao') THEN
        UPDATE nucleo.config SET valor = valor || '{"persona": "João"}'::jsonb
         WHERE chave = 'atendimento_empresa'
           AND (NOT (valor ? 'persona') OR valor->>'persona' IN ('', 'Leo 2.0'));
        INSERT INTO nucleo.config VALUES ('migracao_persona_joao', 'true');
    END IF;
END $$;
UPDATE nucleo.config SET valor = valor || '{"persona": "João"}'::jsonb
 WHERE chave = 'atendimento_empresa' AND NOT (valor ? 'persona');

-- Leo 2.0 (IA master) supervisionando o atendimento do Joao: so admin
CREATE OR REPLACE FUNCTION nucleo.atendimento_resumo(p_usuario int, p_dias int DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
    PERFORM nucleo.exigir_admin(p_usuario);
    RETURN jsonb_build_object(
        'config', nucleo.atendimento_config() - 'empresa',
        'periodo_dias', p_dias,
        'clientes_novos', (SELECT count(*) FROM nucleo.clientes WHERE criado_em > now() - make_interval(days => p_dias) AND whatsapp NOT LIKE 'teste%'),
        'mensagens_de_clientes', (SELECT count(*) FROM nucleo.conversas WHERE cliente_id IS NOT NULL AND papel = 'usuario' AND criado_em > now() - make_interval(days => p_dias)),
        'respostas_suas', (SELECT count(*) FROM nucleo.conversas WHERE cliente_id IS NOT NULL AND papel = 'humano' AND criado_em > now() - make_interval(days => p_dias)),
        'respostas_do_joao', (SELECT count(*) FROM nucleo.conversas WHERE cliente_id IS NOT NULL AND papel = 'ia' AND criado_em > now() - make_interval(days => p_dias)),
        'aguardando_aprovacao', (SELECT count(*) FROM nucleo.atendimento_fila WHERE status = 'pendente'),
        'sugestoes_para_revisar', (SELECT count(*) FROM nucleo.conhecimento WHERE usuario_id IS NULL AND NOT aprovado AND origem = 'observacao'),
        'chamados_abertos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'area', h.area, 'titulo', h.titulo,
                'prioridade', h.prioridade, 'cliente', c.nome, 'aberto_em', to_char(h.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')))
            FROM nucleo.chamados h LEFT JOIN nucleo.clientes c ON c.id = h.cliente_id WHERE h.status = 'aberto'), '[]'),
        'leads_recentes', coalesce((SELECT jsonb_agg(x) FROM (
            SELECT nome, empresa, interesse, etapa, to_char(ultimo_contato AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS ultimo_contato
              FROM nucleo.clientes WHERE etapa IN ('lead', 'cliente') AND whatsapp NOT LIKE 'teste%'
             ORDER BY ultimo_contato DESC LIMIT 10) x), '[]'),
        'aprendido_recente', coalesce((SELECT jsonb_agg(x) FROM (
            SELECT dominio AS area, titulo, conteudo, aprovado FROM nucleo.conhecimento
             WHERE usuario_id IS NULL AND origem IN ('observacao', 'aprendido_observando', 'resposta_aprovada')
               AND criado_em > now() - make_interval(days => p_dias)
             ORDER BY criado_em DESC LIMIT 15) x), '[]'));
END $$;

-- registra ids de mensagens que a IA enviou (usada pelo n8n)
CREATE OR REPLACE FUNCTION nucleo.whatsapp_registrar_ids(p_ids text[]) RETURNS void
LANGUAGE sql AS $$ INSERT INTO nucleo.whatsapp_enviadas (id) SELECT unnest(p_ids) ON CONFLICT DO NOTHING $$;
