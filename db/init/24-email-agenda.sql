-- =====================================================================
-- IA Central - E-MAIL E AGENDA EM CADA IA (leo | gabriel | joao | suporte)
-- * cada IA pode ter VARIAS contas: Google (Gmail + Google Agenda), Microsoft (Outlook + calendario)
--   e dominio proprio (IMAP/SMTP + CalDAV se o provedor tiver)
-- * as chaves do app OAuth (Google Cloud / Azure) ficam no perfil de CADA IA (nao no Render)
-- * senhas e tokens ficam CRIPTOGRAFADOS (pgcrypto) com a N8N_ENCRYPTION_KEY, que o n8n passa em cada chamada
-- * a IA so LE (so o que e novo, sem reler e sem marcar como lido), aprende so para ela e PROPOE
--   respostas/rascunhos e eventos; nada e executado sem voce aprovar no painel (aba Aprovar)
-- Idempotente.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS nucleo.correio_apps (          -- app OAuth de cada IA
    agente        text NOT NULL,
    provedor      text NOT NULL CHECK (provedor IN ('google', 'microsoft')),
    client_id     text NOT NULL,
    segredo       bytea NOT NULL,                          -- client secret (criptografado)
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agente, provedor)
);

CREATE TABLE IF NOT EXISTS nucleo.correio_contas (
    id             serial PRIMARY KEY,
    agente         text NOT NULL,
    tipo           text NOT NULL CHECK (tipo IN ('google', 'microsoft', 'imap')),
    email          text NOT NULL,
    nome           text,
    segredo        bytea,                                  -- tokens OAuth ou senhas IMAP/SMTP/CalDAV (criptografado)
    config         jsonb NOT NULL DEFAULT '{}',            -- o que pode aparecer no painel (servidores, sem senha)
    cursor         jsonb NOT NULL DEFAULT '{}',            -- ate onde ja leu (nunca rele)
    ler_email      boolean NOT NULL DEFAULT true,
    ler_agenda     boolean NOT NULL DEFAULT true,
    ativo          boolean NOT NULL DEFAULT true,
    estado         text NOT NULL DEFAULT 'ok',             -- ok | testando | erro
    erro           text,
    ultima_leitura timestamptz,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agente, email)
);

CREATE TABLE IF NOT EXISTS nucleo.correio_itens (         -- e-mails e eventos lidos (60 dias)
    id        bigserial PRIMARY KEY,
    conta_id  int NOT NULL REFERENCES nucleo.correio_contas(id) ON DELETE CASCADE,
    tipo      text NOT NULL CHECK (tipo IN ('email', 'evento')),
    ext_id    text NOT NULL,
    de        text,
    assunto   text,
    texto     text,
    quando    timestamptz,
    fim       timestamptz,
    dados     jsonb NOT NULL DEFAULT '{}',
    aprendido boolean NOT NULL DEFAULT false,
    criado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (conta_id, tipo, ext_id)
);
CREATE INDEX IF NOT EXISTS correio_itens_conta ON nucleo.correio_itens (conta_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS nucleo.correio_propostas (     -- o que a IA quer fazer (espera voce aprovar)
    id           serial PRIMARY KEY,
    agente       text NOT NULL,
    conta_id     int REFERENCES nucleo.correio_contas(id) ON DELETE CASCADE,
    item_id      bigint REFERENCES nucleo.correio_itens(id) ON DELETE SET NULL,
    tipo         text NOT NULL CHECK (tipo IN ('email', 'evento')),
    motivo       text,
    dados        jsonb NOT NULL,
    status       text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'executando', 'executada', 'rejeitada', 'falhou')),
    modo         text,                                     -- enviar | rascunho | criar
    resultado    text,
    criado_em    timestamptz NOT NULL DEFAULT now(),
    revisado_por int,
    revisado_em  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS correio_propostas_item ON nucleo.correio_propostas (item_id, tipo) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS correio_propostas_agente ON nucleo.correio_propostas (agente, status);

CREATE TABLE IF NOT EXISTS nucleo.correio_oauth (         -- "state" do OAuth (vale 30 min, uso unico)
    estado     text PRIMARY KEY,
    agente     text NOT NULL,
    provedor   text NOT NULL,
    redirect   text NOT NULL,
    volta      text NOT NULL,
    usuario_id int,
    criado_em  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- criptografia
CREATE OR REPLACE FUNCTION nucleo.correio_chave() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE k text := current_setting('nucleo.chave', true);
BEGIN
    IF coalesce(k, '') = '' THEN RAISE EXCEPTION 'Chave de criptografia ausente (N8N_ENCRYPTION_KEY)'; END IF;
    RETURN k;
END $$;

CREATE OR REPLACE FUNCTION nucleo.correio_usar_chave(p_chave text) RETURNS void
LANGUAGE sql AS $$ SELECT set_config('nucleo.chave', coalesce(p_chave, ''), true); SELECT $$;

CREATE OR REPLACE FUNCTION nucleo.cifrar(p jsonb) RETURNS bytea
LANGUAGE sql AS $$ SELECT pgp_sym_encrypt(p::text, nucleo.correio_chave()) $$;

CREATE OR REPLACE FUNCTION nucleo.decifrar(p bytea) RETURNS jsonb
LANGUAGE sql AS $$ SELECT CASE WHEN p IS NULL THEN '{}'::jsonb ELSE pgp_sym_decrypt(p, nucleo.correio_chave())::jsonb END $$;

CREATE OR REPLACE FUNCTION nucleo.url_cod(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(string_agg(CASE WHEN ch ~ '^[A-Za-z0-9_.~-]$' THEN ch
                    ELSE regexp_replace(upper(encode(convert_to(ch, 'UTF8'), 'hex')), '(..)', '%\1', 'g') END, '' ORDER BY i), '')
      FROM regexp_split_to_table(coalesce(p, ''), '') WITH ORDINALITY t(ch, i)
$$;

CREATE OR REPLACE FUNCTION nucleo.correio_tem_agenda(c nucleo.correio_contas) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT c.tipo IN ('google', 'microsoft') OR coalesce(c.config->>'caldav_url', '') <> '' $$;

CREATE OR REPLACE FUNCTION nucleo.correio_escopos(p_provedor text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_provedor
        WHEN 'google' THEN 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events'
        ELSE 'openid email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite' END
$$;

-- ---------------------------------------------------------------- o que o passo "4 · E-mail e agenda" mostra
CREATE OR REPLACE FUNCTION nucleo.correio_painel(p_agente text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'agente', p_agente,
        'apps', jsonb_build_object(
            'google', (SELECT jsonb_build_object('client_id', client_id, 'atualizado_em', atualizado_em) FROM nucleo.correio_apps WHERE agente = p_agente AND provedor = 'google'),
            'microsoft', (SELECT jsonb_build_object('client_id', client_id, 'atualizado_em', atualizado_em) FROM nucleo.correio_apps WHERE agente = p_agente AND provedor = 'microsoft')),
        'contas', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'email', c.email, 'nome', c.nome,
                    'ler_email', c.ler_email, 'ler_agenda', c.ler_agenda, 'ativo', c.ativo, 'estado', c.estado, 'erro', c.erro,
                    'ultima_leitura', c.ultima_leitura, 'tem_agenda', nucleo.correio_tem_agenda(c), 'config', c.config,
                    'lidos', (SELECT count(*) FROM nucleo.correio_itens i WHERE i.conta_id = c.id)) ORDER BY c.criado_em)
                FROM nucleo.correio_contas c WHERE c.agente = p_agente), '[]'),
        'itens', coalesce((SELECT jsonb_agg(x ORDER BY x.lido_em DESC) FROM (
                SELECT i.id, i.tipo, i.de, i.assunto, left(i.texto, 300) AS resumo, i.quando, i.fim, i.criado_em AS lido_em,
                       i.aprendido, c.email AS conta, i.dados->>'local' AS local
                  FROM nucleo.correio_itens i JOIN nucleo.correio_contas c ON c.id = i.conta_id
                 WHERE c.agente = p_agente ORDER BY i.criado_em DESC LIMIT 40) x), '[]'),
        'propostas', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
                SELECT p.id, p.tipo, p.motivo, p.dados, p.status, p.resultado, p.criado_em, p.conta_id, c.email AS conta, c.tipo AS conta_tipo,
                       i.de AS item_de, i.assunto AS item_assunto, left(i.texto, 1200) AS item_texto, i.quando AS item_quando
                  FROM nucleo.correio_propostas p JOIN nucleo.correio_contas c ON c.id = p.conta_id
                  LEFT JOIN nucleo.correio_itens i ON i.id = p.item_id
                 WHERE p.agente = p_agente AND (p.status IN ('pendente', 'executando', 'falhou'))
                 ORDER BY p.criado_em LIMIT 30) x), '[]'))
$$;

-- ---------------------------------------------------------------- API do painel (nucleo.api chama aqui: admin_correio*)
-- saida 8 = n8n executa (testar conta / executar proposta) | saida 9 = n8n le as contas agora
CREATE OR REPLACE FUNCTION nucleo.api_correio(p_usuario int, p_acao text, d jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    ag   text := CASE WHEN d->>'agente' IN ('leo', 'gabriel', 'joao', 'suporte') THEN d->>'agente' ELSE NULL END;
    prov text := CASE WHEN d->>'provedor' IN ('google', 'microsoft') THEN d->>'provedor' END;
    c    nucleo.correio_contas%ROWTYPE;
    p    nucleo.correio_propostas%ROWTYPE;
    app  nucleo.correio_apps%ROWTYPE;
    est  text;
    url  text;
BEGIN
    IF p_acao = 'admin_correio' THEN
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.correio_painel(coalesce(ag, 'leo')));

    ELSIF p_acao = 'admin_correio_app_salvar' THEN    -- chaves do app OAuth desta IA
        IF ag IS NULL OR prov IS NULL OR coalesce(trim(d->>'client_id'), '') = '' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Informe o Client ID'));
        END IF;
        IF coalesce(trim(d->>'segredo'), '') = '' THEN
            UPDATE nucleo.correio_apps SET client_id = trim(d->>'client_id'), atualizado_em = now() WHERE agente = ag AND provedor = prov;
            IF NOT FOUND THEN
                RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Informe o Client secret'));
            END IF;
        ELSE
            INSERT INTO nucleo.correio_apps (agente, provedor, client_id, segredo)
            VALUES (ag, prov, trim(d->>'client_id'), nucleo.cifrar(jsonb_build_object('segredo', trim(d->>'segredo'))))
            ON CONFLICT (agente, provedor) DO UPDATE SET client_id = EXCLUDED.client_id, segredo = EXCLUDED.segredo, atualizado_em = now();
        END IF;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.correio_painel(ag));

    ELSIF p_acao = 'admin_correio_app_apagar' THEN
        DELETE FROM nucleo.correio_apps WHERE agente = ag AND provedor = prov;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.correio_painel(coalesce(ag, 'leo')));

    ELSIF p_acao = 'admin_correio_conectar' THEN      -- devolve o endereco do login do Google/Microsoft
        SELECT * INTO app FROM nucleo.correio_apps WHERE agente = ag AND provedor = prov;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Salve antes as chaves do app ' ||
                CASE prov WHEN 'google' THEN 'Google' ELSE 'Microsoft' END || ' desta IA'));
        END IF;
        IF coalesce(d->>'redirect', '') !~ ('^https?://[^/]+/webhook/oauth/' || prov || '$') OR coalesce(d->>'volta', '') !~ '^https?://' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Endereco de retorno invalido'));
        END IF;
        DELETE FROM nucleo.correio_oauth WHERE criado_em < now() - interval '30 minutes';
        est := encode(gen_random_bytes(24), 'hex');
        INSERT INTO nucleo.correio_oauth (estado, agente, provedor, redirect, volta, usuario_id)
        VALUES (est, ag, prov, d->>'redirect', d->>'volta', p_usuario);
        url := CASE prov
            WHEN 'google' THEN 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent&include_granted_scopes=true&response_type=code'
            ELSE 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&response_mode=query&prompt=select_account' END
            || '&client_id=' || nucleo.url_cod(app.client_id) || '&redirect_uri=' || nucleo.url_cod(d->>'redirect')
            || '&scope=' || nucleo.url_cod(nucleo.correio_escopos(prov)) || '&state=' || est
            || CASE WHEN coalesce(d->>'email', '') <> '' THEN '&login_hint=' || nucleo.url_cod(d->>'email') ELSE '' END;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', jsonb_build_object('url', url));

    ELSIF p_acao = 'admin_correio_imap_salvar' THEN   -- dominio proprio: testa antes de valer
        IF ag IS NULL OR coalesce(d->>'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR coalesce(d->>'imap_host', '') = '' OR coalesce(d->>'senha', '') = '' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Informe e-mail, servidor IMAP e senha'));
        END IF;
        INSERT INTO nucleo.correio_contas (agente, tipo, email, nome, segredo, config, estado)
        VALUES (ag, 'imap', lower(trim(d->>'email')), nullif(trim(d->>'nome'), ''),
            nucleo.cifrar(jsonb_build_object(
                'imap', jsonb_build_object('host', trim(d->>'imap_host'), 'porta', coalesce(nullif(d->>'imap_porta', '')::int, 993),
                                           'usuario', coalesce(nullif(trim(d->>'usuario'), ''), lower(trim(d->>'email'))), 'senha', d->>'senha'),
                'smtp', CASE WHEN coalesce(d->>'smtp_host', '') <> '' THEN jsonb_build_object('host', trim(d->>'smtp_host'),
                                           'porta', coalesce(nullif(d->>'smtp_porta', '')::int, 465),
                                           'usuario', coalesce(nullif(trim(d->>'usuario'), ''), lower(trim(d->>'email'))), 'senha', d->>'senha') END,
                'caldav', CASE WHEN coalesce(d->>'caldav_url', '') <> '' THEN jsonb_build_object('url', trim(d->>'caldav_url'),
                                           'usuario', coalesce(nullif(trim(d->>'usuario'), ''), lower(trim(d->>'email'))), 'senha', d->>'senha') END)),
            jsonb_build_object('imap_host', trim(d->>'imap_host'), 'imap_porta', coalesce(nullif(d->>'imap_porta', '')::int, 993),
                               'smtp_host', nullif(trim(d->>'smtp_host'), ''), 'smtp_porta', coalesce(nullif(d->>'smtp_porta', '')::int, 465),
                               'caldav_url', nullif(trim(d->>'caldav_url'), '')),
            'testando')
        ON CONFLICT (agente, email) DO UPDATE SET tipo = 'imap', nome = coalesce(EXCLUDED.nome, nucleo.correio_contas.nome),
            segredo = EXCLUDED.segredo, config = EXCLUDED.config, estado = 'testando', erro = NULL, ativo = true,
            cursor = CASE WHEN nucleo.correio_contas.tipo = 'imap' THEN nucleo.correio_contas.cursor ELSE '{}' END
        RETURNING * INTO c;
        RETURN jsonb_build_object('saida', 8, 'status', 200, 'corpo', jsonb_build_object('acao', 'testar', 'id', c.id, 'agente', ag));

    ELSIF p_acao = 'admin_correio_conta' THEN         -- liga/desliga leitura de e-mail/agenda ou a conta toda
        UPDATE nucleo.correio_contas SET
            ler_email  = coalesce((d->>'ler_email')::boolean, ler_email),
            ler_agenda = coalesce((d->>'ler_agenda')::boolean, ler_agenda),
            ativo      = coalesce((d->>'ativo')::boolean, ativo)
         WHERE id = (d->>'id')::int RETURNING * INTO c;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.correio_painel(coalesce(c.agente, ag, 'leo')));

    ELSIF p_acao = 'admin_correio_desconectar' THEN   -- apaga a conta (o que a IA ja aprendeu continua)
        DELETE FROM nucleo.correio_contas WHERE id = (d->>'id')::int RETURNING * INTO c;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.correio_painel(coalesce(c.agente, ag, 'leo')));

    ELSIF p_acao = 'admin_correio_testar' THEN
        SELECT * INTO c FROM nucleo.correio_contas WHERE id = (d->>'id')::int;
        IF NOT FOUND THEN RETURN jsonb_build_object('saida', 0, 'status', 404, 'corpo', jsonb_build_object('erro', 'Conta nao encontrada')); END IF;
        RETURN jsonb_build_object('saida', 8, 'status', 200, 'corpo', jsonb_build_object('acao', 'testar', 'id', c.id, 'agente', c.agente));

    ELSIF p_acao = 'admin_correio_ler' THEN           -- le as contas desta IA agora
        RETURN jsonb_build_object('saida', 9, 'status', 200, 'corpo', jsonb_build_object('origem', 'painel', 'agente', coalesce(ag, '')));

    ELSIF p_acao = 'admin_correio_rejeitar' THEN
        UPDATE nucleo.correio_propostas SET status = 'rejeitada', revisado_por = p_usuario, revisado_em = now()
         WHERE id = (d->>'id')::int AND status IN ('pendente', 'falhou') RETURNING * INTO p;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.correio_painel(coalesce(p.agente, ag, 'leo')));

    ELSIF p_acao = 'admin_correio_aprovar' THEN       -- voce aprovou: o n8n executa na conta certa
        SELECT * INTO p FROM nucleo.correio_propostas WHERE id = (d->>'id')::int
           AND (status IN ('pendente', 'falhou') OR (status = 'executando' AND revisado_em < now() - interval '5 minutes'));
        IF NOT FOUND THEN
            RETURN jsonb_build_object('saida', 0, 'status', 404, 'corpo', jsonb_build_object('erro', 'Ja foi revisada'));
        END IF;
        IF p.tipo = 'email' AND coalesce(d->>'modo', '') NOT IN ('enviar', 'rascunho') THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Escolha enviar ou salvar rascunho'));
        END IF;
        -- evento: pode trocar a agenda (so contas desta IA que tem agenda)
        IF p.tipo = 'evento' AND coalesce(d->>'conta_id', '') <> '' THEN
            SELECT * INTO c FROM nucleo.correio_contas WHERE id = (d->>'conta_id')::int AND agente = p.agente;
            IF NOT FOUND OR NOT nucleo.correio_tem_agenda(c) THEN
                RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Essa conta nao tem agenda'));
            END IF;
            p.conta_id := c.id;
        END IF;
        UPDATE nucleo.correio_propostas SET status = 'executando', modo = CASE WHEN tipo = 'evento' THEN 'criar' ELSE d->>'modo' END,
               conta_id = p.conta_id, revisado_por = p_usuario, revisado_em = now(), resultado = NULL,
               dados = dados || (coalesce(d->'dados', '{}') - 'responder_a' - 'thread_id' - 'message_id' - 'referencias')
         WHERE id = p.id;
        RETURN jsonb_build_object('saida', 8, 'status', 200, 'corpo', jsonb_build_object('acao', 'executar', 'id', p.id, 'agente', p.agente));
    END IF;
    RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Acao desconhecida: ' || coalesce(p_acao, '')));
END $$;

-- ---------------------------------------------------------------- OAuth: volta do Google/Microsoft
CREATE OR REPLACE FUNCTION nucleo.correio_oauth_pegar(p_chave text, p_estado text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE o nucleo.correio_oauth%ROWTYPE; app nucleo.correio_apps%ROWTYPE;
BEGIN
    PERFORM nucleo.correio_usar_chave(p_chave);
    DELETE FROM nucleo.correio_oauth WHERE estado = coalesce(p_estado, '') RETURNING * INTO o;   -- uso unico
    IF NOT FOUND OR o.criado_em < now() - interval '30 minutes' THEN
        RETURN jsonb_build_object('erro', 'Link de conexao expirado. Tente conectar de novo.', 'volta', '');
    END IF;
    SELECT * INTO app FROM nucleo.correio_apps WHERE agente = o.agente AND provedor = o.provedor;
    IF NOT FOUND THEN RETURN jsonb_build_object('erro', 'As chaves do app foram apagadas', 'volta', o.volta); END IF;
    RETURN jsonb_build_object('agente', o.agente, 'provedor', o.provedor, 'redirect', o.redirect, 'volta', o.volta,
        'client_id', app.client_id, 'client_secret', nucleo.decifrar(app.segredo)->>'segredo', 'escopos', nucleo.correio_escopos(o.provedor));
END $$;

CREATE OR REPLACE FUNCTION nucleo.correio_oauth_salvar(p_chave text, p_agente text, p_provedor text, p_email text, p_nome text, p_tokens jsonb)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE cid int;
BEGIN
    PERFORM nucleo.correio_usar_chave(p_chave);
    INSERT INTO nucleo.correio_contas (agente, tipo, email, nome, segredo, estado)
    VALUES (p_agente, p_provedor, lower(trim(p_email)), nullif(p_nome, ''), nucleo.cifrar(p_tokens), 'ok')
    ON CONFLICT (agente, email) DO UPDATE SET tipo = EXCLUDED.tipo, nome = coalesce(EXCLUDED.nome, nucleo.correio_contas.nome),
        segredo = CASE WHEN coalesce(p_tokens->>'refresh_token', '') = '' AND nucleo.correio_contas.tipo = EXCLUDED.tipo
                       THEN nucleo.correio_contas.segredo ELSE EXCLUDED.segredo END,
        estado = 'ok', erro = NULL, ativo = true,
        cursor = CASE WHEN nucleo.correio_contas.tipo = EXCLUDED.tipo THEN nucleo.correio_contas.cursor ELSE '{}' END
    RETURNING id INTO cid;
    PERFORM nucleo.registrar_evento(p_agente, 'info', 'E-mail conectado: ' || lower(trim(p_email)), NULL, jsonb_build_object('conta', cid));
    RETURN cid;
END $$;

-- ---------------------------------------------------------------- tudo o que o n8n precisa para falar com uma conta
CREATE OR REPLACE FUNCTION nucleo.correio_conta_json(c nucleo.correio_contas) RETURNS jsonb
LANGUAGE sql AS $$
    SELECT jsonb_build_object('id', c.id, 'agente', c.agente, 'tipo', c.tipo, 'email', c.email, 'nome', c.nome,
        'segredo', nucleo.decifrar(c.segredo), 'cursor', c.cursor, 'ler_email', c.ler_email, 'ler_agenda', c.ler_agenda,
        'tem_agenda', nucleo.correio_tem_agenda(c),
        'app', (SELECT jsonb_build_object('client_id', a.client_id, 'client_secret', nucleo.decifrar(a.segredo)->>'segredo')
                  FROM nucleo.correio_apps a WHERE a.agente = c.agente AND a.provedor = c.tipo))
$$;

-- contas para ler agora (todas, ou so as de uma IA)
CREATE OR REPLACE FUNCTION nucleo.correio_para_ler(p_chave text, p_agente text DEFAULT '') RETURNS SETOF jsonb
LANGUAGE plpgsql AS $$
DECLARE c nucleo.correio_contas%ROWTYPE;
BEGIN
    PERFORM nucleo.correio_usar_chave(p_chave);
    FOR c IN SELECT * FROM nucleo.correio_contas
              WHERE ativo AND estado <> 'testando' AND (ler_email OR ler_agenda)
                AND (coalesce(p_agente, '') = '' OR agente = p_agente) ORDER BY id LOOP
        RETURN NEXT nucleo.correio_conta_json(c);
    END LOOP;
END $$;

-- guarda o que leu; devolve so o que e NOVO (para aprender) + o contexto da IA
CREATE OR REPLACE FUNCTION nucleo.correio_guardar(p_chave text, p_conta int, p_itens jsonb, p_cursor jsonb, p_segredo jsonb, p_erro text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c nucleo.correio_contas%ROWTYPE; novos jsonb; dono int := nucleo.admin_principal();
BEGIN
    PERFORM nucleo.correio_usar_chave(p_chave);
    SELECT * INTO c FROM nucleo.correio_contas WHERE id = p_conta;
    IF NOT FOUND THEN RETURN jsonb_build_object('conta_id', p_conta, 'novos', '[]'::jsonb); END IF;
    IF coalesce(p_segredo, '{}'::jsonb) <> '{}'::jsonb THEN   -- token renovado (Microsoft troca o refresh token)
        UPDATE nucleo.correio_contas SET segredo = nucleo.cifrar(nucleo.decifrar(segredo) || p_segredo) WHERE id = p_conta;
    END IF;
    -- erro em parte da leitura (ex.: so a agenda falhou): guarda o que veio e marca a conta com o erro
    IF coalesce(p_erro, '') <> '' THEN
        IF c.estado <> 'erro' OR coalesce(c.erro, '') <> p_erro THEN
            PERFORM nucleo.registrar_evento(c.agente, 'aviso', 'Nao consegui ler o e-mail ' || c.email, p_erro, jsonb_build_object('conta', c.id));
        END IF;
    END IF;
    UPDATE nucleo.correio_contas SET estado = CASE WHEN coalesce(p_erro, '') <> '' THEN 'erro' ELSE 'ok' END,
           erro = nullif(left(coalesce(p_erro, ''), 500), ''), ultima_leitura = now(),
           cursor = cursor || coalesce(p_cursor, '{}') WHERE id = p_conta;

    INSERT INTO nucleo.correio_itens AS i (conta_id, tipo, ext_id, de, assunto, texto, quando, fim, dados, aprendido)
    SELECT p_conta, x->>'tipo', x->>'ext_id', left(x->>'de', 300), left(x->>'assunto', 300), left(x->>'texto', 4000),
           nullif(x->>'quando', '')::timestamptz, nullif(x->>'fim', '')::timestamptz, coalesce(x->'dados', '{}'),
           coalesce(x->'dados'->>'automatico', '') = 'true'          -- propaganda/automatico: guarda, mas nao gasta IA
      FROM jsonb_array_elements(coalesce(p_itens, '[]')) x
     WHERE x->>'tipo' IN ('email', 'evento') AND coalesce(x->>'ext_id', '') <> ''
    ON CONFLICT (conta_id, tipo, ext_id) DO UPDATE      -- evento mudou de horario/titulo: atualiza (nao reaprende)
        SET assunto = EXCLUDED.assunto, texto = EXCLUDED.texto, quando = EXCLUDED.quando, fim = EXCLUDED.fim, dados = EXCLUDED.dados
      WHERE i.tipo = 'evento';

    -- o que ainda nao foi aprendido (inclui o que falhou na rodada anterior; depois de 3 dias desiste)
    UPDATE nucleo.correio_itens SET aprendido = true WHERE conta_id = p_conta AND NOT aprendido AND criado_em < now() - interval '3 days';
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'tipo', tipo, 'de', de, 'assunto', assunto, 'texto', left(texto, 1200),
               'quando', quando, 'fim', fim, 'local', dados->>'local', 'convidados', dados->'convidados') ORDER BY quando), '[]')
      INTO novos FROM (SELECT * FROM nucleo.correio_itens WHERE conta_id = p_conta AND NOT aprendido ORDER BY criado_em LIMIT 20) n;

    DELETE FROM nucleo.correio_itens WHERE conta_id = p_conta AND criado_em < now() - interval '60 days';
    RETURN jsonb_build_object('conta_id', p_conta, 'agente', c.agente, 'email', c.email, 'tipo', c.tipo, 'novos', novos,
        'tem_agenda', nucleo.correio_tem_agenda(c) OR EXISTS (SELECT 1 FROM nucleo.correio_contas o WHERE o.agente = c.agente AND o.ativo
                                                                AND nucleo.correio_tem_agenda(o)),
        'dono', CASE c.agente WHEN 'leo' THEN nucleo.cfg('leo_nome', 'Leo') WHEN 'gabriel' THEN nucleo.cfg('gabriel_nome', 'Gabriel')
                              ELSE nucleo.cfg(c.agente || '_persona', initcap(c.agente)) END,
        'contexto', CASE c.agente WHEN 'leo' THEN nucleo.memoria_resumo(dono) WHEN 'gabriel' THEN nucleo.memoria_gabriel(30)
                                  ELSE nucleo.base_resumo_agente(c.agente) END,
        'agenda', coalesce((SELECT string_agg('- ' || to_char(i.quando AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || ' ' || coalesce(i.assunto, ''), E'\n' ORDER BY i.quando)
                              FROM nucleo.correio_itens i JOIN nucleo.correio_contas o ON o.id = i.conta_id
                             WHERE o.agente = c.agente AND i.tipo = 'evento' AND i.quando BETWEEN now() - interval '1 day' AND now() + interval '21 days'), '(vazia)'));
END $$;

-- o que a IA aprendeu e propos a partir dos e-mails/eventos novos
CREATE OR REPLACE FUNCTION nucleo.correio_aprendido(p_conta int, p_ids jsonb, p_itens jsonb, p_propostas jsonb,
                                                    p_entrada int, p_saida int, p_modelo text)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE c nucleo.correio_contas%ROWTYPE; it jsonb; pr jsonb; n int := 0; np int := 0; prefixo text; item nucleo.correio_itens%ROWTYPE;
        agenda int; dono int := nucleo.admin_principal();
BEGIN
    SELECT * INTO c FROM nucleo.correio_contas WHERE id = p_conta;
    IF NOT FOUND THEN RETURN 0; END IF;
    UPDATE nucleo.correio_itens SET aprendido = true
     WHERE conta_id = p_conta AND id IN (SELECT (x #>> '{}')::bigint FROM jsonb_array_elements(coalesce(p_ids, '[]')) x);

    FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_itens, '[]')) LOOP
        CONTINUE WHEN coalesce(it->>'conteudo', '') = '';
        prefixo := CASE it->>'tipo' WHEN 'jeito_de_falar' THEN 'Jeito de falar: ' WHEN 'como_resolve' THEN 'Como resolve: ' ELSE '' END;
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, metadata, agente)
        VALUES (CASE WHEN c.agente IN ('leo', 'gabriel') THEN dono END,
                CASE WHEN c.agente IN ('leo', 'gabriel') THEN 'pessoal' ELSE nucleo.area_do_agente(c.agente) END,
                left(prefixo || coalesce(it->>'titulo', ''), 120), it->>'conteudo', 'observacao_email', false,
                jsonb_build_object('contato', 'e-mail ' || c.email, 'tipo', it->>'tipo', 'agente', c.agente, 'conta_id', c.id), c.agente);
        n := n + 1;
    END LOOP;

    -- propostas (no maximo 5 por leitura): resposta de e-mail na mesma conta; evento numa conta com agenda
    SELECT o.id INTO agenda FROM nucleo.correio_contas o
     WHERE o.agente = c.agente AND o.ativo AND nucleo.correio_tem_agenda(o) ORDER BY (o.id = c.id) DESC, o.id LIMIT 1;
    FOR pr IN SELECT * FROM jsonb_array_elements(coalesce(p_propostas, '[]')) LIMIT 5 LOOP
        item := NULL;
        SELECT * INTO item FROM nucleo.correio_itens WHERE conta_id = p_conta AND id = nullif(pr->>'item_id', '')::bigint;
        IF pr->>'tipo' = 'email' AND item.id IS NOT NULL AND item.tipo = 'email' AND coalesce(pr->>'corpo', '') <> '' THEN
            INSERT INTO nucleo.correio_propostas (agente, conta_id, item_id, tipo, motivo, dados)
            VALUES (c.agente, c.id, item.id, 'email', left(pr->>'motivo', 300), jsonb_build_object(
                'para', coalesce(nullif(item.dados->>'responder_para', ''), item.de),
                'assunto', CASE WHEN coalesce(item.assunto, '') ~* '^(re|res):' THEN item.assunto ELSE 'Re: ' || coalesce(item.assunto, '') END,
                'corpo', pr->>'corpo', 'responder_a', item.ext_id, 'thread_id', item.dados->>'thread_id',
                'message_id', item.dados->>'message_id', 'referencias', item.dados->>'referencias'))
            ON CONFLICT DO NOTHING;
            np := np + 1;
        ELSIF pr->>'tipo' = 'evento' AND agenda IS NOT NULL AND coalesce(pr->>'titulo', '') <> ''
              AND coalesce(pr->>'inicio', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN
            INSERT INTO nucleo.correio_propostas (agente, conta_id, item_id, tipo, motivo, dados)
            VALUES (c.agente, agenda, item.id, 'evento', left(pr->>'motivo', 300), jsonb_build_object(
                'titulo', left(pr->>'titulo', 200), 'inicio', left(pr->>'inicio', 16),
                'fim', CASE WHEN coalesce(pr->>'fim', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN left(pr->>'fim', 16)
                            ELSE to_char(left(pr->>'inicio', 16)::timestamp + interval '1 hour', 'YYYY-MM-DD"T"HH24:MI') END,
                'local', coalesce(pr->>'local', ''), 'descricao', coalesce(pr->>'descricao', ''),
                'convidados', coalesce((SELECT jsonb_agg(trim(e)) FROM regexp_split_to_table(coalesce(pr->>'convidados', ''), '[,;\s]+') e
                                         WHERE trim(e) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'), '[]')))
            ON CONFLICT DO NOTHING;
            np := np + 1;
        END IF;
    END LOOP;
    IF np > 0 THEN
        PERFORM nucleo.registrar_evento(c.agente, 'info', np || ' proposta(s) do e-mail esperando voce aprovar', NULL, jsonb_build_object('conta', c.id));
    END IF;
    IF coalesce(p_entrada, 0) + coalesce(p_saida, 0) > 0 THEN
        PERFORM nucleo.uso_registrar('aprendiz', c.agente, p_modelo, p_entrada, p_saida, 0);
    END IF;
    RETURN n;
END $$;

-- o que vem do e-mail tambem entra valendo sozinho (igual ao WhatsApp)
CREATE OR REPLACE FUNCTION nucleo.aprende_sozinho() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.origem IN ('observacao', 'observacao_leo', 'observacao_gabriel', 'observacao_email')
       AND coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'aprender_sozinho'), 'true') = 'true' THEN
        NEW.aprovado := true;
        NEW.metadata := coalesce(NEW.metadata, '{}') || '{"automatico": true}';
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------- executar (proposta aprovada) e testar conta
CREATE OR REPLACE FUNCTION nucleo.correio_execucao(p_chave text, p_acao text, p_id int) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c nucleo.correio_contas%ROWTYPE; p nucleo.correio_propostas%ROWTYPE;
BEGIN
    PERFORM nucleo.correio_usar_chave(p_chave);
    IF p_acao = 'testar' THEN
        SELECT * INTO c FROM nucleo.correio_contas WHERE id = p_id;
        IF NOT FOUND THEN RETURN jsonb_build_object('erro', 'Conta nao encontrada'); END IF;
        RETURN jsonb_build_object('acao', 'testar', 'conta', nucleo.correio_conta_json(c));
    END IF;
    SELECT * INTO p FROM nucleo.correio_propostas WHERE id = p_id AND status = 'executando';
    IF NOT FOUND THEN RETURN jsonb_build_object('erro', 'Proposta nao esta aprovada'); END IF;
    SELECT * INTO c FROM nucleo.correio_contas WHERE id = p.conta_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('erro', 'A conta desta proposta foi desconectada'); END IF;
    RETURN jsonb_build_object('acao', 'executar', 'conta', nucleo.correio_conta_json(c),
        'proposta', jsonb_build_object('id', p.id, 'tipo', p.tipo, 'modo', p.modo, 'dados', p.dados));
END $$;

CREATE OR REPLACE FUNCTION nucleo.correio_resultado(p_chave text, p_acao text, p_id int, p_ok boolean, p_resultado text, p_segredo jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c nucleo.correio_contas%ROWTYPE; p nucleo.correio_propostas%ROWTYPE; item nucleo.correio_itens%ROWTYPE;
BEGIN
    PERFORM nucleo.correio_usar_chave(p_chave);
    IF p_acao = 'testar' THEN
        UPDATE nucleo.correio_contas SET estado = CASE WHEN p_ok THEN 'ok' ELSE 'erro' END,
               erro = CASE WHEN p_ok THEN NULL ELSE left(p_resultado, 500) END,
               segredo = CASE WHEN coalesce(p_segredo, '{}'::jsonb) <> '{}'::jsonb THEN nucleo.cifrar(nucleo.decifrar(segredo) || p_segredo) ELSE segredo END
         WHERE id = p_id RETURNING * INTO c;
        IF p_ok THEN PERFORM nucleo.registrar_evento(c.agente, 'info', 'E-mail conectado: ' || c.email, NULL, jsonb_build_object('conta', c.id)); END IF;
        RETURN jsonb_build_object('ok', p_ok, 'erro', CASE WHEN p_ok THEN NULL ELSE p_resultado END, 'painel', nucleo.correio_painel(c.agente));
    END IF;
    UPDATE nucleo.correio_propostas SET status = CASE WHEN p_ok THEN 'executada' ELSE 'falhou' END, resultado = left(p_resultado, 500)
     WHERE id = p_id RETURNING * INTO p;
    IF coalesce(p_segredo, '{}'::jsonb) <> '{}'::jsonb THEN
        UPDATE nucleo.correio_contas SET segredo = nucleo.cifrar(nucleo.decifrar(segredo) || p_segredo) WHERE id = p.conta_id;
    END IF;
    IF p_ok AND p.tipo = 'email' AND p.modo = 'enviar' THEN   -- resposta aprovada ensina SO esta IA
        SELECT * INTO item FROM nucleo.correio_itens WHERE id = p.item_id;
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem, aprovado, agente, metadata)
        VALUES (CASE WHEN p.agente IN ('leo', 'gabriel') THEN p.revisado_por END,
                CASE WHEN p.agente IN ('leo', 'gabriel') THEN 'pessoal' ELSE nucleo.area_do_agente(p.agente) END,
                'Resposta aprovada (e-mail)', 'E-mail recebido: ' || left(coalesce(item.assunto, '') || ' - ' || coalesce(item.texto, ''), 600)
                || E'\n' || 'Resposta: ' || (p.dados->>'corpo'), 'resposta_aprovada', true, p.agente, jsonb_build_object('agente', p.agente));
    END IF;
    IF NOT p_ok THEN
        PERFORM nucleo.registrar_evento(p.agente, 'erro', 'Nao consegui executar a proposta do e-mail', p_resultado, jsonb_build_object('proposta', p.id));
    END IF;
    RETURN jsonb_build_object('ok', p_ok, 'erro', CASE WHEN p_ok THEN NULL ELSE p_resultado END, 'resultado', p_resultado,
                              'painel', nucleo.correio_painel(p.agente));
END $$;
