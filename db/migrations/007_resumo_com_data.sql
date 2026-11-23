-- Quando o resumo da conversa foi feito: a IA so trata como recente o que e de hoje.
ALTER TABLE app.threads ADD COLUMN IF NOT EXISTS summary_at timestamptz;
UPDATE app.threads SET summary_at = updated_at WHERE summary IS NOT NULL AND summary_at IS NULL;
