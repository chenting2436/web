package api

import (
	"errors"
	"net/http"

	"skyviewlab/backend_go/internal/store"
)

func writeAtomicAuditFailure(response http.ResponseWriter, request *http.Request, err error, message string) bool {
	if !errors.Is(err, store.ErrAtomicAuditWrite) {
		return false
	}
	writeCodedError(response, request, http.StatusInternalServerError, "AUDIT_WRITE_FAILED", message)
	return true
}

// auditEvent builds the immutable request evidence used by both standalone
// denied/error audits and transactionally committed successful mutations.
// It deliberately derives scope and actor only from the authenticated request.
func (service *server) auditEvent(request *http.Request, action, resourceType, resourceID, outcome, beforeHash, afterHash string, metadata map[string]any) store.AuditEvent {
	identity := identityFrom(request)
	if identity.TenantID == "" {
		identity.TenantID = service.config.DevTenantID
		identity.WorkspaceID = service.config.DevWorkspaceID
	}
	return store.AuditEvent{
		TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID, ActorUserID: identity.UserID,
		Action: action, ResourceType: resourceType, ResourceID: truncateText(resourceID, 256), Outcome: outcome,
		RequestID: requestID(request), SourceIP: truncateText(sourceIP(request), 128), UserAgent: truncateText(request.UserAgent(), 512),
		BeforeHash: beforeHash, AfterHash: afterHash, Metadata: metadata,
	}
}
