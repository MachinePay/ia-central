-- =====================================================================
-- IA Central - VIGIA DO WHATSAPP + RESPOSTAS AUTOMATICAS + LIMPEZA DO 🎤
--  - vigia: numero que costuma receber muito e esta mudo ha muito tempo em horario comercial (enquanto os outros
--    recebem) = conexao travada ("zumbi"): o n8n reinicia a conexao e avisa o dono.
--  - mensagem que o numero manda IGUAL para varias pessoas (saudacao, "horario de funcionamento") e automatica:
--    nao conta como resposta da equipe (o aprendiz ignora).
--  - o 🎤 e so a marca interna de audio transcrito: o que foi aprendido "do 🎤" sai.
-- Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------- respostas automaticas
ALTER TABLE nucleo.conversas DROP CONSTRAINT IF EXISTS conversas_papel_check;
ALTER TABLE nucleo.conversas ADD CONSTRAINT conversas_papel_check CHECK (papel IN ('usuario', 'ia', 'humano', 'automatica'));

CREATE OR REPLACE FUNCTION nucleo.parece_automatica(p_instancia text, p_msg text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT length(coalesce(p_msg, '')) >= 25 AND (
        SELECT count(DISTINCT split_part(contato, ' ', 1)) FROM nucleo.conversas
         WHERE instancia = p_instancia AND papel IN ('humano', 'automatica') AND mensagem = p_msg
           AND criado_em > now() - interval '30 days') >= 2
$$;

-- Joao/Suporte: igual ao da 22, mas a resposta "em massa" vira 'automatica'
CREATE OR REPLACE FUNCTION nucleo.agente_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_modo_whats text, p_agente text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    cfg   jsonb := nucleo.agente_config(p_agente);
    amodo text := cfg->>'modo';
    inst  text := nucleo.instancia_do_agente(p_agente);
    c     record;
    msg   text := coalesce(nullif(p_texto, ''), '[' || p_tipo || ']');
    auto  boolean;
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
    auto := p_de_mim AND nucleo.parece_automatica(inst, msg);
    IF auto THEN   -- as copias anteriores tambem eram automaticas
        UPDATE nucleo.conversas SET papel = 'automatica' WHERE instancia = inst AND papel = 'humano' AND mensagem = msg;
    END IF;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero), CASE WHEN p_de_mim THEN 'humano' ELSE 'cliente' END,
            CASE WHEN auto THEN 'automatica' WHEN p_de_mim THEN 'humano' ELSE 'usuario' END, msg, c.id, inst);
    UPDATE nucleo.clientes SET ultimo_contato = now(), nome = coalesce(nome, CASE WHEN p_de_mim THEN NULL ELSE nullif(p_nome, '') END)
     WHERE id = c.id;
    IF p_de_mim THEN RETURN jsonb_build_object('saida', 0, 'motivo',
        CASE WHEN auto THEN 'resposta automatica (nao ensina)' ELSE 'resposta humana registrada (aprendizado)' END); END IF;
    IF nucleo.pode_responder(p_agente, p_numero) THEN
        RETURN jsonb_build_object('saida', 2, 'agente', p_agente, 'cliente_id', c.id,
            'nome', coalesce(c.nome, nullif(p_nome, ''), 'cliente'), 'numero', nucleo.so_digitos(p_numero),
            'texto', p_texto, 'sessionId', 'c' || c.id || ':' || p_agente);
    END IF;
    RETURN jsonb_build_object('saida', 0, 'motivo', 'observando (nao responde esta pessoa)');
END $$;

-- (uma vez) o que ja entrou como "resposta da equipe" mas era mensagem automatica repetida
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_automaticas') THEN
        UPDATE nucleo.conversas c SET papel = 'automatica'
          FROM (SELECT instancia, mensagem FROM nucleo.conversas
                 WHERE papel = 'humano' AND length(mensagem) >= 25 AND instancia IN ('joao', 'suporte')
                 GROUP BY 1, 2 HAVING count(DISTINCT split_part(contato, ' ', 1)) >= 3) r
         WHERE c.papel = 'humano' AND c.instancia = r.instancia AND c.mensagem = r.mensagem;
        INSERT INTO nucleo.config VALUES ('migracao_automaticas', 'true');
    END IF;
END $$;

-- (uma vez) o 🎤 e marca interna: tira o que foi aprendido como "jeito" por causa dele
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_microfone') THEN
        DELETE FROM nucleo.conhecimento
         WHERE conteudo LIKE '%🎤%' OR titulo LIKE '%🎤%'
            OR titulo ILIKE '%audios transcritos%' OR titulo ILIKE '%áudios transcritos%'
            OR titulo ILIKE '%audio transcrito%' OR titulo ILIKE '%áudio transcrito%';
        IF to_regclass('public.nucleo_memoria_chat') IS NOT NULL THEN   -- memoria curta com respostas que comecavam com 🎤
            DELETE FROM nucleo_memoria_chat WHERE message::text LIKE '%🎤%';
        END IF;
        INSERT INTO nucleo.config VALUES ('migracao_microfone', 'true');
    END IF;
END $$;

-- ---------------------------------------------------------------- vigia do WhatsApp
CREATE TABLE IF NOT EXISTS nucleo.vigia_reinicios (
    id        bigserial PRIMARY KEY,
    instancia text NOT NULL,
    em        timestamptz NOT NULL DEFAULT now(),
    motivo    text
);

-- quais numeros parecem travados agora (so em horario comercial e se os outros estao recebendo)
CREATE OR REPLACE FUNCTION nucleo.vigia_whatsapp()
RETURNS TABLE (instancia text, agente text, ultima timestamptz, media_dia numeric)
LANGUAGE sql STABLE AS $$
    WITH agora AS (SELECT now() AT TIME ZONE 'America/Sao_Paulo' AS t),
    por AS (
        SELECT i.inst,
               (SELECT max(criado_em) FROM nucleo.conversas WHERE conversas.instancia = i.inst AND papel <> 'ia') AS ultima,
               (SELECT count(*) / 7.0 FROM nucleo.conversas WHERE conversas.instancia = i.inst AND papel = 'usuario'
                  AND criado_em > now() - interval '7 days') AS media
          FROM unnest(ARRAY['nucleo', 'joao', 'suporte', 'gabriel']) AS i(inst)
    )
    SELECT p.inst, nucleo.papel_instancia(p.inst), p.ultima, round(p.media, 1)
      FROM por p, agora a
     WHERE extract(isodow FROM a.t) <= 6 AND extract(hour FROM a.t) BETWEEN 9 AND 19   -- seg a sab, 9h-20h
       AND p.media >= 15                                                              -- costuma receber bastante
       AND p.ultima < now() - interval '90 minutes'                                   -- mudo ha 1h30
       AND EXISTS (SELECT 1 FROM nucleo.conversas o WHERE o.instancia <> p.inst AND o.papel <> 'ia'
                    AND o.criado_em > now() - interval '30 minutes')                  -- os outros estao recebendo
       AND NOT EXISTS (SELECT 1 FROM nucleo.vigia_reinicios v WHERE v.instancia = p.inst
                        AND v.em > now() - interval '3 hours')                        -- no maximo 1 vez a cada 3h
$$;

CREATE OR REPLACE FUNCTION nucleo.vigia_registrar(p_instancia text, p_agente text, p_ultima text) RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO nucleo.vigia_reinicios (instancia, motivo) VALUES (p_instancia, 'sem mensagens desde ' || p_ultima);
    PERFORM nucleo.registrar_evento(coalesce(p_agente, 'sistema'), 'aviso',
        'WhatsApp parecia travado (sem receber nada): reiniciei a conexao',
        'Ultima mensagem recebida: ' || p_ultima || '. Se continuar sem receber, desconecte e conecte de novo em Configurar.',
        jsonb_build_object('instancia', p_instancia));
    RETURN jsonb_build_object('avisar', coalesce((SELECT jsonb_agg(whatsapp) FROM nucleo.usuarios
                                       WHERE papel = 'admin' AND ativo AND whatsapp IS NOT NULL), '[]'));
END $$;
