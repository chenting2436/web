package store

import (
	"regexp"
	"strings"
	"testing"
)

func TestPostgreSQLMigrationHasScopedOwnershipAndAppendOnlyAudit(t *testing.T) {
	items, err := loadPostgresMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 12 || items[0].version != 1 || items[0].name != "foundation" || len(items[0].checksum) != 64 ||
		items[1].version != 2 || items[1].name != "oidc_identities" || len(items[1].checksum) != 64 ||
		items[2].version != 3 || items[2].name != "canonical_user_emails" || len(items[2].checksum) != 64 ||
		items[3].version != 4 || items[3].name != "transactional_outbox" || len(items[3].checksum) != 64 ||
		items[4].version != 5 || items[4].name != "oidc_login_transactions" || len(items[4].checksum) != 64 ||
		items[5].version != 6 || items[5].name != "audit_chain_heads" || len(items[5].checksum) != 64 ||
		items[6].version != 7 || items[6].name != "workbench_states" || len(items[6].checksum) != 64 ||
		items[7].version != 8 || items[7].name != "job_outbox_leases" || len(items[7].checksum) != 64 ||
		items[8].version != 9 || items[8].name != "secured_audit_append" || len(items[8].checksum) != 64 ||
		items[9].version != 10 || items[9].name != "job_execution_fence" || len(items[9].checksum) != 64 ||
		items[10].version != 11 || items[10].name != "runtime_row_level_security" || len(items[10].checksum) != 64 ||
		items[11].version != 12 || items[11].name != "audit_chain_v3" || len(items[11].checksum) != 64 {
		t.Fatalf("unexpected embedded migrations: %#v", items)
	}
	for _, required := range []string{
		"created_at TIMESTAMPTZ NOT NULL",
		"started_at TIMESTAMPTZ",
		"FOREIGN KEY (tenant_id, workspace_id, owner_user_id) REFERENCES memberships",
		"FOREIGN KEY (tenant_id, workspace_id, project_id) REFERENCES projects",
		"UNIQUE (tenant_id, workspace_id, id)",
		"CREATE TRIGGER audit_events_no_update",
		"CREATE TRIGGER audit_events_no_delete",
	} {
		if !strings.Contains(items[0].sql, required) {
			t.Fatalf("PostgreSQL migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{"PRAGMA", "INSERT OR ", "last_insert_rowid", "rowid", "AUTOINCREMENT"} {
		for _, item := range items {
			if strings.Contains(strings.ToUpper(item.sql), strings.ToUpper(forbidden)) {
				t.Fatalf("PostgreSQL migration %d leaked SQLite-only token %q", item.version, forbidden)
			}
		}
	}
	for _, required := range []string{"CREATE TABLE oidc_identities", "PRIMARY KEY (issuer_hash, subject, tenant_id)", "REFERENCES users(tenant_id, id)"} {
		if !strings.Contains(items[1].sql, required) {
			t.Fatalf("PostgreSQL OIDC migration is missing %q", required)
		}
	}
	for _, required := range []string{"CREATE TABLE oidc_login_transactions", "sealed_payload BYTEA NOT NULL", "expires_at TIMESTAMPTZ NOT NULL"} {
		if !strings.Contains(items[4].sql, required) {
			t.Fatalf("PostgreSQL OIDC transaction migration is missing %q", required)
		}
	}
	for _, required := range []string{"CREATE TABLE audit_heads", "last_sequence BIGINT NOT NULL", "FOR UPDATE", "CREATE TRIGGER audit_events_chain_guard", "cycle or disconnected component"} {
		if !strings.Contains(items[5].sql, required) {
			t.Fatalf("PostgreSQL audit chain migration is missing %q", required)
		}
	}
	for _, required := range []string{"CREATE TABLE workbench_states", "state_json JSONB NOT NULL", "jsonb_typeof(state_json) = 'object'", "size_bytes INTEGER NOT NULL", "size_bytes BETWEEN 2 AND 1048576", "revision BIGINT NOT NULL", "PRIMARY KEY (tenant_id, workspace_id, user_id, slug)", "REFERENCES memberships(tenant_id, workspace_id, user_id)", "octet_length(tenant_id) BETWEEN 1 AND 128"} {
		if !strings.Contains(items[6].sql, required) {
			t.Fatalf("PostgreSQL workbench state migration is missing %q", required)
		}
	}
	for _, required := range []string{
		"CREATE FUNCTION public.append_audit_event_v2", "SECURITY DEFINER", "SET search_path = pg_catalog, public",
		"REVOKE ALL PRIVILEGES ON FUNCTION", "clock_timestamp()", "FOR UPDATE", "sha256(convert_to(canonical_payload, 'UTF8'))",
		"INSERT INTO public.audit_events", "UPDATE public.audit_heads", "hash_metadata_text",
	} {
		if !strings.Contains(items[8].sql, required) {
			t.Fatalf("PostgreSQL secured audit migration is missing %q", required)
		}
	}
	if strings.Contains(items[8].sql, "p_created_at") {
		t.Fatal("secured audit function must derive its timestamp from the database clock")
	}
	for _, required := range []string{
		"ENABLE ROW LEVEL SECURITY", "current_setting('skyview.tenant_id', true)",
		"current_setting('skyview.worker_scopes', true)", "resolve_session_identity_v1",
		"current_setting('skyview.relay_scopes', true)", "current_setting('skyview.operation', true)",
		"current_setting('skyview.outbox_event_id', true)", "audit_scope_denied", "reject_identity_column_mutation",
		"oidc_identities_immutable_identity", "workbench_states_immutable_identity",
		"CREATE TABLE public.runtime_security_contracts", "pg_get_functiondef", "pg_get_triggerdef",
	} {
		if !strings.Contains(items[10].sql, required) {
			t.Fatalf("PostgreSQL RLS migration is missing %q", required)
		}
	}
	for _, required := range []string{
		"audit_v3_preflight", "audit_v3_preflight_invalid_root_count", "audit_v3_preflight_fork",
		"audit_v3_preflight_cycle_or_disconnected_component", "audit_v3_preflight_sequence_mismatch",
		"audit_v3_preflight_version_regression", "chain_version IN (2, 3)", "chain_version = 3",
		"CREATE FUNCTION public.audit_chain_v3_frame", "octet_length(p_value)",
		"CREATE FUNCTION public.append_audit_event_v3", "SECURITY DEFINER",
		"public.audit_chain_v3_frame('metadata_json', p_metadata_text)",
		"next_sequence, 3, created_at_value", "DROP FUNCTION public.append_audit_event_v2",
		"audit_v3_golden_vector", "audit_v2_collision_fixture_invalid", "audit_v3_cross_field_collision",
		"f15b56a60e43cf350e996fab1ab830dd506d4e7d5e0cd0a96847a45e79f2d3d5",
		"DELETE FROM public.runtime_security_contracts", "audit_chain_v3_frame(text,text)",
	} {
		if !strings.Contains(items[11].sql, required) {
			t.Fatalf("PostgreSQL audit-v3 migration is missing %q", required)
		}
	}
}

func TestPostgreSQLAuditV3PreflightsPG011SecurityContractBeforeMutation(t *testing.T) {
	items, err := loadPostgresMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) < 12 {
		t.Fatalf("audit-v3 migration is missing: migration count=%d", len(items))
	}
	migration := items[11].sql
	preflightStart := strings.Index(migration, "DO $runtime_security_contract_preflight$")
	preflightEndMarker := "$runtime_security_contract_preflight$;"
	if preflightStart < 0 {
		t.Fatal("audit-v3 migration has no PG011 security-contract preflight")
	}
	preflightEndOffset := strings.Index(migration[preflightStart+len("DO $runtime_security_contract_preflight$"):], preflightEndMarker)
	if preflightEndOffset < 0 {
		t.Fatal("audit-v3 security-contract preflight is unterminated")
	}
	preflightEnd := preflightStart + len("DO $runtime_security_contract_preflight$") + preflightEndOffset + len(preflightEndMarker)
	preflight := migration[preflightStart:preflightEnd]

	for _, required := range []string{
		"to_regclass('public.runtime_security_contracts') IS NULL",
		"runtime_security_contract_preflight_missing_ledger",
		"current_security_contracts(object_kind, object_identity, definition_hash)",
		"FROM pg_policy policy",
		"FROM pg_proc function_entry",
		"function_entry.pronamespace",
		"FROM pg_trigger trigger_entry",
		"NOT trigger_entry.tgisinternal",
		"FROM public.runtime_security_contracts sealed",
		"FULL OUTER JOIN current_security_contracts current_contract",
		"sealed.object_identity IS NULL",
		"current_contract.object_identity IS NULL",
		"sealed.definition_hash IS NULL",
		"current_contract.definition_hash IS NULL",
		"sealed.definition_hash IS DISTINCT FROM current_contract.definition_hash",
		"runtime_security_contract_preflight_mismatch",
		"pg_get_functiondef(function_entry.oid)",
		"pg_get_triggerdef(trigger_entry.oid, true)",
	} {
		if !strings.Contains(preflight, required) {
			t.Fatalf("audit-v3 security-contract preflight is missing %q", required)
		}
	}
	if strings.Count(preflight, "namespace.nspname = 'public'") != 3 {
		t.Fatal("security-contract preflight must inventory all public policies, functions, and triggers")
	}
	if strings.Contains(preflight, "to_regprocedure(") {
		t.Fatal("security-contract preflight must reject extra public functions, not filter to a function allowlist")
	}

	for _, mutation := range []string{
		"ALTER TABLE public.audit_events",
		"CREATE OR REPLACE FUNCTION public.validate_audit_event_chain_insert",
		"CREATE FUNCTION public.audit_chain_v3_frame",
		"CREATE FUNCTION public.append_audit_event_v3",
		"DROP FUNCTION public.append_audit_event_v2",
		"DROP POLICY skyview_outbox_insert_scope",
		"CREATE POLICY skyview_outbox_insert_scope",
		"DELETE FROM public.runtime_security_contracts",
		"INSERT INTO public.runtime_security_contracts",
	} {
		position := strings.Index(migration, mutation)
		if position < 0 {
			t.Fatalf("audit-v3 migration is missing expected mutation %q", mutation)
		}
		if position < preflightEnd {
			t.Fatalf("audit-v3 mutation %q occurs before the PG011 security contract is verified", mutation)
		}
	}
	if auditPreflight := strings.Index(migration, "DO $audit_v3_preflight$"); auditPreflight < preflightEnd {
		t.Fatal("PG011 security-contract verification must be the first migration preflight")
	}
}

func TestPostgreSQLRLSPolicyInventoryMatchesRuntimeGate(t *testing.T) {
	items, err := loadPostgresMigrations()
	if err != nil {
		t.Fatal(err)
	}
	migration := items[10].sql
	policyPattern := regexp.MustCompile(`(?im)CREATE\s+POLICY\s+([a-z_]+)\s+ON\s+public\.([a-z_]+)(?:\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE))?`)
	actual := make(map[string]runtimeRLSPolicy)
	for _, match := range policyPattern.FindAllStringSubmatch(migration, -1) {
		command := "*"
		switch strings.ToUpper(match[3]) {
		case "SELECT":
			command = "r"
		case "INSERT":
			command = "a"
		case "UPDATE":
			command = "w"
		case "DELETE":
			command = "d"
		}
		key := match[2] + "\x00" + match[1]
		if _, duplicate := actual[key]; duplicate {
			t.Fatalf("duplicate RLS policy %s.%s", match[2], match[1])
		}
		actual[key] = runtimeRLSPolicy{table: match[2], policy: match[1], command: command}
	}
	if len(actual) != len(runtimeRLSPolicies) {
		t.Fatalf("migration policy count = %d, runtime gate count = %d", len(actual), len(runtimeRLSPolicies))
	}
	for _, expected := range runtimeRLSPolicies {
		key := expected.table + "\x00" + expected.policy
		if got, ok := actual[key]; !ok || got.command != expected.command {
			t.Fatalf("RLS policy mismatch for %s.%s: got %+v", expected.table, expected.policy, got)
		}
	}

	outboxStart := strings.Index(migration, "CREATE POLICY skyview_outbox_select_scope")
	outboxEnd := strings.Index(migration, "CREATE POLICY skyview_outbox_insert_scope")
	if outboxStart < 0 || outboxEnd <= outboxStart {
		t.Fatal("cannot isolate outbox SELECT policy")
	}
	outboxSelect := migration[outboxStart:outboxEnd]
	for _, required := range []string{"skyview.operation", "outbox_enqueue", "skyview.outbox_event_id", "skyview.relay_scopes", "worker_scopes", "aggregate_type = 'job'"} {
		if !strings.Contains(outboxSelect, required) {
			t.Fatalf("outbox SELECT policy is missing exact enqueue/relay proof %q", required)
		}
	}

	workbenchStateStart := strings.Index(migration, "CREATE POLICY skyview_workbench_state_scope")
	if workbenchStateStart < 0 {
		t.Fatal("cannot isolate workbench-state RLS policy")
	}
	workbenchStateEnd := strings.Index(migration[workbenchStateStart:], "-- RLS prevents moving a row")
	if workbenchStateEnd < 0 {
		t.Fatal("cannot isolate workbench-state RLS policy")
	}
	workbenchStatePolicy := migration[workbenchStateStart : workbenchStateStart+workbenchStateEnd]
	if strings.Count(workbenchStatePolicy, "user_id = COALESCE(current_setting('skyview.user_id', true), '')") != 2 {
		t.Fatal("workbench-state RLS must bind both visibility and writes to the current user")
	}
	if strings.Contains(workbenchStatePolicy, "skyview.role") || strings.Contains(workbenchStatePolicy, "admin") {
		t.Fatal("workbench-state RLS must not grant an administrator access to another user's draft")
	}

	finalMigration := items[11].sql
	outboxInsertStart := strings.Index(finalMigration, "CREATE POLICY skyview_outbox_insert_scope")
	outboxInsertEnd := strings.Index(finalMigration, "-- PostgreSQL/Go golden vector")
	if outboxInsertStart < 0 || outboxInsertEnd <= outboxInsertStart {
		t.Fatal("cannot isolate final outbox INSERT policy")
	}
	outboxInsert := finalMigration[outboxInsertStart:outboxInsertEnd]
	firstActorBranch := strings.Index(outboxInsert, "current_setting('skyview.actor_kind', true)")
	if firstActorBranch < 0 {
		t.Fatal("final outbox INSERT policy has no actor branch")
	}
	topLevelGate := outboxInsert[:firstActorBranch]
	if !strings.Contains(topLevelGate, "current_setting('skyview.operation', true)") ||
		!strings.Contains(topLevelGate, "current_setting('skyview.outbox_event_id', true)") {
		t.Fatal("outbox operation and exact event ID must guard every INSERT actor branch")
	}
	for _, required := range []string{
		"skyview.operation", "outbox_enqueue", "skyview.outbox_event_id",
		"event_type IN ('job.succeeded', 'job.failed')", "scoped_job.status = 'succeeded'",
		"payload_json->>'status' = scoped_job.status", "worker_scopes", "allowed_action.value = scoped_job.action",
	} {
		if !strings.Contains(outboxInsert, required) {
			t.Fatalf("final outbox INSERT policy is missing exact proof %q", required)
		}
	}
	workerStart := strings.Index(outboxInsert, "= 'worker'")
	if workerStart < 0 {
		t.Fatal("final outbox INSERT policy has no worker branch")
	}
	workerBranch := outboxInsert[workerStart:]
	if strings.Contains(workerBranch, "job.created") || strings.Contains(workerBranch, "job.cancelled") {
		t.Fatal("compute workers must not enqueue create/cancel lifecycle events")
	}
}

func TestJobCreationRollsBackWhenRunCreationFails(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-tx", "workspace-tx", "owner@example.test", "Owner", "admin")
	if err != nil {
		t.Fatal(err)
	}
	project, err := projectStore.CreateProject(identity.Scope(), "paper-writing", "Transaction", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`CREATE TRIGGER reject_test_run BEFORE INSERT ON workbench_runs BEGIN SELECT RAISE(ABORT, 'test_run_rejected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := projectStore.CreateJob(identity.Scope(), project.ID, project.Slug, "audit", map[string]any{"text": "draft"}, "tx-rollback"); err == nil {
		t.Fatal("expected run insertion failure")
	}
	for _, table := range []string{"jobs", "workbench_runs"} {
		var count int
		if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s escaped the failed transaction: count=%d", table, count)
		}
	}
}
