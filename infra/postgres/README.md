# PostgreSQL identity boundary

SkyView uses two PostgreSQL login roles in production:

| Identity | Lifetime | Effective authority |
| --- | --- | --- |
| `SKYVIEW_DB_MIGRATOR_USER` | Controlled release job only | Owns the `skyviewlab` database, `public` schema, migrations, tables and functions. Applies checked migrations and the permission-lockdown SQL. |
| `SKYVIEW_DB_RUNTIME_USER` | Go API runtime only | `CONNECT` on `skyviewlab`, `USAGE` on `public`, reviewed DML, and sequence `USAGE`/`SELECT`. It owns no database objects and cannot create schemas or temporary tables. The independent Worker never receives this credential. |

`POSTGRES_USER` is bootstrap administration only. Keycloak, OpenFGA and Temporal each retain a different login and own only their respective database(s). The initializer rejects duplicate role names and explicitly applies `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION` and `NOBYPASSRLS` to every service login.

The approved PostgreSQL image must be version 15 or newer. The initializer uses psql's `\getenv` so database passwords never appear in command-line arguments; it refuses an older image rather than falling back to unsafe interpolation.

## Secret contract

The PostgreSQL administrator and both SkyView identities use Compose secret files. Each file contains exactly one non-empty password and is excluded by `infra/.gitignore`:

- `POSTGRES_PASSWORD_FILE`
- `SKYVIEW_DB_MIGRATOR_PASSWORD_FILE`
- `SKYVIEW_DB_RUNTIME_PASSWORD_FILE`

The file paths belong in `infra/.env`; secret contents do not. `SKYVIEW_DB_USER` and `SKYVIEW_DB_PASSWORD` are intentionally rejected because a single owner/runtime identity cannot meet the least-privilege gate. Keycloak, OpenFGA and Temporal variables are independent bootstrap credentials; a production orchestrator should inject them through its secret manager rather than commit them to an env file.

## Release order

1. Run the checked Go migrations with `DEV_MODE=false`, `DATABASE_MIGRATE=true`, and a `DATABASE_URL` for `SKYVIEW_DB_MIGRATOR_USER`. The URL must include `sslmode=verify-full` and a pinned `options=-csearch_path%3Dpg_catalog%2Cpublic`. This is a migration-only process: it exits after applying checksum migrations and never starts HTTP or reads service credentials. Never expose this URL to a long-running service.
2. Apply the reviewed ACLs:

   `docker compose --env-file .env -f compose.foundation.yml --profile release run --rm skyview-permission-lockdown`

3. Prove the runtime identity has no excess privileges:

   `docker compose --env-file .env -f compose.foundation.yml --profile release run --rm skyview-permission-verify`

4. Start only the Go API with a separately mounted `DATABASE_URL` for `SKYVIEW_DB_RUNTIME_USER`, the same pinned search path, and `DATABASE_MIGRATE=false`. Before listening, the API independently checks `current_user`, dangerous role attributes, memberships, ownership, exact table DML, table-administration privileges, sequence privileges, function execution, the append-only audit ACL, and the read-only migration ledger. A missing, stale, or excessive grant fails startup. Start `cmd/worker` with only its control-plane URL and own Worker identity/token; do not mount any database Secret into it.

The lockdown is transactional and idempotent. It uses a per-table DML matrix derived from the production code paths: for example, `schema_migrations` is read-only, `project_versions` is `SELECT` plus `INSERT`, and OIDC login transactions can be inserted/read/deleted but not updated. Table and column ACLs are checked separately; unknown views, materialized views, foreign tables, sequences, policies and functions fail closed. Both `audit_events` and `audit_heads` are directly read-only. Runtime may execute only two exact migrator-owned `SECURITY DEFINER` signatures: `append_audit_event_v3` for RLS-context-bound, length-framed audit appends and `resolve_session_identity_v1` for one-digest session resolution. The verifier proves exact owner/runtime ACLs, no runtime grant option, fixed search paths, no PUBLIC or third-party execution, an exact public-function inventory, and empty role-membership edges in both directions for all five non-admin service roles. Future relations, columns, policies, sequences and functions receive no runtime grants until the matrix and verifier are reviewed and rerun.

Migrations 009, 011, and 012 are stop-the-world security transitions, not mixed-version rolling migrations: drain old API writers, run migrations as the migrator, apply lockdown, pass the live verifier as runtime, and only then start instances that use the v3 secured writer and transaction-local RLS context. Before any PG012 DDL or contract reseal, the migration verifies the PG011 sealed ledger bidirectionally against every public policy, function, and non-internal trigger; missing, extra, null, or drifted definitions abort the upgrade. Historical v1/v2 rows remain verifiable and immutable; PG006 legacy-v1 verification still validates every digest and topology edge while recovering only the 1,000 nanosecond values that pgx could have truncated into each stored microsecond. The in-process recovery limit is 10,000 legacy events; a larger database must remain offline while a restored snapshot is fully preflighted and benchmarked before an approved migration window.

## Fresh cluster versus an existing volume

`init-databases.sh` runs only when the official PostgreSQL entrypoint initializes an empty `PGDATA`. Changing `.env` does not alter roles, ownership or ACLs in an existing volume.

For an existing volume, use a maintenance window and a tested backup/PITR restore point. A DBA must inventory ownership and grants, create the two restricted roles, transfer only SkyView-owned database/schema/table/sequence/function objects to the migrator, run the checked migrations as the migrator, apply lockdown, run verification as the runtime identity, switch application credentials, and finally remove login and grants from the legacy role. This transition is deliberately not automated with a blanket `REASSIGN OWNED`: extensions or manually created objects may have different owners, and silently transferring them would cross the reviewed scope.

Both first deployment and an existing-volume transition remain blocked until the live privilege verifier passes. Static checks only validate the repository contract; they do not replace the live PostgreSQL proof.
