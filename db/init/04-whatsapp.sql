-- =====================================================================
-- IA Central - WHATSAPP
-- Cada usuario cadastra o proprio numero; mensagens desse numero falam com a IA DELE.
-- Modo pessoal (celular do admin) ou dedicado (chip so da IA): ver whatsapp_modo abaixo.
-- Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION nucleo.so_digitos(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(coalesce(t,''), '\D', '', 'g') $$;

-- Celular BR com e sem o 9 extra (o WhatsApp as vezes manda 55 11 8 digitos, as vezes 55 11 9 + 8)
CREATE OR REPLACE FUNCTION nucleo.variantes_numero(t text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
    WITH d AS (SELECT nucleo.so_digitos(t) AS n)
    SELECT CASE
        WHEN n ~ '^55\d{2}9\d{8}$' THEN ARRAY[n, substr(n,1,4) || substr(n,6)]
        WHEN n ~ '^55\d{2}\d{8}$'  THEN ARRAY[n, substr(n,1,4) || '9' || substr(n,5)]
        WHEN n ~ '^\d{2}9\d{8}$'   THEN ARRAY['55' || n, '55' || substr(n,1,2) || substr(n,4)]
        WHEN n ~ '^\d{2}\d{8}$'    THEN ARRAY['55' || n, '55' || substr(n,1,2) || '9' || substr(n,3)]
        ELSE ARRAY[n] END
    FROM d
$$;

CREATE OR REPLACE FUNCTION nucleo.usuario_por_whatsapp(p_numero text)
RETURNS SETOF nucleo.usuarios LANGUAGE sql STABLE AS $$
    SELECT * FROM nucleo.usuarios
     WHERE ativo AND whatsapp IS NOT NULL
       AND nucleo.variantes_numero(whatsapp) && nucleo.variantes_numero(p_numero)
     ORDER BY id LIMIT 1
$$;

-- Config do WhatsApp:
--   whatsapp_modo = 'pessoal'  : numero da IA e o celular pessoal do admin. A IA so responde
--                                na conversa "Voce" (mensagem para si mesmo) e a usuarios
--                                cadastrados que comecem com o gatilho (ex: /ia). Desconhecidos
--                                nao sao registrados (privacidade de amigos/familia).
--   whatsapp_modo = 'dedicado' : chip so da IA. Todo usuario cadastrado conversa direto.
INSERT INTO nucleo.config VALUES ('whatsapp_modo', '"pessoal"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('whatsapp_gatilho', '"/ia"') ON CONFLICT DO NOTHING;

-- Ids das mensagens que a IA enviou (para nunca responder a si mesma)
CREATE TABLE IF NOT EXISTS nucleo.whatsapp_enviadas (
    id        text PRIMARY KEY,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION nucleo.whatsapp_config() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo',    coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'whatsapp_modo'), 'pessoal'),
        'gatilho', coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'whatsapp_gatilho'), '/ia'))
$$;

-- Mensagem chegando do WhatsApp: decide se a IA responde.
--   saida 0 = ignorar | 1 = mandar para a IA do usuario (texto ja sem o gatilho em 'texto')
DROP FUNCTION IF EXISTS nucleo.whatsapp_entrada(text, text, text, text);
CREATE OR REPLACE FUNCTION nucleo.whatsapp_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text,
    p_de_mim boolean DEFAULT false, p_conversa_propria boolean DEFAULT false, p_msg_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    u      nucleo.usuarios%ROWTYPE;
    cfg    jsonb := nucleo.whatsapp_config();
    modo   text := cfg->>'modo';
    gat    text := lower(cfg->>'gatilho');
    texto  text := coalesce(p_texto, '');
BEGIN
    -- 1) nunca responder a propria IA (id registrado ou texto marcado com o robo)
    IF p_msg_id IS NOT NULL AND EXISTS (SELECT 1 FROM nucleo.whatsapp_enviadas WHERE id = p_msg_id) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;
    IF p_de_mim AND texto LIKE '🤖%' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;
    -- 2) mensagens que o dono do numero manda para OUTRAS pessoas: nao e com a IA
    IF p_de_mim AND NOT p_conversa_propria THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa pessoal');
    END IF;

    SELECT * INTO u FROM nucleo.usuario_por_whatsapp(p_numero);

    IF u.id IS NULL THEN
        -- chip dedicado + atendente ligada: cliente vai para a ATENDENTE (suporte/comercial/sistemico)
        IF modo = 'dedicado' AND NOT p_de_mim
           AND coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_modo'), 'aprovacao') <> 'desligado' THEN
            DECLARE cli record;
            BEGIN
                cli := nucleo.cliente_por_whatsapp(p_numero, p_nome);
                INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem)
                VALUES ('whatsapp', nucleo.so_digitos(p_numero) || coalesce(' (' || nullif(p_nome,'') || ')', ''),
                        'atendente', 'usuario', coalesce(nullif(texto,''), '[' || p_tipo || ']'));
                RETURN jsonb_build_object('saida', 2, 'cliente_id', cli.id, 'nome', coalesce(cli.nome, p_nome, 'cliente'),
                    'texto', texto, 'sessionId', 'c' || cli.id || ':whatsapp');
            END;
        END IF;
        IF modo = 'dedicado' THEN   -- atendente desligada: so guarda para o admin ver
            INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, precisa_revisao)
            VALUES ('whatsapp', nucleo.so_digitos(p_numero) || coalesce(' (' || nullif(p_nome,'') || ')', ''),
                    'nenhum', 'usuario', coalesce(nullif(texto,''), '[' || p_tipo || ']'), true);
        END IF;                     -- no modo pessoal: nao registra nada (amigos/familia)
        RETURN jsonb_build_object('saida', 0, 'motivo', 'numero nao cadastrado');
    END IF;

    -- 3) modo pessoal: outros usuarios precisam do gatilho; a conversa "Voce" do dono e livre
    IF modo = 'pessoal' AND NOT p_conversa_propria THEN
        IF p_tipo = 'audio' OR lower(ltrim(texto)) NOT LIKE gat || '%' THEN
            RETURN jsonb_build_object('saida', 0, 'motivo', 'sem gatilho (modo pessoal)');
        END IF;
        texto := ltrim(substr(ltrim(texto), length(gat) + 1), ' ,:');
    END IF;

    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero), 'ia-pessoal', 'usuario',
            coalesce(nullif(texto,''), '[' || p_tipo || ']'), u.id);
    RETURN jsonb_build_object('saida', 1,
        'usuario_id', u.id, 'nome', u.nome, 'papel', u.papel, 'texto', texto,
        'sessionId', 'u' || u.id || ':whatsapp',
        'canal', CASE WHEN p_tipo = 'audio' THEN 'whatsapp (audio: a resposta tambem vai em audio)' ELSE 'whatsapp' END);
END $$;

DROP FUNCTION IF EXISTS nucleo.whatsapp_saida(int, text, text);
CREATE OR REPLACE FUNCTION nucleo.whatsapp_saida(p_usuario int, p_numero text, p_texto text, p_ids text[] DEFAULT '{}')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO nucleo.whatsapp_enviadas (id) SELECT unnest(p_ids) ON CONFLICT DO NOTHING;
    DELETE FROM nucleo.whatsapp_enviadas WHERE criado_em < now() - interval '2 days';
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, usuario_id)
    VALUES ('whatsapp', nucleo.so_digitos(p_numero), 'ia-pessoal', 'ia', p_texto, p_usuario);
END $$;

-- Ultimas mensagens de numeros desconhecidos (so existem no modo dedicado)
CREATE OR REPLACE FUNCTION nucleo.whatsapp_desconhecidos() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT coalesce(jsonb_agg(x), '[]') FROM (
        SELECT contato, mensagem, criado_em FROM nucleo.conversas
         WHERE canal = 'whatsapp' AND usuario_id IS NULL
         ORDER BY criado_em DESC LIMIT 10) x
$$;
