\set ON_ERROR_STOP on

WITH reviewed_grants(table_name, can_select, can_insert, can_update, can_delete) AS (
    VALUES
        ('schema_migrations', true, false, false, false),
		('runtime_security_contracts', true, false, false, false),
        ('tenants', true, false, false, false),
        ('users', true, false, false, false),
        ('workspaces', true, false, false, false),
        ('memberships', true, false, false, false),
        ('projects', true, true, true, true),
        ('project_versions', true, true, false, false),
        ('sessions', true, true, true, true),
        ('jobs', true, true, true, false),
        ('workbench_runs', true, true, true, false),
        ('workbench_states', true, true, true, false),
        ('shared_records', true, true, true, true),
        ('audit_events', true, false, false, false),
        ('audit_heads', true, false, false, false),
        ('oidc_identities', true, true, true, false),
        ('oidc_login_transactions', true, true, false, true),
        ('outbox_events', true, true, true, false)
),
-- Exact sequence grant allowlist. No current migration consumes a sequence.
reviewed_sequence_grants(sequence_name, can_usage, can_select, can_update) AS (
    SELECT NULL::text, false, false, false WHERE false
),
reviewed_rls_policies(table_name, policy_name, policy_command) AS (
    VALUES
		('tenants', 'skyview_tenant_scope', 'r'),
		('users', 'skyview_user_scope', 'r'),
		('workspaces', 'skyview_workspace_scope', 'r'),
		('memberships', 'skyview_membership_scope', 'r'),
        ('projects', 'skyview_project_select_scope', 'r'),
        ('projects', 'skyview_project_insert_scope', 'a'),
        ('projects', 'skyview_project_update_scope', 'w'),
        ('projects', 'skyview_project_delete_scope', 'd'),
        ('project_versions', 'skyview_project_version_scope', '*'),
        ('sessions', 'skyview_session_scope', '*'),
        ('jobs', 'skyview_job_select_scope', 'r'),
        ('jobs', 'skyview_job_insert_scope', 'a'),
        ('jobs', 'skyview_job_update_scope', 'w'),
        ('workbench_runs', 'skyview_run_select_scope', 'r'),
        ('workbench_runs', 'skyview_run_insert_scope', 'a'),
        ('workbench_runs', 'skyview_run_update_scope', 'w'),
        ('shared_records', 'skyview_shared_record_select_scope', 'r'),
        ('shared_records', 'skyview_shared_record_insert_scope', 'a'),
        ('shared_records', 'skyview_shared_record_update_scope', 'w'),
        ('shared_records', 'skyview_shared_record_delete_scope', 'd'),
        ('audit_events', 'skyview_audit_event_scope', 'r'),
        ('audit_heads', 'skyview_audit_head_scope', 'r'),
        ('oidc_identities', 'skyview_oidc_identity_scope', '*'),
        ('outbox_events', 'skyview_outbox_select_scope', 'r'),
        ('outbox_events', 'skyview_outbox_insert_scope', 'a'),
        ('outbox_events', 'skyview_outbox_update_scope', 'w'),
        ('workbench_states', 'skyview_workbench_state_scope', '*')
),
reviewed_public_functions(function_identity, function_kind, extension_name, runtime_executable) AS (
    VALUES
        ('reject_audit_event_mutation()', 'f', NULL::text, false),
        ('validate_audit_event_chain_insert()', 'f', NULL::text, false),
        ('reject_identity_column_mutation()', 'f', NULL::text, false),
        ('resolve_session_identity_v1(text)', 'f', NULL::text, true),
        ('audit_chain_v3_frame(text, text)', 'f', NULL::text, false),
        ('append_audit_event_v3(text, text, text, text, text, text, text, text, text, text, text, text, text, text)', 'f', NULL::text, true)
),
live_public_functions(function_oid, function_identity, function_kind, extension_name, function_owner, function_acl) AS (
    SELECT
        function_entry.oid,
        function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')',
        function_entry.prokind::text,
        extension_entry.extname,
        function_entry.proowner,
        function_entry.proacl
    FROM pg_proc function_entry
    JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
    LEFT JOIN pg_depend extension_dependency
      ON extension_dependency.classid = 'pg_proc'::regclass
     AND extension_dependency.objid = function_entry.oid
     AND extension_dependency.refclassid = 'pg_extension'::regclass
     AND extension_dependency.deptype = 'e'
    LEFT JOIN pg_extension extension_entry ON extension_entry.oid = extension_dependency.refobjid
    WHERE namespace.nspname = 'public'
),
current_security_contracts(object_kind, object_identity, definition_hash) AS (
    SELECT
        'policy',
        relation.relname || '.' || policy.polname,
        encode(sha256(convert_to(array_to_string(ARRAY[
            policy.polcmd::text,
            policy.polpermissive::text,
            policy.polroles::text,
            COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''),
            COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
        ], chr(10)), 'UTF8')), 'hex')
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT
        'function',
        function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')',
        encode(sha256(convert_to(array_to_string(ARRAY[
            pg_get_userbyid(function_entry.proowner),
            function_entry.prosecdef::text,
            COALESCE(function_entry.proconfig::text, ''),
            pg_get_functiondef(function_entry.oid)
        ], chr(10)), 'UTF8')), 'hex')
    FROM pg_proc function_entry
    JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
    JOIN reviewed_public_functions reviewed
      ON reviewed.function_identity = function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')'
     AND reviewed.function_kind = function_entry.prokind::text
    WHERE namespace.nspname = 'public'
    UNION ALL
    SELECT
        'trigger',
        relation.relname || '.' || trigger_entry.tgname,
        encode(sha256(convert_to(array_to_string(ARRAY[
            trigger_entry.tgenabled::text,
            pg_get_triggerdef(trigger_entry.oid, true)
        ], chr(10)), 'UTF8')), 'hex')
    FROM pg_trigger trigger_entry
    JOIN pg_class relation ON relation.oid = trigger_entry.tgrelid
    WHERE relation.relnamespace = 'public'::regnamespace
      AND NOT trigger_entry.tgisinternal
),
checks AS (
    SELECT *
    FROM (VALUES
        ('connected identity is the runtime role', current_user = :'runtime_role'),
        ('runtime role has safe role attributes', EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname = current_user
              AND rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolinherit
              AND NOT rolreplication
              AND NOT rolbypassrls
        )),
        ('all service identities are distinct', (
            SELECT COUNT(DISTINCT role_name) = 6
            FROM (VALUES
                (:'administrator_role'),
                (:'migrator_role'),
                (:'runtime_role'),
                (:'keycloak_role'),
                (:'openfga_role'),
                (:'temporal_role')
            ) AS configured_roles(role_name)
        )),
        ('all non-admin service roles have safe attributes', (
            SELECT COUNT(*) = 5
               AND bool_and(
                   rolcanlogin
                   AND NOT rolsuper
                   AND NOT rolcreatedb
                   AND NOT rolcreaterole
                   AND NOT rolinherit
                   AND NOT rolreplication
                   AND NOT rolbypassrls
               )
            FROM pg_roles
            WHERE rolname IN (:'migrator_role', :'runtime_role', :'keycloak_role', :'openfga_role', :'temporal_role')
        )),
		('all non-admin service roles have no role memberships', NOT EXISTS (
			SELECT 1
			FROM pg_auth_members membership
			JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
			JOIN pg_roles member_role ON member_role.oid = membership.member
			WHERE granted_role.rolname IN (
				:'migrator_role', :'runtime_role', :'keycloak_role', :'openfga_role', :'temporal_role'
			)
			   OR member_role.rolname IN (
				:'migrator_role', :'runtime_role', :'keycloak_role', :'openfga_role', :'temporal_role'
			)
		)),
        ('runtime role has no granted role memberships', NOT EXISTS (
            SELECT 1
            FROM pg_auth_members membership
            JOIN pg_roles member_role ON member_role.oid = membership.member
            WHERE member_role.rolname = current_user
        )),
		('runtime role has no members', NOT EXISTS (
			SELECT 1
			FROM pg_auth_members membership
			JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
			WHERE granted_role.rolname = current_user
		)),
        ('runtime role cannot assume migrator role', NOT pg_has_role(current_user, :'migrator_role', 'USAGE')),
        ('runtime role can connect to SkyView database', has_database_privilege(current_user, current_database(), 'CONNECT')),
        ('runtime role cannot create in SkyView database', NOT has_database_privilege(current_user, current_database(), 'CREATE')),
        ('runtime role cannot create temporary tables', NOT has_database_privilege(current_user, current_database(), 'TEMPORARY')),
        ('runtime role is not the database owner', EXISTS (
            SELECT 1 FROM pg_database
            WHERE datname = current_database()
              AND pg_get_userbyid(datdba) <> current_user
        )),
        ('SkyView database is owned by migrator', EXISTS (
            SELECT 1 FROM pg_database
            WHERE datname = current_database()
              AND pg_get_userbyid(datdba) = :'migrator_role'
        )),
        ('runtime role can use public schema', has_schema_privilege(current_user, 'public', 'USAGE')),
        ('runtime role cannot create in public schema', NOT has_schema_privilege(current_user, 'public', 'CREATE')),
        ('runtime role cannot create in any application schema', NOT EXISTS (
            SELECT 1
            FROM pg_namespace
            WHERE nspname !~ '^pg_'
              AND nspname <> 'information_schema'
              AND has_schema_privilege(current_user, oid, 'CREATE')
        )),
        ('runtime role owns no application schema', NOT EXISTS (
            SELECT 1
            FROM pg_namespace
            WHERE nspname !~ '^pg_'
              AND nspname <> 'information_schema'
              AND pg_get_userbyid(nspowner) = current_user
        )),
        ('runtime search path is pinned',
            current_schemas(false) = ARRAY['pg_catalog'::name, 'public'::name]
            AND regexp_replace(current_setting('search_path'), '[[:space:]"]+', '', 'g') = 'pg_catalog,public'
        ),
        ('runtime role cannot connect to postgres database', NOT has_database_privilege(current_user, :'postgres_database', 'CONNECT')),
        ('runtime role cannot connect to template database', NOT has_database_privilege(current_user, :'template_database', 'CONNECT')),
        ('runtime role cannot connect to Keycloak database', NOT has_database_privilege(current_user, :'keycloak_database', 'CONNECT')),
        ('runtime role cannot connect to OpenFGA database', NOT has_database_privilege(current_user, :'openfga_database', 'CONNECT')),
        ('runtime role cannot connect to Temporal database', NOT has_database_privilege(current_user, :'temporal_database', 'CONNECT')),
        ('runtime role cannot connect to Temporal visibility database', NOT has_database_privilege(current_user, :'temporal_visibility_database', 'CONNECT')),
        ('service databases have dedicated owners', NOT EXISTS (
            SELECT 1
            FROM (VALUES
                (:'keycloak_database', :'keycloak_role'),
                (:'openfga_database', :'openfga_role'),
                (:'temporal_database', :'temporal_role'),
                (:'temporal_visibility_database', :'temporal_role')
            ) AS expected_owners(database_name, owner_name)
            LEFT JOIN pg_database database_entry ON database_entry.datname = expected_owners.database_name
            LEFT JOIN pg_roles owner_role ON owner_role.oid = database_entry.datdba
            WHERE database_entry.oid IS NULL OR owner_role.rolname IS DISTINCT FROM expected_owners.owner_name
        )),
        ('service roles can connect only to their intended databases', NOT EXISTS (
            SELECT 1
            FROM (VALUES
                (:'migrator_role'),
                (:'runtime_role'),
                (:'keycloak_role'),
                (:'openfga_role'),
                (:'temporal_role')
            ) AS service_roles(role_name)
            CROSS JOIN (VALUES
                (current_database()),
                (:'postgres_database'),
                (:'template_database'),
                (:'keycloak_database'),
                (:'openfga_database'),
                (:'temporal_database'),
                (:'temporal_visibility_database')
            ) AS service_databases(database_name)
            LEFT JOIN (VALUES
                (:'migrator_role', current_database()),
                (:'runtime_role', current_database()),
                (:'keycloak_role', :'keycloak_database'),
                (:'openfga_role', :'openfga_database'),
                (:'temporal_role', :'temporal_database'),
                (:'temporal_role', :'temporal_visibility_database')
            ) AS expected_connections(role_name, database_name)
              ON expected_connections.role_name = service_roles.role_name
             AND expected_connections.database_name = service_databases.database_name
            WHERE has_database_privilege(service_roles.role_name, service_databases.database_name, 'CONNECT')
                  <> (expected_connections.role_name IS NOT NULL)
        )),
        ('schema_migrations exists', to_regclass('public.schema_migrations') IS NOT NULL),
        ('schema_migrations is SELECT-only',
            COALESCE(has_table_privilege(current_user, to_regclass('public.schema_migrations'), 'SELECT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.schema_migrations'), 'INSERT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.schema_migrations'), 'UPDATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.schema_migrations'), 'DELETE'), false)
        ),
        ('audit_events exists', to_regclass('public.audit_events') IS NOT NULL),
        ('audit_events is directly read-only',
            COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'SELECT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'INSERT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'UPDATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'DELETE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'TRUNCATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'REFERENCES'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_events'), 'TRIGGER'), false)
        ),
        ('audit_heads is directly read-only',
            COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'SELECT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'INSERT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'UPDATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'DELETE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'TRUNCATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'REFERENCES'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass('public.audit_heads'), 'TRIGGER'), false)
        ),
        ('runtime role owns no application relations', NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname !~ '^pg_'
              AND namespace.nspname <> 'information_schema'
              AND pg_get_userbyid(relation.relowner) = current_user
        )),
        ('runtime role owns no application functions', NOT EXISTS (
            SELECT 1
            FROM pg_proc function_entry
            JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
            WHERE namespace.nspname !~ '^pg_'
              AND namespace.nspname <> 'information_schema'
              AND pg_get_userbyid(function_entry.proowner) = current_user
        )),
        ('reviewed table inventory exactly matches deployed tables',
            NOT EXISTS (
                SELECT 1
                FROM reviewed_grants reviewed
                LEFT JOIN pg_class relation
                  ON relation.relname = reviewed.table_name
                 AND relation.relnamespace = 'public'::regnamespace
                 AND relation.relkind IN ('r', 'p')
                WHERE relation.oid IS NULL
            )
            AND NOT EXISTS (
                SELECT 1
                FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                LEFT JOIN reviewed_grants reviewed ON reviewed.table_name = relation.relname
                WHERE namespace.nspname = 'public'
                  AND relation.relkind IN ('r', 'p')
                  AND reviewed.table_name IS NULL
            )
        ),
        ('per-table DML exactly matches the reviewed matrix', NOT EXISTS (
            SELECT 1
            FROM reviewed_grants reviewed
            JOIN pg_class relation
              ON relation.relname = reviewed.table_name
             AND relation.relnamespace = 'public'::regnamespace
             AND relation.relkind IN ('r', 'p')
            WHERE has_table_privilege(current_user, relation.oid, 'SELECT') <> reviewed.can_select
               OR has_table_privilege(current_user, relation.oid, 'INSERT') <> reviewed.can_insert
               OR has_table_privilege(current_user, relation.oid, 'UPDATE') <> reviewed.can_update
               OR has_table_privilege(current_user, relation.oid, 'DELETE') <> reviewed.can_delete
        )),
		('reviewed table ACL grantees are exact', NOT EXISTS (
			SELECT 1
			FROM reviewed_grants reviewed
			JOIN pg_class relation
			  ON relation.relname = reviewed.table_name
			 AND relation.relnamespace = 'public'::regnamespace
			 AND relation.relkind IN ('r', 'p')
			CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) table_acl
			WHERE table_acl.grantee NOT IN (
				relation.relowner,
				(SELECT oid FROM pg_roles WHERE rolname = current_user)
			)
			   OR (
				table_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
				AND table_acl.is_grantable
			   )
		)),
        ('effective per-column DML exactly matches the reviewed matrix', NOT EXISTS (
            SELECT 1
            FROM reviewed_grants reviewed
            JOIN pg_class relation
              ON relation.relname = reviewed.table_name
             AND relation.relnamespace = 'public'::regnamespace
             AND relation.relkind IN ('r', 'p')
            JOIN pg_attribute attribute
              ON attribute.attrelid = relation.oid
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
            WHERE has_column_privilege(current_user, relation.oid, attribute.attnum, 'SELECT') <> reviewed.can_select
               OR has_column_privilege(current_user, relation.oid, attribute.attnum, 'INSERT') <> reviewed.can_insert
               OR has_column_privilege(current_user, relation.oid, attribute.attnum, 'UPDATE') <> reviewed.can_update
               OR has_column_privilege(current_user, relation.oid, attribute.attnum, 'REFERENCES')
        )),
        ('reviewed tables have no non-owner column ACLs', NOT EXISTS (
            SELECT 1
            FROM reviewed_grants reviewed
            JOIN pg_class relation
              ON relation.relname = reviewed.table_name
             AND relation.relnamespace = 'public'::regnamespace
             AND relation.relkind IN ('r', 'p')
            JOIN pg_attribute attribute
              ON attribute.attrelid = relation.oid
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
            CROSS JOIN LATERAL aclexplode(attribute.attacl) column_acl
            WHERE column_acl.grantee <> relation.relowner
        )),
        ('tenant tables have RLS enabled and runtime is not their owner', NOT EXISTS (
            SELECT 1
            FROM (SELECT DISTINCT table_name FROM reviewed_rls_policies) reviewed
            LEFT JOIN pg_class relation
              ON relation.relname = reviewed.table_name
             AND relation.relnamespace = 'public'::regnamespace
             AND relation.relkind IN ('r', 'p')
            WHERE relation.oid IS NULL
               OR NOT relation.relrowsecurity
               OR pg_get_userbyid(relation.relowner) = current_user
        )),
        ('RLS policy inventory and commands are exact',
            NOT EXISTS (
                SELECT 1
                FROM reviewed_rls_policies reviewed
                LEFT JOIN pg_class relation
                  ON relation.relname = reviewed.table_name
                 AND relation.relnamespace = 'public'::regnamespace
                LEFT JOIN pg_policy policy
                  ON policy.polrelid = relation.oid AND policy.polname = reviewed.policy_name
                WHERE policy.oid IS NULL
                   OR policy.polcmd::text <> reviewed.policy_command
                   OR NOT policy.polpermissive
                   OR policy.polroles <> ARRAY[0::oid]
                   OR (policy.polqual IS NULL AND policy.polcmd IN ('*', 'r', 'w', 'd'))
                   OR (policy.polwithcheck IS NULL AND policy.polcmd IN ('*', 'a', 'w'))
                   OR COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') NOT LIKE '%skyview.%'
                   OR (policy.polcmd IN ('*', 'a', 'w') AND COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '') NOT LIKE '%skyview.%')
            )
            AND NOT EXISTS (
                SELECT 1
                FROM pg_policy policy
                JOIN pg_class relation ON relation.oid = policy.polrelid
                LEFT JOIN reviewed_rls_policies reviewed
                  ON reviewed.table_name = relation.relname AND reviewed.policy_name = policy.polname
                WHERE relation.relnamespace = 'public'::regnamespace
                  AND reviewed.policy_name IS NULL
            )
        ),
        ('live security definitions match migration-sealed hashes',
            NOT EXISTS (
                SELECT 1
                FROM public.runtime_security_contracts expected
                LEFT JOIN current_security_contracts current_contract
                  ON current_contract.object_kind = expected.object_kind
                 AND current_contract.object_identity = expected.object_identity
                WHERE current_contract.object_identity IS NULL
                   OR current_contract.definition_hash <> expected.definition_hash
            )
            AND NOT EXISTS (
                SELECT 1
                FROM current_security_contracts current_contract
                LEFT JOIN public.runtime_security_contracts expected
                  ON expected.object_kind = current_contract.object_kind
                 AND expected.object_identity = current_contract.object_identity
                WHERE expected.object_identity IS NULL
            )
        ),
        ('unreviewed public relations have no runtime privileges', NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            WHERE relation.relnamespace = 'public'::regnamespace
              AND relation.relkind IN ('v', 'm', 'f')
              AND (
                  has_table_privilege(current_user, relation.oid, 'SELECT')
                  OR has_table_privilege(current_user, relation.oid, 'INSERT')
                  OR has_table_privilege(current_user, relation.oid, 'UPDATE')
                  OR has_table_privilege(current_user, relation.oid, 'DELETE')
                  OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
                  OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
                  OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
                  OR CASE
                      WHEN current_setting('server_version_num')::integer >= 170000
                      THEN has_table_privilege(current_user, relation.oid, 'MAINTAIN')
                      ELSE false
                  END
                  OR has_any_column_privilege(current_user, relation.oid, 'SELECT')
                  OR has_any_column_privilege(current_user, relation.oid, 'INSERT')
                  OR has_any_column_privilege(current_user, relation.oid, 'UPDATE')
                  OR has_any_column_privilege(current_user, relation.oid, 'REFERENCES')
              )
        )),
        ('verification connection has no residual application context',
            COALESCE(current_setting('skyview.actor_kind', true), '') = ''
            AND COALESCE(current_setting('skyview.tenant_id', true), '') = ''
            AND COALESCE(current_setting('skyview.workspace_id', true), '') = ''
            AND COALESCE(current_setting('skyview.user_id', true), '') = ''
            AND COALESCE(current_setting('skyview.role', true), '') = ''
            AND COALESCE(current_setting('skyview.worker_id', true), '') = ''
            AND COALESCE(current_setting('skyview.worker_scopes', true), '') = ''
            AND COALESCE(current_setting('skyview.relay_id', true), '') = ''
            AND COALESCE(current_setting('skyview.relay_scopes', true), '') = ''
            AND COALESCE(current_setting('skyview.operation', true), '') = ''
            AND COALESCE(current_setting('skyview.outbox_event_id', true), '') = ''
        ),
        ('tenant tables expose no rows without application context', NOT EXISTS (
            SELECT 1 FROM tenants UNION ALL
            SELECT 1 FROM users UNION ALL
            SELECT 1 FROM workspaces UNION ALL
            SELECT 1 FROM memberships UNION ALL
            SELECT 1 FROM projects UNION ALL
            SELECT 1 FROM project_versions UNION ALL
            SELECT 1 FROM sessions UNION ALL
            SELECT 1 FROM jobs UNION ALL
            SELECT 1 FROM workbench_runs UNION ALL
            SELECT 1 FROM shared_records UNION ALL
            SELECT 1 FROM audit_events UNION ALL
            SELECT 1 FROM audit_heads UNION ALL
            SELECT 1 FROM oidc_identities UNION ALL
            SELECT 1 FROM outbox_events UNION ALL
            SELECT 1 FROM workbench_states
        )),
        ('runtime role has no table administration privileges', NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relkind IN ('r', 'p')
              AND (
                  has_table_privilege(current_user, relation.oid, 'TRUNCATE')
                  OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
                  OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
                  OR CASE
                      WHEN current_setting('server_version_num')::integer >= 170000
                      THEN has_table_privilege(current_user, relation.oid, 'MAINTAIN')
                      ELSE false
                  END
              )
        )),
        ('reviewed sequence inventory is present', NOT EXISTS (
            SELECT 1
            FROM reviewed_sequence_grants reviewed
            LEFT JOIN pg_class sequence_entry
              ON sequence_entry.relname = reviewed.sequence_name
             AND sequence_entry.relnamespace = 'public'::regnamespace
             AND sequence_entry.relkind = 'S'
            WHERE sequence_entry.oid IS NULL
        )),
        ('sequence privileges match the exact empty-by-default allowlist',
            NOT EXISTS (
                SELECT 1
                FROM reviewed_sequence_grants reviewed
                JOIN pg_class sequence_entry
                  ON sequence_entry.relname = reviewed.sequence_name
                 AND sequence_entry.relnamespace = 'public'::regnamespace
                 AND sequence_entry.relkind = 'S'
                WHERE has_sequence_privilege(current_user, sequence_entry.oid, 'USAGE') IS DISTINCT FROM reviewed.can_usage
                   OR has_sequence_privilege(current_user, sequence_entry.oid, 'SELECT') IS DISTINCT FROM reviewed.can_select
                   OR has_sequence_privilege(current_user, sequence_entry.oid, 'UPDATE') IS DISTINCT FROM reviewed.can_update
                   OR EXISTS (
                       SELECT 1
                       FROM aclexplode(COALESCE(sequence_entry.relacl, acldefault('S', sequence_entry.relowner))) sequence_acl
                       WHERE sequence_acl.grantee = 0
                         AND sequence_acl.privilege_type IN ('USAGE', 'SELECT', 'UPDATE')
                   )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM pg_class sequence_entry
                LEFT JOIN reviewed_sequence_grants reviewed ON reviewed.sequence_name = sequence_entry.relname
                WHERE sequence_entry.relnamespace = 'public'::regnamespace
                  AND sequence_entry.relkind = 'S'
                  AND reviewed.sequence_name IS NULL
                  AND (
                      has_sequence_privilege(current_user, sequence_entry.oid, 'USAGE')
                      OR has_sequence_privilege(current_user, sequence_entry.oid, 'SELECT')
                      OR has_sequence_privilege(current_user, sequence_entry.oid, 'UPDATE')
                      OR EXISTS (
                          SELECT 1
                          FROM aclexplode(COALESCE(sequence_entry.relacl, acldefault('S', sequence_entry.relowner))) sequence_acl
                          WHERE sequence_acl.grantee = 0
                            AND sequence_acl.privilege_type IN ('USAGE', 'SELECT', 'UPDATE')
                      )
                  )
            )
        ),
        ('public function inventory is exact',
            NOT EXISTS (
                SELECT 1
                FROM reviewed_public_functions reviewed
                LEFT JOIN live_public_functions live
                  ON live.function_identity = reviewed.function_identity
                 AND live.function_kind = reviewed.function_kind
                 AND live.extension_name IS NOT DISTINCT FROM reviewed.extension_name
                WHERE live.function_oid IS NULL
            )
            AND NOT EXISTS (
                SELECT 1
                FROM live_public_functions live
                LEFT JOIN reviewed_public_functions reviewed
                  ON reviewed.function_identity = live.function_identity
                 AND reviewed.function_kind = live.function_kind
                 AND reviewed.extension_name IS NOT DISTINCT FROM live.extension_name
                WHERE reviewed.function_identity IS NULL
            )
        ),
        ('public function ACL grantees are exact',
            NOT EXISTS (
                SELECT 1
                FROM live_public_functions live
                JOIN reviewed_public_functions reviewed
                  ON reviewed.function_identity = live.function_identity
                 AND reviewed.function_kind = live.function_kind
                 AND reviewed.extension_name IS NOT DISTINCT FROM live.extension_name
                CROSS JOIN LATERAL aclexplode(COALESCE(live.function_acl, acldefault('f', live.function_owner))) function_acl
                WHERE function_acl.privilege_type <> 'EXECUTE'
                   OR (
                      function_acl.grantee <> live.function_owner
                      AND NOT (
                          reviewed.runtime_executable
                          AND function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = :'runtime_role')
                          AND function_acl.grantor = live.function_owner
                          AND NOT function_acl.is_grantable
                      )
                   )
                   OR (
                      function_acl.grantee = live.function_owner
                      AND function_acl.grantor <> live.function_owner
                   )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM live_public_functions live
                JOIN reviewed_public_functions reviewed
                  ON reviewed.function_identity = live.function_identity
                 AND reviewed.function_kind = live.function_kind
                 AND reviewed.extension_name IS NOT DISTINCT FROM live.extension_name
                WHERE reviewed.runtime_executable
                  AND NOT EXISTS (
                      SELECT 1
                      FROM aclexplode(COALESCE(live.function_acl, acldefault('f', live.function_owner))) function_acl
                      WHERE function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = :'runtime_role')
                        AND function_acl.grantor = live.function_owner
                        AND function_acl.privilege_type = 'EXECUTE'
                        AND NOT function_acl.is_grantable
                  )
            )
        ),
        ('secured runtime functions are hardened',
            (SELECT COUNT(*) = 2
             FROM pg_proc function_entry
             WHERE function_entry.oid IN (
                 to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
                 to_regprocedure('public.resolve_session_identity_v1(text)')
             )
               AND pg_get_userbyid(function_entry.proowner) = :'migrator_role'
               AND function_entry.prosecdef
               AND function_entry.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
               AND EXISTS (
                   SELECT 1
                   FROM aclexplode(COALESCE(function_entry.proacl, acldefault('f', function_entry.proowner))) function_acl
                   WHERE function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = :'runtime_role')
                     AND function_acl.grantor = function_entry.proowner
                     AND function_acl.privilege_type = 'EXECUTE'
                     AND NOT function_acl.is_grantable
               )
               AND NOT EXISTS (
                   SELECT 1
                   FROM aclexplode(COALESCE(function_entry.proacl, acldefault('f', function_entry.proowner))) function_acl
                   WHERE function_acl.privilege_type <> 'EXECUTE'
                      OR function_acl.grantee NOT IN (
                          function_entry.proowner,
                          (SELECT oid FROM pg_roles WHERE rolname = :'runtime_role')
                      )
                      OR (
                          function_acl.grantee = function_entry.proowner
                          AND function_acl.grantor <> function_entry.proowner
                      )
                      OR (
                          function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = :'runtime_role')
                          AND (
                              function_acl.grantor <> function_entry.proowner
                              OR function_acl.is_grantable
                          )
                      )
               ))
            AND pg_get_functiondef(to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)')) LIKE '%skyview.actor_kind%'
            AND to_regprocedure('public.append_audit_event_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NULL
        ),
        ('runtime function execution is limited to secured entry points',
            COALESCE(has_function_privilege(
                current_user,
                to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
                'EXECUTE'
            ), false)
            AND COALESCE(has_function_privilege(
                current_user,
                to_regprocedure('public.resolve_session_identity_v1(text)'),
                'EXECUTE'
            ), false)
            AND NOT EXISTS (
                SELECT 1
                FROM pg_proc function_entry
                JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
                WHERE namespace.nspname = 'public'
                  AND function_entry.oid NOT IN (
                      to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
                      to_regprocedure('public.resolve_session_identity_v1(text)')
                  )
                  AND has_function_privilege(current_user, function_entry.oid, 'EXECUTE')
            )
        )
    ) AS fixed_checks(check_name, passed)
)
SELECT
    COALESCE(bool_and(COALESCE(passed, false)), false) AS all_checks_passed,
    COALESCE(string_agg(check_name, ', ' ORDER BY check_name) FILTER (WHERE NOT COALESCE(passed, false)), 'none') AS failed_checks
FROM checks
\gset

\if :all_checks_passed
  \echo 'SkyView runtime least-privilege verification passed'
\else
  \echo 'SkyView runtime least-privilege verification failed:' :failed_checks
  \quit 1
\endif
