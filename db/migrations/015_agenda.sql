-- Agenda de cada IA: compromissos (com dia e hora), tarefas (sem data ou com prazo) e anotacoes
CREATE TABLE IF NOT EXISTS app.agenda (
  id             bigserial PRIMARY KEY,
  instance       text NOT NULL,                 -- de qual IA (numero) e o calendario
  kind           text NOT NULL,                 -- evento | tarefa | nota
  title          text NOT NULL,
  notes          text,
  due_at         timestamptz,                   -- dia e hora (evento) ou prazo (tarefa)
  all_day        boolean NOT NULL DEFAULT false,
  remind_minutes int[] NOT NULL DEFAULT '{1440,60}',
  reminded       int[] NOT NULL DEFAULT '{}',
  done_at        timestamptz,
  created_via    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_instance_due_idx ON app.agenda (instance, due_at);
