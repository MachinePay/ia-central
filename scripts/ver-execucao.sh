#!/usr/bin/env sh
# Mostra o que aconteceu na ultima execucao de um workflow. Uso: sh scripts/ver-execucao.sh <workflowId> [v]
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
docker compose exec -T postgres psql -U ia ia_central -tAc "select data from execution_data where \"executionId\" = (select max(id) from execution_entity where \"workflowId\"='$1')" > .ver-execucao.txt 2>/dev/null || true
docker compose cp .ver-execucao.txt n8n:/tmp/exec.txt >/dev/null 2>&1
docker compose cp scripts/.ver-execucao.js n8n:/tmp/exec.js >/dev/null 2>&1
docker compose exec -T n8n node /tmp/exec.js "$2"
