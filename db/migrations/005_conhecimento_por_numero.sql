-- Cada numero aprende so com as proprias conversas: o conhecimento passa a ter o numero de origem.
-- NULL = vale para todos os numeros (so o que for escrito no painel marcado como "todos").
ALTER TABLE app.knowledge_chunks ADD COLUMN IF NOT EXISTS instance text;
CREATE INDEX IF NOT EXISTS kb_instance ON app.knowledge_chunks (instance);

-- o sistema antigo aprendia observando o chip do Joao
UPDATE app.knowledge_chunks SET instance = 'joao' WHERE source LIKE 'legado:%' AND instance IS NULL;

-- o que o aprendiz novo guardou ate agora nao tinha numero: reestuda as mesmas conversas ja separando
DELETE FROM app.knowledge_chunks WHERE source = 'aprendido:equipe';
UPDATE app.messages SET learned_at = NULL WHERE learned_at IS NOT NULL;

-- perguntas sem resposta tambem por numero
ALTER TABLE app.knowledge_gaps ADD COLUMN IF NOT EXISTS instance text;
