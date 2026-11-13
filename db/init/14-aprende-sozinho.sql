-- =====================================================================
-- IA Central - AS IAS APRENDEM SOZINHAS: o que o aprendiz tira das conversas ja entra valendo.
-- Voce so acompanha o historico (e pode mandar esquecer). Para voltar a revisar antes:
--   UPDATE nucleo.config SET valor = 'false' WHERE chave = 'aprender_sozinho';
-- Idempotente.
-- =====================================================================

INSERT INTO nucleo.config VALUES ('aprender_sozinho', 'true') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION nucleo.aprende_sozinho() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.origem IN ('observacao', 'observacao_leo', 'observacao_gabriel')
       AND coalesce((SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'aprender_sozinho'), 'true') = 'true' THEN
        NEW.aprovado := true;
        NEW.metadata := coalesce(NEW.metadata, '{}') || '{"automatico": true}';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aprende_sozinho ON nucleo.conhecimento;
CREATE TRIGGER aprende_sozinho BEFORE INSERT ON nucleo.conhecimento FOR EACH ROW EXECUTE FUNCTION nucleo.aprende_sozinho();

-- o que estava esperando revisao passa a valer (uma vez)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM nucleo.config WHERE chave = 'migracao_aprende_sozinho') THEN
        UPDATE nucleo.conhecimento SET aprovado = true, metadata = coalesce(metadata, '{}') || '{"automatico": true}'
         WHERE NOT aprovado AND origem IN ('observacao', 'observacao_leo', 'observacao_gabriel');
        INSERT INTO nucleo.config VALUES ('migracao_aprende_sozinho', 'true');
    END IF;
END $$;
