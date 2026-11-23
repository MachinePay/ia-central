-- Aprendiz: marca as respostas da equipe ja estudadas
ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS learned_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_to_learn ON app.messages (created_at)
  WHERE direction = 'OUTBOUND' AND sender = 'HUMAN' AND learned_at IS NULL;
