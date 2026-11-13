#!/bin/sh
# Inicio do n8n no Render: prepara banco/admin/credenciais, importa e ativa os workflows, sobe o n8n.
set -e

# endereco publico (o Render informa em RENDER_EXTERNAL_URL)
if [ -z "$WEBHOOK_URL" ] && [ -n "$RENDER_EXTERNAL_URL" ]; then
  export WEBHOOK_URL="$RENDER_EXTERNAL_URL/"
fi

if [ -n "$BANCO_URL" ]; then
  eval "$(node /opt/ia/preparar.js --env)"
fi

node /opt/ia/preparar.js
n8n import:credentials --input=/tmp/credenciais.json
rm -f /tmp/credenciais.json
n8n import:workflow --separate --input=/opt/ia/workflows
node /opt/ia/preparar.js --ativar
echo "[ia-central] workflows importados e ativados; subindo o n8n em $WEBHOOK_URL"

exec /docker-entrypoint.sh "$@"
