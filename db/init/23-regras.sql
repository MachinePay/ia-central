-- =====================================================================
-- IA Central - REGRAS DO DONO
--  - pedido de agendar/confirmar evento: a IA NAO responde a pessoa; registra e avisa o dono para ele responder.
-- Idempotente.
-- =====================================================================

CREATE OR REPLACE FUNCTION nucleo.agente_nao_responder(p_agente text, p_numero text, p_pergunta text, p_nome text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
    PERFORM nucleo.registrar_evento(p_agente, 'aviso', 'Pedido de agendamento: a IA nao respondeu (responda voce)',
        p_pergunta, jsonb_build_object('numero', p_numero, 'mensagem', left(p_pergunta, 300)));
    RETURN jsonb_build_object('enviar', false, 'pulou', true, 'agente', p_agente, 'numero', p_numero, 'nome', p_nome,
        'pergunta', left(p_pergunta, 500),
        'avisar', coalesce((SELECT jsonb_agg(whatsapp) FROM nucleo.usuarios WHERE papel = 'admin' AND ativo AND whatsapp IS NOT NULL), '[]'));
END $$;
