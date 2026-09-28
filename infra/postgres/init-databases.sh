#!/usr/bin/env sh
set -eu

fail() {
  echo "postgres bootstrap failed: $1" >&2
  exit 1
}

require_value() {
  variable_name="$1"
  variable_value="$2"
  [ -n "$variable_value" ] || fail "required environment variable is empty: $variable_name"
}

read_secret_file() {
  variable_name="$1"
  secret_file="$2"
  require_value "$variable_name" "$secret_file"
  [ -f "$secret_file" ] || fail "$variable_name does not reference a regular file"
  [ -r "$secret_file" ] || fail "$variable_name is not readable"

  secret_value="$(cat "$secret_file")"
  [ -n "$secret_value" ] || fail "$variable_name references an empty secret"
  printf '%s' "$secret_value"
}

assert_different_roles() {
  left_name="$1"
  left_value="$2"
  right_name="$3"
  right_value="$4"
  [ "$left_value" != "$right_value" ] || fail "$left_name and $right_name must identify different PostgreSQL roles"
}

if [ -n "${SKYVIEW_DB_USER:-}" ] || [ -n "${SKYVIEW_DB_PASSWORD:-}" ]; then
  fail "legacy SKYVIEW_DB_USER/SKYVIEW_DB_PASSWORD is forbidden; configure separate SKYVIEW_DB_MIGRATOR_* and SKYVIEW_DB_RUNTIME_* identities"
fi

require_value POSTGRES_USER "${POSTGRES_USER:-}"
require_value SKYVIEW_DB_MIGRATOR_USER "${SKYVIEW_DB_MIGRATOR_USER:-}"
require_value SKYVIEW_DB_RUNTIME_USER "${SKYVIEW_DB_RUNTIME_USER:-}"
require_value KEYCLOAK_DB_USER "${KEYCLOAK_DB_USER:-}"
require_value KEYCLOAK_DB_PASSWORD "${KEYCLOAK_DB_PASSWORD:-}"
require_value OPENFGA_DB_USER "${OPENFGA_DB_USER:-}"
require_value OPENFGA_DB_PASSWORD "${OPENFGA_DB_PASSWORD:-}"
require_value TEMPORAL_DB_USER "${TEMPORAL_DB_USER:-}"
require_value TEMPORAL_DB_PASSWORD "${TEMPORAL_DB_PASSWORD:-}"

skyview_migrator_password="$(read_secret_file SKYVIEW_DB_MIGRATOR_PASSWORD_FILE "${SKYVIEW_DB_MIGRATOR_PASSWORD_FILE:-}")"
skyview_runtime_password="$(read_secret_file SKYVIEW_DB_RUNTIME_PASSWORD_FILE "${SKYVIEW_DB_RUNTIME_PASSWORD_FILE:-}")"

# psql 15 introduced \getenv, which keeps role passwords out of process
# arguments and generated logs. Refuse an older image instead of weakening the
# secret-handling contract.
postgres_version_number="$(psql -X --tuples-only --no-align --username "$POSTGRES_USER" --dbname postgres --command 'SHOW server_version_num')"
case "$postgres_version_number" in
  ''|*[!0-9]*) fail "could not determine a numeric PostgreSQL server version" ;;
esac
[ "$postgres_version_number" -ge 150000 ] || fail "PostgreSQL 15 or newer is required"

assert_different_roles POSTGRES_USER "$POSTGRES_USER" SKYVIEW_DB_MIGRATOR_USER "$SKYVIEW_DB_MIGRATOR_USER"
assert_different_roles POSTGRES_USER "$POSTGRES_USER" SKYVIEW_DB_RUNTIME_USER "$SKYVIEW_DB_RUNTIME_USER"
assert_different_roles POSTGRES_USER "$POSTGRES_USER" KEYCLOAK_DB_USER "$KEYCLOAK_DB_USER"
assert_different_roles POSTGRES_USER "$POSTGRES_USER" OPENFGA_DB_USER "$OPENFGA_DB_USER"
assert_different_roles POSTGRES_USER "$POSTGRES_USER" TEMPORAL_DB_USER "$TEMPORAL_DB_USER"
assert_different_roles SKYVIEW_DB_MIGRATOR_USER "$SKYVIEW_DB_MIGRATOR_USER" SKYVIEW_DB_RUNTIME_USER "$SKYVIEW_DB_RUNTIME_USER"
assert_different_roles SKYVIEW_DB_MIGRATOR_USER "$SKYVIEW_DB_MIGRATOR_USER" KEYCLOAK_DB_USER "$KEYCLOAK_DB_USER"
assert_different_roles SKYVIEW_DB_MIGRATOR_USER "$SKYVIEW_DB_MIGRATOR_USER" OPENFGA_DB_USER "$OPENFGA_DB_USER"
assert_different_roles SKYVIEW_DB_MIGRATOR_USER "$SKYVIEW_DB_MIGRATOR_USER" TEMPORAL_DB_USER "$TEMPORAL_DB_USER"
assert_different_roles SKYVIEW_DB_RUNTIME_USER "$SKYVIEW_DB_RUNTIME_USER" KEYCLOAK_DB_USER "$KEYCLOAK_DB_USER"
assert_different_roles SKYVIEW_DB_RUNTIME_USER "$SKYVIEW_DB_RUNTIME_USER" OPENFGA_DB_USER "$OPENFGA_DB_USER"
assert_different_roles SKYVIEW_DB_RUNTIME_USER "$SKYVIEW_DB_RUNTIME_USER" TEMPORAL_DB_USER "$TEMPORAL_DB_USER"
assert_different_roles KEYCLOAK_DB_USER "$KEYCLOAK_DB_USER" OPENFGA_DB_USER "$OPENFGA_DB_USER"
assert_different_roles KEYCLOAK_DB_USER "$KEYCLOAK_DB_USER" TEMPORAL_DB_USER "$TEMPORAL_DB_USER"
assert_different_roles OPENFGA_DB_USER "$OPENFGA_DB_USER" TEMPORAL_DB_USER "$TEMPORAL_DB_USER"

create_login_role() {
  role_name="$1"
  role_password="$2"

  BOOTSTRAP_ROLE_PASSWORD="$role_password" psql -X --quiet --set ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname postgres \
    --set=role_name="$role_name" <<-'EOSQL'
\getenv role_password BOOTSTRAP_ROLE_PASSWORD
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_duration = off;
SET log_statement = 'none';
SET password_encryption = 'scram-sha-256';
SELECT format(
    'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    :'role_name', :'role_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec
SELECT format(
    'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
    :'role_name', :'role_password'
)
\gexec
EOSQL
}

create_owned_database() {
  role_name="$1"
  database_name="$2"

  psql -X --quiet --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --set=role_name="$role_name" --set=database_name="$database_name" <<-'EOSQL'
SELECT format('CREATE DATABASE %I OWNER %I TEMPLATE template0', :'database_name', :'role_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database_name')
\gexec
SELECT EXISTS (
    SELECT 1
    FROM pg_database database_entry
    JOIN pg_roles owner_role ON owner_role.oid = database_entry.datdba
    WHERE database_entry.datname = :'database_name'
      AND owner_role.rolname = :'role_name'
) AS database_owner_matches
\gset
\if :database_owner_matches
\else
  \echo 'database owner does not match the dedicated service role'
  \quit 1
\endif
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
EOSQL
}

create_login_role "$SKYVIEW_DB_MIGRATOR_USER" "$skyview_migrator_password"
create_login_role "$SKYVIEW_DB_RUNTIME_USER" "$skyview_runtime_password"
create_login_role "$KEYCLOAK_DB_USER" "$KEYCLOAK_DB_PASSWORD"
create_login_role "$OPENFGA_DB_USER" "$OPENFGA_DB_PASSWORD"
create_login_role "$TEMPORAL_DB_USER" "$TEMPORAL_DB_PASSWORD"

create_owned_database "$SKYVIEW_DB_MIGRATOR_USER" skyviewlab
create_owned_database "$KEYCLOAK_DB_USER" keycloak
create_owned_database "$OPENFGA_DB_USER" openfga
create_owned_database "$TEMPORAL_DB_USER" temporal
create_owned_database "$TEMPORAL_DB_USER" temporal_visibility

psql -X --quiet --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=migrator_role="$SKYVIEW_DB_MIGRATOR_USER" \
  --set=runtime_role="$SKYVIEW_DB_RUNTIME_USER" \
  --set=keycloak_role="$KEYCLOAK_DB_USER" \
  --set=openfga_role="$OPENFGA_DB_USER" \
  --set=temporal_role="$TEMPORAL_DB_USER" <<-'EOSQL'
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;
-- Service identities never inherit or expose another role. Bootstrap runs as
-- the administrator and therefore actively removes every inbound/outbound
-- membership edge, including memberships involving an unexpected low role.
WITH service_roles(role_name) AS (
  VALUES (:'migrator_role'), (:'runtime_role'), (:'keycloak_role'),
         (:'openfga_role'), (:'temporal_role')
)
SELECT DISTINCT format('REVOKE %I FROM %I', granted_role.rolname, member_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE granted_role.rolname IN (SELECT role_name FROM service_roles)
   OR member_role.rolname IN (SELECT role_name FROM service_roles)
\gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE skyviewlab FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE skyviewlab TO %I', :'runtime_role')
\gexec
SELECT format('ALTER ROLE %I IN DATABASE skyviewlab SET search_path TO pg_catalog, public', :'runtime_role')
\gexec
EOSQL

psql -X --quiet --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname skyviewlab \
  --set=migrator_role="$SKYVIEW_DB_MIGRATOR_USER" \
  --set=runtime_role="$SKYVIEW_DB_RUNTIME_USER" <<-'EOSQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migrator_role')
\gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role')
\gexec

-- New objects receive no runtime authority until the post-migration lockdown
-- step reviews them and grants the required operations. This fails closed if
-- that release step is missed.
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
    :'migrator_role', :'runtime_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC',
    :'migrator_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
    :'migrator_role', :'runtime_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC',
    :'migrator_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    :'migrator_role'
)
\gexec
SELECT format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I',
    :'migrator_role', :'runtime_role'
)
\gexec
EOSQL

unset skyview_migrator_password skyview_runtime_password postgres_version_number
