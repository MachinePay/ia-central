-- =====================================================================
-- IA Central - NUCLEO COMPARTILHADO
-- Tudo da IA fica no schema "nucleo". O n8n usa o schema "public". Idempotente.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS nucleo;

-- ---------------------------------------------------------------------
-- PESSOAS: quem a IA conhece e por onde fala com cada um
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nucleo.contatos (
    id            serial PRIMARY KEY,
    nome          text NOT NULL,
    telegram_chat_id text,
    whatsapp      text,          -- formato 5511999999999
    email         text,
    ativo         boolean NOT NULL DEFAULT true,
    criado_em     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- ESCALONAMENTO: quem avisar para cada grupo de sistemas
-- grupo 'geral' = recebe tudo. ordem 1 = primeiro a ser avisado.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nucleo.escalonamento (
    id          serial PRIMARY KEY,
    grupo       text NOT NULL DEFAULT 'geral',
    contato_id  int  NOT NULL REFERENCES nucleo.contatos(id) ON DELETE CASCADE,
    canal       text NOT NULL CHECK (canal IN ('telegram','whatsapp','email')),
    ordem       int  NOT NULL DEFAULT 1,
    UNIQUE (grupo, contato_id, canal)
);

-- ---------------------------------------------------------------------
-- SISTEMAS MONITORADOS (qualquer URL/API, de qualquer projeto)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nucleo.sistemas (
    id                  serial PRIMARY KEY,
    nome                text NOT NULL UNIQUE,
    grupo               text NOT NULL DEFAULT 'geral',
    url                 text NOT NULL,
    metodo              text NOT NULL DEFAULT 'GET',
    status_esperado     int  NOT NULL DEFAULT 200,
    texto_esperado      text,              -- opcional: resposta tem que conter isto
    timeout_ms          int  NOT NULL DEFAULT 10000,
    falhas_para_alertar int  NOT NULL DEFAULT 2,  -- evita alarme por 1 falha isolada
    ativo               boolean NOT NULL DEFAULT true,
    -- estado atual (preenchido pelo monitor)
    estado              text NOT NULL DEFAULT 'desconhecido', -- ok | falha | desconhecido
    falhas_seguidas     int  NOT NULL DEFAULT 0,
    ultimo_detalhe      text,
    ultimo_check        timestamptz,
    caiu_em             timestamptz
);

-- Historico de incidentes (abre quando cai, fecha quando volta)
CREATE TABLE IF NOT EXISTS nucleo.incidentes (
    id          serial PRIMARY KEY,
    sistema_id  int NOT NULL REFERENCES nucleo.sistemas(id) ON DELETE CASCADE,
    inicio      timestamptz NOT NULL DEFAULT now(),
    fim         timestamptz,
    detalhe     text,
    reconhecido_por int REFERENCES nucleo.contatos(id),
    reconhecido_em  timestamptz
);

-- Todo alerta enviado fica registrado
CREATE TABLE IF NOT EXISTS nucleo.alertas (
    id          serial PRIMARY KEY,
    incidente_id int REFERENCES nucleo.incidentes(id) ON DELETE SET NULL,
    contato_id  int REFERENCES nucleo.contatos(id) ON DELETE SET NULL,
    canal       text NOT NULL,
    destino     text NOT NULL,
    mensagem    text NOT NULL,
    enviado_em  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- BASE DE CONHECIMENTO (RAG) - compartilhada por todas as IAs
-- dimensao 1536 = text-embedding-3-small (OpenAI)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nucleo.conhecimento (
    id          bigserial PRIMARY KEY,
    dominio     text NOT NULL DEFAULT 'geral',   -- ex: atendimento, sistemas, pessoal
    titulo      text,
    conteudo    text NOT NULL,
    origem      text,          -- manual | resposta_aprovada | documento
    aprovado    boolean NOT NULL DEFAULT true,
    embedding   vector(1536),
    metadata    jsonb NOT NULL DEFAULT '{}',
    criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conhecimento_embedding ON nucleo.conhecimento USING hnsw (embedding vector_cosine_ops);

-- Log de conversas (WhatsApp, Telegram, painel...) para revisar e aprender
CREATE TABLE IF NOT EXISTS nucleo.conversas (
    id          bigserial PRIMARY KEY,
    canal       text NOT NULL,
    contato     text NOT NULL,      -- numero / chat_id
    agente      text NOT NULL,      -- qual IA respondeu
    papel       text NOT NULL CHECK (papel IN ('usuario','ia','humano')),
    mensagem    text NOT NULL,
    precisa_revisao boolean NOT NULL DEFAULT false,
    criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversas_canal ON nucleo.conversas (canal, contato, criado_em);

-- =====================================================================
-- FUNCAO DO MONITOR
-- Recebe o resultado dos checks: [{"sistema_id":1,"ok":true,"detalhe":"..."}]
-- Atualiza o estado e devolve UMA LINHA POR ALERTA A ENVIAR
-- (so quando muda de estado: caiu ou voltou). Regras fixas, sem IA.
-- =====================================================================
CREATE OR REPLACE FUNCTION nucleo.registrar_checks(checks jsonb)
RETURNS TABLE (
    incidente_id int, sistema text, evento text,
    contato_id int, canal text, destino text, mensagem text
)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
    c   jsonb;
    s   nucleo.sistemas%ROWTYPE;
    ok  boolean;
    det text;
    ev  text;
    inc int;
BEGIN
    FOR c IN SELECT * FROM jsonb_array_elements(checks) LOOP
        SELECT * INTO s FROM nucleo.sistemas WHERE id = (c->>'sistema_id')::int FOR UPDATE;
        CONTINUE WHEN NOT FOUND;
        ok  := (c->>'ok')::boolean;
        det := left(c->>'detalhe', 500);
        ev  := NULL;

        IF ok THEN
            IF s.estado = 'falha' THEN
                ev := 'voltou';
                UPDATE nucleo.incidentes SET fim = now()
                 WHERE sistema_id = s.id AND fim IS NULL
                 RETURNING id INTO inc;
            END IF;
            UPDATE nucleo.sistemas SET estado = 'ok', falhas_seguidas = 0,
                   ultimo_detalhe = det, ultimo_check = now(), caiu_em = NULL
             WHERE id = s.id;
        ELSE
            UPDATE nucleo.sistemas SET falhas_seguidas = falhas_seguidas + 1,
                   ultimo_detalhe = det, ultimo_check = now()
             WHERE id = s.id;
            IF s.estado <> 'falha' AND s.falhas_seguidas + 1 >= s.falhas_para_alertar THEN
                ev := 'caiu';
                UPDATE nucleo.sistemas SET estado = 'falha', caiu_em = now() WHERE id = s.id;
                INSERT INTO nucleo.incidentes (sistema_id, detalhe) VALUES (s.id, det)
                RETURNING id INTO inc;
            END IF;
        END IF;

        IF ev IS NOT NULL THEN
            -- gera e registra os alertas (1 por contato/canal) e devolve para envio
            RETURN QUERY
            WITH dest AS (
                SELECT DISTINCT ct.id AS cid, e.canal AS can,
                       CASE e.canal WHEN 'telegram' THEN ct.telegram_chat_id
                                    WHEN 'whatsapp' THEN ct.whatsapp
                                    ELSE ct.email END AS dst
                  FROM nucleo.escalonamento e
                  JOIN nucleo.contatos ct ON ct.id = e.contato_id AND ct.ativo
                 WHERE e.grupo IN (s.grupo, 'geral')
                   AND e.ordem = 1
            ), msg AS (
                SELECT CASE ev
                         WHEN 'caiu' THEN
                           '🔴 ' || s.nome || ' está FORA DO AR' || E'\n' ||
                           'URL: ' || s.url || E'\n' || 'Detalhe: ' || coalesce(det,'-')
                         ELSE
                           '🟢 ' || s.nome || ' VOLTOU ao normal' || E'\n' ||
                           'Ficou fora por ' ||
                           coalesce(to_char(now() - s.caiu_em, 'HH24"h"MI"min"'), '?')
                       END AS txt
            ), ins AS (
                INSERT INTO nucleo.alertas AS a (incidente_id, contato_id, canal, destino, mensagem)
                SELECT inc, d.cid, d.can, d.dst, m.txt
                  FROM dest d, msg m
                 WHERE d.dst IS NOT NULL
                RETURNING a.incidente_id, a.contato_id, a.canal, a.destino, a.mensagem
            )
            SELECT ins.incidente_id, s.nome, ev, ins.contato_id, ins.canal, ins.destino, ins.mensagem
              FROM ins;
        END IF;
    END LOOP;
END $$;

-- =====================================================================
-- EXEMPLO (troque pelos seus). O proprio n8n ja vem monitorado.
-- =====================================================================
INSERT INTO nucleo.sistemas (nome, url, falhas_para_alertar)
VALUES ('n8n (proprio)', 'http://localhost:5678/healthz', 2)
ON CONFLICT (nome) DO NOTHING;
