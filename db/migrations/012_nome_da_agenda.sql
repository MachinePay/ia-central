-- Nome que o dono de cada numero salvou na agenda do celular (vem do WhatsApp quando os contatos sincronizam)
CREATE TABLE IF NOT EXISTS app.contact_names (
  instance   text NOT NULL,
  phone      text NOT NULL,
  name       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance, phone)
);

-- conversas importadas do sistema antigo ficaram sem a data da ultima mensagem de cada lado
UPDATE app.threads t SET
  last_outbound_at = greatest(t.last_outbound_at, x.out_at),
  last_inbound_at = greatest(t.last_inbound_at, x.in_at)
FROM (
  SELECT thread_id,
         max(created_at) FILTER (WHERE direction = 'OUTBOUND' AND status NOT IN ('DRAFT', 'DRAFT_DISCARDED')) AS out_at,
         max(created_at) FILTER (WHERE direction = 'INBOUND') AS in_at
    FROM app.messages GROUP BY thread_id
) x
WHERE x.thread_id = t.id;
