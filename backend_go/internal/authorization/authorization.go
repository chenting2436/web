package authorization

import (
	"context"
	"errors"
	"fmt"
	"regexp"
)

type Relation string

// Relations intentionally match infra/openfga/authorization-model.fga.
const (
	RelationView   Relation = "can_view"
	RelationEdit   Relation = "can_edit"
	RelationCancel Relation = "can_cancel"
	RelationGrade  Relation = "can_grade"
)

type ResourceType string

const (
	ResourceWorkspace  ResourceType = "workspace"
	ResourceProject    ResourceType = "project"
	ResourceJob        ResourceType = "job"
	ResourceAssignment ResourceType = "assignment"
	ResourceSubmission ResourceType = "submission"
)

var (
	ErrInvalidCheck = errors.New("invalid authorization check")
	identifierRE    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	roles           = map[string]struct{}{
		"admin": {}, "researcher": {}, "teacher": {}, "reviewer": {}, "student": {}, "viewer": {},
	}
)

// Principal is derived from the authenticated server-side session. Callers
// must never populate it from request JSON or forwarding headers.
type Principal struct {
	UserID      string
	TenantID    string
	WorkspaceID string
	Role        string
}

// Resource contains ownership and hierarchy read from the server-side store.
// DraftEditable is computed from server-owned submission state.
type Resource struct {
	Type          ResourceType
	ID            string
	TenantID      string
	WorkspaceID   string
	OwnerUserID   string
	ParentType    ResourceType
	ParentID      string
	DraftEditable bool
}

type Check struct {
	Principal Principal
	Relation  Relation
	Resource  Resource
	RequestID string
}

type Authorizer interface {
	Check(context.Context, Check) (bool, error)
	Ready(context.Context) error
	Mode() string
}

type TupleKey struct {
	User     string `json:"user"`
	Relation string `json:"relation"`
	Object   string `json:"object"`
}

type MappedCheck struct {
	User             string
	Relation         string
	Object           string
	ContextualTuples []TupleKey
	Context          map[string]any
}

func Validate(check Check) error {
	principal := check.Principal
	resource := check.Resource
	if err := validID("user", principal.UserID); err != nil {
		return err
	}
	if err := validID("tenant", principal.TenantID); err != nil {
		return err
	}
	if err := validID("workspace", principal.WorkspaceID); err != nil {
		return err
	}
	if _, ok := roles[principal.Role]; !ok {
		return fmt.Errorf("%w: unsupported principal role", ErrInvalidCheck)
	}
	if principal.TenantID != resource.TenantID || principal.WorkspaceID != resource.WorkspaceID {
		return fmt.Errorf("%w: principal and resource scope differ", ErrInvalidCheck)
	}
	if err := validID(string(resource.Type), resource.ID); err != nil {
		return err
	}
	if !validRelation(resource.Type, check.Relation) {
		return fmt.Errorf("%w: unsupported relation %q for %q", ErrInvalidCheck, check.Relation, resource.Type)
	}
	if resource.OwnerUserID != "" {
		if err := validID("owner", resource.OwnerUserID); err != nil {
			return err
		}
	}
	if (resource.ParentType == "") != (resource.ParentID == "") {
		return fmt.Errorf("%w: parent type and id must be supplied together", ErrInvalidCheck)
	}
	if resource.ParentType != "" {
		if !validParent(resource.Type, resource.ParentType) {
			return fmt.Errorf("%w: unsupported parent type", ErrInvalidCheck)
		}
		if err := validID(string(resource.ParentType), resource.ParentID); err != nil {
			return err
		}
	}
	if (resource.Type == ResourceProject || resource.Type == ResourceJob || resource.Type == ResourceSubmission) && resource.OwnerUserID == "" {
		return fmt.Errorf("%w: resource owner is required", ErrInvalidCheck)
	}
	if resource.Type == ResourceJob && resource.ParentType != ResourceProject {
		return fmt.Errorf("%w: job project is required", ErrInvalidCheck)
	}
	if resource.Type == ResourceSubmission && resource.ParentType != ResourceAssignment {
		return fmt.Errorf("%w: submission assignment is required", ErrInvalidCheck)
	}
	if resource.Type == ResourceWorkspace && resource.ID != principal.WorkspaceID {
		return fmt.Errorf("%w: workspace resource does not match principal", ErrInvalidCheck)
	}
	if check.RequestID != "" && len(check.RequestID) > 128 {
		return fmt.Errorf("%w: request id is too long", ErrInvalidCheck)
	}
	return nil
}

// Map creates canonical OpenFGA names and contextual tuples from trusted
// server context. Production still requires durable tuple synchronization.
func Map(check Check) (MappedCheck, error) {
	if err := Validate(check); err != nil {
		return MappedCheck{}, err
	}
	principal := check.Principal
	resource := check.Resource
	user := object("user", principal.UserID)
	tenant := object("tenant", principal.TenantID)
	workspace := object("workspace", principal.WorkspaceID)
	resourceObject := object(string(resource.Type), resource.ID)

	tuples := []TupleKey{{User: tenant, Relation: "tenant", Object: workspace}}
	switch principal.Role {
	case "admin":
		tuples = append(tuples, TupleKey{User: user, Relation: "admin", Object: tenant})
	case "teacher", "researcher":
		tuples = append(tuples, TupleKey{User: user, Relation: "editor", Object: workspace})
	case "reviewer", "viewer":
		tuples = append(tuples, TupleKey{User: user, Relation: "viewer", Object: workspace})
	case "student":
		tuples = append(tuples, TupleKey{User: user, Relation: "member", Object: workspace})
	}

	switch resource.Type {
	case ResourceProject:
		tuples = append(tuples,
			TupleKey{User: workspace, Relation: "workspace", Object: resourceObject},
			TupleKey{User: object("user", resource.OwnerUserID), Relation: "owner", Object: resourceObject},
		)
		if principal.Role == "reviewer" {
			tuples = append(tuples, TupleKey{User: user, Relation: "reviewer", Object: resourceObject})
		}
	case ResourceJob:
		project := object("project", resource.ParentID)
		tuples = append(tuples,
			TupleKey{User: workspace, Relation: "workspace", Object: project},
			TupleKey{User: project, Relation: "project", Object: resourceObject},
			TupleKey{User: object("user", resource.OwnerUserID), Relation: "submitter", Object: resourceObject},
		)
		if principal.Role == "reviewer" {
			tuples = append(tuples, TupleKey{User: user, Relation: "reviewer", Object: project})
		}
	case ResourceAssignment:
		tuples = appendCourseTuples(tuples, principal, user, workspace, resourceObject)
	case ResourceSubmission:
		assignment := object("assignment", resource.ParentID)
		tuples = appendCourseTuples(tuples, principal, user, workspace, assignment)
		tuples = append(tuples,
			TupleKey{User: assignment, Relation: "assignment", Object: resourceObject},
			TupleKey{User: object("user", resource.OwnerUserID), Relation: "student", Object: resourceObject},
		)
		if resource.DraftEditable {
			tuples = append(tuples, TupleKey{User: object("user", resource.OwnerUserID), Relation: "draft_editor", Object: resourceObject})
		}
	}
	return MappedCheck{
		User: user, Relation: string(check.Relation), Object: resourceObject,
		ContextualTuples: tuples,
		Context: map[string]any{
			"tenant_id": principal.TenantID, "workspace_id": principal.WorkspaceID, "principal_role": principal.Role,
		},
	}, nil
}

func validID(name, value string) error {
	if !identifierRE.MatchString(value) {
		return fmt.Errorf("%w: %s identifier is invalid", ErrInvalidCheck, name)
	}
	return nil
}

func validRelation(resource ResourceType, relation Relation) bool {
	switch resource {
	case ResourceWorkspace, ResourceProject:
		return relation == RelationView || relation == RelationEdit
	case ResourceJob:
		return relation == RelationView || relation == RelationCancel
	case ResourceAssignment:
		return relation == RelationView
	case ResourceSubmission:
		return relation == RelationView || relation == RelationEdit || relation == RelationGrade
	default:
		return false
	}
}

func validParent(resource, parent ResourceType) bool {
	return resource == ResourceJob && parent == ResourceProject || resource == ResourceSubmission && parent == ResourceAssignment
}

func object(resourceType, id string) string {
	return resourceType + ":" + id
}

func appendCourseTuples(tuples []TupleKey, principal Principal, user, workspace, assignment string) []TupleKey {
	course := object("course", principal.WorkspaceID)
	tuples = append(tuples,
		TupleKey{User: workspace, Relation: "workspace", Object: course},
		TupleKey{User: course, Relation: "course", Object: assignment},
	)
	switch principal.Role {
	case "admin", "teacher":
		tuples = append(tuples, TupleKey{User: user, Relation: "teacher", Object: course})
	case "student":
		tuples = append(tuples, TupleKey{User: user, Relation: "student", Object: course})
	}
	return tuples
}
