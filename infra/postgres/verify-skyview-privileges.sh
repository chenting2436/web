#!/usr/bin/env sh
set -eu

fail() {
  echo "SkyView runtime privilege verification failed: $1" >&2
  exit 1
}

if [ -n "${SKYVIEW_DB_USER:-}" ] || [ -n "${SKYVIEW_DB_PASSWORD:-}" ]; then
  fail "legacy SKYVIEW_DB_USER/SKYVIEW_DB_PASSWORD is forbidden"
fi

: "${SKYVIEW_DB_MIGRATOR_USER:?set SKYVIEW_DB_MIGRATOR_USER}"
: "${SKYVIEW_DB_RUNTIME_USER:?set SKYVIEW_DB_RUNTIME_USER}"
: "${SKYVIEW_DB_RUNTIME_PASSWORD_FILE:?set SKYVIEW_DB_RUNTIME_PASSWORD_FILE}"
: "${POSTGRES_USER:?set POSTGRES_USER}"
: "${KEYCLOAK_DB_USER:?set KEYCLOAK_DB_USER}"
: "${OPENFGA_DB_USER:?set OPENFGA_DB_USER}"
: "${TEMPORAL_DB_USER:?set TEMPORAL_DB_USER}"
: "${SKYVIEW_DB_NAME:=skyviewlab}"
: "${PGHOST:=postgres}"
: "${PGPORT:=5432}"

[ -f "$SKYVIEW_DB_RUNTIME_PASSWORD_FILE" ] || fail "runtime password path is not a regular file"
[ -r "$SKYVIEW_DB_RUNTIME_PASSWORD_FILE" ] || fail "runtime password file is not readable"
PGPASSWORD="$(cat "$SKYVIEW_DB_RUNTIME_PASSWORD_FILE")"
[ -n "$PGPASSWORD" ] || fail "runtime password file is empty"
export PGPASSWORD

script_directory=$(CDPATH= cd "$(dirname "$0")" && pwd)
psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
  --host "$PGHOST" --port "$PGPORT" \
  --username "$SKYVIEW_DB_RUNTIME_USER" --dbname "$SKYVIEW_DB_NAME" \
  --set=migrator_role="$SKYVIEW_DB_MIGRATOR_USER" \
  --set=runtime_role="$SKYVIEW_DB_RUNTIME_USER" \
  --set=administrator_role="$POSTGRES_USER" \
  --set=keycloak_role="$KEYCLOAK_DB_USER" \
  --set=openfga_role="$OPENFGA_DB_USER" \
  --set=temporal_role="$TEMPORAL_DB_USER" \
  --set=postgres_database=postgres \
  --set=template_database=template1 \
  --set=keycloak_database=keycloak \
  --set=openfga_database=openfga \
  --set=temporal_database=temporal \
  --set=temporal_visibility_database=temporal_visibility \
  --file "$script_directory/verify-skyview-privileges.sql"

unset PGPASSWORD
