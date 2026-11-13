-- =====================================================================
-- IA Central - IA PESSOAL
-- Pode rodar de novo sem problema (idempotente).
-- =====================================================================

-- Quem e o dono da IA (recebe lembretes e mensagens sem destinatario)
ALTER TABLE nucleo.contatos ADD COLUMN IF NOT EXISTS dono boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS contatos_um_dono ON nucleo.contatos (dono) WHERE dono;

-- Lembretes criados pela IA. contato NULL = dono.
CREATE TABLE IF NOT EXISTS nucleo.lembretes (
    id          serial PRIMARY KEY,
    texto       text NOT NULL,
    quando      timestamptz NOT NULL,
    contato     text,
    criado_em   timestamptz NOT NULL DEFAULT now(),
    enviado_em  timestamptz
);
CREATE INDEX IF NOT EXISTS lembretes_pendentes ON nucleo.lembretes (quando) WHERE enviado_em IS NULL;

-- Busca por palavras na memoria (sem precisar de embeddings), ignorando acentos
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE INDEX IF NOT EXISTS conhecimento_fts ON nucleo.conhecimento
    USING gin (to_tsvector('portuguese', coalesce(titulo,'') || ' ' || conteudo));
