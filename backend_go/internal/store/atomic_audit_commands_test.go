package store

import (
	"context"
	"errors"
	"testing"
)

func TestAuditedBusinessMutationsRollbackWhenAuditInsertFails(t *testing.T) {
	t.Run("project create", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		forceAtomicAuditFailure(t, projectStore)
		_, err := projectStore.CreateProjectWithAudit(context.Background(), identity.Scope(), "paper-writing", "new", map[string]any{"draft": true},
			func(project Project) AuditEvent {
				return atomicTestAudit(identity.Scope(), "project.create", "project", project.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		projects, err := projectStore.ListProjects(identity.Scope(), "paper-writing")
		if err != nil || len(projects) != 0 {
			t.Fatalf("project create escaped rollback: projects=%+v err=%v", projects, err)
		}
	})

	t.Run("project update", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		project, err := projectStore.CreateProject(identity.Scope(), "paper-writing", "before", map[string]any{"version": 1})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, _, err = projectStore.UpdateProjectWithAudit(context.Background(), identity.Scope(), project.ID, "after", map[string]any{"version": 2},
			func(before, after Project) AuditEvent {
				return atomicTestAudit(identity.Scope(), "project.update", "project", after.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		stored, found, err := projectStore.GetProject(identity.Scope(), project.ID)
		if err != nil || !found || stored.Title != "before" || stored.State["version"] != float64(1) {
			t.Fatalf("project update escaped rollback: project=%+v found=%v err=%v", stored, found, err)
		}
	})

	t.Run("project delete", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		project, err := projectStore.CreateProject(identity.Scope(), "paper-writing", "retained", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, err = projectStore.DeleteProjectWithAudit(context.Background(), identity.Scope(), project.ID,
			func(before Project) AuditEvent {
				return atomicTestAudit(identity.Scope(), "project.delete", "project", before.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		if _, found, err := projectStore.GetProject(identity.Scope(), project.ID); err != nil || !found {
			t.Fatalf("project delete escaped rollback: found=%v err=%v", found, err)
		}
	})

	t.Run("project version create", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		project, err := projectStore.CreateProject(identity.Scope(), "paper-writing", "versioned", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, _, err = projectStore.CreateVersionWithAudit(context.Background(), identity.Scope(), project.ID, "v1", map[string]any{"value": 1},
			func(version Version) AuditEvent {
				return atomicTestAudit(identity.Scope(), "project.version.create", "project_version", version.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		versions, err := projectStore.ListVersions(identity.Scope(), project.ID)
		if err != nil || len(versions) != 0 {
			t.Fatalf("version create escaped rollback: versions=%+v err=%v", versions, err)
		}
	})

	t.Run("workbench state create", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		forceAtomicAuditFailure(t, projectStore)
		_, err := projectStore.PutWorkbenchStateWithAudit(context.Background(), identity.Scope(), "paper-writing", 0, map[string]any{"draft": "new"},
			func(_, after WorkbenchState) AuditEvent {
				return atomicTestAudit(identity.Scope(), "workbench.state.update", "workbench", "paper-writing")
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		if _, found, err := projectStore.GetWorkbenchState(identity.Scope(), "paper-writing"); err != nil || found {
			t.Fatalf("workbench state create escaped rollback: found=%v err=%v", found, err)
		}
	})

	t.Run("workbench state update", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		before, err := projectStore.PutWorkbenchState(identity.Scope(), "paper-writing", 0, map[string]any{"draft": "before"})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, err = projectStore.PutWorkbenchStateWithAudit(context.Background(), identity.Scope(), "paper-writing", before.Revision, map[string]any{"draft": "after"},
			func(_, after WorkbenchState) AuditEvent {
				return atomicTestAudit(identity.Scope(), "workbench.state.update", "workbench", "paper-writing")
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		stored, found, err := projectStore.GetWorkbenchState(identity.Scope(), "paper-writing")
		if err != nil || !found || stored.Revision != before.Revision || stored.State["draft"] != "before" {
			t.Fatalf("workbench state update escaped rollback: state=%+v found=%v err=%v", stored, found, err)
		}
	})

	t.Run("shared create", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		forceAtomicAuditFailure(t, projectStore)
		_, err := projectStore.CreateSharedWithAudit(context.Background(), identity.Scope(), "discussions", map[string]any{"title": "new"},
			func(record SharedRecord) AuditEvent {
				return atomicTestAudit(identity.Scope(), "collaboration.discussions.create", "discussions", record.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		records, err := projectStore.ListShared(identity.Scope(), "discussions")
		if err != nil || len(records) != 0 {
			t.Fatalf("shared create escaped rollback: records=%+v err=%v", records, err)
		}
	})

	t.Run("shared update", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		record, err := projectStore.CreateShared(identity.Scope(), "discussions", map[string]any{"title": "before"})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, _, _, err = projectStore.UpdateSharedWithAudit(context.Background(), identity.Scope(), "discussions", record.ID, record.Revision, map[string]any{"title": "after"},
			func(before, after SharedRecord) AuditEvent {
				return atomicTestAudit(identity.Scope(), "collaboration.discussions.update", "discussions", after.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		stored, found, err := projectStore.GetShared(identity.Scope(), "discussions", record.ID)
		if err != nil || !found || stored.Revision != record.Revision || stored.Data["title"] != "before" {
			t.Fatalf("shared update escaped rollback: record=%+v found=%v err=%v", stored, found, err)
		}
	})

	t.Run("shared delete", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		record, err := projectStore.CreateShared(identity.Scope(), "assignments", map[string]any{"title": "retained"})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, err = projectStore.DeleteSharedWithAudit(context.Background(), identity.Scope(), "assignments", record.ID,
			func(before SharedRecord) AuditEvent {
				return atomicTestAudit(identity.Scope(), "collaboration.assignments.delete", "assignments", before.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		if _, found, err := projectStore.GetShared(identity.Scope(), "assignments", record.ID); err != nil || !found {
			t.Fatalf("shared delete escaped rollback: found=%v err=%v", found, err)
		}
	})

	t.Run("discussion reply", func(t *testing.T) {
		projectStore, identity := atomicAuditFixture(t)
		record, err := projectStore.CreateShared(identity.Scope(), "discussions", map[string]any{"replies": []any{}})
		if err != nil {
			t.Fatal(err)
		}
		forceAtomicAuditFailure(t, projectStore)
		_, _, _, err = projectStore.UpdateSharedWithAudit(context.Background(), identity.Scope(), "discussions", record.ID, record.Revision,
			map[string]any{"replies": []any{map[string]any{"body": "must rollback"}}},
			func(before, after SharedRecord) AuditEvent {
				return atomicTestAudit(identity.Scope(), "collaboration.discussion.reply", "discussion", after.ID)
			})
		if err == nil {
			t.Fatal("expected forced audit failure")
		}
		stored, found, err := projectStore.GetShared(identity.Scope(), "discussions", record.ID)
		if err != nil || !found || stored.Revision != record.Revision || len(stored.Data["replies"].([]any)) != 0 {
			t.Fatalf("discussion reply escaped rollback: record=%+v found=%v err=%v", stored, found, err)
		}
	})
}

func TestAuditedBusinessMutationCommitsRowAndChainTogether(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	project, err := projectStore.CreateProjectWithAudit(context.Background(), identity.Scope(), "paper-writing", "atomic", map[string]any{"draft": true},
		func(project Project) AuditEvent {
			return atomicTestAudit(identity.Scope(), "project.create", "project", project.ID)
		})
	if err != nil {
		t.Fatal(err)
	}
	if _, found, err := projectStore.GetProject(identity.Scope(), project.ID); err != nil || !found {
		t.Fatalf("committed project missing: found=%v err=%v", found, err)
	}
	events, err := projectStore.ListAudit(identity.Scope(), 10)
	if err != nil || len(events) != 1 || events[0].ResourceID != project.ID || events[0].Sequence != 1 || events[0].ChainVersion != auditChainVersion {
		t.Fatalf("atomic audit missing or invalid: events=%+v err=%v", events, err)
	}
	if err := projectStore.VerifyAuditChain(identity.Scope()); err != nil {
		t.Fatalf("verify committed atomic audit chain: %v", err)
	}
}

func TestAuditedBusinessMutationRollsBackWhenAuditHeadAdvanceFails(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	_, err := projectStore.database.Exec(`CREATE TRIGGER force_atomic_audit_head_failure
		BEFORE UPDATE ON audit_heads
		BEGIN
			SELECT RAISE(ABORT, 'forced atomic audit head failure');
		END`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = projectStore.CreateProjectWithAudit(context.Background(), identity.Scope(), "paper-writing", "must rollback", map[string]any{},
		func(project Project) AuditEvent {
			return atomicTestAudit(identity.Scope(), "project.create", "project", project.ID)
		})
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit head failure, got %v", err)
	}
	projects, err := projectStore.ListProjects(identity.Scope(), "paper-writing")
	if err != nil || len(projects) != 0 {
		t.Fatalf("audit head failure committed project: projects=%+v err=%v", projects, err)
	}
	var events, heads int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM audit_events`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM audit_heads`).Scan(&heads); err != nil {
		t.Fatal(err)
	}
	if events != 0 || heads != 0 {
		t.Fatalf("audit failure left partial chain state: events=%d heads=%d", events, heads)
	}
}

func TestAuditedBusinessMutationRejectsMismatchedAuditScopeAndRollsBack(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	_, err := projectStore.CreateProjectWithAudit(context.Background(), identity.Scope(), "paper-writing", "wrong scope", map[string]any{},
		func(project Project) AuditEvent {
			event := atomicTestAudit(identity.Scope(), "project.create", "project", project.ID)
			event.WorkspaceID = "another-workspace"
			return event
		})
	if err == nil || err.Error() != "business audit scope does not match authenticated mutation scope" {
		t.Fatalf("expected mismatched audit scope failure, got %v", err)
	}
	projects, listErr := projectStore.ListProjects(identity.Scope(), "paper-writing")
	if listErr != nil || len(projects) != 0 {
		t.Fatalf("mismatched audit scope committed project: projects=%+v err=%v", projects, listErr)
	}
}

func atomicAuditFixture(t *testing.T) (*ProjectStore, Identity) {
	t.Helper()
	projectStore := openTestProjectStore(t, ":memory:")
	identity, err := projectStore.EnsureDevIdentity("tenant-atomic", "workspace-atomic", "atomic@example.test", "Atomic User", "admin")
	if err != nil {
		t.Fatal(err)
	}
	return projectStore, identity
}

func forceAtomicAuditFailure(t *testing.T, projectStore *ProjectStore) {
	t.Helper()
	_, err := projectStore.database.Exec(`CREATE TRIGGER force_atomic_audit_failure
		BEFORE INSERT ON audit_events
		BEGIN
			SELECT RAISE(ABORT, 'forced atomic audit failure');
		END`)
	if err != nil {
		t.Fatal(err)
	}
}

func atomicTestAudit(scope Scope, action, resourceType, resourceID string) AuditEvent {
	return AuditEvent{
		TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, ActorUserID: scope.UserID,
		Action: action, ResourceType: resourceType, ResourceID: resourceID, Outcome: "success",
		RequestID: "request-atomic", Metadata: map[string]any{},
	}
}
