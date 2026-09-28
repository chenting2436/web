$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$postgresDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$infraDirectory = Split-Path -Parent $postgresDirectory
$workspaceDirectory = Split-Path -Parent $infraDirectory

function Read-RequiredFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw
}

function Assert-Contains([string]$Text, [string]$Pattern, [string]$Message) {
    if ($Text -notmatch $Pattern) {
        throw $Message
    }
}

$init = Read-RequiredFile (Join-Path $postgresDirectory 'init-databases.sh')
$lockdownShell = Read-RequiredFile (Join-Path $postgresDirectory 'lockdown-skyview-runtime.sh')
$lockdownSql = Read-RequiredFile (Join-Path $postgresDirectory 'lockdown-skyview-runtime.sql')
$verifyShell = Read-RequiredFile (Join-Path $postgresDirectory 'verify-skyview-privileges.sh')
$verifySql = Read-RequiredFile (Join-Path $postgresDirectory 'verify-skyview-privileges.sql')
$compose = Read-RequiredFile (Join-Path $infraDirectory 'compose.foundation.yml')
$exampleEnvironment = Read-RequiredFile (Join-Path $infraDirectory '.env.example')

foreach ($shellScript in @($init, $lockdownShell, $verifyShell)) {
    Assert-Contains $shellScript '(?m)^set -eu$' 'Every PostgreSQL shell script must fail closed with set -eu.'
    if ($shellScript -match '(?m)^\s*set\s+-x') {
        throw 'PostgreSQL scripts must never enable shell tracing around secrets.'
    }
    if ($shellScript -match '--set(?:=|\s+)\w*password') {
        throw 'Passwords must not be passed through psql command-line variables.'
    }
}

Assert-Contains $init 'SKYVIEW_DB_MIGRATOR_USER' 'Initializer is missing the migrator identity.'
Assert-Contains $init 'SKYVIEW_DB_RUNTIME_USER' 'Initializer is missing the runtime identity.'
Assert-Contains $init 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS' 'Service roles are not explicitly restricted.'
Assert-Contains $init 'legacy SKYVIEW_DB_USER/SKYVIEW_DB_PASSWORD is forbidden' 'Legacy shared identity must fail closed.'
Assert-Contains $init 'PostgreSQL 15 or newer is required' 'Initializer must enforce the secret-safe psql version floor.'
Assert-Contains $init 'WITH service_roles\(role_name\)' 'Initializer does not enumerate the exact service-role membership graph.'
Assert-Contains $init 'granted_role\.oid = membership\.roleid' 'Initializer does not remove inbound service-role memberships.'
Assert-Contains $init 'member_role\.oid = membership\.member' 'Initializer does not remove outbound service-role memberships.'

Assert-Contains $lockdownSql 'REVOKE CREATE ON SCHEMA public FROM PUBLIC' 'Public schema CREATE is not revoked.'
Assert-Contains $lockdownSql 'GRANT CONNECT ON DATABASE %I TO %I' 'Runtime database CONNECT grant is missing.'
Assert-Contains $lockdownSql 'GRANT USAGE ON SCHEMA public TO %I' 'Runtime schema USAGE grant is missing.'
Assert-Contains $lockdownSql 'REVOKE ALL PRIVILEGES \(%I\) ON TABLE %I\.%I FROM PUBLIC' 'PUBLIC column-level ACL cleanup is missing.'
Assert-Contains $lockdownSql 'REVOKE ALL PRIVILEGES \(%I\) ON TABLE %I\.%I FROM %I' 'Runtime column-level ACL cleanup is missing.'
Assert-Contains $lockdownSql 'WITH service_roles\(role_name\)' 'Lockdown does not enumerate all five service roles.'
Assert-Contains $lockdownSql "REVOKE %I FROM %I', granted_role\.rolname, member_role\.rolname" 'Bidirectional service-role membership cleanup is missing.'
Assert-Contains $lockdownSql 'aclexplode\(COALESCE\(relation\.relacl' 'Third-party table ACL cleanup is missing.'
Assert-Contains $lockdownSql 'table_acl\.grantee NOT IN \(relation\.relowner, runtime_role\.oid\)' 'Table ACL cleanup is not limited to the exact owner/runtime graph.'
Assert-Contains $lockdownSql 'WITH secured_runtime_functions\(function_oid\)' 'Exact SECURITY DEFINER function ACL cleanup is missing.'
Assert-Contains $lockdownSql 'function_acl\.grantee NOT IN \(function_entry\.proowner, runtime_role\.oid\)' 'Third-party SECURITY DEFINER EXECUTE cleanup is missing.'
Assert-Contains $lockdownSql 'DO \$public_function_inventory\$' 'Exact public function inventory gate is missing from lockdown.'
Assert-Contains $lockdownSql "extension_dependency\.deptype = 'e'" 'Lockdown does not reject unreviewed extension-owned public functions.'
Assert-Contains $lockdownSql 'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE' 'Lockdown does not revoke named third-party function grants and their delegated grants.'
Assert-Contains $lockdownSql 'function_acl\.grantee <> function_entry\.proowner' 'Lockdown function ACL cleanup is not applied to every reviewed public function.'
Assert-Contains $lockdownSql 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM %I' 'PostgreSQL 17+ MAINTAIN cleanup is missing.'
Assert-Contains $lockdownSql 'WITH reviewed_sequence_grants\(sequence_name, privileges\)' 'Exact sequence allowlist is missing from lockdown.'
Assert-Contains $lockdownSql 'SELECT NULL::text, NULL::text WHERE false' 'The current sequence allowlist must be explicitly empty.'
if ($lockdownSql -match '(?i)GRANT\s+[^;\r\n]*ON\s+ALL\s+SEQUENCES') {
    throw 'Runtime must never receive a blanket grant on all sequences.'
}
Assert-Contains $lockdownSql 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.audit_events' 'Direct audit-event mutation privileges are not explicitly revoked.'
Assert-Contains $lockdownSql 'GRANT SELECT ON TABLE public\.audit_events' 'Audit-event read grant is missing.'
Assert-Contains $lockdownSql 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.audit_heads' 'Direct audit-head mutation privileges are not explicitly revoked.'
Assert-Contains $lockdownSql 'GRANT SELECT ON TABLE public\.audit_heads' 'Audit-head read grant is missing.'
Assert-Contains $lockdownSql 'GRANT EXECUTE ON FUNCTION public\.append_audit_event_v3' 'Secured audit append execute grant is missing.'
Assert-Contains $lockdownSql 'GRANT EXECUTE ON FUNCTION public\.resolve_session_identity_v1' 'Secured session resolver execute grant is missing.'
foreach ($serviceVariable in @('KEYCLOAK_DB_USER', 'OPENFGA_DB_USER', 'TEMPORAL_DB_USER')) {
    Assert-Contains $lockdownShell ([regex]::Escape($serviceVariable)) "Lockdown shell is missing $serviceVariable."
    if ([regex]::Matches($compose, [regex]::Escape($serviceVariable)).Count -lt 3) {
        throw "Compose does not pass $serviceVariable to bootstrap, lockdown, and verification."
    }
}
if ($lockdownSql -match 'GRANT SELECT, INSERT ON TABLE public\.audit_events' -or $lockdownSql -match 'GRANT SELECT, INSERT, UPDATE ON TABLE public\.audit_heads') {
    throw 'Runtime must not receive direct audit storage mutation privileges.'
}
if ($lockdownSql -match 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES') {
    throw 'A blanket CRUD grant is not an acceptable least-privilege matrix.'
}

$lockdownTables = [regex]::Matches($lockdownSql, "\('([a-z_]+)', 'SELECT(?:, INSERT)?(?:, UPDATE)?(?:, DELETE)?'\)") |
    ForEach-Object { $_.Groups[1].Value } |
    Sort-Object -Unique
$verificationTables = [regex]::Matches($verifySql, "\('([a-z_]+)', (?:true|false), (?:true|false), (?:true|false), (?:true|false)\)") |
    ForEach-Object { $_.Groups[1].Value } |
    Sort-Object -Unique
if (($lockdownTables -join ',') -ne ($verificationTables -join ',')) {
    throw 'Lockdown and verification per-table DML matrices have drifted.'
}

$migrationDirectory = Join-Path $workspaceDirectory 'backend_go\internal\store\migrations\postgres'
if (Test-Path -LiteralPath $migrationDirectory -PathType Container) {
    $migrationTables = Get-ChildItem -LiteralPath $migrationDirectory -Filter '*.sql' -File |
        ForEach-Object { [regex]::Matches((Get-Content -LiteralPath $_.FullName -Raw), '(?im)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_]+)"?') } |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique
    $matrixMigrationTables = $lockdownTables | Where-Object { $_ -ne 'schema_migrations' }
    if (($migrationTables -join ',') -ne ($matrixMigrationTables -join ',')) {
        throw 'PostgreSQL migrations and the reviewed runtime DML matrix have drifted.'
    }

    $securedAuditMigration = Read-RequiredFile (Join-Path $migrationDirectory '009_secured_audit_append.sql')
    foreach ($auditProof in @('SECURITY DEFINER', 'SET search_path = pg_catalog, public', 'clock_timestamp()', 'FOR UPDATE', 'sha256(convert_to(canonical_payload', 'REVOKE ALL PRIVILEGES ON FUNCTION')) {
        Assert-Contains $securedAuditMigration ([regex]::Escape($auditProof)) "Secured audit migration is missing $auditProof."
    }
    if ($securedAuditMigration -match 'p_created_at') {
        throw 'Secured audit append must derive time from the PostgreSQL clock.'
    }

    $rlsMigration = Read-RequiredFile (Join-Path $migrationDirectory '011_runtime_row_level_security.sql')
    foreach ($rlsProof in @(
        'ENABLE ROW LEVEL SECURITY',
        "current_setting('skyview.tenant_id', true)",
        "current_setting('skyview.workspace_id', true)",
        "current_setting('skyview.user_id', true)",
        "current_setting('skyview.worker_scopes', true)",
        "current_setting('skyview.relay_scopes', true)",
        "current_setting('skyview.operation', true)",
        "current_setting('skyview.outbox_event_id', true)",
        'resolve_session_identity_v1',
        'SECURITY DEFINER',
        'audit_scope_denied',
		'reject_identity_column_mutation',
		'CREATE TABLE public.runtime_security_contracts',
		'pg_get_functiondef',
		'pg_get_triggerdef'
    )) {
        Assert-Contains $rlsMigration ([regex]::Escape($rlsProof)) "RLS migration is missing $rlsProof."
    }
    $workbenchPolicyStart = $rlsMigration.IndexOf('CREATE POLICY skyview_workbench_state_scope', [System.StringComparison]::Ordinal)
    if ($workbenchPolicyStart -lt 0) {
        throw 'Cannot isolate the workbench-state RLS policy.'
    }
    $workbenchPolicyEnd = $rlsMigration.IndexOf('-- RLS prevents moving a row', $workbenchPolicyStart, [System.StringComparison]::Ordinal)
    if ($workbenchPolicyEnd -le $workbenchPolicyStart) {
        throw 'Cannot isolate the workbench-state RLS policy.'
    }
    $workbenchPolicy = $rlsMigration.Substring($workbenchPolicyStart, $workbenchPolicyEnd - $workbenchPolicyStart)
    $workbenchCurrentUserChecks = [regex]::Matches($workbenchPolicy, [regex]::Escape("user_id = COALESCE(current_setting('skyview.user_id', true), '')"))
    if ($workbenchCurrentUserChecks.Count -ne 2 -or $workbenchPolicy -match 'skyview\.role|\badmin\b') {
        throw 'Workbench-state RLS must bind reads and writes to the current user without an administrator exception.'
    }
    $enabledRlsTables = [regex]::Matches($rlsMigration, '(?im)ALTER\s+TABLE\s+public\.([a-z_]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique
    $policyTables = [regex]::Matches($verifySql, "\('([a-z_]+)', 'skyview_[a-z_]+'?, '[*rawd]'\)") |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique
    if (($enabledRlsTables -join ',') -ne ($policyTables -join ',')) {
        throw 'RLS migration and live policy inventory have drifted.'
    }

    $auditV3Migration = Read-RequiredFile (Join-Path $migrationDirectory '012_audit_chain_v3.sql')
    foreach ($auditV3Proof in @(
        'CREATE FUNCTION public.append_audit_event_v3',
        'CREATE FUNCTION public.audit_chain_v3_frame',
        "octet_length(p_name)::text || ':' || p_name",
        "public.audit_chain_v3_frame('metadata_json', p_metadata_text)",
        'next_sequence, 3, created_at_value',
        'DROP FUNCTION public.append_audit_event_v2',
        'audit_v3_golden_vector',
		'audit_v2_collision_fixture_invalid',
		'audit_v3_cross_field_collision',
        'f15b56a60e43cf350e996fab1ab830dd506d4e7d5e0cd0a96847a45e79f2d3d5',
        'DELETE FROM public.runtime_security_contracts',
        'skyview_outbox_insert_scope'
    )) {
        Assert-Contains $auditV3Migration ([regex]::Escape($auditV3Proof)) "Audit-v3 migration is missing $auditV3Proof."
    }
    $outboxInsertStart = $auditV3Migration.IndexOf('CREATE POLICY skyview_outbox_insert_scope', [System.StringComparison]::Ordinal)
    $outboxInsertEnd = $auditV3Migration.IndexOf('-- PostgreSQL/Go golden vector', $outboxInsertStart, [System.StringComparison]::Ordinal)
    if ($outboxInsertStart -lt 0 -or $outboxInsertEnd -le $outboxInsertStart) {
        throw 'Cannot isolate the final outbox INSERT policy.'
    }
    $outboxInsertPolicy = $auditV3Migration.Substring($outboxInsertStart, $outboxInsertEnd - $outboxInsertStart)
	$firstOutboxActorBranch = $outboxInsertPolicy.IndexOf("current_setting('skyview.actor_kind', true)", [System.StringComparison]::Ordinal)
	if ($firstOutboxActorBranch -lt 0) {
		throw 'Final outbox INSERT policy has no actor branch.'
	}
	$outboxTopLevelGate = $outboxInsertPolicy.Substring(0, $firstOutboxActorBranch)
	if (-not $outboxTopLevelGate.Contains("current_setting('skyview.operation', true)") -or
		-not $outboxTopLevelGate.Contains("current_setting('skyview.outbox_event_id', true)")) {
		throw 'Outbox operation and exact event ID must guard every INSERT actor branch.'
	}
    foreach ($outboxProof in @(
        "current_setting('skyview.operation', true)",
        'outbox_enqueue',
        "current_setting('skyview.outbox_event_id', true)",
        "event_type IN ('job.succeeded', 'job.failed')",
        "outbox_events.payload_json->>'status' = scoped_job.status",
        "worker_scope.value->>'slug' = scoped_job.slug"
    )) {
        Assert-Contains $outboxInsertPolicy ([regex]::Escape($outboxProof)) "Final outbox INSERT policy is missing $outboxProof."
    }
	$workerOutboxBranch = $outboxInsertPolicy.Substring($outboxInsertPolicy.IndexOf("= 'worker'", [System.StringComparison]::Ordinal))
	if ($workerOutboxBranch -match 'job\.created|job\.cancelled') {
		throw 'Compute workers must not enqueue create/cancel lifecycle events.'
	}
}

foreach ($requiredProof in @('current_user', 'current_schemas(false)', 'current_setting(''search_path'')', 'has_database_privilege', 'has_schema_privilege', 'has_table_privilege', 'MAINTAIN', 'server_version_num', 'has_any_column_privilege', 'has_column_privilege', 'pg_attribute', 'attacl', 'relation.relacl', 'table_acl.grantee', 'table_acl.is_grantable', 'membership.roleid', 'membership.member', 'all non-admin service roles have no role memberships', 'function_acl.grantee', 'function_acl.grantor', 'function_acl.is_grantable', 'reviewed_public_functions', 'live_public_functions', 'public function inventory is exact', 'public function ACL grantees are exact', 'pg_extension', 'extension_dependency.deptype = ''e''', 'function_acl.grantee <> live.function_owner', 'reviewed.runtime_executable', 'reviewed_sequence_grants', 'exact empty-by-default allowlist', 'has_sequence_privilege', 'has_function_privilege', 'pg_has_role', 'append_audit_event_v3', 'audit_chain_v3_frame', 'resolve_session_identity_v1', 'relrowsecurity', 'pg_policy', 'polpermissive', 'runtime_security_contracts', 'pg_get_triggerdef', 'pg_get_functiondef', 'prosecdef', 'aclexplode')) {
    Assert-Contains $verifySql ([regex]::Escape($requiredProof)) "Live verification is missing $requiredProof proof."
}

if ($compose -match '(?m)^\s+SKYVIEW_DB_USER\s*:') {
    throw 'Compose still accepts the legacy shared SkyView database identity.'
}
Assert-Contains $compose 'skyview_db_migrator_password' 'Compose migrator secret is missing.'
Assert-Contains $compose 'skyview_db_runtime_password' 'Compose runtime secret is missing.'
Assert-Contains $compose 'skyview-permission-lockdown' 'Compose lockdown release job is missing.'
Assert-Contains $compose 'skyview-permission-verify' 'Compose live verification release job is missing.'

if ($exampleEnvironment -match '(?m)^SKYVIEW_DB_(?:USER|PASSWORD)=') {
    throw 'Environment example still advertises the legacy shared SkyView identity.'
}
foreach ($line in ($exampleEnvironment -split "`r?`n")) {
    if ($line -match '^[A-Z0-9_]*PASSWORD=(.+)$') {
        throw "Environment example contains a non-empty password value for $($line.Split('=')[0])."
    }
}

Write-Output 'PostgreSQL least-privilege static contract passed.'
