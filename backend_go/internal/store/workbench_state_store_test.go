package store

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestWorkbenchStateIsSharedAcrossStoreInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared-state.db")
	first := openTestProjectStore(t, path)
	identity, err := first.EnsureDevIdentity("tenant-state", "workspace-state", "state@example.test", "State User", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	second := openTestProjectStore(t, path)

	input := map[string]any{"draft": map[string]any{"title": "Initial"}, "steps": []any{"collect", "review"}}
	created, err := first.PutWorkbenchState(identity.Scope(), "paper-writing", 0, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 || created.UpdatedAt == "" {
		t.Fatalf("unexpected created record: %+v", created)
	}

	// Mutating either caller-owned or returned nested data must not mutate the
	// durable state.
	input["draft"].(map[string]any)["title"] = "caller mutation"
	created.State["draft"].(map[string]any)["title"] = "return mutation"
	loaded, found, err := second.GetWorkbenchState(identity.Scope(), "paper-writing")
	if err != nil || !found {
		t.Fatalf("load shared state found=%v err=%v", found, err)
	}
	if got := loaded.State["draft"].(map[string]any)["title"]; got != "Initial" {
		t.Fatalf("stored state was aliased, title=%v", got)
	}
}

func TestWorkbenchStateCASAllowsOnlyOneConcurrentWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cas-state.db")
	first := openTestProjectStore(t, path)
	identity, err := first.EnsureDevIdentity("tenant-cas", "workspace-cas", "cas@example.test", "CAS User", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	second := openTestProjectStore(t, path)
	if _, err := first.PutWorkbenchState(identity.Scope(), "research-radar", 0, map[string]any{"winner": "none"}); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	errorsFound := make(chan error, 2)
	var wait sync.WaitGroup
	for index, candidate := range []struct {
		store *ProjectStore
		name  string
	}{{first, "first"}, {second, "second"}} {
		wait.Add(1)
		go func(index int, candidate struct {
			store *ProjectStore
			name  string
		}) {
			defer wait.Done()
			<-start
			_, err := candidate.store.PutWorkbenchState(identity.Scope(), "research-radar", 1, map[string]any{"winner": candidate.name, "index": index})
			errorsFound <- err
		}(index, candidate)
	}
	close(start)
	wait.Wait()
	close(errorsFound)

	successes, conflicts := 0, 0
	for err := range errorsFound {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrWorkbenchStateConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent write error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("CAS results successes=%d conflicts=%d", successes, conflicts)
	}
	loaded, found, err := first.GetWorkbenchState(identity.Scope(), "research-radar")
	if err != nil || !found || loaded.Revision != 2 {
		t.Fatalf("unexpected CAS result found=%v state=%+v err=%v", found, loaded, err)
	}
}

func TestWorkbenchStateUsesFullTenantWorkspaceUserScope(t *testing.T) {
	projectStore := openTestProjectStore(t, filepath.Join(t.TempDir(), "isolated-state.db"))
	owner, err := projectStore.EnsureDevIdentity("tenant-a", "workspace-a", "owner@example.test", "Owner", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	otherUser, err := projectStore.EnsureDevIdentity("tenant-a", "workspace-a", "other@example.test", "Other", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	otherTenant, err := projectStore.EnsureDevIdentity("tenant-b", "workspace-b", "owner@example.test", "Other Tenant", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.PutWorkbenchState(owner.Scope(), "data-lab", 0, map[string]any{"owner": "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.PutWorkbenchState(otherUser.Scope(), "data-lab", 0, map[string]any{"owner": "b"}); err != nil {
		t.Fatal(err)
	}

	for _, scope := range []Scope{otherTenant.Scope(), {TenantID: owner.TenantID, WorkspaceID: owner.WorkspaceID, UserID: otherTenant.UserID}} {
		if _, found, err := projectStore.GetWorkbenchState(scope, "data-lab"); err != nil || found {
			t.Fatalf("cross-scope read found=%v err=%v scope=%+v", found, err, scope)
		}
	}
	loaded, found, err := projectStore.GetWorkbenchState(otherUser.Scope(), "data-lab")
	if err != nil || !found || loaded.State["owner"] != "b" {
		t.Fatalf("user-owned state mismatch found=%v state=%+v err=%v", found, loaded, err)
	}
}

func TestWorkbenchStateRejectsOversizeWithoutPersisting(t *testing.T) {
	projectStore := openTestProjectStore(t, filepath.Join(t.TempDir(), "bounded-state.db"))
	identity, err := projectStore.EnsureDevIdentity("tenant-size", "workspace-size", "size@example.test", "Size User", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	boundaryValue := map[string]any{"payload": strings.Repeat("x", MaxWorkbenchStateBytes-len(`{"payload":""}`))}
	encoded, _, err := normalizeWorkbenchState(boundaryValue)
	if err != nil || len(encoded) != MaxWorkbenchStateBytes {
		t.Fatalf("exact boundary normalization bytes=%d err=%v", len(encoded), err)
	}
	created, err := projectStore.PutWorkbenchState(identity.Scope(), "knowledge-system", 0, boundaryValue)
	if err != nil || created.Revision != 1 {
		t.Fatalf("exact 1 MiB state was rejected record=%+v err=%v", created, err)
	}

	_, err = projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", 0,
		map[string]any{"payload": strings.Repeat("x", MaxWorkbenchStateBytes)})
	if !errors.Is(err, ErrWorkbenchStateTooLarge) {
		t.Fatalf("expected size error, got %v", err)
	}
	if _, found, err := projectStore.GetWorkbenchState(identity.Scope(), "paper-writing"); err != nil || found {
		t.Fatalf("oversize state persisted found=%v err=%v", found, err)
	}
	var count int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM workbench_states`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unexpected row count=%d err=%v", count, err)
	}
	if _, err := projectStore.PutWorkbenchState(identity.Scope(), "knowledge-system", created.Revision,
		map[string]any{"payload": strings.Repeat("y", MaxWorkbenchStateBytes)}); !errors.Is(err, ErrWorkbenchStateTooLarge) {
		t.Fatalf("expected oversize update error, got %v", err)
	}
	loaded, found, err := projectStore.GetWorkbenchState(identity.Scope(), "knowledge-system")
	if err != nil || !found || loaded.Revision != 1 || loaded.State["payload"] != boundaryValue["payload"] {
		t.Fatalf("oversize update changed stored row found=%v record=%+v err=%v", found, loaded, err)
	}
}

func TestWorkbenchStateRequiresActiveMembership(t *testing.T) {
	projectStore := openTestProjectStore(t, filepath.Join(t.TempDir(), "active-state.db"))
	identity, err := projectStore.EnsureDevIdentity("tenant-active", "workspace-active", "active@example.test", "Active User", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	created, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", 0, map[string]any{"draft": true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`UPDATE memberships SET status = 'suspended'
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?`, identity.TenantID, identity.WorkspaceID, identity.UserID); err != nil {
		t.Fatal(err)
	}
	if _, found, err := projectStore.GetWorkbenchState(identity.Scope(), "paper-writing"); err != nil || found {
		t.Fatalf("suspended membership could read state found=%v err=%v", found, err)
	}
	if _, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", created.Revision, map[string]any{"draft": false}); !errors.Is(err, ErrWorkbenchStateConflict) {
		t.Fatalf("suspended membership update error=%v", err)
	}
}

func TestWorkbenchStateMigrationEnforcesObjectSizeRevisionAndMembership(t *testing.T) {
	projectStore := openTestProjectStore(t, filepath.Join(t.TempDir(), "constraints-state.db"))
	identity, err := projectStore.EnsureDevIdentity("tenant-schema", "workspace-schema", "schema@example.test", "Schema User", "admin")
	if err != nil {
		t.Fatal(err)
	}
	var migrationName string
	if err := projectStore.database.QueryRow(`SELECT name FROM schema_migrations WHERE version = 8`).Scan(&migrationName); err != nil || migrationName != "workbench_states" {
		t.Fatalf("migration 8 name=%q err=%v", migrationName, err)
	}
	var tableSQL string
	if err := projectStore.database.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workbench_states'`).Scan(&tableSQL); err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{
		"PRIMARY KEY(tenant_id, workspace_id, user_id, slug)",
		"REFERENCES memberships(tenant_id, workspace_id, user_id)",
		"size_bytes BETWEEN 2 AND 1048576",
		"json_type(state_json) = 'object'",
		"revision >= 1",
	} {
		if !strings.Contains(tableSQL, fragment) {
			t.Fatalf("SQLite workbench state schema missing %q:\n%s", fragment, tableSQL)
		}
	}
	now := nowText()
	invalidRows := []struct {
		name      string
		tenantID  string
		workspace string
		userID    string
		stateJSON string
		size      int
		revision  int
	}{
		{name: "array", tenantID: identity.TenantID, workspace: identity.WorkspaceID, userID: identity.UserID, stateJSON: `[]`, size: 2, revision: 1},
		{name: "incorrect size", tenantID: identity.TenantID, workspace: identity.WorkspaceID, userID: identity.UserID, stateJSON: `{}`, size: 3, revision: 1},
		{name: "zero revision", tenantID: identity.TenantID, workspace: identity.WorkspaceID, userID: identity.UserID, stateJSON: `{}`, size: 2, revision: 0},
		{name: "missing membership", tenantID: identity.TenantID, workspace: identity.WorkspaceID, userID: "missing-user", stateJSON: `{}`, size: 2, revision: 1},
	}
	for _, item := range invalidRows {
		t.Run(item.name, func(t *testing.T) {
			_, err := projectStore.database.Exec(`INSERT INTO workbench_states(
				tenant_id, workspace_id, user_id, slug, state_json, size_bytes, revision, created_at, updated_at
			) VALUES(?, ?, ?, 'paper-writing', ?, ?, ?, ?, ?)`, item.tenantID, item.workspace, item.userID,
				item.stateJSON, item.size, item.revision, now, now)
			if err == nil {
				t.Fatal("database accepted invalid workbench state")
			}
		})
	}
	if _, err := projectStore.database.Exec(`INSERT INTO workbench_states(
		tenant_id, workspace_id, user_id, slug, state_json, size_bytes, revision, created_at, updated_at
	) VALUES(?, ?, ?, ?, '{}', 2, 1, ?, ?)`, identity.TenantID, identity.WorkspaceID, identity.UserID,
		strings.Repeat("s", maxWorkbenchStateKeyBytes+1), now, now); err == nil {
		t.Fatal("database accepted an overlong slug")
	}
}

func TestWorkbenchStateRequiresExplicitExpectedRevision(t *testing.T) {
	projectStore := openTestProjectStore(t, filepath.Join(t.TempDir(), "revision-state.db"))
	identity, err := projectStore.EnsureDevIdentity("tenant-revision", "workspace-revision", "revision@example.test", "Revision User", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", -1, map[string]any{}); !errors.Is(err, ErrInvalidWorkbenchState) {
		t.Fatalf("negative revision error=%v", err)
	}
	created, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", 0, map[string]any{"value": 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", 0, map[string]any{"value": 2}); !errors.Is(err, ErrWorkbenchStateConflict) {
		t.Fatalf("duplicate create error=%v", err)
	}
	if _, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", created.Revision+1, map[string]any{"value": 3}); !errors.Is(err, ErrWorkbenchStateConflict) {
		t.Fatalf("stale update error=%v", err)
	}
}

func openTestProjectStore(t *testing.T, path string) *ProjectStore {
	t.Helper()
	projectStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	return projectStore
}
