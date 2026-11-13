-- =====================================================================
-- IA Central - SAUDE E ATIVIDADE: eventos (erros com motivo), saude por IA e o que cada uma
-- leu e aprendeu. Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS nucleo.eventos (
    id        bigserial PRIMARY KEY,
    agente    text NOT NULL,                 -- leo | joao | suporte | gabriel | aprendiz | monitor | sistema
    nivel     text NOT NULL DEFAULT 'erro' CHECK (nivel IN ('erro', 'aviso', 'info')),
    titulo    text NOT NULL,
    detalhe   text,
    contexto  jsonb NOT NULL DEFAULT '{}',
    visto     boolean NOT NULL DEFAULT false,
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eventos_agente ON nucleo.eventos (agente, criado_em DESC);

CREATE OR REPLACE FUNCTION nucleo.registrar_evento(p_agente text, p_nivel text, p_titulo text, p_detalhe text, p_contexto jsonb DEFAULT '{}')
RETURNS int LANGUAGE sql AS $$
    INSERT INTO nucleo.eventos (agente, nivel, titulo, detalhe, contexto)
    VALUES (coalesce(nullif(p_agente, ''), 'sistema'), CASE WHEN p_nivel IN ('erro','aviso','info') THEN p_nivel ELSE 'erro' END,
            left(coalesce(p_titulo, 'Falha'), 200), left(p_detalhe, 4000), coalesce(p_contexto, '{}'));
    DELETE FROM nucleo.eventos WHERE criado_em < now() - interval '30 days';
    SELECT 1
$$;

-- traduz o erro tecnico para um motivo que da pra entender
CREATE OR REPLACE FUNCTION nucleo.motivo_erro(p_erro text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_erro ~* '401|invalid api key|incorrect api key|authentication|authorization failed|check your credentials|unauthorized' THEN 'Chave da OpenAI invalida ou expirada (troque OPENAI_API_KEY no Render).'
        WHEN p_erro ~* '429|rate limit|quota|insufficient_quota|billing' THEN 'OpenAI sem credito ou limite de uso atingido (veja o billing da OpenAI).'
        WHEN p_erro ~* 'timeout|timed out|ETIMEDOUT|ECONNABORTED' THEN 'Demorou demais para responder (OpenAI ou servico lento).'
        WHEN p_erro ~* 'ECONNREFUSED|ENOTFOUND|getaddrinfo' THEN 'Nao conseguiu conectar em um servico (Evolution/WhatsApp, banco ou internet).'
        WHEN p_erro ~* 'not connected|connection closed|instance.*(not|nao)|close' THEN 'WhatsApp desconectado (leia o QR de novo no painel).'
        WHEN p_erro ~* 'context_length|maximum context|too many tokens' THEN 'Conversa grande demais para a IA (historico muito longo).'
        WHEN p_erro ~* 'model.*(not found|does not exist)' THEN 'Modelo de IA indisponivel na sua conta OpenAI.'
        WHEN p_erro ~* 'Max iterations|maximum iterations' THEN 'A IA ficou em loop usando ferramentas e desistiu.'
        WHEN coalesce(p_erro, '') = '' THEN 'A IA nao devolveu resposta.'
        ELSE 'Erro inesperado (veja o detalhe tecnico).'
    END
$$;

-- agente falhou ao responder: nao manda nada ao cliente, registra o motivo e avisa os admins
CREATE OR REPLACE FUNCTION nucleo.agente_falhou(p_agente text, p_erro text, p_numero text, p_pergunta text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE motivo text := nucleo.motivo_erro(p_erro);
BEGIN
    PERFORM nucleo.registrar_evento(p_agente, 'erro', motivo, p_erro,
        jsonb_build_object('numero', p_numero, 'mensagem', left(p_pergunta, 300)));
    RETURN jsonb_build_object('enviar', false, 'falhou', true, 'agente', p_agente, 'motivo', motivo,
        'avisar', coalesce((SELECT jsonb_agg(whatsapp) FROM nucleo.usuarios WHERE papel = 'admin' AND ativo AND whatsapp IS NOT NULL), '[]'));
END $$;

-- qual IA e cada workflow (para o workflow de erros)
CREATE OR REPLACE FUNCTION nucleo.agente_do_workflow(p_id text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_id IN ('iaCerebro00001', 'iaPessoal00001', 'espSistemas01', 'lembretes00001') THEN 'leo'
        WHEN p_id IN ('atendente00001', 'atendComercial1') THEN 'joao'
        WHEN p_id IN ('suporte24h0001', 'atendSuporte01', 'atendSistemico1') THEN 'suporte'
        WHEN p_id = 'gabriel000001' THEN 'gabriel'
        WHEN p_id = 'aprendiz000001' THEN 'aprendiz'
        WHEN p_id = 'monitorSistemas01' THEN 'monitor'
        ELSE 'sistema' END
$$;

-- ---------------------------------------------------------------- saude de cada IA (tela Inicio)
CREATE OR REPLACE FUNCTION nucleo.painel_saude(p_usuario int) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE r jsonb := '[]'; a text; lidas int; resp int; pend int; sug int; aprend int; ult timestamptz; ev jsonb; erros int;
BEGIN
    FOREACH a IN ARRAY ARRAY['leo', 'joao', 'suporte', 'gabriel'] LOOP
        IF a = 'leo' THEN
            SELECT count(*) FILTER (WHERE agente = 'leo-observa'), count(*) FILTER (WHERE agente = 'ia-pessoal' OR (papel = 'ia' AND usuario_id IS NOT NULL)),
                   max(criado_em) INTO lidas, resp, ult
              FROM nucleo.conversas WHERE criado_em > now() - interval '24 hours' AND (agente IN ('leo-observa', 'ia-pessoal') OR (papel = 'ia' AND usuario_id IS NOT NULL));
            pend := 0;
            SELECT count(*) FILTER (WHERE NOT aprovado AND origem = 'observacao_leo'), count(*) FILTER (WHERE aprovado)
              INTO sug, aprend FROM nucleo.conhecimento WHERE usuario_id = p_usuario;
        ELSIF a = 'gabriel' THEN
            SELECT count(*) FILTER (WHERE papel <> 'ia'), count(*) FILTER (WHERE papel = 'ia'), max(criado_em) INTO lidas, resp, ult
              FROM nucleo.conversas WHERE criado_em > now() - interval '24 hours' AND agente IN ('leo-observa', 'gabriel');
            SELECT count(*) INTO pend FROM nucleo.atendimento_fila WHERE status = 'pendente' AND agente = 'gabriel';
            SELECT count(*) FILTER (WHERE NOT aprovado AND origem = 'observacao_leo'),
                   count(*) FILTER (WHERE aprovado AND (titulo ILIKE 'jeito de%' OR titulo ILIKE 'como resolve%' OR metadata->>'tipo' IN ('jeito_de_falar', 'como_resolve')))
              INTO sug, aprend FROM nucleo.conhecimento WHERE usuario_id = p_usuario;
        ELSE
            SELECT count(*) FILTER (WHERE papel <> 'ia'), count(*) FILTER (WHERE papel = 'ia'), max(criado_em) INTO lidas, resp, ult
              FROM nucleo.conversas WHERE criado_em > now() - interval '24 hours' AND cliente_id IS NOT NULL
               AND coalesce(instancia, 'joao') = nucleo.instancia_do_agente(a);
            SELECT count(*) INTO pend FROM nucleo.atendimento_fila WHERE status = 'pendente' AND agente = a;
            SELECT count(*) FILTER (WHERE NOT aprovado AND origem = 'observacao' AND coalesce(metadata->>'agente', 'joao') = a),
                   count(*) FILTER (WHERE aprovado AND dominio IN (nucleo.area_do_agente(a), 'geral'))
              INTO sug, aprend FROM nucleo.conhecimento WHERE usuario_id IS NULL;
        END IF;
        SELECT count(*) INTO erros FROM nucleo.eventos WHERE agente = a AND nivel = 'erro' AND criado_em > now() - interval '24 hours';
        SELECT jsonb_build_object('id', id, 'titulo', titulo, 'detalhe', detalhe, 'em', criado_em, 'visto', visto) INTO ev
          FROM nucleo.eventos WHERE agente = a AND nivel = 'erro' ORDER BY criado_em DESC LIMIT 1;
        r := r || jsonb_build_array(jsonb_build_object(
            'agente', a,
            'modo', CASE a WHEN 'leo' THEN 'ativo' ELSE nucleo.cfg(a || '_modo', 'observando') END,
            'instancia', CASE a WHEN 'leo' THEN 'nucleo' WHEN 'gabriel' THEN 'nucleo' ELSE nucleo.instancia_do_agente(a) END,
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

-- ---------------------------------------------------------------- o que a IA leu / aprendeu / errou
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
                        WHEN 'leo' THEN agente IN ('leo-observa', 'ia-pessoal') OR (papel = 'ia' AND usuario_id IS NOT NULL AND cliente_id IS NULL AND agente <> 'gabriel')
                        WHEN 'gabriel' THEN agente IN ('leo-observa', 'gabriel')
                        ELSE cliente_id IS NOT NULL AND coalesce(instancia, 'joao') = nucleo.instancia_do_agente(p_agente) END
                     ORDER BY criado_em DESC LIMIT 600) v
              LEFT JOIN nucleo.clientes c ON c.id = v.cliente_id
             GROUP BY 1 ORDER BY max(v.criado_em) DESC LIMIT 40) x), '[]'),
        'aprendizado', coalesce((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'titulo', k.titulo, 'conteudo', k.conteudo, 'area', k.dominio,
                    'aprovado', k.aprovado, 'origem', k.origem, 'em', k.criado_em) ORDER BY k.criado_em DESC)
            FROM (SELECT * FROM nucleo.conhecimento WHERE CASE p_agente
                    WHEN 'leo' THEN usuario_id = p_usuario
                    WHEN 'gabriel' THEN usuario_id = p_usuario AND (titulo ILIKE 'jeito de%' OR titulo ILIKE 'como resolve%'
                                         OR metadata->>'tipo' IN ('jeito_de_falar', 'como_resolve') OR origem = 'resposta_aprovada')
                    ELSE usuario_id IS NULL AND (dominio IN (nucleo.area_do_agente(p_agente), 'geral'))
                         AND (aprovado OR coalesce(metadata->>'agente', 'joao') = p_agente) END
                  ORDER BY criado_em DESC LIMIT 150) k), '[]'),
        'eventos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nivel', nivel, 'titulo', titulo, 'detalhe', detalhe,
                    'contexto', contexto, 'visto', visto, 'em', criado_em) ORDER BY criado_em DESC)
            FROM (SELECT * FROM nucleo.eventos WHERE agente = p_agente ORDER BY criado_em DESC LIMIT 50) e), '[]'))
$$;
