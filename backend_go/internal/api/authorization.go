package api

import (
	"net/http"
	"strings"

	"skyviewlab/backend_go/internal/authorization"
	"skyviewlab/backend_go/internal/store"
)

func principalFrom(identity store.Identity) authorization.Principal {
	return authorization.Principal{
		UserID: identity.UserID, TenantID: identity.TenantID,
		WorkspaceID: identity.WorkspaceID, Role: identity.Role,
	}
}

func workspaceAuthorizationResource(identity store.Identity) authorization.Resource {
	return authorization.Resource{
		Type: authorization.ResourceWorkspace, ID: identity.WorkspaceID,
		TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
	}
}

func projectAuthorizationResource(project store.Project) authorization.Resource {
	return authorization.Resource{
		Type: authorization.ResourceProject, ID: project.ID,
		TenantID: project.TenantID, WorkspaceID: project.WorkspaceID, OwnerUserID: project.OwnerUserID,
	}
}

func jobAuthorizationResource(job store.Job) authorization.Resource {
	return authorization.Resource{
		Type: authorization.ResourceJob, ID: job.ID,
		TenantID: job.TenantID, WorkspaceID: job.WorkspaceID, OwnerUserID: job.CreatedByUserID,
		ParentType: authorization.ResourceProject, ParentID: job.ProjectID,
	}
}

func assignmentAuthorizationResource(record store.SharedRecord) authorization.Resource {
	return authorization.Resource{
		Type: authorization.ResourceAssignment, ID: record.ID,
		TenantID: record.TenantID, WorkspaceID: record.WorkspaceID,
	}
}

func submissionAuthorizationResource(record store.SharedRecord) authorization.Resource {
	owner, _ := record.Data["studentId"].(string)
	if strings.TrimSpace(owner) == "" {
		owner, _ = record.Data["authorId"].(string)
	}
	assignmentID, _ := record.Data["assignmentId"].(string)
	status, _ := record.Data["status"].(string)
	resource := authorization.Resource{
		Type: authorization.ResourceSubmission, ID: record.ID,
		TenantID: record.TenantID, WorkspaceID: record.WorkspaceID, OwnerUserID: strings.TrimSpace(owner),
		DraftEditable: strings.TrimSpace(status) == "draft",
	}
	if strings.TrimSpace(assignmentID) != "" {
		resource.ParentType = authorization.ResourceAssignment
		resource.ParentID = strings.TrimSpace(assignmentID)
	}
	return resource
}

func (service *server) authorize(
	response http.ResponseWriter,
	request *http.Request,
	relation authorization.Relation,
	resource authorization.Resource,
	deniedCode string,
	deniedMessage string,
) bool {
	identity := identityFrom(request)
	if service.authorizer == nil {
		writeCodedError(response, request, http.StatusServiceUnavailable, "AUTHORIZATION_UNAVAILABLE", "授权服务未配置")
		return false
	}
	check := authorization.Check{
		Principal: principalFrom(identity), Relation: relation, Resource: resource, RequestID: requestID(request),
	}
	allowed, err := service.authorizer.Check(request.Context(), check)
	metadata := map[string]any{"relation": relation, "mode": service.authorizer.Mode()}
	if err != nil {
		metadata["reason"] = "authorization_check_failed"
		_ = service.audit(request, "authorization.check", string(resource.Type), resource.ID, "error", "", "", metadata)
		writeCodedError(response, request, http.StatusServiceUnavailable, "AUTHORIZATION_UNAVAILABLE", "授权服务暂不可用")
		return false
	}
	if !allowed {
		metadata["reason"] = "policy_denied"
		_ = service.audit(request, "authorization.check", string(resource.Type), resource.ID, "denied", "", "", metadata)
		writeCodedError(response, request, http.StatusForbidden, deniedCode, deniedMessage)
		return false
	}
	return true
}
