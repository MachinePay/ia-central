#!/usr/bin/env sh
# Gera credenciais + workflows a partir do .env e do gerador, importa e publica no n8n.
#   sh scripts/implantar.sh                 -> tudo (banco, admin, credenciais, todos os workflows)
#   sh scripts/implantar.sh cerebro api-painel  -> so esses workflows (mais rapido)
# Cada publicacao inicia o n8n CLI (~1 min cada).
set -e
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

TODOS="erros:errosGerais001 aprendiz:aprendiz000001 ferramenta-checar-agora:ferrChecarAgora1 ferramenta-abrir-chamado:ferrChamado0001 atendente-suporte:atendSuporte01 atendente-comercial:atendComercial1 atendente-sistemico:atendSistemico1 atendente:atendente00001 suporte24hrs:suporte24h0001 gabriel:gabriel000001 roteador:roteadorAg0001 monitor-sistemas:monitorSistemas01 ferramenta-enviar-mensagem:ferrEnviarMsg01 especialista-sistemas:espSistemas01 cerebro:iaCerebro00001 ia-pessoal:iaPessoal00001 api-painel:apiPainel00001 api-painel-audio:apiPainelAudio1 canal-whatsapp:canalWhatsapp01 lembretes:lembretes00001"

sh scripts/gerar-credenciais.sh
python scripts/montar_workflows.py

if [ $# -eq 0 ]; then
  for f in db/init/00-bancos.sql db/init/02-ia-pessoal.sql db/init/03-usuarios.sql db/init/04-whatsapp.sql db/init/05-plataformas.sql db/init/06-atendimento.sql db/init/07-observacao.sql db/init/08-dois-numeros.sql db/init/09-agentes.sql db/init/10-lote.sql db/init/11-saude.sql db/init/12-gabriel-chip.sql db/init/13-memorias-separadas.sql db/init/14-aprende-sozinho.sql db/init/15-conversa-com-dono.sql db/init/16-monitor-suspensos.sql db/init/17-perfis-contato.sql db/init/18-audio-espera.sql; do
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
# garante a ativacao (o restart logo depois do publish as vezes deixa algum inativo) - igual ao Render
IDS_SQL=$(for par in $ESCOLHIDOS; do printf "'%s'," "${par#*:}"; done | sed 's/,$//')
docker compose exec -T postgres sh -c "psql -q -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\" -c \"UPDATE workflow_entity SET active = true, \\\"activeVersionId\\\" = \\\"versionId\\\" WHERE id IN ($IDS_SQL)\""
docker compose restart n8n >/dev/null
for i in $(seq 40); do curl -s localhost:5678/healthz >/dev/null 2>&1 && break; sleep 3; done
for i in $(seq 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:5678/webhook/whatsapp -d '{}')" != "404" ] && break; sleep 3; done
INATIVOS=$(docker compose exec -T postgres sh -c 'psql -tA -U "$POSTGRES_USER" "$POSTGRES_DB" -c "SELECT string_agg(name, '"'"', '"'"') FROM workflow_entity WHERE NOT active"')
[ -n "$INATIVOS" ] && echo "ATENCAO, inativos: $INATIVOS"
echo "pronto: workflows importados e publicados"
