-- =====================================================================
-- IA Central - ATENDIMENTO MULTIEMPRESA (Gira Kids, MachinePay, Self Machine e as proximas)
--  Um numero atende varias empresas: a IA identifica a empresa pelo assunto, consulta so a base
--  APROVADA daquela empresa (ou o catalogo da loja) e responde. Quando precisa, passa para uma pessoa.
--
--  * nucleo.empresas          cadastro de cada empresa (o que vende, como reconhecer o assunto, catalogo)
--  * nucleo.empresa_base      informacoes aprovadas por empresa, com responsavel e data
--  * nucleo.atendimentos      UMA linha por conversa: empresa atual e ESTADO
--                             automatico | aguardando_humano | humano | encerrado
--                             (versao sobe a cada mudanca de estado: resposta gerada antes nao sai)
--  * nucleo.atendimento_respostas  cada resposta gerada e o que aconteceu com ela
--
--  As garantias ficam AQUI (nao no prompt):
--   - conferir imediatamente antes de enviar: estado, versao, mensagem mais nova do cliente, janela de 24h
--   - quem respondeu pelo celular assume a conversa (a IA para nela)
--   - chave geral: multi_modo = desligado | observando | aprovacao | automatico
--  Comeca DESLIGADO. O numero que atende e escolhido em whatsapp_instancias (papel 'multi').
--  Idempotente.
-- =====================================================================

INSERT INTO nucleo.config VALUES ('multi_modo', '"desligado"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('multi_janela_horas', '24') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('multi_dono_nome', '"Leonardo"') ON CONFLICT DO NOTHING;
-- conversa com uma pessoa volta para a IA quando a equipe fica este tempo sem escrever nela
-- e o cliente manda mensagem nova
INSERT INTO nucleo.config VALUES ('multi_humano_minutos', '30') ON CONFLICT DO NOTHING;
-- quem a IA responde: 'selecionados' (so os contatos escolhidos no painel, lista nucleo.responde_para agente 'multi') | 'todos'
-- os outros continuam aparecendo no painel (a conversa fica guardada), so a IA nao responde
INSERT INTO nucleo.config VALUES ('multi_alcance', '"selecionados"') ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- empresas
CREATE TABLE IF NOT EXISTS nucleo.empresas (
    id            serial PRIMARY KEY,
    slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
    nome          text NOT NULL,
    descricao     text NOT NULL DEFAULT '',     -- o que a empresa faz/vende (a IA le isto)
    assuntos      text NOT NULL DEFAULT '',     -- sinais de que a conversa e desta empresa (exemplos, produtos, termos)
    site          text,
    catalogo_url  text,                         -- API de consulta (ex.: https://girakids.com/api/atendimento); vazio = sem catalogo
    catalogo_env  text,                         -- NOME da variavel de ambiente do n8n com o token (o token nunca fica no banco)
    tom           text,
    responsavel   text,
    ativo         boolean NOT NULL DEFAULT true,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO nucleo.empresas (slug, nome, descricao, assuntos, site) VALUES
 ('girakids', 'Gira Kids', 'Loja (girakids.com). REVISAR: descreva o que a loja vende e para quem.',
  'pelucias, brinquedos, produtos da loja, preco de produto, disponibilidade, compra pelo site', 'https://girakids.com'),
 ('machinepay', 'MachinePay', 'REVISAR: pagamento (ex.: Pix) para maquinas como gruas. Descreva produtos e planos.',
  'receber Pix na maquina, grua, maquina de pelucia, pagamento na maquina, leitor, configuracao do pagamento', NULL),
 ('selfmachine', 'Self Machine', 'REVISAR: sistemas e solucoes sob medida. Descreva o que oferece.',
  'sistema para empresa, clinica, software, automacao, proposta, orcamento de sistema', NULL)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------- base aprovada por empresa
CREATE TABLE IF NOT EXISTS nucleo.empresa_base (
    id            serial PRIMARY KEY,
    empresa_id    int NOT NULL REFERENCES nucleo.empresas(id) ON DELETE CASCADE,
    tipo          text NOT NULL DEFAULT 'faq' CHECK (tipo IN ('produto', 'politica', 'faq', 'procedimento', 'contato')),
    titulo        text NOT NULL,
    conteudo      text NOT NULL,
    responsavel   text,
    ativo         boolean NOT NULL DEFAULT true,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS empresa_base_empresa ON nucleo.empresa_base (empresa_id) WHERE ativo;

-- mesma busca da base dos agentes: qualquer palavra, sem acento; so a empresa pedida
CREATE OR REPLACE FUNCTION nucleo.empresa_buscar(p_empresa text, p_busca text)
RETURNS TABLE (tipo text, titulo text, conteudo text, atualizado text, relevante boolean)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('portuguese',
               unaccent(regexp_replace(coalesce(p_busca, ''), '[;,|[:space:]]+', ' or ', 'g'))) AS tsq
    ), c AS (
        SELECT b.tipo, b.titulo, b.conteudo, b.atualizado_em,
               to_tsvector('portuguese', unaccent(b.titulo || ' ' || b.conteudo)) AS doc
          FROM nucleo.empresa_base b JOIN nucleo.empresas e ON e.id = b.empresa_id
         WHERE b.ativo AND e.ativo AND e.slug = lower(trim(p_empresa))
    )
    SELECT c.tipo, c.titulo, c.conteudo, to_char(c.atualizado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY'), c.doc @@ q.tsq
      FROM c, q
     ORDER BY c.doc @@ q.tsq DESC, ts_rank(c.doc, q.tsq) DESC, c.atualizado_em DESC
     LIMIT 8
$$;

-- ---------------------------------------------------------------- estado de cada conversa
CREATE TABLE IF NOT EXISTS nucleo.atendimentos (
    id                 serial PRIMARY KEY,
    instancia          text NOT NULL,             -- numero/canal que atende ('simulador' no teste do painel)
    contato            text NOT NULL,             -- numero do cliente (so digitos; 'teste-N' no simulador)
    nome               text,
    cliente_id         int REFERENCES nucleo.clientes(id) ON DELETE SET NULL,
    empresa_id         int REFERENCES nucleo.empresas(id) ON DELETE SET NULL,
    estado             text NOT NULL DEFAULT 'automatico'
                       CHECK (estado IN ('automatico', 'aguardando_humano', 'humano', 'encerrado')),
    versao             int NOT NULL DEFAULT 1,
    conduzido_por      int REFERENCES nucleo.usuarios(id) ON DELETE SET NULL,
    motivo             text,                      -- por que esta no estado atual (transferencia, assumiu...)
    resumo             text,                      -- resumo do problema para quem assume
    encaminhado_em     timestamptz,
    ultima_cliente_em  timestamptz,               -- janela de 24h do WhatsApp
    ultima_resposta_em timestamptz,
    criado_em          timestamptz NOT NULL DEFAULT now(),
    atualizado_em      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (instancia, contato)
);
-- quando entrou no estado atual (para devolver a IA depois de X horas sem a equipe escrever)
ALTER TABLE nucleo.atendimentos ADD COLUMN IF NOT EXISTS estado_desde timestamptz;
UPDATE nucleo.atendimentos SET estado_desde = atualizado_em WHERE estado_desde IS NULL;
-- por que a IA NAO respondeu a ultima mensagem do cliente (vazio = respondeu/foi gerar). Aparece no painel.
ALTER TABLE nucleo.atendimentos ADD COLUMN IF NOT EXISTS sem_resposta text;

CREATE TABLE IF NOT EXISTS nucleo.atendimento_respostas (
    id             bigserial PRIMARY KEY,
    atendimento_id int NOT NULL REFERENCES nucleo.atendimentos(id) ON DELETE CASCADE,
    versao         int NOT NULL,                  -- versao do atendimento quando comecou a gerar
    ate_conversa   bigint NOT NULL DEFAULT 0,     -- ultima mensagem do cliente que esta resposta leu
    pergunta       text,
    texto          text,
    status         text NOT NULL DEFAULT 'gerando'
                   CHECK (status IN ('gerando', 'pendente', 'aprovada', 'enviada', 'descartada', 'falhou')),
    motivo         text,
    revisado_por   int REFERENCES nucleo.usuarios(id) ON DELETE SET NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    decidido_em    timestamptz
);
CREATE INDEX IF NOT EXISTS atendimento_respostas_pendentes ON nucleo.atendimento_respostas (criado_em) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS conversas_multi ON nucleo.conversas (instancia, contato, id) WHERE agente = 'multi';

CREATE OR REPLACE FUNCTION nucleo.multi_modo() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nucleo.cfg('multi_modo', 'desligado') $$;

-- este contato esta na lista de quem a IA responde?
CREATE OR REPLACE FUNCTION nucleo.multi_liberado(p_numero text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM nucleo.responde_para r WHERE r.agente = 'multi'
                    AND nucleo.variantes_numero(r.numero) && nucleo.variantes_numero(p_numero))
$$;

CREATE OR REPLACE FUNCTION nucleo.multi_avisar() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT jsonb_agg(whatsapp) FROM nucleo.usuarios WHERE papel = 'admin' AND ativo AND whatsapp IS NOT NULL), '[]')
$$;

-- muda o estado (sobe a versao: qualquer resposta gerada antes deixa de poder sair)
CREATE OR REPLACE FUNCTION nucleo.multi_mudar_estado(p_at int, p_estado text, p_usuario int, p_motivo text)
RETURNS nucleo.atendimentos LANGUAGE plpgsql AS $$
DECLARE a nucleo.atendimentos%ROWTYPE;
BEGIN
    IF p_estado NOT IN ('automatico', 'aguardando_humano', 'humano', 'encerrado') THEN
        RAISE EXCEPTION 'estado invalido: %', p_estado;
    END IF;
    UPDATE nucleo.atendimentos
       SET estado = p_estado, versao = versao + 1, motivo = p_motivo, atualizado_em = now(), estado_desde = now(),
           conduzido_por = CASE WHEN p_estado = 'humano' THEN p_usuario WHEN p_estado = 'automatico' THEN NULL ELSE conduzido_por END,
           encaminhado_em = CASE WHEN p_estado = 'aguardando_humano' THEN now() WHEN p_estado = 'automatico' THEN NULL ELSE encaminhado_em END
     WHERE id = p_at RETURNING * INTO a;
    IF NOT FOUND THEN RAISE EXCEPTION 'atendimento % nao existe', p_at; END IF;
    -- pessoa assumiu ou encerrou: o que estava gerando ou esperando aprovacao nao sai mais
    IF p_estado IN ('humano', 'encerrado') THEN
        UPDATE nucleo.atendimento_respostas SET status = 'descartada', decidido_em = now(),
               motivo = 'atendimento passou para ' || p_estado
         WHERE atendimento_id = p_at AND status IN ('gerando', 'pendente', 'aprovada');
    END IF;
    RETURN a;
END $$;

-- ---------------------------------------------------------------- entrada de mensagem (numero com papel 'multi')
CREATE OR REPLACE FUNCTION nucleo.multi_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text, p_de_mim boolean, p_msg_id text, p_instancia text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    modo    text := nucleo.multi_modo();
    teste   boolean := p_numero LIKE 'teste%';
    num     text := CASE WHEN p_numero LIKE 'teste%' THEN p_numero ELSE nucleo.so_digitos(p_numero) END;
    msg     text := coalesce(nullif(p_texto, ''), '[' || coalesce(p_tipo, 'mensagem') || ']');
    a       nucleo.atendimentos%ROWTYPE;
    c       nucleo.clientes%ROWTYPE;
    auto    boolean;
BEGIN
    IF modo = 'desligado' THEN RETURN jsonb_build_object('saida', 0, 'motivo', 'atendimento multiempresa desligado'); END IF;

    -- a propria IA voltando pelo webhook nao e uma pessoa respondendo
    IF p_de_mim AND p_msg_id IS NOT NULL AND EXISTS (SELECT 1 FROM nucleo.whatsapp_enviadas WHERE id = p_msg_id) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    SELECT * INTO a FROM nucleo.atendimentos WHERE instancia = p_instancia AND contato = num;
    IF NOT FOUND THEN
        IF p_de_mim THEN   -- conversa que a IA nunca atendeu: e conversa da pessoa, nao mexe
            RETURN jsonb_build_object('saida', 0, 'motivo', 'conversa sem atendimento');
        END IF;
        c := nucleo.cliente_por_whatsapp(num, p_nome);
        INSERT INTO nucleo.atendimentos (instancia, contato, nome, cliente_id)
        VALUES (p_instancia, num, nullif(p_nome, ''), c.id)
        ON CONFLICT (instancia, contato) DO UPDATE SET atualizado_em = now()
        RETURNING * INTO a;
    END IF;

    IF p_de_mim AND EXISTS (SELECT 1 FROM nucleo.conversas
         WHERE agente = 'multi' AND instancia = p_instancia AND contato = num
           -- 'humano' recente = enviada pelo painel ("responder"): o eco do WhatsApp nao duplica
           AND (papel = 'ia' OR (papel = 'humano' AND criado_em > now() - interval '2 minutes'))
           AND criado_em > now() - interval '10 minutes'
           AND regexp_replace(mensagem, '[*_~\s⁣]', '', 'g') = regexp_replace(msg, '[*_~\s⁣]', '', 'g')) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'mensagem da propria IA');
    END IF;

    IF p_de_mim THEN
        auto := NOT teste AND nucleo.parece_automatica(p_instancia, msg);
        INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
        VALUES ('whatsapp', num, 'multi', CASE WHEN auto THEN 'automatica' ELSE 'humano' END, msg, a.cliente_id, p_instancia);
        -- uma pessoa respondeu pelo celular: ela assume, a IA para nesta conversa
        IF NOT auto AND a.estado IN ('automatico', 'aguardando_humano') THEN
            PERFORM nucleo.multi_mudar_estado(a.id, 'humano', NULL, 'respondeu pelo celular');
            RETURN jsonb_build_object('saida', 0, 'motivo', 'pessoa respondeu: conversa passou para humano');
        END IF;
        RETURN jsonb_build_object('saida', 0, 'motivo', 'resposta da equipe registrada');
    END IF;

    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
    VALUES ('whatsapp', num, 'multi', 'usuario', msg, a.cliente_id, p_instancia);
    UPDATE nucleo.atendimentos SET ultima_cliente_em = now(), atualizado_em = now(),
           nome = coalesce(nome, nullif(p_nome, ''))
     WHERE id = a.id RETURNING * INTO a;
    UPDATE nucleo.clientes SET ultimo_contato = now() WHERE id = a.cliente_id;

    IF a.estado = 'encerrado' THEN   -- cliente voltou: novo atendimento automatico
        a := nucleo.multi_mudar_estado(a.id, 'automatico', NULL, 'cliente voltou a escrever');
    END IF;
    -- com uma pessoa, mas a equipe nao escreve nesta conversa ha X minutos (desde que assumiu): volta para a IA
    IF a.estado = 'humano' AND greatest(
           coalesce(a.estado_desde, a.atualizado_em),
           coalesce((SELECT max(criado_em) FROM nucleo.conversas WHERE agente = 'multi' AND instancia = p_instancia
                      AND contato = num AND papel = 'humano'), '-infinity'::timestamptz))
       < now() - make_interval(mins => coalesce(nullif(nucleo.cfg('multi_humano_minutos', '30'), '')::int, 30)) THEN
        a := nucleo.multi_mudar_estado(a.id, 'automatico', NULL,
                 'equipe sem responder ha ' || nucleo.cfg('multi_humano_minutos', '30') || ' min: voltou para a IA');
    END IF;
    IF a.estado = 'humano' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'uma pessoa esta conduzindo esta conversa');
    END IF;
    IF a.estado = 'aguardando_humano' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'aguardando uma pessoa (ja foi encaminhado)');
    END IF;
    IF modo = 'observando' THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'observando (nao responde)');
    END IF;
    -- so os contatos escolhidos (o teste do painel sempre passa)
    IF NOT teste AND nucleo.cfg('multi_alcance', 'selecionados') <> 'todos' AND NOT nucleo.multi_liberado(num) THEN
        RETURN jsonb_build_object('saida', 0, 'motivo', 'contato nao esta na lista da IA (so guarda)');
    END IF;
    RETURN jsonb_build_object('saida', 3, 'agente', 'multi', 'atendimento_id', a.id, 'cliente_id', a.cliente_id,
        'nome', coalesce(a.nome, nullif(p_nome, ''), 'cliente'), 'numero', num, 'texto', p_texto,
        'sessionId', 'm' || a.id);
END $$;

-- canal WhatsApp: o numero com papel 'multi' vai para o atendimento multiempresa (a conversa "Voce" continua com o Leo)
CREATE OR REPLACE FUNCTION nucleo.canal_entrada(
    p_numero text, p_nome text, p_texto text, p_tipo text,
    p_de_mim boolean, p_conversa_propria boolean, p_msg_id text, p_instancia text, p_dono text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
    IF nucleo.papel_instancia(p_instancia) = 'multi' AND NOT coalesce(p_conversa_propria, false) THEN
        r := nucleo.multi_entrada(p_numero, p_nome, p_texto, p_tipo, p_de_mim, p_msg_id, p_instancia);
        -- mensagem do cliente: guarda por que a IA nao respondeu (o painel mostra; some quando ela responde)
        IF NOT p_de_mim THEN
            UPDATE nucleo.atendimentos SET sem_resposta = CASE WHEN (r->>'saida')::int = 0 THEN r->>'motivo' END
             WHERE instancia = p_instancia AND contato = nucleo.so_digitos(p_numero);
        END IF;
        RETURN r || jsonb_build_object('instancia', p_instancia);
    END IF;
    RETURN nucleo.whatsapp_entrada(p_numero, p_nome, p_texto, p_tipo, p_de_mim, p_conversa_propria, p_msg_id, p_instancia, p_dono);
END $$;

CREATE OR REPLACE FUNCTION nucleo.canal_vai_ler(p_instancia text, p_numero text, p_de_mim boolean, p_propria boolean)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN nucleo.papel_instancia(p_instancia) = 'multi' AND NOT coalesce(p_propria, false)
                -- audio da equipe numa conversa que a IA atende tambem e transcrito: e com ele que a IA aprende
                THEN nucleo.multi_modo() <> 'desligado'
                     AND (NOT p_de_mim OR EXISTS (SELECT 1 FROM nucleo.atendimentos
                                                   WHERE instancia = p_instancia AND contato = nucleo.so_digitos(p_numero)))
                ELSE nucleo.whatsapp_vai_ler(p_instancia, p_numero, p_de_mim, p_propria) END
$$;

-- ---------------------------------------------------------------- antes de gerar: contexto + "ficha" da resposta
CREATE OR REPLACE FUNCTION nucleo.multi_iniciar(p_at int, p_pergunta text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    a   nucleo.atendimentos%ROWTYPE;
    rid bigint;
    ult bigint;
BEGIN
    SELECT * INTO a FROM nucleo.atendimentos WHERE id = p_at;
    IF NOT FOUND THEN RAISE EXCEPTION 'atendimento % nao existe', p_at; END IF;
    SELECT coalesce(max(id), 0) INTO ult FROM nucleo.conversas
     WHERE agente = 'multi' AND instancia = a.instancia AND contato = a.contato AND papel = 'usuario';
    INSERT INTO nucleo.atendimento_respostas (atendimento_id, versao, ate_conversa, pergunta)
    VALUES (a.id, a.versao, ult, p_pergunta) RETURNING id INTO rid;
    RETURN jsonb_build_object(
        'resposta_id', rid,
        'atendimento_id', a.id,
        'estado', a.estado,
        'dono', nucleo.cfg('multi_dono_nome', 'Leonardo'),
        'empresa_atual', (SELECT slug FROM nucleo.empresas WHERE id = a.empresa_id),
        'empresas', coalesce((SELECT string_agg(
                 '- ' || slug || ' = ' || nome || ': ' || descricao
                 || CASE WHEN assuntos <> '' THEN E'\n  Assuntos: ' || assuntos ELSE '' END
                 || CASE WHEN site IS NOT NULL THEN E'\n  Site: ' || site ELSE '' END
                 || CASE WHEN catalogo_url IS NOT NULL THEN E'\n  Tem catalogo (buscar_produtos/consultar_produto).' ELSE E'\n  Sem catalogo conectado (nao informe preco nem estoque).' END
                 || CASE WHEN tom IS NOT NULL THEN E'\n  Tom: ' || tom ELSE '' END,
                 E'\n' ORDER BY nome) FROM nucleo.empresas WHERE ativo), '(nenhuma empresa cadastrada)'),
        -- historico real da conversa ATE a ultima resposta (inclui o que a equipe respondeu pelo celular);
        -- as mensagens do cliente depois dela sao a pergunta atual (chegam juntas no lote)
        'historico', coalesce((SELECT string_agg(CASE v.papel WHEN 'usuario' THEN 'CLIENTE' WHEN 'ia' THEN 'VOCE (IA)'
                                                   WHEN 'humano' THEN 'EQUIPE' ELSE 'MENSAGEM AUTOMATICA' END
                                              || ' (' || to_char(v.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || '): '
                                              || v.mensagem, E'\n' ORDER BY v.id)
                                 FROM (SELECT * FROM nucleo.conversas
                                        WHERE agente = 'multi' AND instancia = a.instancia AND contato = a.contato
                                          AND id <= coalesce((SELECT max(id) FROM nucleo.conversas WHERE agente = 'multi'
                                                    AND instancia = a.instancia AND contato = a.contato AND papel <> 'usuario'), 0)
                                        ORDER BY id DESC LIMIT 30) v), ''),
        'cliente', coalesce(a.nome, 'cliente'));
END $$;

-- a IA mudou de assunto/empresa
CREATE OR REPLACE FUNCTION nucleo.multi_definir_empresa(p_at int, p_slug text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE e nucleo.empresas%ROWTYPE;
BEGIN
    SELECT * INTO e FROM nucleo.empresas WHERE slug = lower(trim(p_slug)) AND ativo;
    IF NOT FOUND THEN
        RETURN 'Empresa "' || coalesce(p_slug, '') || '" nao existe. Use uma destas: '
               || (SELECT string_agg(slug, ', ' ORDER BY slug) FROM nucleo.empresas WHERE ativo);
    END IF;
    UPDATE nucleo.atendimentos SET empresa_id = e.id, atualizado_em = now() WHERE id = p_at;
    RETURN 'Conversa agora e sobre ' || e.nome || '. Consulte a base dela antes de afirmar algo.';
END $$;

-- a IA passa para uma pessoa (a resposta que esta gerando agora ainda pode sair: "vou chamar o Leonardo")
CREATE OR REPLACE FUNCTION nucleo.multi_encaminhar(p_at int, p_motivo text, p_resumo text, p_prioridade text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE a nucleo.atendimentos%ROWTYPE; cid int;
BEGIN
    SELECT * INTO a FROM nucleo.atendimentos WHERE id = p_at;
    IF a.estado IN ('humano', 'aguardando_humano') THEN RETURN 'Ja esta com a equipe.'; END IF;
    a := nucleo.multi_mudar_estado(p_at, 'aguardando_humano', NULL, coalesce(nullif(p_motivo, ''), 'pedido de atendimento humano'));
    UPDATE nucleo.atendimentos SET resumo = nullif(p_resumo, '') WHERE id = p_at;
    -- a resposta desta mesma rodada continua valida (avisa o cliente que vai passar)
    UPDATE nucleo.atendimento_respostas SET versao = a.versao WHERE atendimento_id = p_at AND status = 'gerando';
    INSERT INTO nucleo.chamados (cliente_id, area, titulo, descricao, prioridade)
    VALUES (a.cliente_id, 'humano',
            left(coalesce((SELECT nome || ': ' FROM nucleo.empresas WHERE id = a.empresa_id), '') || coalesce(nullif(p_motivo, ''), 'Atendimento humano'), 120),
            p_resumo, CASE WHEN p_prioridade IN ('baixa', 'normal', 'alta') THEN p_prioridade ELSE 'normal' END)
    RETURNING id INTO cid;
    RETURN 'Encaminhado para a equipe (chamado #' || cid || '). Diga ao cliente, em poucas palavras, que alguem da equipe vai continuar.';
END $$;

-- ---------------------------------------------------------------- conferencia IMEDIATAMENTE antes de enviar
-- p_aprovada: resposta aprovada no painel (quem aprovou ja viu a conversa: nao exige ser a mais nova)
CREATE OR REPLACE FUNCTION nucleo.multi_conferir_envio(p_resposta bigint, p_aprovada boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    r      nucleo.atendimento_respostas%ROWTYPE;
    a      nucleo.atendimentos%ROWTYPE;
    janela int := coalesce(nullif(nucleo.cfg('multi_janela_horas', '24'), '')::int, 24);
    v_motivo text;
BEGIN
    SELECT * INTO r FROM nucleo.atendimento_respostas WHERE id = p_resposta FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('enviar', false, 'motivo', 'resposta nao existe'); END IF;
    SELECT * INTO a FROM nucleo.atendimentos WHERE id = r.atendimento_id FOR UPDATE;

    v_motivo := CASE
        WHEN r.status NOT IN ('gerando', 'aprovada') THEN 'resposta ja ' || r.status
        WHEN nucleo.multi_modo() = 'desligado' THEN 'atendimento desligado'
        WHEN a.estado NOT IN ('automatico', 'aguardando_humano') THEN 'conversa esta com ' || a.estado
        WHEN r.versao <> a.versao AND NOT p_aprovada THEN 'estado da conversa mudou durante a geracao'
        WHEN NOT p_aprovada AND EXISTS (SELECT 1 FROM nucleo.conversas WHERE agente = 'multi' AND instancia = a.instancia
                AND contato = a.contato AND papel = 'usuario' AND id > r.ate_conversa) THEN 'cliente mandou mensagem mais nova (outra resposta cuida)'
        WHEN NOT p_aprovada AND EXISTS (SELECT 1 FROM nucleo.conversas WHERE agente = 'multi' AND instancia = a.instancia
                AND contato = a.contato AND papel = 'humano' AND criado_em > r.criado_em) THEN 'a equipe respondeu durante a geracao'
        WHEN a.ultima_cliente_em IS NULL OR a.ultima_cliente_em < now() - make_interval(hours => janela)
             THEN 'fora da janela de ' || janela || 'h (precisa de modelo aprovado)'
        WHEN coalesce(trim(r.texto), '') = '' THEN 'resposta vazia'
    END;
    IF v_motivo IS NOT NULL THEN
        UPDATE nucleo.atendimento_respostas SET status = CASE WHEN status IN ('gerando', 'aprovada') THEN 'descartada' ELSE status END,
               motivo = coalesce(nucleo.atendimento_respostas.motivo, v_motivo), decidido_em = coalesce(decidido_em, now())
         WHERE id = r.id;
        RETURN jsonb_build_object('enviar', false, 'motivo', v_motivo);
    END IF;

    UPDATE nucleo.atendimento_respostas SET status = 'enviada', decidido_em = now() WHERE id = r.id;
    INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
    VALUES ('whatsapp', a.contato, 'multi', 'ia', r.texto, a.cliente_id, a.instancia);
    UPDATE nucleo.atendimentos SET ultima_resposta_em = now() WHERE id = a.id;
    RETURN jsonb_build_object('enviar', true, 'numero', a.contato, 'instancia', a.instancia, 'texto', r.texto,
                              'teste', a.instancia = 'simulador' OR a.contato LIKE 'teste%');
END $$;

-- depois da IA: guarda o texto e decide (enviar agora | fila de aprovacao | nada)
CREATE OR REPLACE FUNCTION nucleo.multi_registrar(p_resposta bigint, p_texto text, p_erro text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    r    nucleo.atendimento_respostas%ROWTYPE;
    a    nucleo.atendimentos%ROWTYPE;
    t    text := trim(coalesce(p_texto, ''));
    res  jsonb;
    enc  jsonb := 'null';
BEGIN
    SELECT * INTO r FROM nucleo.atendimento_respostas WHERE id = p_resposta;
    SELECT * INTO a FROM nucleo.atendimentos WHERE id = r.atendimento_id;
    IF a.encaminhado_em IS NOT NULL AND a.encaminhado_em >= r.criado_em THEN   -- esta rodada encaminhou: avisa a equipe
        enc := jsonb_build_object('avisar', nucleo.multi_avisar(), 'texto',
            '🙋 ' || coalesce(a.nome, a.contato) || CASE WHEN a.contato LIKE 'teste%' THEN '' ELSE ' (+' || a.contato || ')' END
            || coalesce(' · ' || (SELECT nome FROM nucleo.empresas WHERE id = a.empresa_id), '')
            || E' precisa de uma pessoa.\nMotivo: ' || coalesce(a.motivo, '-') || coalesce(E'\nResumo: ' || a.resumo, '')
            || E'\nAssuma no painel → Atendimento multiempresa (ou responda pelo celular).');
    END IF;

    IF t = '' THEN
        UPDATE nucleo.atendimento_respostas SET status = 'falhou', motivo = left(coalesce(p_erro, 'a IA nao devolveu resposta'), 500),
               decidido_em = now() WHERE id = r.id;
        PERFORM nucleo.registrar_evento('multi', 'erro', 'Atendimento multiempresa nao respondeu ' || coalesce(a.nome, a.contato),
                                        coalesce(p_erro, 'a IA nao devolveu resposta'), jsonb_build_object('atendimento_id', a.id));
        RETURN jsonb_build_object('enviar', false, 'motivo', 'falhou: ' || coalesce(p_erro, 'sem resposta'), 'encaminhado', enc);
    END IF;
    IF position('[NAO_RESPONDER]' IN t) > 0 THEN
        UPDATE nucleo.atendimento_respostas SET status = 'descartada', texto = t, motivo = 'IA decidiu nao responder', decidido_em = now() WHERE id = r.id;
        RETURN jsonb_build_object('enviar', false, 'motivo', 'IA decidiu nao responder', 'encaminhado', enc);
    END IF;

    UPDATE nucleo.atendimento_respostas SET texto = t WHERE id = r.id;
    IF nucleo.multi_modo() = 'aprovacao' THEN
        UPDATE nucleo.atendimento_respostas SET status = 'pendente' WHERE id = r.id AND status = 'gerando';
        RETURN jsonb_build_object('enviar', false, 'pendente', true, 'texto', t, 'motivo', 'aguardando aprovacao',
            'avisar', nucleo.multi_avisar(), 'encaminhado', enc,
            'aviso', '📥 Resposta para ' || coalesce(a.nome, a.contato) || ' esperando sua aprovacao no painel (Atendimento multiempresa).');
    END IF;
    res := nucleo.multi_conferir_envio(r.id, false);
    RETURN res || jsonb_build_object('encaminhado', enc);
END $$;

CREATE OR REPLACE FUNCTION nucleo.multi_envio_falhou(p_resposta bigint, p_erro text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r nucleo.atendimento_respostas%ROWTYPE;
BEGIN
    UPDATE nucleo.atendimento_respostas SET status = 'falhou', motivo = left('envio: ' || coalesce(p_erro, '?'), 500)
     WHERE id = p_resposta RETURNING * INTO r;
    -- a mensagem nao chegou: tira do historico
    DELETE FROM nucleo.conversas WHERE id = (SELECT max(v.id) FROM nucleo.conversas v JOIN nucleo.atendimentos a
         ON a.instancia = v.instancia AND a.contato = v.contato WHERE a.id = r.atendimento_id AND v.agente = 'multi' AND v.papel = 'ia'
           AND v.mensagem = r.texto);
    PERFORM nucleo.registrar_evento('multi', 'aviso', 'Nao consegui entregar a resposta no WhatsApp', p_erro,
                                    jsonb_build_object('resposta_id', p_resposta));
END $$;

-- ---------------------------------------------------------------- painel
CREATE OR REPLACE FUNCTION nucleo.multi_painel() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo', nucleo.multi_modo(),
        'janela_horas', nucleo.cfg('multi_janela_horas', '24')::int,
        'dono', nucleo.cfg('multi_dono_nome', 'Leonardo'),
        'alcance', nucleo.cfg('multi_alcance', 'selecionados'),
        'liberados', (SELECT count(*) FROM nucleo.responde_para WHERE agente = 'multi'),
        'aprendidos_24h', (SELECT count(*) FROM nucleo.empresa_base WHERE ativo AND responsavel LIKE 'Aprendiz%'
                              AND atualizado_em > now() - interval '24 hours'),
        'respostas_ia_24h', (SELECT count(*) FROM nucleo.atendimento_respostas WHERE status = 'enviada'
                                AND decidido_em > now() - interval '24 hours'),
        'instancias', coalesce((SELECT jsonb_agg(k ORDER BY k) FROM nucleo.config, jsonb_each_text(valor) e(k, v)
                                 WHERE chave = 'whatsapp_instancias' AND v = 'multi'), '[]'),
        'empresas', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'id', e.id, 'slug', e.slug, 'nome', e.nome, 'descricao', e.descricao, 'assuntos', e.assuntos,
                'site', e.site, 'catalogo_url', e.catalogo_url, 'catalogo_env', e.catalogo_env, 'tom', e.tom,
                'responsavel', e.responsavel, 'ativo', e.ativo, 'atualizado_em', e.atualizado_em,
                'base', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'tipo', b.tipo, 'titulo', b.titulo,
                          'conteudo', b.conteudo, 'responsavel', b.responsavel, 'atualizado_em', b.atualizado_em)
                          ORDER BY b.tipo, b.titulo) FROM nucleo.empresa_base b WHERE b.empresa_id = e.id AND b.ativo), '[]'))
                ORDER BY e.nome) FROM nucleo.empresas e), '[]'),
        'atendimentos', coalesce((SELECT jsonb_agg(x ORDER BY x.ordem, x.atualizado_em DESC) FROM (
            SELECT a.id, a.instancia, a.contato, a.nome, a.estado, a.motivo, a.resumo, a.atualizado_em, a.sem_resposta,
                   a.ultima_cliente_em, em.nome AS empresa, u.nome AS conduzido_por,
                   (a.instancia = 'simulador' OR nucleo.multi_liberado(a.contato)) AS liberado,
                   CASE a.estado WHEN 'aguardando_humano' THEN 0 WHEN 'humano' THEN 1 WHEN 'automatico' THEN 2 ELSE 3 END AS ordem,
                   (SELECT left(v.mensagem, 140) FROM nucleo.conversas v WHERE v.agente = 'multi' AND v.instancia = a.instancia
                       AND v.contato = a.contato ORDER BY v.id DESC LIMIT 1) AS ultima_mensagem,
                   (SELECT count(*) FROM nucleo.atendimento_respostas r WHERE r.atendimento_id = a.id AND r.status = 'pendente') AS pendentes
              FROM nucleo.atendimentos a
              LEFT JOIN nucleo.empresas em ON em.id = a.empresa_id
              LEFT JOIN nucleo.usuarios u ON u.id = a.conduzido_por
             ORDER BY a.atualizado_em DESC LIMIT 60) x), '[]'),
        'fila', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
            SELECT r.id, r.atendimento_id, r.pergunta, r.texto, r.criado_em, a.nome, a.contato, em.nome AS empresa
              FROM nucleo.atendimento_respostas r JOIN nucleo.atendimentos a ON a.id = r.atendimento_id
              LEFT JOIN nucleo.empresas em ON em.id = a.empresa_id
             WHERE r.status = 'pendente' ORDER BY r.criado_em LIMIT 40) x), '[]'))
$$;

CREATE OR REPLACE FUNCTION nucleo.multi_conversa(p_at int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'atendimento', (SELECT to_jsonb(a) || jsonb_build_object('empresa', em.nome, 'conduzido_por_nome', u.nome)
                          FROM nucleo.atendimentos a LEFT JOIN nucleo.empresas em ON em.id = a.empresa_id
                          LEFT JOIN nucleo.usuarios u ON u.id = a.conduzido_por WHERE a.id = p_at),
        'mensagens', coalesce((SELECT jsonb_agg(jsonb_build_object('papel', v.papel, 'texto', v.mensagem, 'em', v.criado_em) ORDER BY v.id)
              FROM (SELECT v.* FROM nucleo.conversas v JOIN nucleo.atendimentos a ON a.instancia = v.instancia AND a.contato = v.contato
                     WHERE a.id = p_at AND v.agente = 'multi' ORDER BY v.id DESC LIMIT 100) v), '[]'),
        'respostas', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'texto', r.texto, 'motivo', r.motivo,
                                   'em', r.criado_em) ORDER BY r.id DESC)
              FROM (SELECT * FROM nucleo.atendimento_respostas WHERE atendimento_id = p_at ORDER BY id DESC LIMIT 20) r), '[]'))
$$;

-- acoes do painel (so admin). Devolve o mesmo formato de nucleo.api: { saida, status, corpo }
CREATE OR REPLACE FUNCTION nucleo.api_multi(p_usuario int, p_acao text, d jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    eid int;
    a   nucleo.atendimentos%ROWTYPE;
    r   jsonb;
    ok  jsonb := jsonb_build_object('saida', 0, 'status', 200, 'corpo', '{}'::jsonb);
BEGIN
    PERFORM nucleo.exigir_admin(p_usuario);

    IF p_acao = 'admin_multi' THEN
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_conversa' THEN
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_conversa((d->>'id')::int));

    ELSIF p_acao = 'admin_multi_config' THEN
        IF d->>'modo' IN ('desligado', 'observando', 'aprovacao', 'automatico') THEN
            INSERT INTO nucleo.config VALUES ('multi_modo', to_jsonb(d->>'modo'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        IF d->>'alcance' IN ('selecionados', 'todos') THEN
            INSERT INTO nucleo.config VALUES ('multi_alcance', to_jsonb(d->>'alcance'))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        IF coalesce(d->>'dono', '') <> '' THEN
            INSERT INTO nucleo.config VALUES ('multi_dono_nome', to_jsonb(left(d->>'dono', 60)))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        -- numero que atende: a instancia passa a ter papel 'multi' (volta para 'leo' se tirar)
        IF d ? 'instancia' THEN
            UPDATE nucleo.config SET valor = (SELECT coalesce(jsonb_object_agg(k, CASE WHEN v = 'multi' THEN 'leo' ELSE v END), '{}')
                                                FROM jsonb_each_text(valor) e(k, v))
             WHERE chave = 'whatsapp_instancias';
            IF coalesce(d->>'instancia', '') <> '' THEN
                UPDATE nucleo.config SET valor = valor || jsonb_build_object(d->>'instancia', 'multi') WHERE chave = 'whatsapp_instancias';
            END IF;
        END IF;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_liberar' THEN   -- poe/tira o contato da lista de quem a IA responde
        IF coalesce(d->>'contato', '') = '' OR d->>'contato' LIKE 'teste%' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Contato invalido'));
        END IF;
        IF coalesce((d->>'liberar')::boolean, false) THEN
            INSERT INTO nucleo.responde_para (agente, numero, nome)
            VALUES ('multi', nucleo.so_digitos(d->>'contato'), nullif(d->>'nome', ''))
            ON CONFLICT (agente, numero) DO UPDATE SET nome = coalesce(EXCLUDED.nome, nucleo.responde_para.nome);
        ELSE
            DELETE FROM nucleo.responde_para WHERE agente = 'multi'
               AND nucleo.variantes_numero(numero) && nucleo.variantes_numero(d->>'contato');
        END IF;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_estado' THEN   -- assumir | devolver | encerrar
        a := nucleo.multi_mudar_estado((d->>'id')::int,
                CASE d->>'acao' WHEN 'assumir' THEN 'humano' WHEN 'devolver' THEN 'automatico' WHEN 'encerrar' THEN 'encerrado' END,
                p_usuario, CASE d->>'acao' WHEN 'assumir' THEN 'assumido no painel' WHEN 'devolver' THEN 'devolvido para a IA'
                                          ELSE 'encerrado no painel' END);
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_conversa(a.id));

    ELSIF p_acao = 'admin_multi_empresa' THEN   -- criar/editar
        IF coalesce(d->>'nome', '') = '' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Informe o nome da empresa'));
        END IF;
        IF nullif(d->>'id', '') IS NULL THEN
            INSERT INTO nucleo.empresas (slug, nome) VALUES (
                coalesce(nullif(lower(regexp_replace(unaccent(coalesce(nullif(d->>'slug', ''), d->>'nome')), '[^a-zA-Z0-9]+', '', 'g')), ''), 'empresa' || (SELECT count(*) + 1 FROM nucleo.empresas)),
                d->>'nome') RETURNING id INTO eid;
        ELSE eid := (d->>'id')::int;
        END IF;
        UPDATE nucleo.empresas SET
            nome = coalesce(nullif(d->>'nome', ''), nome),
            descricao = coalesce(d->>'descricao', descricao), assuntos = coalesce(d->>'assuntos', assuntos),
            site = CASE WHEN d ? 'site' THEN nullif(trim(d->>'site'), '') ELSE site END,
            catalogo_url = CASE WHEN d ? 'catalogo_url' THEN nullif(trim(d->>'catalogo_url'), '') ELSE catalogo_url END,
            catalogo_env = CASE WHEN d ? 'catalogo_env' THEN nullif(upper(regexp_replace(d->>'catalogo_env', '[^A-Za-z0-9_]', '', 'g')), '') ELSE catalogo_env END,
            tom = CASE WHEN d ? 'tom' THEN nullif(trim(d->>'tom'), '') ELSE tom END,
            responsavel = CASE WHEN d ? 'responsavel' THEN nullif(trim(d->>'responsavel'), '') ELSE responsavel END,
            ativo = coalesce((d->>'ativo')::boolean, ativo),
            atualizado_em = now()
         WHERE id = eid;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_base' THEN   -- criar/editar/apagar item da base de uma empresa
        IF coalesce((d->>'apagar')::boolean, false) THEN
            UPDATE nucleo.empresa_base SET ativo = false, atualizado_em = now() WHERE id = (d->>'id')::int;
        ELSIF nullif(d->>'id', '') IS NULL THEN
            INSERT INTO nucleo.empresa_base (empresa_id, tipo, titulo, conteudo, responsavel)
            VALUES ((d->>'empresa_id')::int, CASE WHEN d->>'tipo' IN ('produto','politica','faq','procedimento','contato') THEN d->>'tipo' ELSE 'faq' END,
                    left(d->>'titulo', 200), d->>'conteudo', nullif(d->>'responsavel', ''));
        ELSE
            UPDATE nucleo.empresa_base SET
                tipo = CASE WHEN d->>'tipo' IN ('produto','politica','faq','procedimento','contato') THEN d->>'tipo' ELSE tipo END,
                titulo = coalesce(nullif(left(d->>'titulo', 200), ''), titulo), conteudo = coalesce(nullif(d->>'conteudo', ''), conteudo),
                responsavel = CASE WHEN d ? 'responsavel' THEN nullif(d->>'responsavel', '') ELSE responsavel END, atualizado_em = now()
             WHERE id = (d->>'id')::int;
        END IF;
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_responder' THEN
        -- a equipe responde pelo painel: vale como resposta pelo celular (assume a conversa e ensina o aprendiz)
        SELECT * INTO a FROM nucleo.atendimentos WHERE id = (d->>'id')::int;
        IF NOT FOUND OR coalesce(trim(d->>'texto'), '') = '' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Escreva a mensagem'));
        END IF;
        INSERT INTO nucleo.conversas (canal, contato, agente, papel, mensagem, cliente_id, instancia)
        VALUES ('whatsapp', a.contato, 'multi', 'humano', trim(d->>'texto'), a.cliente_id, a.instancia);
        IF a.estado IN ('automatico', 'aguardando_humano') THEN
            PERFORM nucleo.multi_mudar_estado(a.id, 'humano', p_usuario, 'respondeu pelo painel');
        END IF;
        UPDATE nucleo.atendimentos SET sem_resposta = NULL, atualizado_em = now() WHERE id = a.id;
        IF a.instancia = 'simulador' OR a.contato LIKE 'teste%' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', jsonb_build_object('ok', true, 'enviado', false, 'motivo', 'conversa de teste'));
        END IF;
        -- 5 = o n8n envia pelo numero do atendimento (o id enviado e guardado: o eco do WhatsApp nao duplica)
        RETURN jsonb_build_object('saida', 5, 'status', 200, 'corpo', jsonb_build_object(
            'numero', a.contato, 'texto', trim(d->>'texto'), 'instancia', a.instancia, 'so_instancia', true));

    ELSIF p_acao = 'admin_multi_rejeitar' THEN
        UPDATE nucleo.atendimento_respostas SET status = 'descartada', motivo = 'rejeitada no painel', revisado_por = p_usuario, decidido_em = now()
         WHERE id = (d->>'id')::bigint AND status = 'pendente';
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_aprovar' THEN
        UPDATE nucleo.atendimento_respostas SET status = 'aprovada', texto = coalesce(nullif(trim(d->>'texto'), ''), texto),
               revisado_por = p_usuario
         WHERE id = (d->>'id')::bigint AND status = 'pendente';
        IF NOT FOUND THEN
            RETURN jsonb_build_object('saida', 0, 'status', 409, 'corpo', jsonb_build_object('erro', 'Essa resposta nao esta mais esperando aprovacao'));
        END IF;
        r := nucleo.multi_conferir_envio((d->>'id')::bigint, true);
        IF NOT (r->>'enviar')::boolean THEN
            RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', jsonb_build_object('ok', true, 'enviado', false, 'motivo', r->>'motivo'));
        END IF;
        IF (r->>'teste')::boolean THEN
            RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', jsonb_build_object('ok', true, 'enviado', false, 'motivo', 'conversa de teste'));
        END IF;
        -- 5 = o n8n envia pelo numero do atendimento (e so por ele)
        RETURN jsonb_build_object('saida', 5, 'status', 200, 'corpo', jsonb_build_object(
            'numero', r->>'numero', 'texto', r->>'texto', 'instancia', r->>'instancia', 'so_instancia', true,
            'resposta_id', (d->>'id')::bigint));

    ELSIF p_acao = 'admin_multi_simular' THEN
        -- conversa de teste do proprio admin (instancia 'simulador'); passa pela MESMA entrada e conferencia
        IF coalesce((d->>'reiniciar')::boolean, false) THEN
            DELETE FROM nucleo.conversas WHERE agente = 'multi' AND instancia = 'simulador' AND contato = 'teste-multi-' || p_usuario;
            DELETE FROM nucleo.atendimentos WHERE instancia = 'simulador' AND contato = 'teste-multi-' || p_usuario;
            RETURN ok;
        END IF;
        r := nucleo.multi_entrada('teste-multi-' || p_usuario, coalesce(nullif(d->>'nome', ''), 'Cliente de teste'),
                                  coalesce(d->>'mensagem', ''), 'texto', false, NULL, 'simulador');
        IF (r->>'saida')::int <> 3 THEN
            RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', jsonb_build_object('resposta', NULL, 'motivo', r->>'motivo',
                   'conversa', nucleo.multi_conversa((SELECT id FROM nucleo.atendimentos WHERE instancia = 'simulador' AND contato = 'teste-multi-' || p_usuario))));
        END IF;
        RETURN jsonb_build_object('saida', 6, 'status', 200, 'corpo', jsonb_build_object(
            'agente', 'multi', 'atendimento_id', r->>'atendimento_id', 'cliente_id', r->>'cliente_id', 'nome', r->>'nome',
            'chatInput', coalesce(d->>'mensagem', ''), 'sessionId', r->>'sessionId', 'numero', r->>'numero'));
    END IF;
    RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'acao desconhecida: ' || p_acao));
END $$;
