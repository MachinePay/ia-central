-- =====================================================================
-- IA Central - ATENDENTE (clientes no WhatsApp): suporte, comercial, sistemico
-- * a base de conhecimento da EMPRESA fica em nucleo.conhecimento com usuario_id NULL
--   e dominio = 'suporte' | 'comercial' | 'geral' (nao se mistura com memoria pessoal)
-- * modo 'aprovacao': a IA so sugere; o admin aprova/edita no painel e a resposta aprovada
--   vira conhecimento (aprendizado). 'automatico': responde direto. 'desligado': ignora.
-- Idempotente.
-- =====================================================================

INSERT INTO nucleo.config VALUES ('atendimento_modo', '"aprovacao"') ON CONFLICT DO NOTHING;
INSERT INTO nucleo.config VALUES ('atendimento_empresa',
  '{"nome": "Minha empresa", "descricao": "", "horario": "segunda a sexta, 9h as 18h", "tom": "simpatico, objetivo e profissional"}')
  ON CONFLICT DO NOTHING;

-- sistemas que os clientes podem saber se estao fora (o resto e interno)
ALTER TABLE nucleo.sistemas ADD COLUMN IF NOT EXISTS publico boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS nucleo.clientes (
    id             serial PRIMARY KEY,
    whatsapp       text UNIQUE,
    nome           text,
    empresa        text,
    interesse      text,
    etapa          text NOT NULL DEFAULT 'novo' CHECK (etapa IN ('novo','lead','cliente','perdido')),
    observacoes    text,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    ultimo_contato timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nucleo.chamados (
    id           serial PRIMARY KEY,
    cliente_id   int REFERENCES nucleo.clientes(id) ON DELETE CASCADE,
    area         text NOT NULL DEFAULT 'suporte',      -- suporte | comercial | sistemico | humano
    titulo       text NOT NULL,
    descricao    text,
    prioridade   text NOT NULL DEFAULT 'normal' CHECK (prioridade IN ('baixa','normal','alta')),
    status       text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','resolvido')),
    criado_em    timestamptz NOT NULL DEFAULT now(),
    resolvido_em timestamptz
);

CREATE TABLE IF NOT EXISTS nucleo.atendimento_fila (
    id             serial PRIMARY KEY,
    cliente_id     int REFERENCES nucleo.clientes(id) ON DELETE CASCADE,
    pergunta       text NOT NULL,
    rascunho       text NOT NULL,
    resposta_final text,
    area           text,
    status         text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','rejeitada','automatica')),
    revisado_por   int REFERENCES nucleo.usuarios(id) ON DELETE SET NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    revisado_em    timestamptz
);
CREATE INDEX IF NOT EXISTS fila_pendente ON nucleo.atendimento_fila (criado_em) WHERE status = 'pendente';

CREATE OR REPLACE FUNCTION nucleo.atendimento_config() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'modo',    coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_modo'), 'aprovacao'),
        'empresa', coalesce((SELECT valor FROM nucleo.config WHERE chave = 'atendimento_empresa'), '{}'::jsonb))
$$;

-- Busca na base da empresa (area + geral). Mesma busca da memoria: qualquer palavra, sem acento.
CREATE OR REPLACE FUNCTION nucleo.buscar_base(p_area text, p_busca text)
RETURNS TABLE (id bigint, area text, titulo text, conteudo text, relevante boolean)
LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT websearch_to_tsquery('portuguese',
               unaccent(regexp_replace(coalesce(p_busca,''), '[;,|[:space:]]+', ' or ', 'g'))) AS tsq
    ), c AS (
        SELECT k.id, k.dominio, k.titulo, k.conteudo, k.criado_em,
               to_tsvector('portuguese', unaccent(coalesce(k.titulo,'') || ' ' || k.conteudo)) AS doc
          FROM nucleo.conhecimento k
         WHERE k.usuario_id IS NULL AND k.aprovado
           AND k.dominio IN (coalesce(p_area,'geral'), 'geral')
    )
    SELECT c.id, c.dominio, c.titulo, c.conteudo, c.doc @@ q.tsq
      FROM c, q
     ORDER BY c.doc @@ q.tsq DESC, ts_rank(c.doc, q.tsq) DESC, c.criado_em DESC
     LIMIT 12
$$;

CREATE OR REPLACE FUNCTION nucleo.cliente_por_whatsapp(p_numero text, p_nome text)
RETURNS nucleo.clientes LANGUAGE plpgsql AS $$
DECLARE c nucleo.clientes%ROWTYPE;
BEGIN
    IF p_numero LIKE 'teste%' THEN       -- cliente do simulador do painel
        SELECT * INTO c FROM nucleo.clientes WHERE whatsapp = p_numero;
    ELSE
        SELECT * INTO c FROM nucleo.clientes
         WHERE whatsapp NOT LIKE 'teste%' AND nucleo.variantes_numero(whatsapp) && nucleo.variantes_numero(p_numero) LIMIT 1;
    END IF;
    IF NOT FOUND THEN
        INSERT INTO nucleo.clientes (whatsapp, nome)
        VALUES (CASE WHEN p_numero LIKE 'teste%' THEN p_numero ELSE nucleo.so_digitos(p_numero) END, nullif(p_nome,''))
        RETURNING * INTO c;
    ELSE
        UPDATE nucleo.clientes SET ultimo_contato = now(), nome = coalesce(nome, nullif(p_nome,''))
         WHERE id = c.id RETURNING * INTO c;
    END IF;
    RETURN c;
END $$;

-- Resposta da IA para um cliente: decide se envia agora (automatico) ou vai para aprovacao
CREATE OR REPLACE FUNCTION nucleo.atendimento_registrar(p_cliente int, p_pergunta text, p_rascunho text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    modo text := nucleo.atendimento_config()->>'modo';
    fid  int;
    num  text;
BEGIN
    SELECT whatsapp INTO num FROM nucleo.clientes WHERE id = p_cliente;
    INSERT INTO nucleo.atendimento_fila (cliente_id, pergunta, rascunho, resposta_final, status)
    VALUES (p_cliente, p_pergunta, p_rascunho,
            CASE WHEN modo = 'automatico' THEN p_rascunho END,
            CASE WHEN modo = 'automatico' THEN 'automatica' ELSE 'pendente' END)
    RETURNING id INTO fid;
    RETURN jsonb_build_object('fila_id', fid, 'enviar', modo = 'automatico', 'numero', num, 'modo', modo,
        'avisar', CASE WHEN modo = 'automatico' THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(whatsapp) FROM nucleo.usuarios
                   WHERE papel = 'admin' AND ativo AND whatsapp IS NOT NULL), '[]') END);
END $$;

-- Admin aprovou (talvez editando): marca enviada e APRENDE (vira conhecimento da empresa)
CREATE OR REPLACE FUNCTION nucleo.atendimento_aprovar(p_fila int, p_revisor int, p_texto text, p_area text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f nucleo.atendimento_fila%ROWTYPE; num text;
BEGIN
    UPDATE nucleo.atendimento_fila
       SET status = 'enviada', resposta_final = coalesce(nullif(p_texto,''), rascunho),
           area = coalesce(nullif(p_area,''), area, 'geral'), revisado_por = p_revisor, revisado_em = now()
     WHERE id = p_fila AND status = 'pendente'
     RETURNING * INTO f;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT whatsapp INTO num FROM nucleo.clientes WHERE id = f.cliente_id;
    INSERT INTO nucleo.conhecimento (usuario_id, dominio, titulo, conteudo, origem)
    VALUES (NULL, f.area, left(f.pergunta, 90),
            'Pergunta de cliente: ' || f.pergunta || E'\n' || 'Resposta aprovada: ' || f.resposta_final,
            'resposta_aprovada');
    RETURN jsonb_build_object('numero', num, 'texto', f.resposta_final, 'cliente_id', f.cliente_id);
END $$;

-- Painel do atendimento (admin)
CREATE OR REPLACE FUNCTION nucleo.atendimento_painel() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'config', nucleo.atendimento_config(),
        'fila', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em) FROM (
            SELECT f.id, f.pergunta, f.rascunho, f.criado_em, c.nome, c.whatsapp
              FROM nucleo.atendimento_fila f LEFT JOIN nucleo.clientes c ON c.id = f.cliente_id
             WHERE f.status = 'pendente' ORDER BY f.criado_em LIMIT 30) x), '[]'),
        'chamados', coalesce((SELECT jsonb_agg(x ORDER BY x.criado_em DESC) FROM (
            SELECT h.id, h.area, h.titulo, h.descricao, h.prioridade, h.criado_em, c.nome, c.whatsapp
              FROM nucleo.chamados h LEFT JOIN nucleo.clientes c ON c.id = h.cliente_id
             WHERE h.status = 'aberto' ORDER BY h.criado_em DESC LIMIT 30) x), '[]'),
        'clientes', coalesce((SELECT jsonb_agg(x ORDER BY x.ultimo_contato DESC) FROM (
            SELECT id, nome, whatsapp, empresa, interesse, etapa, ultimo_contato
              FROM nucleo.clientes WHERE whatsapp NOT LIKE 'teste%' ORDER BY ultimo_contato DESC LIMIT 30) x), '[]'),
        'base', coalesce((SELECT jsonb_agg(x ORDER BY x.dominio, x.criado_em DESC) FROM (
            SELECT id, dominio, titulo, conteudo, origem, criado_em
              FROM nucleo.conhecimento WHERE usuario_id IS NULL AND dominio IN ('suporte','comercial','geral')
             ORDER BY criado_em DESC LIMIT 200) x), '[]'),
        'sistemas', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'publico', publico) ORDER BY nome)
              FROM nucleo.sistemas WHERE tipo = 'http'), '[]'))
$$;
