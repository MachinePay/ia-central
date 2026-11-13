# WhatsApp (Evolution API) da IA Central no Render.
# Usa o mesmo banco do n8n num schema separado e a chave compartilhada EVOLUTION_API_KEY.
FROM evoapicloud/evolution-api:v2.3.7
ENTRYPOINT ["/bin/bash", "-c", "export DATABASE_CONNECTION_URI=\"${BANCO_URL}?schema=evolution\"; export AUTHENTICATION_API_KEY=\"${EVOLUTION_API_KEY}\"; . ./Docker/scripts/deploy_database.sh && npm run start:prod"]
