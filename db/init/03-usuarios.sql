-- =====================================================================
-- IA Central - USUARIOS (cada um com a propria IA)
-- * memoria, lembretes, contatos e conversas separados por usuario
-- * admin ve tudo e pode mandar a IA usar a memoria de todos
-- * config "memoria_compartilhada": todos veem de todos (quem participa)
-- * cada usuario (inclusive o admin) pode ficar de fora (compartilha=false)
-- As regras ficam AQUI no banco: a IA nunca decide sozinha o que pode ver.
-- Idempotente: pode rodar de novo.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS nucleo.usuarios (
    id               serial PRIMARY KEY,
    nome             text NOT NULL,
    login            text NOT NULL UNIQUE,
    senha_hash       text NOT NULL,
    papel            text NOT NULL DEFAULT 'usuario' CHECK (papel IN ('admin','usuario')),
    compartilha      boolean NOT NULL DEFAULT true,   -- participa da memoria compartilhada
    telegram_chat_id text,
    whatsapp         text,
    ativo            boolean NOT NULL DEFAULT true,
    criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nucleo.sessoes (
    token       text PRIMARY KEY,
    usuario_id  int NOT NULL REFERENCES nucleo.usuarios(id) ON DELETE CASCADE,
    criada_em   timestamptz NOT NULL DEFAULT now(),
    expira_em   timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

CREATE TABLE IF NOT EXISTS nucleo.config (
    chave  text PRIMARY KEY,
    valor  jsonb NOT NULL
);
INSERT INTO nucleo.config VALUES ('memoria_compartilhada', 'false') ON CONFLICT DO NOTHING;

-- dono de cada dado
ALTER TABLE nucleo.conhecimento ADD COLUMN IF NOT EXISTS usuario_id int REFERENCES nucleo.usuarios(id) ON DELETE CASCADE;
ALTER TABLE nucleo.lembretes    ADD COLUMN IF NOT EXISTS usuario_id int REFERENCES nucleo.usuarios(id) ON DELETE CASCADE;
ALTER TABLE nucleo.contatos     ADD COLUMN IF NOT EXISTS usuario_id int REFERENCES nucleo.usuarios(id) ON DELETE CASCADE;
ALTER TABLE nucleo.conversas    ADD COLUMN IF NOT EXISTS usuario_id int REFERENCES nucleo.usuarios(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS conhecimento_usuario ON nucleo.conhecimento (usuario_id);
CREATE INDEX IF NOT EXISTS lembretes_usuario    ON nucleo.lembretes (usuario_id);

-- ---------------------------------------------------------------------
-- Cria/atualiza um usuario (usado pelo script do admin e pelo painel)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.salvar_usuario(p_nome text, p_login text, p_senha text, p_papel text DEFAULT 'usuario')
RETURNS int LANGUAGE sql AS $$
    INSERT INTO nucleo.usuarios (nome, login, senha_hash, papel)
    VALUES (p_nome, lower(p_login), crypt(p_senha, gen_salt('bf')), p_papel)
    ON CONFLICT (login) DO UPDATE
       SET nome = EXCLUDED.nome, senha_hash = EXCLUDED.senha_hash, papel = EXCLUDED.papel, ativo = true
    RETURNING id
$$;

CREATE OR REPLACE FUNCTION nucleo.memoria_compartilhada() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT valor::text::boolean FROM nucleo.config WHERE chave = 'memoria_compartilhada'), false)
$$;

-- ---------------------------------------------------------------------
-- REGRA DE VISIBILIDADE da memoria
--   minha        -> so as minhas
--   compartilhada-> minhas + de quem participa (se o modo estiver ligado e eu participar)
--   todos        -> admin: tudo de todos | outros: igual a compartilhada
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION nucleo.pode_ver_memoria(p_viewer int, p_dono int, p_escopo text)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT p_viewer = p_dono
        OR (p_escopo = 'todos' AND EXISTS (SELECT 1 FROM nucleo.usuarios WHERE id = p_viewer AND papel = 'admin'))
        OR (p_escopo IN ('compartilhada','todos')
            AND nucleo.memoria_compartilhada()
            AND EXISTS (SELECT 1 FROM nucleo.usuarios WHERE id = p_viewer AND compartilha)
            AND EXISTS (SELECT 1 FROM nucleo.usuarios WHERE id = p_dono   AND compartilha))
$$;

CREATE OR REPLACE FUNCTION nucleo.buscar_memoria(p_usuario int, p_busca text, p_escopo text DEFAULT 'minha')
RETURNS TABLE (id bigint, de text, titulo text, conteudo text, criado_em timestamptz, relevante boolean)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('portuguese',
               unaccent(regexp_replace(coalesce(p_busca,''), '[;,|[:space:]]+', ' or ', 'g'))) AS tsq
    ), c AS (
        SELECT k.id, u.nome AS de, k.titulo, k.conteudo, k.criado_em,
               to_tsvector('portuguese', unaccent(coalesce(k.titulo,'') || ' ' || k.conteudo)) AS doc
          FROM nucleo.conhecimento k
          JOIN nucleo.usuarios u ON u.id = k.usuario_id
         WHERE k.aprovado AND nucleo.pode_ver_memoria(p_usuario, k.usuario_id, coalesce(p_escopo,'minha'))
    )
    SELECT c.id, c.de, c.titulo, c.conteudo, c.criado_em, c.doc @@ q.tsq
      FROM c, q
     ORDER BY c.doc @@ q.tsq DESC, ts_rank(c.doc, q.tsq) DESC, c.criado_em DESC
     LIMIT 20
$$;

CREATE OR REPLACE FUNCTION nucleo.lembrar(p_usuario int, p_titulo text, p_conteudo text)
RETURNS TABLE (id bigint, titulo text) LANGUAGE sql AS $$
    INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem)
    VALUES (p_usuario, 'pessoal', p_titulo, p_conteudo, 'conversa')
    RETURNING id, titulo
$$;

-- So admin altera o monitoramento (cadastrar/pausar)
CREATE OR REPLACE FUNCTION nucleo.exigir_admin(p_usuario int) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.usuarios WHERE id = p_usuario AND papel = 'admin') THEN
        RAISE EXCEPTION 'Apenas o admin pode alterar o monitoramento.';
    END IF;
END $$;

-- =====================================================================
-- API DO PAINEL: uma funcao, varias acoes. Devolve
--   { saida: 0 responder | 1 chamar IA | 2 falar (TTS), status, corpo }
-- =====================================================================
CREATE OR REPLACE FUNCTION nucleo.api(p_token text, p_acao text, p_dados jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    u   nucleo.usuarios%ROWTYPE;
    tok text;
    adm boolean;
    d   jsonb := coalesce(p_dados, '{}');
BEGIN
    -- ---------- login (sem token) ----------
    IF p_acao = 'login' THEN
        SELECT * INTO u FROM nucleo.usuarios
         WHERE login = lower(d->>'login') AND ativo
           AND senha_hash = crypt(coalesce(d->>'senha',''), senha_hash);
        IF NOT FOUND THEN
            PERFORM pg_sleep(0.5);  -- atrapalha tentativa de adivinhar senha
            RETURN jsonb_build_object('saida',0,'status',401,'corpo',jsonb_build_object('erro','Login ou senha invalidos'));
        END IF;
        tok := encode(gen_random_bytes(32), 'hex');
        INSERT INTO nucleo.sessoes (token, usuario_id) VALUES (tok, u.id);
        DELETE FROM nucleo.sessoes WHERE expira_em < now();
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object(
            'token', tok, 'usuario', jsonb_build_object('id',u.id,'nome',u.nome,'papel',u.papel)));
    END IF;

    -- ---------- todo o resto exige token valido ----------
    SELECT us.* INTO u FROM nucleo.sessoes s JOIN nucleo.usuarios us ON us.id = s.usuario_id
     WHERE s.token = p_token AND s.expira_em > now() AND us.ativo;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('saida',0,'status',401,'corpo',jsonb_build_object('erro','Sessao expirada, entre de novo'));
    END IF;
    adm := u.papel = 'admin';

    IF p_acao = 'logout' THEN
        DELETE FROM nucleo.sessoes WHERE token = p_token;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao IN ('chat','audio') THEN
        RETURN jsonb_build_object('saida',1,'status',200,'corpo',jsonb_build_object(
            'usuario_id', u.id, 'nome', u.nome, 'papel', u.papel,
            'chatInput', coalesce(d->>'mensagem',''),
            'sessionId', 'u' || u.id || ':' || coalesce(nullif(d->>'sessao',''),'painel'),
            'canal', coalesce(d->>'canal', CASE WHEN p_acao='audio' THEN 'voz' ELSE 'painel' END)));

    ELSIF p_acao = 'falar' THEN
        RETURN jsonb_build_object('saida',2,'status',200,'corpo',jsonb_build_object(
            'texto', left(coalesce(d->>'texto',''), 3000)));

    ELSIF p_acao = 'historico' THEN
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object('mensagens', coalesce((
            SELECT jsonb_agg(jsonb_build_object('papel', CASE WHEN m.tipo = 'human' THEN 'eu' ELSE 'ia' END,
                                                'texto', m.texto) ORDER BY m.id)
              FROM (SELECT id, message->>'type' AS tipo,
                           -- formato do n8n: {type, content}; versoes antigas: {type, data:{content}}
                           CASE WHEN jsonb_typeof(coalesce(message->'content', message->'data'->'content')) = 'string'
                                THEN coalesce(message->>'content', message->'data'->>'content') END AS texto
                      FROM nucleo_memoria_chat
                     WHERE session_id = 'u' || u.id || ':' || coalesce(nullif(d->>'sessao',''),'painel')
                     ORDER BY id DESC LIMIT 80) m
             WHERE m.tipo IN ('human','ai') AND coalesce(m.texto,'') <> ''
        ), '[]'::jsonb)));

    ELSIF p_acao = 'resumo' THEN
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object(
            'usuario', jsonb_build_object('id',u.id,'nome',u.nome,'papel',u.papel,'compartilha',u.compartilha,
                                          'telegram', u.telegram_chat_id IS NOT NULL, 'whatsapp', u.whatsapp),
            'memoria_compartilhada', nucleo.memoria_compartilhada(),
            'sistemas', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'nome',nome,'estado',estado,'url',url,'ativo',ativo,
                    'detalhe',ultimo_detalhe,'ultimo_check',ultimo_check,'caiu_em',caiu_em,
                    'origem',origem,'tipo',tipo,'tempo_ms',ultimo_tempo_ms,'painel_url',painel_url)
                    ORDER BY (estado='falha') DESC, origem, nome)
                FROM nucleo.sistemas), '[]'),
            'incidentes', coalesce((SELECT jsonb_agg(x) FROM (
                SELECT s.nome, i.inicio, i.fim FROM nucleo.incidentes i JOIN nucleo.sistemas s ON s.id=i.sistema_id
                 ORDER BY i.inicio DESC LIMIT 6) x), '[]'),
            'lembretes', coalesce((SELECT jsonb_agg(x) FROM (
                SELECT id, texto, quando, contato FROM nucleo.lembretes
                 WHERE usuario_id = u.id AND enviado_em IS NULL ORDER BY quando LIMIT 20) x), '[]'),
            'memorias', coalesce((SELECT jsonb_agg(x) FROM (
                SELECT id, titulo, conteudo, criado_em FROM nucleo.conhecimento
                 WHERE usuario_id = u.id ORDER BY criado_em DESC LIMIT 30) x), '[]'),
            'total_memorias', (SELECT count(*) FROM nucleo.conhecimento WHERE usuario_id = u.id),
            'usuarios', CASE WHEN adm THEN coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'id',x.id,'nome',x.nome,'login',x.login,'papel',x.papel,'compartilha',x.compartilha,'ativo',x.ativo,
                    'memorias',(SELECT count(*) FROM nucleo.conhecimento k WHERE k.usuario_id=x.id)) ORDER BY x.id)
                FROM nucleo.usuarios x), '[]') ELSE NULL END));

    ELSIF p_acao = 'verificar' THEN        -- roda o monitor inteiro agora (n8n)
        RETURN jsonb_build_object('saida',4,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'participar' THEN       -- qualquer um: entrar/sair da memoria compartilhada
        UPDATE nucleo.usuarios SET compartilha = (d->>'compartilha')::boolean WHERE id = u.id;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object('compartilha',(d->>'compartilha')::boolean));

    ELSIF p_acao = 'esquecer' THEN         -- apagar uma memoria propria (admin: qualquer)
        DELETE FROM nucleo.conhecimento WHERE id = (d->>'id')::bigint AND (usuario_id = u.id OR adm);
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'perfil' THEN           -- telegram/whatsapp do proprio usuario
        -- so mexe no que veio (chave ausente = nao altera; vazio = apaga)
        UPDATE nucleo.usuarios
           SET telegram_chat_id = CASE WHEN d ? 'telegram_chat_id' THEN nullif(trim(d->>'telegram_chat_id'),'') ELSE telegram_chat_id END,
               whatsapp = CASE WHEN d ? 'whatsapp' THEN nullif(regexp_replace(coalesce(d->>'whatsapp',''), '\D', '', 'g'),'') ELSE whatsapp END
         WHERE id = u.id;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_whatsapp' AND adm THEN   -- status / conectar (QR) / desconectar: o n8n fala com a Evolution
        IF d->>'op' = 'modo' AND d->>'modo' IN ('pessoal','dedicado') THEN
            INSERT INTO nucleo.config VALUES ('whatsapp_modo', to_jsonb(d->>'modo'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        RETURN jsonb_build_object('saida',3,'status',200,'corpo',jsonb_build_object(
            'config', nucleo.whatsapp_config(),
            'op', coalesce(d->>'op','status'),
            'numero', d->>'numero',
            'instancia', CASE WHEN d->>'instancia' = 'joao' THEN 'joao' ELSE 'nucleo' END,
            'desconhecidos', nucleo.whatsapp_desconhecidos()));

    ELSIF p_acao LIKE 'admin_%' AND NOT adm THEN
        RETURN jsonb_build_object('saida',0,'status',403,'corpo',jsonb_build_object('erro','Apenas o admin'));

    ELSIF p_acao = 'admin_config' THEN
        UPDATE nucleo.config SET valor = to_jsonb((d->>'memoria_compartilhada')::boolean) WHERE chave = 'memoria_compartilhada';
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object('memoria_compartilhada', nucleo.memoria_compartilhada()));

    ELSIF p_acao = 'admin_criar_usuario' THEN
        IF coalesce(d->>'login','') = '' OR length(coalesce(d->>'senha','')) < 6 THEN
            RETURN jsonb_build_object('saida',0,'status',400,'corpo',jsonb_build_object('erro','Informe login e senha (minimo 6 caracteres)'));
        END IF;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object('id',
            nucleo.salvar_usuario(coalesce(nullif(d->>'nome',''), d->>'login'), d->>'login', d->>'senha',
                                  CASE WHEN d->>'papel' = 'admin' THEN 'admin' ELSE 'usuario' END)));

    ELSIF p_acao = 'admin_ativar_usuario' THEN
        IF (d->>'id')::int = u.id THEN
            RETURN jsonb_build_object('saida',0,'status',400,'corpo',jsonb_build_object('erro','Voce nao pode desativar a si mesmo'));
        END IF;
        UPDATE nucleo.usuarios SET ativo = (d->>'ativo')::boolean WHERE id = (d->>'id')::int;
        DELETE FROM nucleo.sessoes WHERE usuario_id = (d->>'id')::int AND NOT (d->>'ativo')::boolean;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);
    END IF;

    -- ---------------------------------------------------------------- ATENDIMENTO (admin)
    IF p_acao = 'admin_atendimento' THEN
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.agente_painel((CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END)));

    ELSIF p_acao = 'admin_gabriel' THEN
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.gabriel_painel(u.id));

    ELSIF p_acao = 'admin_atendimento_config' THEN
        IF d->>'modo' IN ('desligado','observando','aprovacao','automatico') THEN
            INSERT INTO nucleo.config VALUES ((CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) || '_modo', to_jsonb(d->>'modo'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        IF d->>'alcance' IN ('selecionados','todos') THEN
            INSERT INTO nucleo.config VALUES ((CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) || '_alcance', to_jsonb(d->>'alcance'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        IF coalesce(d->>'persona', '') <> '' THEN
            INSERT INTO nucleo.config VALUES ((CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) || '_persona', to_jsonb(d->>'persona'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        IF d->>'observar' IN ('clientes','todos') THEN
            INSERT INTO nucleo.config VALUES ('atendimento_observar', to_jsonb(d->>'observar'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        IF jsonb_typeof(d->'empresa') = 'object' THEN
            IF coalesce(d->'empresa'->>'persona', '') <> '' THEN   -- o nome e de cada agente
                INSERT INTO nucleo.config VALUES ((CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) || '_persona', to_jsonb(d->'empresa'->>'persona'))
                ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
            END IF;
            INSERT INTO nucleo.config VALUES ('atendimento_empresa', (d->'empresa') - 'persona')
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.agente_config((CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END)));

    ELSIF p_acao = 'admin_base_salvar' THEN
        IF coalesce(d->>'conteudo','') = '' OR d->>'area' NOT IN ('suporte','comercial','geral') THEN
            RETURN jsonb_build_object('saida',0,'status',400,'corpo',jsonb_build_object('erro','Informe area e conteudo'));
        END IF;
        INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem)
        VALUES (NULL, d->>'area', nullif(d->>'titulo',''), d->>'conteudo', 'manual');
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_base_apagar' THEN
        DELETE FROM nucleo.conhecimento WHERE id = (d->>'id')::bigint AND usuario_id IS NULL;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_chamado_resolver' THEN
        UPDATE nucleo.chamados SET status = 'resolvido', resolvido_em = now() WHERE id = (d->>'id')::int;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_sistema_publico' THEN
        UPDATE nucleo.sistemas SET publico = (d->>'publico')::boolean WHERE id = (d->>'id')::int;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_fila_rejeitar' THEN
        UPDATE nucleo.atendimento_fila SET status = 'rejeitada', revisado_por = u.id, revisado_em = now()
         WHERE id = (d->>'id')::int AND status = 'pendente';
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_fila_aprovar' THEN   -- marca, aprende e manda o n8n enviar no WhatsApp
        DECLARE r jsonb;
        BEGIN
            r := nucleo.atendimento_aprovar((d->>'id')::int, u.id, d->>'texto', d->>'area');
            IF r IS NULL THEN
                RETURN jsonb_build_object('saida',0,'status',404,'corpo',jsonb_build_object('erro','Ja foi revisada'));
            END IF;
            RETURN jsonb_build_object('saida',5,'status',200,'corpo', r);
        END;

    ELSIF p_acao = 'admin_cliente_salvar' THEN      -- cadastra numero como cliente (passa a ser observado)
        IF length(regexp_replace(coalesce(d->>'whatsapp',''), '[^0-9]', '', 'g')) < 10 THEN
            RETURN jsonb_build_object('saida',0,'status',400,'corpo',jsonb_build_object('erro','Numero invalido'));
        END IF;
        DECLARE cli record;
        BEGIN
            cli := nucleo.cliente_por_whatsapp(d->>'whatsapp', d->>'nome');
            UPDATE nucleo.clientes SET nome = coalesce(nullif(d->>'nome',''), nome),
                   ia_responde = coalesce((d->>'ia_responde')::boolean, ia_responde)
             WHERE id = cli.id;
            RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object('id', cli.id));
        END;

    ELSIF p_acao = 'admin_cliente_ia' THEN          -- liga/desliga o agente (joao/suporte) para um cliente
        IF d->>'agente' = 'suporte' THEN
            UPDATE nucleo.clientes SET suporte_responde = (d->>'ativa')::boolean WHERE id = (d->>'id')::int;
        ELSE
            UPDATE nucleo.clientes SET ia_responde = (d->>'ativa')::boolean WHERE id = (d->>'id')::int;
        END IF;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_cliente_apagar' THEN      -- deixa de observar e apaga as conversas guardadas
        DELETE FROM nucleo.clientes WHERE id = (d->>'id')::int;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_cliente_conversa' THEN
        RETURN jsonb_build_object('saida',0,'status',200,'corpo',jsonb_build_object('mensagens', coalesce((
            SELECT jsonb_agg(jsonb_build_object('papel', v.papel, 'texto', v.mensagem, 'em', v.criado_em) ORDER BY v.criado_em)
              FROM (SELECT * FROM nucleo.conversas WHERE cliente_id = (d->>'id')::int ORDER BY criado_em DESC LIMIT 60) v), '[]'::jsonb)));

    ELSIF p_acao = 'admin_sugestao_aprovar' THEN    -- sugestao do aprendiz entra na base (pode editar)
        UPDATE nucleo.conhecimento
           SET aprovado = true, origem = 'aprendido_observando',
               dominio = CASE WHEN d->>'area' IN ('suporte','comercial','geral') THEN d->>'area' ELSE dominio END,
               titulo = coalesce(nullif(d->>'titulo',''), titulo), conteudo = coalesce(nullif(d->>'conteudo',''), conteudo)
         WHERE id = (d->>'id')::bigint AND usuario_id IS NULL AND NOT aprovado;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_sugestao_descartar' THEN
        DELETE FROM nucleo.conhecimento WHERE id = (d->>'id')::bigint AND usuario_id IS NULL AND NOT aprovado;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_aprender_agora' THEN      -- roda o aprendiz agora (n8n)
        RETURN jsonb_build_object('saida',7,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_observacao' THEN
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.observacao_painel(u.id));

    ELSIF p_acao = 'admin_gabriel_config' THEN
        IF d->>'modo' IN ('desligado','observando','aprovacao','automatico') THEN
            INSERT INTO nucleo.config VALUES ('gabriel_modo', to_jsonb(d->>'modo'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.gabriel_painel(u.id));

    ELSIF p_acao = 'admin_observacao_config' THEN   -- filtro: todos | exceto | somente
        IF d->>'agente' IN ('leo','joao','suporte') AND d->>'modo' IN ('todos','exceto','somente') THEN
            INSERT INTO nucleo.config VALUES ((d->>'agente') || '_observar', to_jsonb(d->>'modo'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.observacao_painel(u.id));

    ELSIF p_acao = 'admin_observacao_add' THEN
        IF d->>'agente' NOT IN ('leo','joao','suporte','gabriel') OR d->>'regra' NOT IN ('incluir','excluir')
           OR length(regexp_replace(coalesce(d->>'numero',''), '[^0-9]', '', 'g')) < 10 THEN
            RETURN jsonb_build_object('saida',0,'status',400,'corpo',jsonb_build_object('erro','Informe agente, regra e um numero valido'));
        END IF;
        INSERT INTO nucleo.observacao_lista (agente, numero, nome, regra)
        VALUES (d->>'agente', nucleo.so_digitos(d->>'numero'), nullif(d->>'nome',''), d->>'regra')
        ON CONFLICT (agente, numero) DO UPDATE SET nome = EXCLUDED.nome, regra = EXCLUDED.regra;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.observacao_painel(u.id));

    ELSIF p_acao = 'admin_observacao_del' THEN
        DELETE FROM nucleo.observacao_lista WHERE id = (d->>'id')::int;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo', nucleo.observacao_painel(u.id));

    ELSIF p_acao = 'admin_leo_sugestao_aprovar' THEN
        UPDATE nucleo.conhecimento SET aprovado = true, origem = 'aprendido_leo',
               titulo = coalesce(nullif(d->>'titulo',''), titulo), conteudo = coalesce(nullif(d->>'conteudo',''), conteudo)
         WHERE id = (d->>'id')::bigint AND usuario_id = u.id AND NOT aprovado;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_leo_sugestao_descartar' THEN
        DELETE FROM nucleo.conhecimento WHERE id = (d->>'id')::bigint AND usuario_id = u.id AND NOT aprovado;
        RETURN jsonb_build_object('saida',0,'status',200,'corpo','{}'::jsonb);

    ELSIF p_acao = 'admin_atendimento_teste' THEN  -- simulador: o admin finge ser um cliente
        DECLARE cli record;
        BEGIN
            cli := nucleo.cliente_por_whatsapp('teste-u' || u.id, 'Cliente de teste');
            RETURN jsonb_build_object('saida',6,'status',200,'corpo',jsonb_build_object(
                'agente', (CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END), 'cliente_id', CASE WHEN (CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) = 'gabriel' THEN NULL ELSE cli.id END,
                'nome', CASE WHEN (CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) = 'gabriel' THEN 'Amigo de teste' ELSE 'Cliente de teste' END,
                'numero', 'teste', 'chatInput', coalesce(d->>'mensagem',''),
                'sessionId', CASE WHEN (CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) = 'gabriel' THEN 'g:teste-' ELSE 'c' || cli.id || ':teste-' END
                             || (CASE WHEN d->>'agente' IN ('suporte','gabriel') THEN d->>'agente' ELSE 'joao' END) || '-' || coalesce(nullif(d->>'sessao',''), '1')));
        END;
    END IF;

    RETURN jsonb_build_object('saida',0,'status',400,'corpo',jsonb_build_object('erro','Acao desconhecida: ' || coalesce(p_acao,'')));
END $$;

-- tabela de memoria de conversa do n8n (criada pelo no; aqui garante que exista p/ a API)
CREATE TABLE IF NOT EXISTS nucleo_memoria_chat (
    id serial PRIMARY KEY,
    session_id varchar(255) NOT NULL,
    message jsonb NOT NULL
);
