package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigrationUpgradesLegacyDatabaseWithoutDroppingRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`CREATE TABLE projects (
		id TEXT PRIMARY KEY, scope TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
		state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	); INSERT INTO projects(id, scope, slug, title, state_json, created_at, updated_at)
	VALUES('legacy-project', 'user-old', 'paper-writing', 'Legacy', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	projectStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	var tenantID, workspaceID, title string
	if err := projectStore.database.QueryRow(`SELECT tenant_id, workspace_id, title FROM projects WHERE id = 'legacy-project'`).Scan(&tenantID, &workspaceID, &title); err != nil {
		t.Fatal(err)
	}
	if tenantID != "legacy" || workspaceID != "legacy" || title != "Legacy" {
		t.Fatalf("unexpected migrated row: tenant=%s workspace=%s title=%s", tenantID, workspaceID, title)
	}
}

func TestVersionedMigrationsCreateFoundationTables(t *testing.T) {
	projectStore, err := NewProjectStore(filepath.Join(t.TempDir(), "foundation.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	var count int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 11 {
		t.Fatalf("expected 11 migrations, got %d", count)
	}
	for _, table := range []string{"tenants", "users", "workspaces", "memberships", "sessions", "jobs", "audit_events", "audit_heads", "oidc_identities", "outbox_events", "oidc_login_transactions", "workbench_states"} {
		var found int
		if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&found); err != nil {
			t.Fatal(err)
		}
		if found != 1 {
			t.Fatalf("missing table %s", table)
		}
	}
}

func TestAuditEventsAreAppendOnly(t *testing.T) {
	projectStore, err := NewProjectStore(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	event, err := projectStore.AppendAudit(AuditEvent{
		TenantID: "tenant-1", WorkspaceID: "workspace-1", ActorUserID: "user-1",
		Action: "project.create", ResourceType: "project", ResourceID: "project-1",
		Outcome: "success", RequestID: "request-1", Metadata: map[string]any{"source": "test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if event.EventHash == "" {
		t.Fatal("expected chained event hash")
	}
	if _, err := projectStore.database.Exec(`UPDATE audit_events SET outcome = 'changed' WHERE id = ?`, event.ID); err == nil {
		t.Fatal("audit update must be rejected")
	}
	if _, err := projectStore.database.Exec(`DELETE FROM audit_events WHERE id = ?`, event.ID); err == nil {
		t.Fatal("audit delete must be rejected")
	}
}
