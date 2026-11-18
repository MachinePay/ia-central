-- =====================================================================
-- IA Central - "O QUE LEU" LEVE: a lista de conversas nao carrega mais o historico inteiro de todas
-- (uma conversa com 300+ mensagens deixava o painel travado a cada atualizacao).
--  * agente_feed: so o resumo de cada conversa (ultima mensagem, quem mandou, quantas a IA respondeu)
--  * agente_conversa: o historico de UMA conversa, as ultimas N mensagens, quando voce abre
-- Idempotente.
-- =====================================================================

CREATE INDEX IF NOT EXISTS conversas_criado_em ON nucleo.conversas (criado_em DESC);

-- quais mensagens de conversas sao de cada agente (mesma regra do feed antigo)
CREATE OR REPLACE FUNCTION nucleo.conversa_do_agente(p_agente text, c nucleo.conversas) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_agente
        WHEN 'leo' THEN c.agente IN ('leo-observa', 'ia-pessoal', 'leo', 'leo-clone')
                        OR (c.papel = 'ia' AND c.usuario_id IS NOT NULL AND c.cliente_id IS NULL
                            AND c.agente NOT IN ('gabriel', 'gabriel-observa', 'multi') AND c.agente NOT LIKE '%-dono')
        WHEN 'gabriel' THEN c.agente IN ('gabriel-observa', 'gabriel', 'gabriel-dono')
        ELSE (c.cliente_id IS NOT NULL AND c.agente <> 'multi' AND coalesce(c.instancia, 'joao') = nucleo.instancia_do_agente(p_agente))
             OR c.agente = p_agente || '-dono' END
$$;

CREATE OR REPLACE FUNCTION nucleo.agente_feed(p_agente text, p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'conversas', coalesce((SELECT jsonb_agg(x ORDER BY x.ultima DESC) FROM (
            SELECT y.*, (SELECT to_jsonb(pc) - 'agente' FROM nucleo.perfis_contato pc WHERE pc.agente = p_agente AND pc.numero = y.numero) AS perfil
              FROM (SELECT split_part(v.contato, ' ', 1) AS numero,
                   max(coalesce(cl.nome, nullif(substring(v.contato from '\((.*)\)'), ''))) AS nome,
                   count(*) AS mensagens, max(v.criado_em) AS ultima, min(v.criado_em) AS primeira,
                   (array_agg(v.papel ORDER BY v.id DESC))[1] AS ultimo_papel,
                   (array_agg(left(v.mensagem, 160) ORDER BY v.id DESC))[1] AS ultima_mensagem,
                   count(*) FILTER (WHERE v.papel = 'ia') AS da_ia,
                   count(*) FILTER (WHERE v.papel = 'humano') AS humanas,
                   max(v.criado_em) FILTER (WHERE v.papel = 'ia') AS ultima_ia
              FROM (SELECT * FROM nucleo.conversas c
                     WHERE c.criado_em > now() - interval '14 days' AND nucleo.conversa_do_agente(p_agente, c)
                     ORDER BY c.criado_em DESC LIMIT 3000) v
              LEFT JOIN nucleo.clientes cl ON cl.id = v.cliente_id
             GROUP BY 1 ORDER BY max(v.criado_em) DESC LIMIT 60) y) x), '[]'),
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

-- historico de UMA conversa (as ultimas p_limite mensagens, mais antiga primeiro)
CREATE OR REPLACE FUNCTION nucleo.agente_conversa(p_agente text, p_numero text, p_limite int DEFAULT 150) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'numero', p_numero,
        'total', (SELECT count(*) FROM nucleo.conversas c WHERE split_part(c.contato, ' ', 1) = p_numero
                     AND c.criado_em > now() - interval '14 days' AND nucleo.conversa_do_agente(p_agente, c)),
        'historico', coalesce((SELECT jsonb_agg(jsonb_build_object('papel', v.papel, 'texto', left(v.mensagem, 2000), 'em', v.criado_em) ORDER BY v.id)
            FROM (SELECT c.* FROM nucleo.conversas c
                   WHERE split_part(c.contato, ' ', 1) = p_numero AND c.criado_em > now() - interval '14 days'
                     AND nucleo.conversa_do_agente(p_agente, c)
                   ORDER BY c.id DESC LIMIT least(greatest(coalesce(p_limite, 150), 20), 600)) v), '[]'))
$$;
