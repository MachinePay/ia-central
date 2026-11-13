#!/usr/bin/env sh
# Gera credenciais + workflows a partir do .env e do gerador, importa e publica no n8n.
#   sh scripts/implantar.sh                 -> tudo (banco, admin, credenciais, todos os workflows)
#   sh scripts/implantar.sh cerebro api-painel  -> so esses workflows (mais rapido)
# Cada publicacao inicia o n8n CLI (~1 min cada).
set -e
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

TODOS="aprendiz:aprendiz000001 ferramenta-checar-agora:ferrChecarAgora1 ferramenta-abrir-chamado:ferrChamado0001 atendente-suporte:atendSuporte01 atendente-comercial:atendComercial1 atendente-sistemico:atendSistemico1 atendente:atendente00001 monitor-sistemas:monitorSistemas01 ferramenta-enviar-mensagem:ferrEnviarMsg01 especialista-sistemas:espSistemas01 cerebro:iaCerebro00001 ia-pessoal:iaPessoal00001 api-painel:apiPainel00001 api-painel-audio:apiPainelAudio1 canal-whatsapp:canalWhatsapp01 lembretes:lembretes00001"

sh scripts/gerar-credenciais.sh
python scripts/montar_workflows.py

if [ $# -eq 0 ]; then
  for f in db/init/00-bancos.sql db/init/02-ia-pessoal.sql db/init/03-usuarios.sql db/init/04-whatsapp.sql db/init/05-plataformas.sql db/init/06-atendimento.sql db/init/07-observacao.sql db/init/08-dois-numeros.sql; do
    docker compose exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"' < "$f" 2>&1 | grep -v NOTICE || true
  done
  sh scripts/criar-admin.sh
  ESCOLHIDOS="$TODOS"
else
  ESCOLHIDOS=""
  for nome in "$@"; do
    par=$(echo "$TODOS" | tr ' ' '\n' | grep "^$nome:" || true)
    [ -n "$par" ] || { echo "workflow desconhecido: $nome"; exit 1; }
    ESCOLHIDOS="$ESCOLHIDOS $par"
  done
fi

# ordem importa: sub-workflows antes de quem chama (a lista TODOS ja esta nessa ordem)
docker compose exec -T n8n sh -c '
  n8n import:credentials --input=/import/workflows/credenciais.json 2>&1 | grep -iE "success|error"
  for par in '"$ESCOLHIDOS"'; do
    f=${par%%:*}
    n8n import:workflow --input=/import/workflows/$f.json 2>&1 | grep -iE "success|error" | sed "s/^/$f: /"
  done
  for par in '"$ESCOLHIDOS"'; do
    n8n publish:workflow --id=${par#*:} 2>&1 | grep -iE "publishing|error"
  done'
docker compose restart n8n >/dev/null
for i in $(seq 40); do curl -s localhost:5678/healthz >/dev/null 2>&1 && break; sleep 3; done
echo "pronto: workflows importados e publicados"
