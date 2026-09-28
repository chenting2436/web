package store

import (
	"testing"
	"time"
)

func TestWorkerClaimScopeFiltersTenantWorkspaceSlugAndActionAtomically(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })

	makeJob := func(tenantID, workspaceID, slug, action, key string) Job {
		t.Helper()
		identity, err := projectStore.EnsureDevIdentity(tenantID, workspaceID, key+"@workers.test", key, "admin")
		if err != nil {
			t.Fatal(err)
		}
		project, err := projectStore.CreateProject(identity.Scope(), slug, key, map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		created, inserted, err := projectStore.CreateJob(identity.Scope(), project.ID, slug, action, map[string]any{"marker": key}, key)
		if err != nil || !inserted {
			t.Fatalf("create %s inserted=%t err=%v", key, inserted, err)
		}
		return created.Job
	}

	wrongTenant := makeJob("tenant-b", "workspace-b", "python-lab", "run", "wrong-tenant")
	wrongWorkspace := makeJob("tenant-a", "workspace-c", "python-lab", "run", "wrong-workspace")
	wrongSlug := makeJob("tenant-a", "workspace-a", "data-gateway", "run", "wrong-slug")
	wrongAction := makeJob("tenant-a", "workspace-a", "python-lab", "grade", "wrong-action")
	allowed := makeJob("tenant-a", "workspace-a", "python-lab", "run", "allowed")

	access := JobClaimAccess{WorkerID: "worker-scoped", Scopes: []JobClaimScope{{
		TenantID: "tenant-a", WorkspaceID: "workspace-a",
		Slug: "python-lab", Actions: []string{"run"},
	}}}
	claim, found, err := projectStore.ClaimNextJobWithLease(access, time.Minute)
	if err != nil || !found || claim.Job.ID != allowed.ID {
		t.Fatalf("scoped claim found=%t job=%q want=%q err=%v", found, claim.Job.ID, allowed.ID, err)
	}

	for dimension, job := range map[string]Job{
		"tenant": wrongTenant, "workspace": wrongWorkspace, "slug": wrongSlug, "action": wrongAction,
	} {
		stored, found, err := projectStore.GetJobInternal(job.ID)
		if err != nil || !found || stored.Status != "queued" || stored.WorkerID != "" {
			t.Errorf("%s-disallowed job was mutated: found=%t status=%q worker=%q err=%v", dimension, found, stored.Status, stored.WorkerID, err)
		}
	}
	if _, found, err := projectStore.ClaimNextJobWithLease(access, time.Minute); err != nil || found {
		t.Fatalf("only the exact allowed job may be claimed: found=%t err=%v", found, err)
	}
}

func TestWorkerClaimRejectsEmptyWildcardAndDuplicateScopes(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	valid := JobClaimScope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "python-lab", Actions: []string{"run"}}

	tests := []JobClaimAccess{
		{WorkerID: "worker"},
		{WorkerID: "worker", Scopes: []JobClaimScope{{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "*", Actions: []string{"run"}}}},
		{WorkerID: "worker", Scopes: []JobClaimScope{{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "python-lab", Actions: []string{"run", "run"}}}},
		{WorkerID: "worker", Scopes: []JobClaimScope{valid, valid}},
	}
	for index, access := range tests {
		if _, _, err := projectStore.ClaimNextJobWithLease(access, time.Minute); err == nil {
			t.Errorf("invalid access %d was accepted", index)
		}
	}
}
