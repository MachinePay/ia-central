-- =====================================================================
-- IA Central - APRENDE DIRETO
--  * aprender_sozinho volta a ficar LIGADO (uma vez): o que o aprendiz tira das conversas ja entra valendo,
--    sem esperar aprovacao. O que estava parado esperando revisao passa a valer.
--  * ATENDIMENTO MULTIEMPRESA passa a aprender: o aprendiz le as conversas em que a EQUIPE respondeu
--    pelo numero do atendimento e grava na base da empresa da conversa (responsavel "Aprendiz (automatico)").
--    A IA do atendimento ja consulta essa base, entao usa na proxima pergunta parecida.
--    Item escrito por uma pessoa no painel nunca e sobrescrito pelo aprendiz.
--  Para voltar a revisar antes:  UPDATE nucleo.config SET valor = 'false' WHERE chave = 'aprender_sozinho';
--    (com ele desligado, o que o aprendiz tira do multiempresa entra INATIVO.)
-- Idempotente.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_aprende_direto') THEN
        INSERT INTO nucleo.config VALUES ('aprender_sozinho', 'true')
        ON CONFLICT (chave) DO UPDATE SET valor = 'true';
        UPDATE nucleo.conhecimento SET aprovado = true, metadata = coalesce(metadata, '{}') || '{"automatico": true}'
         WHERE NOT aprovado AND origem IN ('observacao', 'observacao_leo', 'observacao_gabriel');
        INSERT INTO nucleo.config VALUES ('migracao_aprende_direto', 'true');
    END IF;
END $$;

-- o que a base de todas as empresas ja sabe (o aprendiz nao repete)
CREATE OR REPLACE FUNCTION nucleo.multi_base_resumo() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT string_agg('- [' || x.slug || '/' || x.tipo || '] ' || x.titulo || ': ' || left(x.conteudo, 140), E'\n')
                       FROM (SELECT e.slug, b.tipo, b.titulo, b.conteudo FROM nucleo.empresa_base b JOIN nucleo.empresas e ON e.id = b.empresa_id
                              WHERE b.ativo AND e.ativo ORDER BY b.atualizado_em DESC LIMIT 80) x), '(vazia)')
        || E'\nEmpresas (slug = nome: assuntos):\n'
        || coalesce((SELECT string_agg('- ' || slug || ' = ' || nome || ': ' || left(assuntos, 160), E'\n' ORDER BY nome)
                       FROM nucleo.empresas WHERE ativo), '(nenhuma)')
$$;

-- conversas do multiempresa com resposta NOVA da equipe (o que o aprendiz ainda nao leu)
-- tipo 'multi', chave 'm:<atendimento>'; a transcricao leva o contexto de ate 3h antes da ultima leitura
CREATE OR REPLACE FUNCTION nucleo.aprendiz_pendentes_multi(p_limite int DEFAULT 25)
RETURNS TABLE (tipo text, chave text, dono_id int, transcricao text)
LANGUAGE sql STABLE AS $$
    SELECT 'multi', 'm:' || a.id, NULL::int,
           'EMPRESA DA CONVERSA: ' || coalesce((SELECT slug || ' (' || nome || ')' FROM nucleo.empresas WHERE id = a.empresa_id), 'nao definida')
           || E'\n' || (SELECT string_agg(CASE v.papel WHEN 'usuario' THEN 'CLIENTE' WHEN 'humano' THEN 'ATENDENTE HUMANO' ELSE 'IA' END
                                          || ': ' || v.mensagem, E'\n' ORDER BY v.id)
                          FROM (SELECT * FROM nucleo.conversas c
                                 WHERE c.agente = 'multi' AND c.instancia = a.instancia AND c.contato = a.contato
                                   AND c.papel IN ('usuario', 'humano', 'ia')
                                   AND c.criado_em > coalesce(pr.ate - interval '3 hours', '-infinity'::timestamptz)
                                 ORDER BY c.id DESC LIMIT 40) v)
      FROM nucleo.atendimentos a
      LEFT JOIN nucleo.aprendiz_progresso pr ON pr.agente = 'multi' AND pr.chave = 'm:' || a.id
     WHERE a.instancia <> 'simulador' AND a.contato NOT LIKE 'teste%'
       AND EXISTS (SELECT 1 FROM nucleo.conversas c
                    WHERE c.agente = 'multi' AND c.instancia = a.instancia AND c.contato = a.contato AND c.papel = 'humano'
                      AND c.criado_em > coalesce(pr.ate, '-infinity'::timestamptz))
     ORDER BY a.atualizado_em DESC
     LIMIT p_limite
$$;

-- grava o que aprendeu na base da empresa (item com mesmo titulo do aprendiz e atualizado; de pessoa, nao)
CREATE OR REPLACE FUNCTION nucleo.aprendiz_multi_salvar(p_chave text, p_itens jsonb) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    n      int := 0;
    it     jsonb;
    at_id  int := nullif(regexp_replace(coalesce(p_chave, ''), '\D', '', 'g'), '')::int;
    padrao int;
    eid    int;
    tp     text;
    tit    text;
    ex     nucleo.empresa_base%ROWTYPE;
    vale   boolean := coalesce(nucleo.cfg('aprender_sozinho', 'true'), 'true') = 'true';
BEGIN
    SELECT empresa_id INTO padrao FROM nucleo.atendimentos WHERE id = at_id;
    -- so ha uma empresa ativa: tudo e dela
    IF padrao IS NULL AND (SELECT count(*) FROM nucleo.empresas WHERE ativo) = 1 THEN
        SELECT id INTO padrao FROM nucleo.empresas WHERE ativo;
    END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(trim(it->>'conteudo'), '') = '' OR coalesce(trim(it->>'titulo'), '') = '';
        eid := coalesce((SELECT id FROM nucleo.empresas WHERE ativo AND slug = lower(trim(it->>'empresa'))), padrao);
        CONTINUE WHEN eid IS NULL;   -- nao sabe de qual empresa e: nao arrisca
        tp  := CASE WHEN it->>'tipo' IN ('produto', 'politica', 'faq', 'procedimento', 'contato') THEN it->>'tipo' ELSE 'faq' END;
        tit := left(trim(it->>'titulo'), 200);
        SELECT * INTO ex FROM nucleo.empresa_base
         WHERE empresa_id = eid AND ativo AND lower(titulo) = lower(tit) ORDER BY atualizado_em DESC LIMIT 1;
        IF FOUND THEN
            CONTINUE WHEN coalesce(ex.responsavel, '') NOT LIKE 'Aprendiz%';   -- escrito por pessoa: manda a pessoa
            UPDATE nucleo.empresa_base SET conteudo = it->>'conteudo', tipo = tp, atualizado_em = now() WHERE id = ex.id;
        ELSE
            INSERT INTO nucleo.empresa_base (empresa_id, tipo, titulo, conteudo, responsavel, ativo)
            VALUES (eid, tp, tit, it->>'conteudo', 'Aprendiz (automatico)', vale);
        END IF;
        n := n + 1;
    END LOOP;
    -- a empresa que o aprendiz reconheceu vale para a conversa (se ainda nao tinha)
    IF padrao IS NULL AND eid IS NOT NULL THEN
        UPDATE nucleo.atendimentos SET empresa_id = eid WHERE id = at_id AND empresa_id IS NULL;
    END IF;
    INSERT INTO nucleo.aprendiz_progresso VALUES ('multi', p_chave, now())
    ON CONFLICT (agente, chave) DO UPDATE SET ate = now();
    RETURN n;
END $$;
