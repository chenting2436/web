package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const productionSchema = "public"

var (
	// ErrUnsafeRuntimePrivileges means that the connected PostgreSQL identity
	// has either insufficient application permissions or capabilities that a
	// production runtime must never possess.
	ErrUnsafeRuntimePrivileges = errors.New("unsafe PostgreSQL runtime privileges")
	// ErrRuntimePrivilegeVerificationUnavailable deliberately hides driver and
	// connection details. In particular, callers must not surface a DSN or a
	// password through a startup error.
	ErrRuntimePrivilegeVerificationUnavailable = errors.New("PostgreSQL runtime privilege verification unavailable")
)

type runtimeTableGrant struct {
	name                   string
	selectable, insertable bool
	updatable, deletable   bool
}

type runtimeRLSPolicy struct {
	table, policy, command string
}

type runtimeSequenceGrant struct {
	name                          string
	usable, selectable, updatable bool
}

type runtimePublicFunction struct {
	identity, kind, extension string
	runtimeExecutable         bool
}

// runtimeTableGrants is an allowlist, not a set of defaults. A table added by
// a migration makes the production runtime fail closed until its application
// access is reviewed here and in infra/postgres/lockdown-skyview-runtime.sql.
var runtimeTableGrants = []runtimeTableGrant{
	{name: "schema_migrations", selectable: true},
	{name: "runtime_security_contracts", selectable: true},
	{name: "tenants", selectable: true},
	{name: "users", selectable: true},
	{name: "workspaces", selectable: true},
	{name: "memberships", selectable: true},
	{name: "projects", selectable: true, insertable: true, updatable: true, deletable: true},
	{name: "project_versions", selectable: true, insertable: true},
	{name: "sessions", selectable: true, insertable: true, updatable: true, deletable: true},
	{name: "jobs", selectable: true, insertable: true, updatable: true},
	{name: "workbench_runs", selectable: true, insertable: true, updatable: true},
	{name: "workbench_states", selectable: true, insertable: true, updatable: true},
	{name: "shared_records", selectable: true, insertable: true, updatable: true, deletable: true},
	{name: "audit_events", selectable: true},
	{name: "audit_heads", selectable: true},
	{name: "oidc_identities", selectable: true, insertable: true, updatable: true},
	{name: "oidc_login_transactions", selectable: true, insertable: true, deletable: true},
	{name: "outbox_events", selectable: true, insertable: true, updatable: true},
}

// No current migration uses SERIAL, IDENTITY, CREATE SEQUENCE, or nextval.
// Keep this as an explicit empty allowlist: a future sequence must be named
// here, in the lockdown script, and in the live verifier before runtime can
// receive even USAGE on it.
var runtimeSequenceGrants = []runtimeSequenceGrant{}

// runtimePublicFunctions is the complete callable-object inventory for the
// application-owned public schema. Extension-owned routines must be added by
// exact extension name and identity; the allowlist is intentionally empty for
// extensions today. An unexpected function or procedure is treated as a
// potential execution backdoor even when current_user cannot execute it.
var runtimePublicFunctions = []runtimePublicFunction{
	{identity: "reject_audit_event_mutation()", kind: "f"},
	{identity: "validate_audit_event_chain_insert()", kind: "f"},
	{identity: "reject_identity_column_mutation()", kind: "f"},
	{identity: "resolve_session_identity_v1(text)", kind: "f", runtimeExecutable: true},
	{identity: "audit_chain_v3_frame(text, text)", kind: "f"},
	{identity: "append_audit_event_v3(text, text, text, text, text, text, text, text, text, text, text, text, text, text)", kind: "f", runtimeExecutable: true},
}

var runtimeRLSPolicies = []runtimeRLSPolicy{
	{table: "tenants", policy: "skyview_tenant_scope", command: "r"},
	{table: "users", policy: "skyview_user_scope", command: "r"},
	{table: "workspaces", policy: "skyview_workspace_scope", command: "r"},
	{table: "memberships", policy: "skyview_membership_scope", command: "r"},
	{table: "projects", policy: "skyview_project_select_scope", command: "r"},
	{table: "projects", policy: "skyview_project_insert_scope", command: "a"},
	{table: "projects", policy: "skyview_project_update_scope", command: "w"},
	{table: "projects", policy: "skyview_project_delete_scope", command: "d"},
	{table: "project_versions", policy: "skyview_project_version_scope", command: "*"},
	{table: "sessions", policy: "skyview_session_scope", command: "*"},
	{table: "jobs", policy: "skyview_job_select_scope", command: "r"},
	{table: "jobs", policy: "skyview_job_insert_scope", command: "a"},
	{table: "jobs", policy: "skyview_job_update_scope", command: "w"},
	{table: "workbench_runs", policy: "skyview_run_select_scope", command: "r"},
	{table: "workbench_runs", policy: "skyview_run_insert_scope", command: "a"},
	{table: "workbench_runs", policy: "skyview_run_update_scope", command: "w"},
	{table: "shared_records", policy: "skyview_shared_record_select_scope", command: "r"},
	{table: "shared_records", policy: "skyview_shared_record_insert_scope", command: "a"},
	{table: "shared_records", policy: "skyview_shared_record_update_scope", command: "w"},
	{table: "shared_records", policy: "skyview_shared_record_delete_scope", command: "d"},
	{table: "audit_events", policy: "skyview_audit_event_scope", command: "r"},
	{table: "audit_heads", policy: "skyview_audit_head_scope", command: "r"},
	{table: "oidc_identities", policy: "skyview_oidc_identity_scope", command: "*"},
	{table: "outbox_events", policy: "skyview_outbox_select_scope", command: "r"},
	{table: "outbox_events", policy: "skyview_outbox_insert_scope", command: "a"},
	{table: "outbox_events", policy: "skyview_outbox_update_scope", command: "w"},
	{table: "workbench_states", policy: "skyview_workbench_state_scope", command: "*"},
}

// ValidateRuntimePrivileges verifies the effective PostgreSQL privileges of
// current_user. It intentionally has no role-name parameter: the connected
// identity is the authority being checked. SQLite is a development adapter and
// is skipped.
func (store *ProjectStore) ValidateRuntimePrivileges(ctx context.Context) error {
	if store == nil || store.database == nil {
		return ErrRuntimePrivilegeVerificationUnavailable
	}
	if store.adapter != AdapterPostgreSQL {
		return nil
	}
	if ctx == nil {
		return ErrRuntimePrivilegeVerificationUnavailable
	}

	query, err := runtimePrivilegeQuery(runtimeTableGrants)
	if err != nil {
		return ErrRuntimePrivilegeVerificationUnavailable
	}
	rows, err := store.database.QueryContext(ctx, query, productionSchema)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("%w: %w", ErrRuntimePrivilegeVerificationUnavailable, ctxErr)
		}
		return ErrRuntimePrivilegeVerificationUnavailable
	}
	defer rows.Close()

	failed := make([]string, 0, 4)
	for rows.Next() {
		var checkName string
		if err := rows.Scan(&checkName); err != nil {
			return ErrRuntimePrivilegeVerificationUnavailable
		}
		failed = append(failed, checkName)
	}
	if err := rows.Err(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("%w: %w", ErrRuntimePrivilegeVerificationUnavailable, ctxErr)
		}
		return ErrRuntimePrivilegeVerificationUnavailable
	}
	if len(failed) != 0 {
		return fmt.Errorf("%w: %s", ErrUnsafeRuntimePrivileges, strings.Join(failed, ", "))
	}
	return nil
}

func runtimePrivilegeQuery(grants []runtimeTableGrant) (string, error) {
	if len(grants) == 0 {
		return "", errors.New("runtime privilege matrix is empty")
	}
	seen := make(map[string]struct{}, len(grants))
	var values strings.Builder
	for index, grant := range grants {
		if grant.name == "" || strings.ContainsAny(grant.name, "'\"") {
			return "", errors.New("invalid runtime privilege table name")
		}
		if _, exists := seen[grant.name]; exists {
			return "", errors.New("duplicate runtime privilege table")
		}
		seen[grant.name] = struct{}{}
		if index != 0 {
			values.WriteString(",\n        ")
		}
		fmt.Fprintf(&values, "('%s', %t, %t, %t, %t)", grant.name, grant.selectable, grant.insertable, grant.updatable, grant.deletable)
	}
	var sequenceRows string
	if len(runtimeSequenceGrants) == 0 {
		sequenceRows = "SELECT NULL::text, false, false, false WHERE false"
	} else {
		seenSequences := make(map[string]struct{}, len(runtimeSequenceGrants))
		var values strings.Builder
		values.WriteString("VALUES\n        ")
		for index, grant := range runtimeSequenceGrants {
			if grant.name == "" || strings.ContainsAny(grant.name, "'\"") {
				return "", errors.New("invalid runtime privilege sequence name")
			}
			if _, exists := seenSequences[grant.name]; exists {
				return "", errors.New("duplicate runtime privilege sequence")
			}
			seenSequences[grant.name] = struct{}{}
			if index != 0 {
				values.WriteString(",\n        ")
			}
			fmt.Fprintf(&values, "('%s', %t, %t, %t)", grant.name, grant.usable, grant.selectable, grant.updatable)
		}
		sequenceRows = values.String()
	}
	if len(runtimeRLSPolicies) == 0 {
		return "", errors.New("runtime RLS policy inventory is empty")
	}
	if len(runtimePublicFunctions) == 0 {
		return "", errors.New("runtime public function inventory is empty")
	}
	var functionValues strings.Builder
	seenFunctions := make(map[string]struct{}, len(runtimePublicFunctions))
	for index, function := range runtimePublicFunctions {
		if function.identity == "" || len(function.kind) != 1 || !strings.Contains("fpaw", function.kind) ||
			strings.ContainsAny(function.identity+function.kind+function.extension, "'\"") {
			return "", errors.New("invalid runtime public function inventory")
		}
		key := function.kind + "\x00" + function.identity
		if _, exists := seenFunctions[key]; exists {
			return "", errors.New("duplicate runtime public function")
		}
		seenFunctions[key] = struct{}{}
		if index != 0 {
			functionValues.WriteString(",\n        ")
		}
		extension := "NULL::text"
		if function.extension != "" {
			extension = fmt.Sprintf("'%s'", function.extension)
		}
		fmt.Fprintf(&functionValues, "('%s', '%s', %s, %t)", function.identity, function.kind, extension, function.runtimeExecutable)
	}
	var policyValues strings.Builder
	seenPolicies := make(map[string]struct{}, len(runtimeRLSPolicies))
	for index, policy := range runtimeRLSPolicies {
		if policy.table == "" || policy.policy == "" || !strings.Contains("*rawd", policy.command) || len(policy.command) != 1 ||
			strings.ContainsAny(policy.table+policy.policy, "'\"") {
			return "", errors.New("invalid runtime RLS policy inventory")
		}
		key := policy.table + "\x00" + policy.policy
		if _, exists := seenPolicies[key]; exists {
			return "", errors.New("duplicate runtime RLS policy")
		}
		seenPolicies[key] = struct{}{}
		if index != 0 {
			policyValues.WriteString(",\n        ")
		}
		fmt.Fprintf(&policyValues, "('%s', '%s', '%s')", policy.table, policy.policy, policy.command)
	}

	return fmt.Sprintf(`
WITH requested_schema(schema_name) AS (VALUES (?::text)),
reviewed_grants(table_name, can_select, can_insert, can_update, can_delete) AS (
    VALUES
        %s
),
reviewed_sequence_grants(sequence_name, can_usage, can_select, can_update) AS (
	%s
),
reviewed_rls_policies(table_name, policy_name, policy_command) AS (
    VALUES
        %s
),
reviewed_public_functions(function_identity, function_kind, extension_name, runtime_executable) AS (
    VALUES
        %s
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
	JOIN requested_schema requested ON requested.schema_name = namespace.nspname
	LEFT JOIN pg_depend extension_dependency
	  ON extension_dependency.classid = 'pg_proc'::regclass
	 AND extension_dependency.objid = function_entry.oid
	 AND extension_dependency.refclassid = 'pg_extension'::regclass
	 AND extension_dependency.deptype = 'e'
	LEFT JOIN pg_extension extension_entry ON extension_entry.oid = extension_dependency.refobjid
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
	JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
	JOIN requested_schema requested ON requested.schema_name = namespace.nspname
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
	JOIN requested_schema requested ON requested.schema_name = namespace.nspname
	JOIN reviewed_public_functions reviewed
	  ON reviewed.function_identity = function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')'
	 AND reviewed.function_kind = function_entry.prokind::text
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
	JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
	JOIN requested_schema requested ON requested.schema_name = namespace.nspname
	WHERE NOT trigger_entry.tgisinternal
),
checks(check_name, passed) AS (
    VALUES
        ('role has safe attributes', EXISTS (
            SELECT 1 FROM pg_roles
            WHERE rolname = current_user
              AND rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolinherit
              AND NOT rolreplication
              AND NOT rolbypassrls
        )),
        ('role has no memberships', NOT EXISTS (
            SELECT 1
            FROM pg_auth_members membership
            JOIN pg_roles member_role ON member_role.oid = membership.member
            WHERE member_role.rolname = current_user
        )),
		('role has no members', NOT EXISTS (
			SELECT 1
			FROM pg_auth_members membership
			JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
			WHERE granted_role.rolname = current_user
		)),
        ('database privileges are runtime-only',
            has_database_privilege(current_user, current_database(), 'CONNECT')
            AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
            AND NOT has_database_privilege(current_user, current_database(), 'TEMPORARY')
        ),
        ('role does not own the database', EXISTS (
            SELECT 1 FROM pg_database
            WHERE datname = current_database()
              AND pg_get_userbyid(datdba) <> current_user
        )),
        ('schema privileges are runtime-only', EXISTS (
            SELECT 1
            FROM pg_namespace namespace
            JOIN requested_schema requested ON requested.schema_name = namespace.nspname
            WHERE has_schema_privilege(current_user, namespace.oid, 'USAGE')
              AND NOT has_schema_privilege(current_user, namespace.oid, 'CREATE')
              AND pg_get_userbyid(namespace.nspowner) <> current_user
        )),
		('runtime search path is pinned',
			current_schemas(false) = ARRAY[
				'pg_catalog'::name,
				(SELECT schema_name::name FROM requested_schema)
			]
			AND regexp_replace(current_setting('search_path'), '[[:space:]"]+', '', 'g') =
				'pg_catalog,' || (SELECT schema_name FROM requested_schema)
		),
        ('role owns no application relations', NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            JOIN requested_schema requested ON requested.schema_name = namespace.nspname
            WHERE relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
              AND pg_get_userbyid(relation.relowner) = current_user
        )),
        ('role owns no application functions', NOT EXISTS (
            SELECT 1
            FROM pg_proc function_entry
            JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
            JOIN requested_schema requested ON requested.schema_name = namespace.nspname
            WHERE pg_get_userbyid(function_entry.proowner) = current_user
        )),
        ('reviewed table inventory matches deployed tables',
            NOT EXISTS (
                SELECT 1
                FROM reviewed_grants reviewed
                CROSS JOIN requested_schema requested
                LEFT JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
                LEFT JOIN pg_class relation
                  ON relation.relnamespace = namespace.oid
                 AND relation.relname = reviewed.table_name
                 AND relation.relkind IN ('r', 'p')
                WHERE relation.oid IS NULL
            )
            AND NOT EXISTS (
                SELECT 1
                FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                JOIN requested_schema requested ON requested.schema_name = namespace.nspname
                LEFT JOIN reviewed_grants reviewed ON reviewed.table_name = relation.relname
                WHERE relation.relkind IN ('r', 'p')
                  AND reviewed.table_name IS NULL
            )
        ),
        ('table DML matches reviewed matrix', NOT EXISTS (
            SELECT 1
            FROM reviewed_grants reviewed
            CROSS JOIN requested_schema requested
            JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
            JOIN pg_class relation
              ON relation.relnamespace = namespace.oid
             AND relation.relname = reviewed.table_name
             AND relation.relkind IN ('r', 'p')
            WHERE has_table_privilege(current_user, relation.oid, 'SELECT') IS DISTINCT FROM reviewed.can_select
               OR has_table_privilege(current_user, relation.oid, 'INSERT') IS DISTINCT FROM reviewed.can_insert
               OR has_table_privilege(current_user, relation.oid, 'UPDATE') IS DISTINCT FROM reviewed.can_update
               OR has_table_privilege(current_user, relation.oid, 'DELETE') IS DISTINCT FROM reviewed.can_delete
        )),
		('reviewed table ACL grantees are exact', NOT EXISTS (
			SELECT 1
			FROM reviewed_grants reviewed
			CROSS JOIN requested_schema requested
			JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
			JOIN pg_class relation
			  ON relation.relnamespace = namespace.oid
			 AND relation.relname = reviewed.table_name
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
		('effective column DML matches reviewed matrix', NOT EXISTS (
			SELECT 1
			FROM reviewed_grants reviewed
			CROSS JOIN requested_schema requested
			JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
			JOIN pg_class relation
			  ON relation.relnamespace = namespace.oid
			 AND relation.relname = reviewed.table_name
			 AND relation.relkind IN ('r', 'p')
			JOIN pg_attribute attribute
			  ON attribute.attrelid = relation.oid
			 AND attribute.attnum > 0
			 AND NOT attribute.attisdropped
			WHERE has_column_privilege(current_user, relation.oid, attribute.attnum, 'SELECT') IS DISTINCT FROM reviewed.can_select
			   OR has_column_privilege(current_user, relation.oid, attribute.attnum, 'INSERT') IS DISTINCT FROM reviewed.can_insert
			   OR has_column_privilege(current_user, relation.oid, attribute.attnum, 'UPDATE') IS DISTINCT FROM reviewed.can_update
			   OR has_column_privilege(current_user, relation.oid, attribute.attnum, 'REFERENCES')
		)),
		('reviewed tables have no non-owner column ACLs', NOT EXISTS (
			SELECT 1
			FROM reviewed_grants reviewed
			CROSS JOIN requested_schema requested
			JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
			JOIN pg_class relation
			  ON relation.relnamespace = namespace.oid
			 AND relation.relname = reviewed.table_name
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
			CROSS JOIN requested_schema requested
			LEFT JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
			LEFT JOIN pg_class relation
			  ON relation.relnamespace = namespace.oid
			 AND relation.relname = reviewed.table_name
			 AND relation.relkind IN ('r', 'p')
			WHERE relation.oid IS NULL
			   OR NOT relation.relrowsecurity
			   OR pg_get_userbyid(relation.relowner) = current_user
		)),
		('RLS policy inventory and commands are exact',
			NOT EXISTS (
				SELECT 1
				FROM reviewed_rls_policies reviewed
				CROSS JOIN requested_schema requested
				LEFT JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
				LEFT JOIN pg_class relation
				  ON relation.relnamespace = namespace.oid AND relation.relname = reviewed.table_name
				LEFT JOIN pg_policy policy
				  ON policy.polrelid = relation.oid AND policy.polname = reviewed.policy_name
				WHERE policy.oid IS NULL
				   OR policy.polcmd::text <> reviewed.policy_command
				   OR NOT policy.polpermissive
				   OR policy.polroles <> ARRAY[0::oid]
				   OR (policy.polqual IS NULL AND policy.polcmd IN ('*', 'r', 'w', 'd'))
				   OR (policy.polwithcheck IS NULL AND policy.polcmd IN ('*', 'a', 'w'))
				   OR COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') NOT LIKE '%%skyview.%%'
				   OR (policy.polcmd IN ('*', 'a', 'w') AND COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '') NOT LIKE '%%skyview.%%')
			)
			AND NOT EXISTS (
				SELECT 1
				FROM pg_policy policy
				JOIN pg_class relation ON relation.oid = policy.polrelid
				JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
				JOIN requested_schema requested ON requested.schema_name = namespace.nspname
				LEFT JOIN reviewed_rls_policies reviewed
				  ON reviewed.table_name = relation.relname AND reviewed.policy_name = policy.polname
				WHERE reviewed.policy_name IS NULL
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
			JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
			JOIN requested_schema requested ON requested.schema_name = namespace.nspname
			WHERE relation.relkind IN ('v', 'm', 'f')
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
		('startup connection has no residual application context',
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
        ('tables have no administration privileges', NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            JOIN requested_schema requested ON requested.schema_name = namespace.nspname
            WHERE relation.relkind IN ('r', 'p')
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
		('audit events are directly read-only',
			COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'SELECT'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'INSERT'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'UPDATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'DELETE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'TRUNCATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'REFERENCES'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_events'), 'TRIGGER'), false)
		),
		('audit heads are directly read-only',
			COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'SELECT'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'INSERT'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'UPDATE'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'DELETE'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'TRUNCATE'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'REFERENCES'), false)
			AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.audit_heads'), 'TRIGGER'), false)
		),
        ('migration ledger is read-only',
            COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'SELECT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'INSERT'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'UPDATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'DELETE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'TRUNCATE'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'REFERENCES'), false)
            AND NOT COALESCE(has_table_privilege(current_user, to_regclass((SELECT schema_name FROM requested_schema) || '.schema_migrations'), 'TRIGGER'), false)
        ),
		('reviewed sequence inventory is present', NOT EXISTS (
			SELECT 1
			FROM reviewed_sequence_grants reviewed
			CROSS JOIN requested_schema requested
			LEFT JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
			LEFT JOIN pg_class sequence_entry
			  ON sequence_entry.relnamespace = namespace.oid
			 AND sequence_entry.relname = reviewed.sequence_name
			 AND sequence_entry.relkind = 'S'
			WHERE sequence_entry.oid IS NULL
		)),
		('sequence privileges match the exact empty-by-default allowlist',
			NOT EXISTS (
				SELECT 1
				FROM reviewed_sequence_grants reviewed
				CROSS JOIN requested_schema requested
				JOIN pg_namespace namespace ON namespace.nspname = requested.schema_name
				JOIN pg_class sequence_entry
				  ON sequence_entry.relnamespace = namespace.oid
				 AND sequence_entry.relname = reviewed.sequence_name
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
				JOIN pg_namespace namespace ON namespace.oid = sequence_entry.relnamespace
				JOIN requested_schema requested ON requested.schema_name = namespace.nspname
				LEFT JOIN reviewed_sequence_grants reviewed ON reviewed.sequence_name = sequence_entry.relname
				WHERE sequence_entry.relkind = 'S'
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
						AND function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
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
					WHERE function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
					  AND function_acl.grantor = live.function_owner
					  AND function_acl.privilege_type = 'EXECUTE'
					  AND NOT function_acl.is_grantable
				  )
			)
		),
		('secured functions have hardened definitions',
			(SELECT COUNT(*) = 2
			 FROM pg_proc function_entry
			 JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
			 JOIN requested_schema requested ON requested.schema_name = namespace.nspname
			 WHERE function_entry.oid IN (
				to_regprocedure(requested.schema_name || '.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
				to_regprocedure(requested.schema_name || '.resolve_session_identity_v1(text)')
			 )
			   AND function_entry.prosecdef
			   AND function_entry.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
			   AND function_entry.proowner = (
				SELECT datdba FROM pg_database WHERE datname = current_database()
			   )
			   AND function_entry.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
			   AND EXISTS (
				SELECT 1
				FROM aclexplode(COALESCE(function_entry.proacl, acldefault('f', function_entry.proowner))) function_acl
				WHERE function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
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
					(SELECT oid FROM pg_roles WHERE rolname = current_user)
				   )
				   OR (
					function_acl.grantee = function_entry.proowner
					AND function_acl.grantor <> function_entry.proowner
				   )
				   OR (
					function_acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
					AND (
						function_acl.grantor <> function_entry.proowner
						OR function_acl.is_grantable
					)
				   )
			   ))
			AND pg_get_functiondef(to_regprocedure(
				(SELECT schema_name FROM requested_schema) || '.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'
			)) LIKE '%%skyview.actor_kind%%'
			AND to_regprocedure(
				(SELECT schema_name FROM requested_schema) || '.append_audit_event_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'
			) IS NULL
		),
		('function execution is limited to secured entry points',
			COALESCE(has_function_privilege(
				current_user,
				to_regprocedure((SELECT schema_name FROM requested_schema) || '.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
				'EXECUTE'
			), false)
			AND COALESCE(has_function_privilege(
				current_user,
				to_regprocedure((SELECT schema_name FROM requested_schema) || '.resolve_session_identity_v1(text)'),
				'EXECUTE'
			), false)
			AND NOT EXISTS (
				SELECT 1
				FROM pg_proc function_entry
				JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
				JOIN requested_schema requested ON requested.schema_name = namespace.nspname
				WHERE function_entry.oid NOT IN (
					to_regprocedure(requested.schema_name || '.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)'),
					to_regprocedure(requested.schema_name || '.resolve_session_identity_v1(text)')
				)
				  AND has_function_privilege(current_user, function_entry.oid, 'EXECUTE')
			)
		)
)
SELECT check_name
FROM checks
WHERE NOT COALESCE(passed, false)
ORDER BY check_name`, values.String(), sequenceRows, policyValues.String(), functionValues.String()), nil
}

const postgresMigratorIdentityQuery = `
SELECT EXISTS (
    SELECT 1
    FROM pg_roles role_entry
    JOIN pg_database database_entry ON database_entry.datname = current_database()
    JOIN pg_namespace namespace ON namespace.nspname = ?
    WHERE role_entry.rolname = current_user
      AND role_entry.rolcanlogin
      AND NOT role_entry.rolsuper
      AND NOT role_entry.rolcreatedb
      AND NOT role_entry.rolcreaterole
      AND NOT role_entry.rolinherit
      AND NOT role_entry.rolreplication
      AND NOT role_entry.rolbypassrls
      AND NOT EXISTS (
		  SELECT 1
		  FROM pg_auth_members membership
		  WHERE membership.member = role_entry.oid
		     OR membership.roleid = role_entry.oid
      )
      AND pg_get_userbyid(database_entry.datdba) = current_user
      AND pg_get_userbyid(namespace.nspowner) = current_user
      AND current_schemas(false) = ARRAY['pg_catalog'::name, ?::name]
      AND regexp_replace(current_setting('search_path'), '[[:space:]"]+', '', 'g') = 'pg_catalog,' || ?
)`

// RunPostgreSQLMigrations is the only production migration entry point. It
// validates that the connected identity is a restricted owner with no inbound
// or outbound role-membership edges before applying checksum migrations, then
// closes the connection and returns to the caller.
func RunPostgreSQLMigrations(ctx context.Context, config StoreConfig) error {
	if ctx == nil {
		return errors.New("production migration context is required")
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("production migration canceled: %w", err)
	}
	config.ApplyMigrations = true
	config.RequireTLS = true
	config.MaxOpenConns = 1
	config.MaxIdleConns = 1
	adapterName := strings.ToLower(strings.TrimSpace(config.Adapter))
	if adapterName != "postgres" && adapterName != AdapterPostgreSQL {
		return errors.New("production migrations require the PostgreSQL adapter")
	}
	database, adapter, err := openDatabase(config)
	if err != nil {
		return errors.New("open PostgreSQL migration database failed")
	}
	defer func() { _ = database.Close() }()
	if adapter != AdapterPostgreSQL {
		return errors.New("production migrations require the PostgreSQL adapter")
	}
	var allowed bool
	err = database.QueryRowContext(ctx, postgresMigratorIdentityQuery,
		productionSchema, productionSchema, productionSchema).Scan(&allowed)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("verify PostgreSQL migrator identity: %w", ctxErr)
		}
		return errors.New("verify PostgreSQL migrator identity failed")
	}
	if !allowed {
		return errors.New("connected PostgreSQL identity is not an approved migration owner")
	}

	projectStore := &ProjectStore{database: database, adapter: adapter}
	if err := projectStore.migratePostgreSQL(); err != nil {
		return errors.New("apply PostgreSQL migrations failed")
	}
	return nil
}
