\set ON_ERROR_STOP on

SELECT current_user = :'migrator_role' AS correct_migrator_identity
\gset
\if :correct_migrator_identity
\else
  \echo 'permission lockdown must run as the configured SkyView migrator role'
  \quit 1
\endif

SELECT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = :'runtime_role'
      AND rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolinherit
      AND NOT rolreplication
      AND NOT rolbypassrls
) AS runtime_role_is_restricted
\gset
\if :runtime_role_is_restricted
\else
  \echo 'runtime role is missing or has unsafe PostgreSQL role attributes'
  \quit 1
\endif

SELECT pg_get_userbyid(datdba) = current_user AS migrator_owns_database
FROM pg_database
WHERE datname = current_database()
\gset
\if :migrator_owns_database
\else
  \echo 'migrator role must own the SkyView database'
  \quit 1
\endif

SELECT pg_get_userbyid(nspowner) = current_user AS migrator_owns_public_schema
FROM pg_namespace
WHERE nspname = 'public'
\gset
\if :migrator_owns_public_schema
\else
  \echo 'migrator role must own the public schema'
  \quit 1
\endif

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('skyviewlab:runtime-permission-lockdown'));

-- No non-admin service identity may inherit or expose another role. Attempt
-- to remove every edge touching one of the five service roles. This migrator
-- intentionally has no CREATEROLE; if it lacks ADMIN OPTION for a drifted
-- edge, REVOKE aborts release and requires administrator remediation.
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

SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), :'runtime_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role')
\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', :'runtime_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role')
\gexec

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_role')
\gexec
-- Strip grants to every third-party role as well. The exact reviewed table ACL
-- graph permits only the relation owner and the dedicated runtime identity.
SELECT DISTINCT format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
    namespace.nspname, relation.relname, grantee_role.rolname
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) table_acl
JOIN pg_roles grantee_role ON grantee_role.oid = table_acl.grantee
JOIN pg_roles runtime_role ON runtime_role.rolname = :'runtime_role'
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND table_acl.grantee NOT IN (relation.relowner, runtime_role.oid)
\gexec
-- MAINTAIN was added in PostgreSQL 17. Keep the SQL parseable on the supported
-- PostgreSQL 15/16 baseline while explicitly revoking it when available.
SELECT 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM PUBLIC'
WHERE current_setting('server_version_num')::integer >= 170000
\gexec
SELECT format('REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM %I', :'runtime_role')
WHERE current_setting('server_version_num')::integer >= 170000
\gexec

-- Table-level REVOKE is expected to clear matching column grants as well, but
-- enumerate every user column explicitly so a future PostgreSQL/DDL change
-- cannot leave an effective column ACL outside the reviewed table matrix.
SELECT format(
    'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC',
    attribute.attname,
    namespace.nspname,
    relation.relname
)
FROM pg_catalog.pg_attribute attribute
JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
\gexec
SELECT format(
    'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
    attribute.attname,
    namespace.nspname,
    relation.relname,
    :'runtime_role'
)
FROM pg_catalog.pg_attribute attribute
JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
\gexec
SELECT DISTINCT format(
    'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
    attribute.attname,
    namespace.nspname,
    relation.relname,
    grantee_role.rolname
)
FROM pg_catalog.pg_attribute attribute
JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
CROSS JOIN LATERAL aclexplode(attribute.attacl) column_acl
JOIN pg_roles grantee_role ON grantee_role.oid = column_acl.grantee
JOIN pg_roles runtime_role ON runtime_role.rolname = :'runtime_role'
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
  AND column_acl.grantee NOT IN (relation.relowner, runtime_role.oid)
\gexec

-- This is the reviewed production-runtime DML matrix. Adding a migration table
-- requires an explicit entry here and in verify-skyview-privileges.sql.
WITH reviewed_grants(table_name, privileges) AS (
    VALUES
        ('schema_migrations', 'SELECT'),
		('runtime_security_contracts', 'SELECT'),
        ('tenants', 'SELECT'),
        ('users', 'SELECT'),
        ('workspaces', 'SELECT'),
        ('memberships', 'SELECT'),
        ('projects', 'SELECT, INSERT, UPDATE, DELETE'),
        ('project_versions', 'SELECT, INSERT'),
        ('sessions', 'SELECT, INSERT, UPDATE, DELETE'),
        ('jobs', 'SELECT, INSERT, UPDATE'),
        ('workbench_runs', 'SELECT, INSERT, UPDATE'),
        ('workbench_states', 'SELECT, INSERT, UPDATE'),
        ('shared_records', 'SELECT, INSERT, UPDATE, DELETE'),
        ('audit_events', 'SELECT'),
        ('audit_heads', 'SELECT'),
        ('oidc_identities', 'SELECT, INSERT, UPDATE'),
        ('oidc_login_transactions', 'SELECT, INSERT, DELETE'),
        ('outbox_events', 'SELECT, INSERT, UPDATE')
)
SELECT format('GRANT %s ON TABLE public.%I TO %I', privileges, table_name, :'runtime_role')
FROM reviewed_grants
WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL
\gexec

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', :'runtime_role')
\gexec

-- Exact sequence grant allowlist. It is intentionally empty today because no
-- migration uses SERIAL, IDENTITY, CREATE SEQUENCE, or nextval. Future entries
-- must be reviewed in this script, the runtime startup gate, and the live
-- verifier; never replace this with an ALL SEQUENCES grant.
WITH reviewed_sequence_grants(sequence_name, privileges) AS (
    SELECT NULL::text, NULL::text WHERE false
)
SELECT format('GRANT %s ON SEQUENCE public.%I TO %I', privileges, sequence_name, :'runtime_role')
FROM reviewed_sequence_grants
WHERE to_regclass(format('public.%I', sequence_name)) IS NOT NULL
\gexec

-- The application schema has an exact routine inventory. Extension routines
-- are only permitted through a reviewed (extension, identity) allowlist; that
-- allowlist is intentionally empty today. Refuse to bless an unexpected
-- function/procedure, an extension-installed routine, or a non-migrator owner.
DO $public_function_inventory$
BEGIN
    IF (
        SELECT count(*)
        FROM pg_proc function_entry
        JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
        WHERE namespace.nspname = 'public'
    ) <> 6 OR (
        SELECT count(*)
        FROM pg_proc function_entry
        JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
        WHERE namespace.nspname = 'public'
          AND function_entry.prokind = 'f'
          AND function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')' IN (
              'reject_audit_event_mutation()',
              'validate_audit_event_chain_insert()',
              'reject_identity_column_mutation()',
              'resolve_session_identity_v1(text)',
              'audit_chain_v3_frame(text, text)',
              'append_audit_event_v3(text, text, text, text, text, text, text, text, text, text, text, text, text, text)'
          )
          AND function_entry.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND NOT EXISTS (
              SELECT 1
              FROM pg_depend extension_dependency
              WHERE extension_dependency.classid = 'pg_proc'::regclass
                AND extension_dependency.objid = function_entry.oid
                AND extension_dependency.refclassid = 'pg_extension'::regclass
                AND extension_dependency.deptype = 'e'
          )
    ) <> 6 THEN
        RAISE EXCEPTION 'public function inventory, extension ownership, or migrator ownership drifted';
    END IF;
END;
$public_function_inventory$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'runtime_role')
\gexec

-- Remove every named third-party grant from every reviewed public function.
-- CASCADE also removes dependent grants made through an improperly delegated
-- grant option. The exact-inventory check above prevents unknown routines from
-- being silently normalized by this cleanup.
SELECT DISTINCT format(
    'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
    function_entry.oid::regprocedure,
    grantee_role.rolname
)
FROM pg_proc function_entry
JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(function_entry.proacl, acldefault('f', function_entry.proowner))) function_acl
JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
WHERE namespace.nspname = 'public'
  AND function_acl.grantee <> function_entry.proowner
\gexec

-- These are the only SECURITY DEFINER entry points exposed to runtime. Remove
-- every third-party EXECUTE ACL on the exact signatures before regranting the
-- dedicated runtime role.
WITH secured_runtime_functions(function_oid) AS (
    VALUES
        (to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)')),
        (to_regprocedure('public.resolve_session_identity_v1(text)'))
)
SELECT DISTINCT format(
    'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
    function_entry.oid::regprocedure,
    grantee_role.rolname
)
FROM secured_runtime_functions secured
JOIN pg_proc function_entry ON function_entry.oid = secured.function_oid
CROSS JOIN LATERAL aclexplode(COALESCE(function_entry.proacl, acldefault('f', function_entry.proowner))) function_acl
JOIN pg_roles grantee_role ON grantee_role.oid = function_acl.grantee
JOIN pg_roles runtime_role ON runtime_role.rolname = :'runtime_role'
WHERE function_acl.grantee NOT IN (function_entry.proowner, runtime_role.oid)
\gexec

DO $secured_runtime_functions_required$
BEGIN
    IF pg_catalog.to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NULL THEN
        RAISE EXCEPTION 'secured audit append function is missing';
    END IF;
    IF pg_catalog.to_regprocedure('public.resolve_session_identity_v1(text)') IS NULL THEN
        RAISE EXCEPTION 'secured session identity resolver is missing';
    END IF;
    IF pg_catalog.to_regprocedure('public.append_audit_event_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'obsolete v2 audit append function is still deployed';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc function_entry
        WHERE function_entry.oid IN (
            pg_catalog.to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
            pg_catalog.to_regprocedure('public.resolve_session_identity_v1(text)')
        )
          AND function_entry.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
    ) THEN
        RAISE EXCEPTION 'secured runtime function owner is not the migrator';
    END IF;
END;
$secured_runtime_functions_required$;

SELECT format(
    'GRANT EXECUTE ON FUNCTION public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text) TO %I',
    :'runtime_role'
)
\gexec
SELECT format(
    'GRANT EXECUTE ON FUNCTION public.resolve_session_identity_v1(text) TO %I',
    :'runtime_role'
)
\gexec

-- The migration ledger is runtime-readable for checksum validation, never
-- runtime-writable.
SELECT format('REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM %I', :'runtime_role')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec
SELECT format('GRANT SELECT ON TABLE public.schema_migrations TO %I', :'runtime_role')
WHERE to_regclass('public.schema_migrations') IS NOT NULL
\gexec

-- Audit storage is directly read-only to the runtime. Appends can only pass
-- through the reviewed SECURITY DEFINER function above.
SELECT format(
    'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_events FROM %I',
    :'runtime_role'
)
WHERE to_regclass('public.audit_events') IS NOT NULL
\gexec
SELECT format('GRANT SELECT ON TABLE public.audit_events TO %I', :'runtime_role')
WHERE to_regclass('public.audit_events') IS NOT NULL
\gexec

SELECT format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_heads FROM %I', :'runtime_role')
WHERE to_regclass('public.audit_heads') IS NOT NULL
\gexec
SELECT format('GRANT SELECT ON TABLE public.audit_heads TO %I', :'runtime_role')
WHERE to_regclass('public.audit_heads') IS NOT NULL
\gexec

-- Future objects receive no runtime grants until this script and its verifier
-- are deliberately updated and rerun after their migration.
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
COMMIT;
