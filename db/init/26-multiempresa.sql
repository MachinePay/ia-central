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
-- sugestao de resposta que a IA deixa para a equipe quando encaminha (a pessoa so ajusta e envia)
ALTER TABLE nucleo.atendimentos ADD COLUMN IF NOT EXISTS rascunho text;

-- perguntas que a IA nao soube responder (faltou informacao na base): viram informacao com 1 resposta da equipe
CREATE TABLE IF NOT EXISTS nucleo.multi_lacunas (
    id             serial PRIMARY KEY,
    empresa_id     int REFERENCES nucleo.empresas(id) ON DELETE CASCADE,
    atendimento_id int REFERENCES nucleo.atendimentos(id) ON DELETE SET NULL,
    pergunta       text NOT NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    resolvida_em   timestamptz,
    base_id        int REFERENCES nucleo.empresa_base(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS multi_lacunas_abertas ON nucleo.multi_lacunas (criado_em DESC) WHERE resolvida_em IS NULL;

-- nota da equipe em cada resposta da IA (👍 / 👎 com a resposta certa)
CREATE TABLE IF NOT EXISTS nucleo.multi_avaliacoes (
    conversa_id bigint PRIMARY KEY REFERENCES nucleo.conversas(id) ON DELETE CASCADE,
    nota        smallint NOT NULL CHECK (nota IN (-1, 1)),
    correcao    text,
    usuario_id  int REFERENCES nucleo.usuarios(id) ON DELETE SET NULL,
    em          timestamptz NOT NULL DEFAULT now()
);

-- horario de atendimento: dentro/fora do horario a IA usa outro modo (a chave geral desligada desliga tudo)
INSERT INTO nucleo.config VALUES ('multi_horario',
    '{"ativo": false, "inicio": "09:00", "fim": "18:00", "dias": [1, 2, 3, 4, 5], "modo_dentro": "aprovacao", "modo_fora": "automatico"}')
ON CONFLICT DO NOTHING;
-- resumo do dia no WhatsApp dos admins
INSERT INTO nucleo.config VALUES ('multi_relatorio', '{"ativo": true, "hora": 18}') ON CONFLICT DO NOTHING;

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

-- dentro do horario de atendimento agora? (null = horario nao configurado)
CREATE OR REPLACE FUNCTION nucleo.multi_no_horario() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN NOT coalesce((h->>'ativo')::boolean, false) THEN NULL ELSE
             extract(isodow FROM agora)::int IN (SELECT jsonb_array_elements_text(coalesce(h->'dias', '[]'))::int)
             AND agora::time >= coalesce(nullif(h->>'inicio', ''), '09:00')::time
             AND agora::time <  coalesce(nullif(h->>'fim', ''), '18:00')::time END
      FROM (SELECT (SELECT valor FROM nucleo.config WHERE chave = 'multi_horario') AS h,
                   (now() AT TIME ZONE 'America/Sao_Paulo') AS agora) x
$$;

-- modo que vale AGORA: a chave geral; com horario ligado, o modo de dentro/fora do horario
CREATE OR REPLACE FUNCTION nucleo.multi_modo() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN nucleo.cfg('multi_modo', 'desligado') = 'desligado' THEN 'desligado'
        WHEN nucleo.multi_no_horario() IS NULL THEN nucleo.cfg('multi_modo', 'desligado')
        ELSE coalesce((SELECT valor ->> CASE WHEN nucleo.multi_no_horario() THEN 'modo_dentro' ELSE 'modo_fora' END
                         FROM nucleo.config WHERE chave = 'multi_horario'), nucleo.cfg('multi_modo', 'desligado'))
    END
$$;

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
           encaminhado_em = CASE WHEN p_estado = 'aguardando_humano' THEN now() WHEN p_estado = 'automatico' THEN NULL ELSE encaminhado_em END,
           rascunho = CASE WHEN p_estado IN ('automatico', 'encerrado') THEN NULL ELSE rascunho END
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
    -- comando do dono/admin (/ensina ...) no numero do atendimento
    IF nucleo.papel_instancia(p_instancia) = 'multi' THEN
        r := nucleo.multi_comando(p_numero, p_texto, p_de_mim, p_conversa_propria, p_instancia);
        IF r IS NOT NULL THEN RETURN r; END IF;
    END IF;
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

-- encaminhar + rascunho para a equipe + "faltou informacao" (vira pergunta sem resposta no painel)
CREATE OR REPLACE FUNCTION nucleo.multi_encaminhar(p_at int, p_motivo text, p_resumo text, p_prioridade text,
                                                   p_rascunho text, p_faltou text, p_pergunta text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; a nucleo.atendimentos%ROWTYPE;
BEGIN
    r := nucleo.multi_encaminhar(p_at, p_motivo, p_resumo, p_prioridade);
    SELECT * INTO a FROM nucleo.atendimentos WHERE id = p_at;
    IF coalesce(trim(p_rascunho), '') <> '' THEN
        UPDATE nucleo.atendimentos SET rascunho = left(trim(p_rascunho), 2000) WHERE id = p_at;
    END IF;
    IF lower(coalesce(p_faltou, '')) IN ('sim', 'true', 's', 'yes') AND coalesce(trim(p_pergunta), '') <> ''
       AND a.instancia <> 'simulador' THEN
        INSERT INTO nucleo.multi_lacunas (empresa_id, atendimento_id, pergunta)
        VALUES (a.empresa_id, a.id, left(trim(p_pergunta), 500));
    END IF;
    RETURN r;
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

-- mesma pergunta escrita de jeitos diferentes (acento, maiuscula, pontuacao) vira a mesma chave
CREATE OR REPLACE FUNCTION nucleo.pergunta_chave(p text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT trim(lower(unaccent(regexp_replace(coalesce(p, ''), '[[:punct:][:space:]]+', ' ', 'g')))) $$;

-- ---------------------------------------------------------------- desempenho (painel) e resumo do dia (WhatsApp)
-- por empresa nos ultimos p_dias: conversas, quantas a IA respondeu, quantas resolveu sozinha (sem equipe e sem
-- encaminhar), quantas passou para a equipe, tempo medio ate a resposta, notas da equipe e perguntas sem resposta
CREATE OR REPLACE FUNCTION nucleo.multi_desempenho(p_dias int DEFAULT 7) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    WITH per AS (SELECT now() - make_interval(days => p_dias) AS desde),
    at AS (
        SELECT a.id, a.empresa_id,
               EXISTS (SELECT 1 FROM nucleo.atendimento_respostas r WHERE r.atendimento_id = a.id AND r.status = 'enviada'
                        AND r.decidido_em > per.desde) AS ia_respondeu,
               EXISTS (SELECT 1 FROM nucleo.conversas v WHERE v.agente = 'multi' AND v.instancia = a.instancia AND v.contato = a.contato
                        AND v.papel = 'humano' AND v.criado_em > per.desde) AS equipe,
               coalesce(a.encaminhado_em > per.desde, false) AS encaminhada
          FROM nucleo.atendimentos a, per
         WHERE a.instancia <> 'simulador' AND a.ultima_cliente_em > per.desde
    ),
    tempos AS (
        SELECT a.empresa_id, extract(epoch FROM r.decidido_em - v.criado_em) AS s
          FROM nucleo.atendimento_respostas r JOIN nucleo.atendimentos a ON a.id = r.atendimento_id
          JOIN nucleo.conversas v ON v.id = r.ate_conversa, per
         WHERE r.status = 'enviada' AND r.decidido_em > per.desde AND a.instancia <> 'simulador'
    ),
    notas AS (
        SELECT a.empresa_id, av.nota FROM nucleo.multi_avaliacoes av JOIN nucleo.conversas v ON v.id = av.conversa_id
          JOIN nucleo.atendimentos a ON a.instancia = v.instancia AND a.contato = v.contato, per
         WHERE av.em > per.desde
    )
    SELECT jsonb_build_object('dias', p_dias, 'linhas', coalesce((SELECT jsonb_agg(l ORDER BY l.conversas DESC) FROM (
        SELECT coalesce(e.nome, 'Sem empresa definida') AS empresa,
               count(*) AS conversas,
               count(*) FILTER (WHERE at.ia_respondeu) AS ia_respondeu,
               count(*) FILTER (WHERE at.ia_respondeu AND NOT at.equipe AND NOT at.encaminhada) AS resolvidas_ia,
               count(*) FILTER (WHERE at.encaminhada) AS encaminhadas,
               (SELECT round(avg(t.s)) FROM tempos t WHERE t.empresa_id IS NOT DISTINCT FROM at.empresa_id) AS tempo_medio_s,
               (SELECT count(*) FROM notas n WHERE n.empresa_id IS NOT DISTINCT FROM at.empresa_id AND n.nota = 1) AS positivas,
               (SELECT count(*) FROM notas n WHERE n.empresa_id IS NOT DISTINCT FROM at.empresa_id AND n.nota = -1) AS negativas,
               (SELECT count(*) FROM nucleo.multi_lacunas la, per WHERE la.empresa_id IS NOT DISTINCT FROM at.empresa_id
                   AND la.criado_em > per.desde) AS sem_resposta
          FROM at LEFT JOIN nucleo.empresas e ON e.id = at.empresa_id
         GROUP BY at.empresa_id, e.nome) l), '[]'))
$$;

-- texto do resumo de hoje (o mesmo que vai no WhatsApp e aparece no painel)
CREATE OR REPLACE FUNCTION nucleo.multi_resumo_texto() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    WITH dia AS (SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS ini),
    at AS (
        SELECT a.*,
               EXISTS (SELECT 1 FROM nucleo.atendimento_respostas r WHERE r.atendimento_id = a.id AND r.status = 'enviada'
                        AND r.decidido_em > dia.ini) AS ia,
               EXISTS (SELECT 1 FROM nucleo.conversas v WHERE v.agente = 'multi' AND v.instancia = a.instancia AND v.contato = a.contato
                        AND v.papel = 'humano' AND v.criado_em > dia.ini) AS equipe
          FROM nucleo.atendimentos a, dia WHERE a.instancia <> 'simulador' AND a.ultima_cliente_em > dia.ini
    ),
    n AS (
        SELECT (SELECT count(*) FROM at) AS conversas,
               (SELECT count(*) FROM nucleo.atendimento_respostas r JOIN nucleo.atendimentos a ON a.id = r.atendimento_id, dia
                 WHERE r.status = 'enviada' AND r.decidido_em > dia.ini AND a.instancia <> 'simulador') AS mensagens_ia,
               (SELECT count(*) FROM at, dia WHERE at.ia AND NOT at.equipe AND NOT coalesce(at.encaminhado_em > dia.ini, false)) AS resolvidas,
               (SELECT count(*) FROM at, dia WHERE at.encaminhado_em > dia.ini) AS encaminhadas,
               (SELECT count(*) FROM nucleo.empresa_base b, dia WHERE b.ativo AND b.responsavel LIKE 'Aprendiz%' AND b.atualizado_em > dia.ini) AS aprendidos,
               (SELECT count(*) FROM nucleo.atendimentos WHERE estado = 'aguardando_humano' AND instancia <> 'simulador')
             + (SELECT count(*) FROM nucleo.atendimento_respostas WHERE status = 'pendente') AS esperando,
               (SELECT array_agg(p) FROM (SELECT left(la.pergunta, 90) AS p FROM nucleo.multi_lacunas la, dia
                                          WHERE la.criado_em > dia.ini AND la.resolvida_em IS NULL ORDER BY la.id DESC LIMIT 3) q) AS lacunas,
               (SELECT count(*) FROM nucleo.multi_lacunas la, dia WHERE la.criado_em > dia.ini AND la.resolvida_em IS NULL) AS total_lacunas
    )
    SELECT jsonb_build_object('conversas', n.conversas, 'texto',
        '📊 *Atendimento de hoje* (' || to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM') || ')' || E'\n'
        || '• ' || n.conversas || ' conversa' || CASE WHEN n.conversas = 1 THEN '' ELSE 's' END
        || ' · a IA mandou ' || n.mensagens_ia || ' resposta' || CASE WHEN n.mensagens_ia = 1 THEN '' ELSE 's' END || E'\n'
        || '• ' || n.resolvidas || ' resolvida' || CASE WHEN n.resolvidas = 1 THEN '' ELSE 's' END || ' só pela IA · '
        || n.encaminhadas || ' passada' || CASE WHEN n.encaminhadas = 1 THEN '' ELSE 's' END || ' para a equipe' || E'\n'
        || '• Aprendeu ' || n.aprendidos || ' coisa' || CASE WHEN n.aprendidos = 1 THEN '' ELSE 's' END || ' nova' || CASE WHEN n.aprendidos = 1 THEN '' ELSE 's' END
        || CASE WHEN n.total_lacunas > 0 THEN E'\n' || '• ' || n.total_lacunas || ' pergunta' || CASE WHEN n.total_lacunas = 1 THEN '' ELSE 's' END
               || ' sem resposta na base:' || E'\n' || array_to_string(ARRAY(SELECT '   – “' || x || '”' FROM unnest(n.lacunas) x), E'\n')
                ELSE '' END
        || CASE WHEN n.esperando > 0 THEN E'\n\n' || '⏳ Esperando você agora: ' || n.esperando ELSE '' END
        || E'\n' || 'Painel → Multiempresa para responder e ensinar.')
      FROM n
$$;

-- chamado de hora em hora pelo n8n: na hora configurada (uma vez por dia, so se houve conversa) devolve o texto e para quem
CREATE OR REPLACE FUNCTION nucleo.multi_relatorio() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    cfg   jsonb := coalesce((SELECT valor FROM nucleo.config WHERE chave = 'multi_relatorio'), '{}');
    agora timestamp := now() AT TIME ZONE 'America/Sao_Paulo';
    r     jsonb;
BEGIN
    IF NOT coalesce((cfg->>'ativo')::boolean, true) OR extract(hour FROM agora) < coalesce((cfg->>'hora')::int, 18)
       OR nucleo.cfg('multi_relatorio_ultimo', '') = agora::date::text THEN
        RETURN jsonb_build_object('enviar', false);
    END IF;
    INSERT INTO nucleo.config VALUES ('multi_relatorio_ultimo', to_jsonb(agora::date::text))
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
    r := nucleo.multi_resumo_texto();
    IF (r->>'conversas')::int = 0 THEN RETURN jsonb_build_object('enviar', false, 'motivo', 'sem conversas hoje'); END IF;
    RETURN jsonb_build_object('enviar', true, 'texto', r->>'texto', 'avisar', nucleo.multi_avisar());
END $$;

-- ---------------------------------------------------------------- comando /ensina pelo WhatsApp
-- o dono (conversa "Voce" do numero do atendimento) ou um admin escrevendo para o numero:
--   /ensina girakids: frete gratis acima de R$ 200      (com uma empresa so, o slug e opcional)
-- devolve saida 4 (o n8n responde o texto) ou NULL (nao e comando)
CREATE OR REPLACE FUNCTION nucleo.multi_comando(p_numero text, p_texto text, p_de_mim boolean, p_propria boolean, p_instancia text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    resto text;
    eid   int;
    enome text;
    tit   text;
    quem  text;
    m     text[];
    resp  text;
BEGIN
    IF coalesce(p_texto, '') !~* '^\s*/ensina' THEN RETURN NULL; END IF;
    SELECT nome INTO quem FROM nucleo.usuario_por_whatsapp(p_numero) WHERE papel = 'admin';
    IF NOT (coalesce(p_propria, false) OR (NOT p_de_mim AND quem IS NOT NULL)) THEN RETURN NULL; END IF;
    quem := coalesce(quem, nucleo.cfg('multi_dono_nome', 'Leonardo'));
    resto := trim(regexp_replace(p_texto, '^\s*/ensina\s*', '', 'i'));
    m := regexp_match(resto, '^([A-Za-z0-9-]+)\s*:\s*(.+)$', 's');
    IF m IS NOT NULL THEN
        SELECT id, nome INTO eid, enome FROM nucleo.empresas WHERE ativo AND slug = lower(m[1]);
        IF eid IS NOT NULL THEN resto := trim(m[2]); END IF;
    END IF;
    IF eid IS NULL AND (SELECT count(*) FROM nucleo.empresas WHERE ativo) = 1 THEN
        SELECT id, nome INTO eid, enome FROM nucleo.empresas WHERE ativo;
    END IF;
    IF resto = '' OR eid IS NULL THEN
        resp := 'Para ensinar, mande assim:' || E'\n' || '/ensina ' || coalesce((SELECT slug FROM nucleo.empresas WHERE ativo ORDER BY nome LIMIT 1), 'empresa')
             || ': o que a IA deve saber' || E'\n' || 'Empresas: '
             || coalesce((SELECT string_agg(slug, ', ' ORDER BY slug) FROM nucleo.empresas WHERE ativo), '(nenhuma)');
    ELSE
        tit := left(trim(split_part(regexp_replace(resto, '([.!?])\s', '\1' || chr(10), 'g'), chr(10), 1)), 90);
        INSERT INTO nucleo.empresa_base (empresa_id, tipo, titulo, conteudo, responsavel)
        VALUES (eid, 'faq', tit, resto, quem || ' (WhatsApp)');
        resp := '✅ Aprendi para a ' || enome || ': “' || left(resto, 200) || '”' || E'\n' || 'Para corrigir ou apagar: painel → Multiempresa.';
    END IF;
    RETURN jsonb_build_object('saida', 4, 'motivo', 'comando /ensina', 'numero', nucleo.so_digitos(p_numero),
                              'instancia', p_instancia, 'texto', resp);
END $$;

-- ---------------------------------------------------------------- painel
CREATE OR REPLACE FUNCTION nucleo.multi_painel() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo', nucleo.cfg('multi_modo', 'desligado'),       -- a chave geral
        'modo_agora', nucleo.multi_modo(),                   -- o que vale agora (com o horario de atendimento)
        'no_horario', nucleo.multi_no_horario(),
        'horario', (SELECT valor FROM nucleo.config WHERE chave = 'multi_horario'),
        'relatorio', (SELECT valor FROM nucleo.config WHERE chave = 'multi_relatorio'),
        'humano_minutos', coalesce(nullif(nucleo.cfg('multi_humano_minutos', '30'), '')::int, 30),
        'com_pessoa', (SELECT count(*) FROM nucleo.atendimentos WHERE estado = 'humano' AND instancia <> 'simulador'),
        'desempenho', nucleo.multi_desempenho(7),
        'resumo_hoje', nucleo.multi_resumo_texto() ->> 'texto',
        'lacunas', coalesce((SELECT jsonb_agg(x ORDER BY x.vezes DESC, x.ultima DESC) FROM (
            SELECT min(la.id) AS id, la.empresa_id, em.nome AS empresa, min(la.pergunta) AS pergunta, count(*) AS vezes,
                   max(la.criado_em) AS ultima
              FROM nucleo.multi_lacunas la LEFT JOIN nucleo.empresas em ON em.id = la.empresa_id
             WHERE la.resolvida_em IS NULL
             GROUP BY la.empresa_id, em.nome, nucleo.pergunta_chave(la.pergunta)
             ORDER BY count(*) DESC, max(la.criado_em) DESC LIMIT 40) x), '[]'),
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
                          'conteudo', b.conteudo, 'responsavel', b.responsavel, 'atualizado_em', b.atualizado_em,
                          'revisar', b.atualizado_em < now() - interval '60 days',
                          'repetida', EXISTS (SELECT 1 FROM nucleo.empresa_base o WHERE o.empresa_id = b.empresa_id AND o.ativo
                                               AND o.id <> b.id AND lower(trim(o.titulo)) = lower(trim(b.titulo))))
                          ORDER BY b.tipo, b.titulo) FROM nucleo.empresa_base b WHERE b.empresa_id = e.id AND b.ativo), '[]'))
                ORDER BY e.nome) FROM nucleo.empresas e), '[]'),
        'atendimentos', coalesce((SELECT jsonb_agg(x ORDER BY x.ordem, x.atualizado_em DESC) FROM (
            SELECT a.id, a.instancia, a.contato, a.nome, a.estado, a.motivo, a.resumo, a.atualizado_em, a.sem_resposta, a.rascunho,
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
        'mensagens', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'papel', v.papel, 'texto', v.mensagem, 'em', v.criado_em,
                                   'nota', (SELECT nota FROM nucleo.multi_avaliacoes av WHERE av.conversa_id = v.id)) ORDER BY v.id)
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
        -- volta para a IA depois de X min sem a equipe escrever (5 min a 24 h)
        IF coalesce(d->>'humano_minutos', '') ~ '^\d+$' THEN
            INSERT INTO nucleo.config VALUES ('multi_humano_minutos', to_jsonb(least(greatest((d->>'humano_minutos')::int, 5), 1440)))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        -- horario de atendimento: { ativo, inicio "HH:MM", fim, dias [1..7], modo_dentro, modo_fora }
        IF jsonb_typeof(d->'horario') = 'object' THEN
            INSERT INTO nucleo.config VALUES ('multi_horario', jsonb_build_object(
                'ativo', coalesce((d->'horario'->>'ativo')::boolean, false),
                'inicio', CASE WHEN d->'horario'->>'inicio' ~ '^\d{2}:\d{2}$' THEN d->'horario'->>'inicio' ELSE '09:00' END,
                'fim', CASE WHEN d->'horario'->>'fim' ~ '^\d{2}:\d{2}$' THEN d->'horario'->>'fim' ELSE '18:00' END,
                'dias', coalesce((SELECT jsonb_agg(x::int ORDER BY x::int) FROM jsonb_array_elements_text(coalesce(d->'horario'->'dias', '[]')) x
                                   WHERE x ~ '^[1-7]$'), '[]'),
                'modo_dentro', CASE WHEN d->'horario'->>'modo_dentro' IN ('observando', 'aprovacao', 'automatico') THEN d->'horario'->>'modo_dentro' ELSE 'aprovacao' END,
                'modo_fora', CASE WHEN d->'horario'->>'modo_fora' IN ('observando', 'aprovacao', 'automatico') THEN d->'horario'->>'modo_fora' ELSE 'automatico' END))
            ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
        END IF;
        -- resumo do dia no WhatsApp: { ativo, hora 0..23 }
        IF jsonb_typeof(d->'relatorio') = 'object' THEN
            INSERT INTO nucleo.config VALUES ('multi_relatorio', jsonb_build_object(
                'ativo', coalesce((d->'relatorio'->>'ativo')::boolean, true),
                'hora', CASE WHEN d->'relatorio'->>'hora' ~ '^\d{1,2}$' THEN least((d->'relatorio'->>'hora')::int, 23) ELSE 18 END))
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
        UPDATE nucleo.atendimentos SET sem_resposta = NULL, rascunho = NULL, atualizado_em = now() WHERE id = a.id;
        IF a.instancia = 'simulador' OR a.contato LIKE 'teste%' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', jsonb_build_object('ok', true, 'enviado', false, 'motivo', 'conversa de teste'));
        END IF;
        -- 5 = o n8n envia pelo numero do atendimento (o id enviado e guardado: o eco do WhatsApp nao duplica)
        RETURN jsonb_build_object('saida', 5, 'status', 200, 'corpo', jsonb_build_object(
            'numero', a.contato, 'texto', trim(d->>'texto'), 'instancia', a.instancia, 'so_instancia', true));

    ELSIF p_acao = 'admin_multi_devolver_todas' THEN   -- fim do expediente: tudo que esta com uma pessoa volta para a IA
        PERFORM nucleo.multi_mudar_estado(id, 'automatico', p_usuario, 'devolvido para a IA (todas)')
           FROM nucleo.atendimentos WHERE estado = 'humano';
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_lacuna' THEN   -- pergunta sem resposta: responder (vira informacao) ou ignorar
        SELECT empresa_id INTO eid FROM nucleo.multi_lacunas WHERE id = (d->>'id')::int;
        eid := coalesce(nullif(d->>'empresa_id', '')::int, eid);
        IF coalesce((d->>'ignorar')::boolean, false) THEN
            UPDATE nucleo.multi_lacunas l SET resolvida_em = now() FROM nucleo.multi_lacunas o
             WHERE o.id = (d->>'id')::int AND l.resolvida_em IS NULL AND l.empresa_id IS NOT DISTINCT FROM o.empresa_id
               AND nucleo.pergunta_chave(l.pergunta)
                 = nucleo.pergunta_chave(o.pergunta);
            RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());
        END IF;
        IF eid IS NULL THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Escolha a empresa desta resposta'));
        END IF;
        IF coalesce(trim(d->>'resposta'), '') = '' THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Escreva a resposta'));
        END IF;
        WITH b AS (
            INSERT INTO nucleo.empresa_base (empresa_id, tipo, titulo, conteudo, responsavel)
            SELECT eid, 'faq', left(pergunta, 200), trim(d->>'resposta'), (SELECT nome FROM nucleo.usuarios WHERE id = p_usuario)
              FROM nucleo.multi_lacunas WHERE id = (d->>'id')::int
            RETURNING id)
        UPDATE nucleo.multi_lacunas l SET resolvida_em = now(), base_id = (SELECT id FROM b)
          FROM nucleo.multi_lacunas o
         WHERE o.id = (d->>'id')::int AND l.resolvida_em IS NULL AND l.empresa_id IS NOT DISTINCT FROM o.empresa_id
           AND nucleo.pergunta_chave(l.pergunta)
                 = nucleo.pergunta_chave(o.pergunta);
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_painel());

    ELSIF p_acao = 'admin_multi_avaliar' THEN   -- nota numa resposta da IA; negativa com a resposta certa vira informacao
        SELECT a2.* INTO a FROM nucleo.conversas v JOIN nucleo.atendimentos a2 ON a2.instancia = v.instancia AND a2.contato = v.contato
         WHERE v.id = (d->>'conversa_id')::bigint AND v.agente = 'multi' AND v.papel = 'ia';
        IF NOT FOUND OR coalesce(d->>'nota', '') NOT IN ('1', '-1') THEN
            RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro', 'Resposta nao encontrada'));
        END IF;
        IF (d->>'nota')::int = -1 AND coalesce(trim(d->>'correcao'), '') <> '' THEN
            IF a.empresa_id IS NULL THEN
                RETURN jsonb_build_object('saida', 0, 'status', 400, 'corpo', jsonb_build_object('erro',
                       'A conversa ainda nao tem empresa definida: ensine pela base da empresa'));
            END IF;
            INSERT INTO nucleo.empresa_base (empresa_id, tipo, titulo, conteudo, responsavel)
            VALUES (a.empresa_id, 'faq',
                    left(coalesce((SELECT v.mensagem FROM nucleo.conversas v WHERE v.agente = 'multi' AND v.instancia = a.instancia
                                    AND v.contato = a.contato AND v.papel = 'usuario' AND v.id < (d->>'conversa_id')::bigint
                                  ORDER BY v.id DESC LIMIT 1), 'Correcao da equipe'), 200),
                    trim(d->>'correcao'), (SELECT nome FROM nucleo.usuarios WHERE id = p_usuario));
        END IF;
        INSERT INTO nucleo.multi_avaliacoes (conversa_id, nota, correcao, usuario_id)
        VALUES ((d->>'conversa_id')::bigint, (d->>'nota')::int, nullif(trim(d->>'correcao'), ''), p_usuario)
        ON CONFLICT (conversa_id) DO UPDATE SET nota = EXCLUDED.nota, correcao = EXCLUDED.correcao,
                                                usuario_id = EXCLUDED.usuario_id, em = now();
        RETURN jsonb_build_object('saida', 0, 'status', 200, 'corpo', nucleo.multi_conversa(a.id));

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
