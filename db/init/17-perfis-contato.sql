-- =====================================================================
-- IA Central - PERFIL DE CADA CONTATO: cada IA entende com quem esta falando.
-- O aprendiz monta sozinho (relacao, homem/mulher, tom, resumo, cuidados) e a IA recebe isso ao responder:
-- pessoa nova -> educado e mais formal | cliente antigo -> direto | amigo -> informal |
-- familia / namorada-esposa -> carinhoso e com cuidado (sem promessas, sem assunto delicado).
-- Voce pode corrigir a relacao no painel (vale o que voce marcou). Idempotente.
-- =====================================================================

CREATE TABLE IF NOT EXISTS nucleo.perfis_contato (
    agente         text NOT NULL,                  -- leo | gabriel | joao | suporte
    numero         text NOT NULL,
    nome           text,
    relacao        text NOT NULL DEFAULT 'novo',    -- novo | conhecido | cliente | cliente_antigo | amigo | familia | namorada_conjuge | trabalho | outro
    genero         text NOT NULL DEFAULT 'nao_sei', -- homem | mulher | nao_sei
    tom            text,
    resumo         text,
    cuidados       text,
    editado_manual boolean NOT NULL DEFAULT false,
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agente, numero)
);

CREATE OR REPLACE FUNCTION nucleo.rotulo_relacao(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p WHEN 'novo' THEN 'pessoa nova' WHEN 'conhecido' THEN 'conhecido' WHEN 'cliente' THEN 'cliente'
        WHEN 'cliente_antigo' THEN 'cliente antigo' WHEN 'amigo' THEN 'amigo(a)' WHEN 'familia' THEN 'familia'
        WHEN 'namorada_conjuge' THEN 'relacao intima (namorada/esposa/marido)' WHEN 'trabalho' THEN 'trabalho' ELSE 'outro' END
$$;

-- historico com a pessoa (para saber se e nova ou ja fala faz tempo)
CREATE OR REPLACE FUNCTION nucleo.contato_historico(p_agente text, p_numero text)
RETURNS TABLE (mensagens bigint, desde timestamptz) LANGUAGE sql STABLE AS $$
    SELECT count(*), min(criado_em) FROM nucleo.conversas c
     WHERE split_part(c.contato, ' ', 1) = nucleo.so_digitos(p_numero) AND CASE p_agente
        WHEN 'leo' THEN c.agente = 'leo-observa'
        WHEN 'gabriel' THEN c.agente IN ('gabriel-observa', 'gabriel')
        ELSE c.cliente_id IS NOT NULL AND coalesce(c.instancia, 'joao') = nucleo.instancia_do_agente(p_agente) END
$$;

-- o aprendiz atualiza o perfil (o que voce corrigiu a mao nao e trocado)
DROP FUNCTION IF EXISTS nucleo.perfil_salvar(text, text, jsonb);
CREATE OR REPLACE FUNCTION nucleo.perfil_salvar(p_agente text, p_chave text, p_perfil jsonb) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE num text; rel text; gen text;
BEGIN
    IF p_perfil IS NULL OR p_perfil = '{}'::jsonb OR p_agente NOT IN ('leo', 'gabriel', 'joao', 'suporte') THEN RETURN 0; END IF;
    num := CASE WHEN p_agente IN ('joao', 'suporte') AND p_chave ~ '^\d+$' AND length(p_chave) < 10
                THEN (SELECT whatsapp FROM nucleo.clientes WHERE id = p_chave::int)
                ELSE nucleo.so_digitos(replace(p_chave, 'g:', '')) END;
    IF coalesce(num, '') = '' THEN RETURN 0; END IF;
    rel := CASE WHEN p_perfil->>'relacao' IN ('novo','conhecido','cliente','cliente_antigo','amigo','familia','namorada_conjuge','trabalho','outro')
                THEN p_perfil->>'relacao' ELSE 'outro' END;
    gen := CASE WHEN p_perfil->>'genero' IN ('homem', 'mulher') THEN p_perfil->>'genero' ELSE 'nao_sei' END;
    INSERT INTO nucleo.perfis_contato AS p (agente, numero, nome, relacao, genero, tom, resumo, cuidados)
    VALUES (p_agente, num, nullif(p_perfil->>'nome', ''), rel, gen, nullif(p_perfil->>'tom', ''), nullif(p_perfil->>'resumo', ''), nullif(p_perfil->>'cuidados', ''))
    ON CONFLICT (agente, numero) DO UPDATE SET
        nome     = coalesce(EXCLUDED.nome, p.nome),
        relacao  = CASE WHEN p.editado_manual THEN p.relacao ELSE EXCLUDED.relacao END,
        genero   = CASE WHEN p.editado_manual AND p.genero <> 'nao_sei' THEN p.genero WHEN EXCLUDED.genero <> 'nao_sei' THEN EXCLUDED.genero ELSE p.genero END,
        tom      = coalesce(EXCLUDED.tom, p.tom),
        resumo   = coalesce(EXCLUDED.resumo, p.resumo),
        cuidados = CASE WHEN p.editado_manual AND p.cuidados IS NOT NULL THEN p.cuidados ELSE coalesce(EXCLUDED.cuidados, p.cuidados) END,
        atualizado_em = now();
    RETURN 1;
END $$;

-- o que a IA recebe antes de responder (bloco curto, so para ela)
CREATE OR REPLACE FUNCTION nucleo.perfil_texto(p_agente text, p_numero text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE p nucleo.perfis_contato%ROWTYPE; h record; rel text; regra text; partes text[] := '{}';
BEGIN
    IF coalesce(p_numero, '') = '' THEN RETURN ''; END IF;
    SELECT * INTO p FROM nucleo.perfis_contato WHERE agente = p_agente AND numero = nucleo.so_digitos(p_numero);
    SELECT * INTO h FROM nucleo.contato_historico(p_agente, p_numero);
    rel := coalesce(p.relacao, CASE WHEN coalesce(h.mensagens, 0) <= 3 THEN 'novo'
                                     WHEN p_agente IN ('joao', 'suporte') THEN 'cliente' ELSE 'conhecido' END);
    regra := CASE rel
        WHEN 'novo' THEN 'Pessoa NOVA: seja educado e um pouco mais formal, sem intimidade; entenda primeiro o que ela quer.'
        WHEN 'cliente_antigo' THEN 'Cliente antigo: pode ser mais direto e caloroso, mostre que lembra do historico.'
        WHEN 'cliente' THEN 'Cliente: cordial e objetivo.'
        WHEN 'amigo' THEN 'Amigo: informal e a vontade, do jeito que voces ja conversam.'
        WHEN 'familia' THEN 'Familia: carinhoso e respeitoso; cuidado com assuntos de familia e dinheiro.'
        WHEN 'namorada_conjuge' THEN 'Relacao INTIMA: carinhoso e com muito cuidado. Nunca prometa nada, nao marque compromisso, '
                                     'nao entre em assunto delicado (briga, ciume, DR, dinheiro, outras pessoas); se a conversa ficar seria, '
                                     'responda curto e carinhoso e diga que fala direito depois. Nao invente lembrancas.'
        WHEN 'trabalho' THEN 'Trabalho: profissional, objetivo e educado.'
        ELSE 'Seja natural e educado.' END;
    partes := array_append(partes, 'Quem e: ' || nucleo.rotulo_relacao(rel)
        || CASE coalesce(p.genero, 'nao_sei') WHEN 'mulher' THEN ', mulher' WHEN 'homem' THEN ', homem' ELSE '' END
        || coalesce(' (' || p.nome || ')', ''));
    IF coalesce(h.mensagens, 0) > 0 THEN
        partes := array_append(partes, 'Conversam desde ' || to_char(h.desde AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY')
                                       || ' (' || h.mensagens || ' mensagens)');
    END IF;
    IF p.tom IS NOT NULL THEN partes := array_append(partes, 'Tom com essa pessoa: ' || p.tom); END IF;
    IF p.resumo IS NOT NULL THEN partes := array_append(partes, 'Sobre ela: ' || p.resumo); END IF;
    IF p.cuidados IS NOT NULL THEN partes := array_append(partes, 'Cuidados: ' || p.cuidados); END IF;
    RETURN '[Sobre quem esta falando com voce (so para voce, nunca comente isso): ' || array_to_string(partes, '. ') || '. ' || regra || ']' || E'\n';
END $$;

-- "O que leu": cada conversa vem com o perfil da pessoa
CREATE OR REPLACE FUNCTION nucleo.agente_feed(p_agente text, p_usuario int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'conversas', coalesce((SELECT jsonb_agg(x ORDER BY x.ultima DESC) FROM (
            SELECT y.*, (SELECT to_jsonb(pc) - 'agente' FROM nucleo.perfis_contato pc WHERE pc.agente = p_agente AND pc.numero = y.numero) AS perfil
              FROM (SELECT split_part(v.contato, ' ', 1) AS numero,
                   max(coalesce(c.nome, nullif(substring(v.contato from '\((.*)\)'), ''))) AS nome,
                   count(*) AS mensagens, max(v.criado_em) AS ultima, min(v.criado_em) AS primeira,
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
             GROUP BY 1 ORDER BY max(v.criado_em) DESC LIMIT 40) y) x), '[]'),
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
