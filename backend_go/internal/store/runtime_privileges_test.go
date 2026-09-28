package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestSQLiteDevelopmentSkipsRuntimePrivilegeValidation(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = projectStore.Close() }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := projectStore.ValidateRuntimePrivileges(ctx); err != nil {
		t.Fatalf("SQLite development privilege validation must be skipped: %v", err)
	}
}

func TestRuntimePrivilegeMatrixMatchesInfrastructureACLs(t *testing.T) {
	lockdownPath := filepath.Join("..", "..", "..", "infra", "postgres", "lockdown-skyview-runtime.sql")
	verifierPath := filepath.Join("..", "..", "..", "infra", "postgres", "verify-skyview-privileges.sql")
	lockdownBytes, err := os.ReadFile(lockdownPath)
	if err != nil {
		t.Fatal(err)
	}
	verifierBytes, err := os.ReadFile(verifierPath)
	if err != nil {
		t.Fatal(err)
	}
	lockdown, verifier := string(lockdownBytes), string(verifierBytes)

	lockdownRows := regexp.MustCompile(`\('([a-z_]+)', '([A-Z, ]+)'\)`).FindAllStringSubmatch(lockdown, -1)
	verifierRows := regexp.MustCompile(`\('([a-z_]+)', (true|false), (true|false), (true|false), (true|false)\)`).FindAllStringSubmatch(verifier, -1)
	if len(lockdownRows) != len(runtimeTableGrants) || len(verifierRows) != len(runtimeTableGrants) {
		t.Fatalf("ACL inventories differ: application=%d lockdown=%d verifier=%d", len(runtimeTableGrants), len(lockdownRows), len(verifierRows))
	}

	for _, grant := range runtimeTableGrants {
		privileges := make([]string, 0, 4)
		if grant.selectable {
			privileges = append(privileges, "SELECT")
		}
		if grant.insertable {
			privileges = append(privileges, "INSERT")
		}
		if grant.updatable {
			privileges = append(privileges, "UPDATE")
		}
		if grant.deletable {
			privileges = append(privileges, "DELETE")
		}
		lockdownTuple := fmt.Sprintf("('%s', '%s')", grant.name, strings.Join(privileges, ", "))
		verifierTuple := fmt.Sprintf("('%s', %t, %t, %t, %t)", grant.name, grant.selectable, grant.insertable, grant.updatable, grant.deletable)
		if strings.Count(lockdown, lockdownTuple) != 1 {
			t.Fatalf("lockdown ACL is missing or duplicates %s", lockdownTuple)
		}
		if strings.Count(verifier, verifierTuple) != 1 {
			t.Fatalf("privilege verifier is missing or duplicates %s", verifierTuple)
		}
	}
}

func TestRuntimePrivilegeMatrixIsCompleteAndFailClosed(t *testing.T) {
	expected := map[string]string{
		"schema_migrations":          "s",
		"runtime_security_contracts": "s",
		"tenants":                    "s",
		"users":                      "s",
		"workspaces":                 "s",
		"memberships":                "s",
		"projects":                   "siud",
		"project_versions":           "si",
		"sessions":                   "siud",
		"jobs":                       "siu",
		"workbench_runs":             "siu",
		"workbench_states":           "siu",
		"shared_records":             "siud",
		"audit_events":               "s",
		"audit_heads":                "s",
		"oidc_identities":            "siu",
		"oidc_login_transactions":    "sid",
		"outbox_events":              "siu",
	}
	if len(runtimeTableGrants) != len(expected) {
		t.Fatalf("reviewed table count = %d, want %d", len(runtimeTableGrants), len(expected))
	}
	for _, grant := range runtimeTableGrants {
		got := ""
		if grant.selectable {
			got += "s"
		}
		if grant.insertable {
			got += "i"
		}
		if grant.updatable {
			got += "u"
		}
		if grant.deletable {
			got += "d"
		}
		want, exists := expected[grant.name]
		if !exists {
			t.Fatalf("unreviewed table %q in runtime matrix", grant.name)
		}
		if got != want {
			t.Fatalf("table %q grants = %q, want %q", grant.name, got, want)
		}
		delete(expected, grant.name)
	}
	if len(expected) != 0 {
		t.Fatalf("tables missing from runtime matrix: %v", expected)
	}
}

func TestRuntimeSequencePrivilegeAllowlistIsExplicitlyEmpty(t *testing.T) {
	if len(runtimeSequenceGrants) != 0 {
		t.Fatalf("current migrations use no sequences, but runtime allowlist contains %d entries", len(runtimeSequenceGrants))
	}
	lockdownPath := filepath.Join("..", "..", "..", "infra", "postgres", "lockdown-skyview-runtime.sql")
	verifierPath := filepath.Join("..", "..", "..", "infra", "postgres", "verify-skyview-privileges.sql")
	lockdownBytes, err := os.ReadFile(lockdownPath)
	if err != nil {
		t.Fatal(err)
	}
	verifierBytes, err := os.ReadFile(verifierPath)
	if err != nil {
		t.Fatal(err)
	}
	lockdown, verifier := string(lockdownBytes), string(verifierBytes)
	if regexp.MustCompile(`(?i)GRANT\s+[^;\r\n]*ON\s+ALL\s+SEQUENCES`).MatchString(lockdown) {
		t.Fatal("lockdown must not grant privileges on all present or future sequences")
	}
	for name, document := range map[string]string{"lockdown": lockdown, "verifier": verifier} {
		for _, required := range []string{"reviewed_sequence_grants", "SELECT NULL::text", "WHERE false"} {
			if !strings.Contains(document, required) {
				t.Fatalf("%s does not encode the empty sequence allowlist with %q", name, required)
			}
		}
	}
}

func TestRuntimePublicFunctionInventoryAndACLsAreExact(t *testing.T) {
	expected := map[string]bool{
		"reject_audit_event_mutation()":       false,
		"validate_audit_event_chain_insert()": false,
		"reject_identity_column_mutation()":   false,
		"resolve_session_identity_v1(text)":   true,
		"audit_chain_v3_frame(text, text)":    false,
		"append_audit_event_v3(text, text, text, text, text, text, text, text, text, text, text, text, text, text)": true,
	}
	if len(runtimePublicFunctions) != len(expected) {
		t.Fatalf("reviewed public function count = %d, want %d", len(runtimePublicFunctions), len(expected))
	}
	for _, function := range runtimePublicFunctions {
		wantRuntime, exists := expected[function.identity]
		if !exists {
			t.Fatalf("unexpected public function %q", function.identity)
		}
		if function.kind != "f" || function.extension != "" || function.runtimeExecutable != wantRuntime {
			t.Fatalf("public function %q metadata = kind %q extension %q runtime=%t", function.identity, function.kind, function.extension, function.runtimeExecutable)
		}
		delete(expected, function.identity)
	}
	if len(expected) != 0 {
		t.Fatalf("public functions missing from inventory: %v", expected)
	}

	lockdownPath := filepath.Join("..", "..", "..", "infra", "postgres", "lockdown-skyview-runtime.sql")
	verifierPath := filepath.Join("..", "..", "..", "infra", "postgres", "verify-skyview-privileges.sql")
	lockdownBytes, err := os.ReadFile(lockdownPath)
	if err != nil {
		t.Fatal(err)
	}
	verifierBytes, err := os.ReadFile(verifierPath)
	if err != nil {
		t.Fatal(err)
	}
	lockdown, verifier := string(lockdownBytes), string(verifierBytes)
	for _, function := range runtimePublicFunctions {
		if !strings.Contains(lockdown, "'"+function.identity+"'") {
			t.Fatalf("lockdown exact public function inventory is missing %q", function.identity)
		}
		if !strings.Contains(verifier, "('"+function.identity+"', '"+function.kind+"'") {
			t.Fatalf("live verifier exact public function inventory is missing %q", function.identity)
		}
	}
	for name, document := range map[string]string{"lockdown": lockdown, "verifier": verifier} {
		for _, required := range []string{"pg_extension", "extension_dependency.deptype = 'e'", "public function inventory"} {
			if !strings.Contains(document, required) {
				t.Fatalf("%s does not fail closed on unknown/extension routines with %q", name, required)
			}
		}
	}
	for _, required := range []string{
		"REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE",
		"function_acl.grantee <> function_entry.proowner",
		"The exact-inventory check above prevents unknown routines",
	} {
		if !strings.Contains(lockdown, required) {
			t.Fatalf("lockdown does not remove third-party function ACLs: missing %q", required)
		}
	}
	for _, required := range []string{
		"public function ACL grantees are exact",
		"function_acl.grantee <> live.function_owner",
		"reviewed.runtime_executable",
		"NOT function_acl.is_grantable",
	} {
		if !strings.Contains(verifier, required) {
			t.Fatalf("live verifier does not reject third-party or grant-option function ACLs: missing %q", required)
		}
	}
}

func TestRuntimePrivilegeQuerySecurityContract(t *testing.T) {
	query, err := runtimePrivilegeQuery(runtimeTableGrants)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"current_user", "current_database()", "NOT rolsuper", "NOT rolcreatedb", "NOT rolcreaterole",
		"NOT rolinherit", "NOT rolreplication", "NOT rolbypassrls", "pg_auth_members",
		"role has no members", "membership.roleid",
		"TEMPORARY", "has_schema_privilege", "pg_get_userbyid", "reviewed table inventory matches deployed tables",
		"TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN", "server_version_num", "audit events are directly read-only", "audit heads are directly read-only",
		"migration ledger is read-only", "reviewed_sequence_grants", "exact empty-by-default allowlist", "has_sequence_privilege", "has_function_privilege",
		"has_any_column_privilege", "has_column_privilege", "pg_attribute", "attacl", "relation.relacl",
		"reviewed table ACL grantees are exact", "table_acl.grantee NOT IN", "table_acl.is_grantable",
		"reviewed tables have no non-owner column ACLs", "column_acl.grantee <> relation.relowner",
		"current_schemas(false)", "pg_catalog", "append_audit_event_v3", "audit_chain_v3_frame", "resolve_session_identity_v1",
		"function_acl.grantee NOT IN", "function_acl.grantor", "function_acl.is_grantable", "NOT function_acl.is_grantable",
		"reviewed_public_functions", "live_public_functions", "public function inventory is exact", "public function ACL grantees are exact",
		"pg_extension", "extension_dependency.deptype = 'e'", "function_acl.grantee <> live.function_owner", "reviewed.runtime_executable",
		"relrowsecurity", "reviewed_rls_policies", "polpermissive", "runtime_security_contracts",
		"live security definitions match migration-sealed hashes", "pg_get_triggerdef", "pg_get_functiondef",
		"unreviewed public relations", "prosecdef", "aclexplode",
	} {
		if !strings.Contains(query, required) {
			t.Fatalf("runtime privilege query is missing %q", required)
		}
	}
	if strings.Contains(strings.ToLower(query), "skyview_runtime") {
		t.Fatal("runtime validation must derive the identity from current_user")
	}
	if strings.Count(query, "?") != 1 {
		t.Fatalf("schema must use exactly one bound parameter, query has %d", strings.Count(query, "?"))
	}
	rebound := rebind(query, dialectPostgreSQL)
	if strings.Contains(rebound, "?") || !strings.Contains(rebound, "$1::text") {
		t.Fatal("runtime privilege query schema parameter was not rebound safely")
	}
}

func TestPostgreSQLMigratorIdentityRejectsBidirectionalRoleMemberships(t *testing.T) {
	for _, required := range []string{
		"FROM pg_auth_members membership",
		"membership.member = role_entry.oid",
		"membership.roleid = role_entry.oid",
	} {
		if !strings.Contains(postgresMigratorIdentityQuery, required) {
			t.Fatalf("migrator identity gate is missing %q", required)
		}
	}
	if strings.Count(postgresMigratorIdentityQuery, "?") != 3 {
		t.Fatalf("migrator identity query placeholder count changed: %d", strings.Count(postgresMigratorIdentityQuery, "?"))
	}
}

func TestRuntimePrivilegeQueryRejectsInvalidMatrices(t *testing.T) {
	if _, err := runtimePrivilegeQuery(nil); err == nil {
		t.Fatal("empty runtime privilege matrix must fail closed")
	}
	if _, err := runtimePrivilegeQuery([]runtimeTableGrant{{name: "projects"}, {name: "projects"}}); err == nil {
		t.Fatal("duplicate runtime privilege table must fail closed")
	}
	if _, err := runtimePrivilegeQuery([]runtimeTableGrant{{name: "unsafe'table"}}); err == nil {
		t.Fatal("unsafe runtime privilege table name must be rejected")
	}
}

func TestNilPostgreSQLPrivilegeValidatorFailsClosed(t *testing.T) {
	var projectStore *ProjectStore
	if err := projectStore.ValidateRuntimePrivileges(context.Background()); !errors.Is(err, ErrRuntimePrivilegeVerificationUnavailable) {
		t.Fatalf("nil store must fail closed, got %v", err)
	}
}
