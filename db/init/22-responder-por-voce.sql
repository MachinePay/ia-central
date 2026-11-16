-- =====================================================================
-- IA Central - RESPONDER POR VOCE (igual para as 4 IAs)
-- Cada IA tem: modo (desligada | so observando | com aprovacao | automatica), alcance (so quem voce escolher | todos,
-- este so para Joao e Suporte) e a lista de pessoas que ela responde no seu lugar, usando o que ela ja aprendeu.
--   Leo e Gabriel respondem como VOCE; Joao e Suporte respondem como a equipe.
-- Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS nucleo.responde_para (
    agente    text NOT NULL,     -- leo | gabriel | joao | suporte
    numero    text NOT NULL,
    nome      text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agente, numero)
);

INSERT INTO nucleo.config VALUES ('leo_modo', '"observando"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('leo_nome', '"Leo"') ON CONFLICT DO NOTHING;   -- nome que o numero do Leo usa ao responder   -- com contatos (com voce ele sempre fala)

-- migracao (uma vez): junta as listas antigas (Gabriel: liberados; Joao/Suporte: interruptor IA do cliente)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_responde_para') THEN
        INSERT INTO nucleo.responde_para (agente, numero, nome)
        SELECT 'gabriel', numero, nome FROM nucleo.observacao_lista WHERE agente = 'gabriel' AND regra = 'incluir'
        ON CONFLICT DO NOTHING;
        INSERT INTO nucleo.responde_para (agente, numero, nome)
        SELECT 'joao', whatsapp, nome FROM nucleo.clientes WHERE ia_responde AND whatsapp NOT LIKE 'teste%' ON CONFLICT DO NOTHING;
        INSERT INTO nucleo.responde_para (agente, numero, nome)
        SELECT 'suporte', whatsapp, nome FROM nucleo.clientes WHERE suporte_responde AND whatsapp NOT LIKE 'teste%' ON CONFLICT DO NOTHING;
        INSERT INTO nucleo.config VALUES ('migracao_responde_para', 'true');
    END IF;
END $$;

-- esta IA responde esta pessoa? (modo permite + pessoa na lista, ou alcance "todos" para Joao/Suporte)
CREATE OR REPLACE FUNCTION nucleo.pode_responder(p_agente text, p_numero text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT nucleo.cfg(p_agente || '_modo', 'observando') IN ('aprovacao', 'automatico')
       AND ((p_agente IN ('joao', 'suporte') AND nucleo.cfg(p_agente || '_alcance', 'selecionados') = 'todos')
            OR EXISTS (SELECT 1 FROM nucleo.responde_para r WHERE r.agente = p_agente
                        AND nucleo.variantes_numero(r.numero) && nucleo.variantes_numero(p_numero)))
$$;

CREATE OR REPLACE FUNCTION nucleo.gabriel_pode_responder(p_numero text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT nucleo.pode_responder('gabriel', p_numero) $$;

-- Joao/Suporte: decide pela lista unica
CREATE OR REPLACE FUNCTION nucleo.agente_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_modo_whats text, p_agente text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    cfg   jsonb := nucleo.agente_config(p_agente);
    amodo text := cfg->>'modo';
    inst  text := nucleo.instancia_do_agente(p_agente);
    c     record;
    msg   text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
BEGIN
    IF amodo = 'desligado' THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'agente desligado'); END IF;
    SELECT * INTO c FROM nucleo.clientes
     WHERE whatsapp NOT LIKE 'teste%' AND nucleo.variantes_numero(whatsapp) && nucleo.variantes_numero(p_numero) LIMIT 1;
    IF NOT FOUND THEN
        IF p_de_mim AND p_modo_whats <> 'dedicado' THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa pessoal'); END IF;
        c := nucleo.cliente_por_whatsapp(p_numero, CASE WHEN p_de_mim THEN NULL ELSE p_nome END);
    END IF;
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
    IF nucleo.pode_responder(p_agente, p_numero) THEN
        RETURN jsonb_build_object('saida', 2, 'agente', p_agente, 'cliente_id', c.id,
            'nome', coalesce(c.nome, nullif(p_nome, ''), 'cliente'), 'numero', nucleo.so_digitos(p_numero),
            'texto', p_texto, 'sessionId', 'c' || c.id || ':' || p_agente);
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', 'observando (nao responde esta pessoa)');
END $$;

-- Leo: le o numero dele e, se voce escolheu a pessoa, responde como VOCE (com o que aprendeu do seu jeito)
CREATE OR REPLACE FUNCTION nucleo.leo_observar(p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_dono text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE dono_id int; msg text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
BEGIN
    IF NOT (nucleo.pode_observar('leo', p_numero) OR nucleo.pode_responder('leo', p_numero)) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'Leo nao le este contato');
    END IF;
    -- a propria resposta do Leo voltando nao e voce escrevendo
    IF p_de_mim AND EXISTS (SELECT 1 FROM nucleo.conversas
         WHERE agente IN ('leo', 'leo-clone') AND papel = 'ia' AND split_part(contato, ' ', 1) = nucleo.so_digitos(p_numero)
           AND criado_em > now() - interval '10 minutes'
           AND regexp_replace(mensagem, '[*_~\s]', '', 'g') = regexp_replace(msg, '[*_~\s]', '', 'g')) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA (Leo)');
    END IF;
    SELECT id INTO dono_id FROM nucleo.usuario_por_whatsapp(p_dono);
    IF dono_id IS NULL THEN dono_id := nucleo.admin_principal(); END IF;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero) || CASE WHEN p_de_mim OR coalesce(p_nome, '') = '' THEN '' ELSE ' (' || p_nome || ')' END,
            'leo-observa', CASE WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, dono_id, 'nucleo');
    IF NOT p_de_mim AND nucleo.pode_responder('leo', p_numero) THEN
        RETURN jsonb_build_object('saida', 2, 'agente', 'leo', 'cliente_id', NULL, 'dono_id', dono_id,
            'nome', coalesce(nullif(p_nome, ''), (SELECT nome FROM nucleo.responde_para WHERE agente = 'leo'
                     AND nucleo.variantes_numero(numero) && nucleo.variantes_numero(p_numero) LIMIT 1), 'contato'),
            'numero', nucleo.so_digitos(p_numero), 'texto', p_texto, 'sessionId', 'l:' || nucleo.so_digitos(p_numero));
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', CASE WHEN p_de_mim THEN 'Leo leu sua mensagem (aprendizado)' ELSE 'Leo leu a mensagem do contato' END);
END $$;

-- resposta do Leo para um contato fica registrada como "leo-clone" (nao mistura com a sua conversa com ele)
-- e resposta aprovada do Leo/Gabriel ensina SO a propria IA
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
    VALUES ('whatsapp', coalesce(num, ''), CASE WHEN f.agente = 'leo' THEN 'leo-clone' ELSE f.agente END, 'ia', f.resposta_final,
            f.cliente_id, nucleo.instancia_do_agente(f.agente));
    IF f.agente IN ('gabriel', 'leo') THEN
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, agente)
        VALUES (p_revisor, 'pessoal', 'Resposta aprovada (' || f.agente || ')',
                'Mensagem recebida: ' || f.pergunta || E'\n' || 'Resposta: ' || f.resposta_final, 'resposta_aprovada', true, f.agente);
    ELSE
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, agente)
        VALUES (NULL, f.area, left(f.pergunta, 90),
                'Pergunta de cliente: ' || f.pergunta || E'\n' || 'Resposta aprovada: ' || f.resposta_final, 'resposta_aprovada', true,
                CASE WHEN f.agente IN ('joao', 'suporte') THEN f.agente ELSE nucleo.agente_da_area(f.area) END);
    END IF;
    RETURN jsonb_build_object('numero', num, 'texto', f.resposta_final, 'cliente_id', f.cliente_id,
                              'agente', f.agente, 'instancia', nucleo.instancia_do_agente(f.agente));
END $$;

-- tudo o que a tela "Configurar > Responder pessoas" precisa, igual para as 4 IAs
CREATE OR REPLACE FUNCTION nucleo.responder_painel(p_agente text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'agente', p_agente,
        'modo', nucleo.cfg(p_agente || '_modo', 'observando'),
        'alcance', CASE WHEN p_agente IN ('joao', 'suporte') THEN nucleo.cfg(p_agente || '_alcance', 'selecionados') ELSE 'selecionados' END,
        'pode_todos', p_agente IN ('joao', 'suporte'),
        'nome', CASE p_agente WHEN 'leo' THEN nucleo.cfg('leo_nome', 'Leo') WHEN 'gabriel' THEN nucleo.cfg('gabriel_nome', 'Gabriel') END,
        'contatos', coalesce((SELECT jsonb_agg(jsonb_build_object('numero', numero, 'nome', nome) ORDER BY nome NULLS LAST, numero)
                                FROM nucleo.responde_para WHERE agente = p_agente), '[]'),
        'fila', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
            SELECT f.id, f.pergunta, f.rascunho, f.criado_em, coalesce(c.nome, f.nome) AS nome, coalesce(c.whatsapp, f.numero) AS whatsapp
              FROM nucleo.atendimento_fila f LEFT JOIN nucleo.clientes c ON c.id = f.cliente_id
             WHERE f.status = 'pendente' AND f.agente = p_agente ORDER BY f.criado_em LIMIT 30) x), '[]'))
$$;

-- (uma vez) o Leo respondeu se apresentando como "Gabriel": limpa so a memoria curta dessas conversas
-- para ele nao repetir o erro (o aprendizado continua)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_nome_leo') THEN
        IF to_regclass('public.nucleo_memoria_chat') IS NOT NULL THEN   -- num banco novo a tabela ainda nao existe
            DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'l:%';
        END IF;
        INSERT INTO nucleo.config VALUES ('migracao_nome_leo', 'true');
    END IF;
END $$;
