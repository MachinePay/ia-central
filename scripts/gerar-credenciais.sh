#!/usr/bin/env sh
# Gera workflows/credenciais.json a partir do .env (Postgres + Anthropic + OpenAI).
# Depois: docker compose exec n8n n8n import:credentials --input=/import/workflows/credenciais.json
# Reimportar atualiza as credenciais existentes (mesmo id).
set -e
cd "$(dirname "$0")/.."
. ./.env
cat > workflows/credenciais.json <<JSON
[
  {
    "id": "pgNucleo01",
    "name": "Postgres Nucleo",
    "type": "postgres",
    "data": {
      "host": "postgres", "port": 5432, "database": "${POSTGRES_DB}",
      "user": "${POSTGRES_USER}", "password": "${POSTGRES_PASSWORD}",
      "ssl": "disable", "allowUnauthorizedCerts": false, "sshTunnel": false
    }
  },
  {
    "id": "anthropic01",
    "name": "Anthropic",
    "type": "anthropicApi",
    "data": { "apiKey": "${ANTHROPIC_API_KEY}" }
  },
  {
    "id": "openai01",
    "name": "OpenAI",
    "type": "openAiApi",
    "data": { "apiKey": "${OPENAI_API_KEY}" }
  }
]
JSON
echo "workflows/credenciais.json gerado"
