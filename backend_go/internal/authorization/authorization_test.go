package authorization

import (
	"errors"
	"testing"
)

func TestMapUsesPublishedJobRelations(t *testing.T) {
	check := Check{
		Principal: Principal{UserID: "user-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: "student"},
		Relation:  RelationView,
		Resource: Resource{
			Type: ResourceJob, ID: "job-1", TenantID: "tenant-1", WorkspaceID: "workspace-1",
			OwnerUserID: "user-1", ParentType: ResourceProject, ParentID: "project-1",
		},
	}
	mapped, err := Map(check)
	if err != nil {
		t.Fatal(err)
	}
	if mapped.User != "user:user-1" || mapped.Relation != "can_view" || mapped.Object != "job:job-1" {
		t.Fatalf("unexpected tuple key: %#v", mapped)
	}
	want := map[TupleKey]bool{
		{User: "user:user-1", Relation: "member", Object: "workspace:workspace-1"}:     true,
		{User: "tenant:tenant-1", Relation: "tenant", Object: "workspace:workspace-1"}: true,
		{User: "user:user-1", Relation: "submitter", Object: "job:job-1"}:              true,
		{User: "project:project-1", Relation: "project", Object: "job:job-1"}:          true,
	}
	for _, tuple := range mapped.ContextualTuples {
		delete(want, tuple)
	}
	if len(want) != 0 {
		t.Fatalf("missing contextual tuples: %#v", want)
	}
}

func TestValidateRejectsScopeAndTypeConfusion(t *testing.T) {
	base := Check{
		Principal: Principal{UserID: "user-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: "admin"},
		Relation:  RelationView,
		Resource:  Resource{Type: ResourceProject, ID: "project-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", OwnerUserID: "owner-1"},
	}
	tests := []Check{base, base, base}
	tests[0].Resource.TenantID = "tenant-2"
	tests[1].Resource.ID = "project:other"
	tests[2].Relation = RelationGrade
	for _, check := range tests {
		if err := Validate(check); !errors.Is(err, ErrInvalidCheck) {
			t.Fatalf("expected invalid check, got %v", err)
		}
	}
}

func TestResearcherMapsToWorkspaceEditor(t *testing.T) {
	check := Check{
		Principal: Principal{UserID: "researcher-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: "researcher"},
		Relation:  RelationEdit,
		Resource: Resource{
			Type: ResourceProject, ID: "project-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", OwnerUserID: "owner-1",
		},
	}
	mapped, err := Map(check)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tuple := range mapped.ContextualTuples {
		if tuple == (TupleKey{User: "user:researcher-1", Relation: "editor", Object: "workspace:workspace-1"}) {
			found = true
		}
	}
	if !found {
		t.Fatalf("researcher workspace editor tuple missing: %#v", mapped.ContextualTuples)
	}
	allowed, err := (LocalFallback{}).Check(t.Context(), check)
	if err != nil || !allowed {
		t.Fatalf("researcher project access must be supported: allowed=%v err=%v", allowed, err)
	}
}

func TestLocalFallbackScopesStudentAndViewerToOwnedProjects(t *testing.T) {
	for _, role := range []string{"student", "viewer"} {
		check := Check{
			Principal: Principal{UserID: role + "-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: role},
			Relation:  RelationView,
			Resource: Resource{
				Type: ResourceProject, ID: "project-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", OwnerUserID: "someone-else",
			},
		}
		allowed, err := (LocalFallback{}).Check(t.Context(), check)
		if err != nil || allowed {
			t.Fatalf("%s must not read another user's project: allowed=%v err=%v", role, allowed, err)
		}
	}
}

func TestLocalFallbackScopesStudentJobReadToSubmitter(t *testing.T) {
	check := Check{
		Principal: Principal{UserID: "student-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: "student"},
		Relation:  RelationView,
		Resource: Resource{
			Type: ResourceJob, ID: "job-1", TenantID: "tenant-1", WorkspaceID: "workspace-1",
			OwnerUserID: "student-2", ParentType: ResourceProject, ParentID: "project-2",
		},
	}
	allowed, err := (LocalFallback{}).Check(t.Context(), check)
	if err != nil || allowed {
		t.Fatalf("student must not read another submitter's job: allowed=%v err=%v", allowed, err)
	}
}

func TestLocalFallbackDoesNotTreatSubmittedRecordAsDraft(t *testing.T) {
	check := Check{
		Principal: Principal{UserID: "student-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: "student"},
		Relation:  RelationEdit,
		Resource: Resource{
			Type: ResourceSubmission, ID: "submission-1", TenantID: "tenant-1", WorkspaceID: "workspace-1",
			OwnerUserID: "student-1", ParentType: ResourceAssignment, ParentID: "assignment-1",
		},
	}
	allowed, err := (LocalFallback{}).Check(t.Context(), check)
	if err != nil || allowed {
		t.Fatalf("a submitted record must not be editable: allowed=%v err=%v", allowed, err)
	}
	check.Resource.DraftEditable = true
	allowed, err = (LocalFallback{}).Check(t.Context(), check)
	if err != nil || !allowed {
		t.Fatalf("an explicit server-side draft must remain editable: allowed=%v err=%v", allowed, err)
	}
}
