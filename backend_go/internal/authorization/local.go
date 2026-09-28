package authorization

import "context"

// LocalFallback exists only for explicitly enabled development environments.
type LocalFallback struct{}

func (LocalFallback) Check(_ context.Context, check Check) (bool, error) {
	if err := Validate(check); err != nil {
		return false, err
	}
	principal := check.Principal
	resource := check.Resource
	owner := resource.OwnerUserID == principal.UserID

	switch resource.Type {
	case ResourceWorkspace:
		if check.Relation == RelationView {
			return true, nil
		}
		return principal.Role == "admin" || principal.Role == "teacher" || principal.Role == "researcher", nil
	case ResourceProject:
		if check.Relation == RelationView {
			return principal.Role == "admin" || principal.Role == "teacher" || principal.Role == "researcher" || principal.Role == "reviewer" || owner, nil
		}
		return principal.Role == "admin" || principal.Role == "teacher" || principal.Role == "researcher" || owner, nil
	case ResourceJob:
		if check.Relation == RelationView {
			return principal.Role == "admin" || principal.Role == "teacher" || principal.Role == "researcher" || principal.Role == "reviewer" || owner, nil
		}
		return principal.Role == "admin" || owner, nil
	case ResourceAssignment:
		return check.Relation == RelationView && principal.Role == "student", nil
	case ResourceSubmission:
		switch check.Relation {
		case RelationView:
			return principal.Role == "admin" || principal.Role == "teacher" || owner, nil
		case RelationEdit:
			return owner && resource.DraftEditable, nil
		case RelationGrade:
			return principal.Role == "admin" || principal.Role == "teacher", nil
		}
	}
	return false, nil
}

func (LocalFallback) Ready(context.Context) error { return nil }

func (LocalFallback) Mode() string { return "local-development" }
