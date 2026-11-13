#!/usr/bin/env sh
# Cria/atualiza o admin maximo a partir do .env (ADMIN_LOGIN / ADMIN_SENHA / ADMIN_NOME)
# e passa para ele os dados antigos que ainda nao tinham dono.
set -e
cd "$(dirname "$0")/.."
. ./.env
docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q \
  -v nome="${ADMIN_NOME:-Admin}" -v login="$ADMIN_LOGIN" -v senha="$ADMIN_SENHA" <<'SQL'
SELECT nucleo.salvar_usuario(:'nome', :'login', :'senha', 'admin') AS admin_id \gset
UPDATE nucleo.conhecimento SET usuario_id = :admin_id WHERE usuario_id IS NULL;
UPDATE nucleo.lembretes    SET usuario_id = :admin_id WHERE usuario_id IS NULL;
UPDATE nucleo.contatos     SET usuario_id = :admin_id WHERE usuario_id IS NULL;
UPDATE nucleo.conversas    SET usuario_id = :admin_id WHERE usuario_id IS NULL;
SQL
echo "admin '$ADMIN_LOGIN' pronto"
