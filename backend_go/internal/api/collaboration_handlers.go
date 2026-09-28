package api

import (
	"net/http"
	"strings"
	"time"

	"skyviewlab/backend_go/internal/authorization"
	"skyviewlab/backend_go/internal/store"
)

var sharedKinds = map[string]struct{}{"discussions": {}, "assignments": {}, "submissions": {}}

var submissionServerFields = map[string]struct{}{
	"authorId": {}, "authorName": {}, "authorRole": {}, "studentId": {}, "studentName": {},
	"score": {}, "feedback": {}, "gradedBy": {}, "gradedByName": {}, "gradedAt": {},
	"rubric": {}, "rubricScores": {}, "status": {}, "submittedAt": {}, "updatedAt": {},
}

func (service *server) sharedRequest(response http.ResponseWriter, request *http.Request) (string, store.Identity, bool) {
	kind := request.PathValue("kind")
	if _, ok := sharedKinds[kind]; !ok {
		writeCodedError(response, request, http.StatusNotFound, "COLLABORATION_KIND_NOT_FOUND", "协作资源不存在")
		return "", store.Identity{}, false
	}
	return kind, identityFrom(request), true
}

func (service *server) handleSharedRecords(response http.ResponseWriter, request *http.Request) {
	kind, identity, ok := service.sharedRequest(response, request)
	if !ok {
		return
	}
	records, err := service.projects.ListShared(identity.Scope(), kind)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "COLLABORATION_LIST_FAILED", "无法读取协作数据")
		return
	}
	if kind == "submissions" {
		for _, record := range records {
			if !service.authorize(response, request, authorization.RelationView, submissionAuthorizationResource(record), "SUBMISSION_LIST_DENIED", "无权读取此工作区的提交记录") {
				return
			}
		}
	}
	writeData(response, request, http.StatusOK, records)
}

func (service *server) handleCreateSharedRecord(response http.ResponseWriter, request *http.Request) {
	kind, identity, ok := service.sharedRequest(response, request)
	if !ok {
		return
	}
	if kind == "assignments" && identity.Role != "admin" && identity.Role != "teacher" {
		writeCodedError(response, request, http.StatusForbidden, "ASSIGNMENT_CREATE_DENIED", "只有教师或管理员可以发布作业")
		return
	}
	if kind == "submissions" && identity.Role != "student" {
		writeCodedError(response, request, http.StatusForbidden, "SUBMISSION_CREATE_DENIED", "只有学生可以创建作业提交")
		return
	}
	var payload struct {
		Data map[string]any `json:"data"`
	}
	if err := decodeJSON(response, request, &payload); err != nil || payload.Data == nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_COLLABORATION_DATA", "协作数据无效")
		return
	}
	data := cloneMap(payload.Data)
	if code, message := validateSharedCreate(service, identity, kind, data); code != "" {
		status := http.StatusBadRequest
		if code == "SUBMISSION_SERVER_FIELD_FORBIDDEN" {
			status = http.StatusForbidden
		}
		writeCodedError(response, request, status, code, message)
		return
	}
	if kind == "submissions" {
		assignmentID, _ := data["assignmentId"].(string)
		assignment, found, err := service.projects.GetShared(identity.Scope(), "assignments", strings.TrimSpace(assignmentID))
		if err != nil {
			writeCodedError(response, request, http.StatusInternalServerError, "ASSIGNMENT_READ_FAILED", "无法读取作业")
			return
		}
		if !found {
			writeCodedError(response, request, http.StatusNotFound, "ASSIGNMENT_NOT_FOUND", "作业不存在")
			return
		}
		if !service.authorize(response, request, authorization.RelationView, assignmentAuthorizationResource(assignment), "SUBMISSION_CREATE_DENIED", "无权向此作业提交内容") {
			return
		}
	}
	data["authorId"] = identity.UserID
	data["authorName"] = identity.DisplayName
	data["authorRole"] = identity.Role
	if kind == "discussions" {
		data["status"] = "open"
		data["replies"] = []any{}
	}
	if kind == "submissions" {
		data["studentId"] = identity.UserID
		data["studentName"] = identity.DisplayName
		data["status"] = "submitted"
		data["submittedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	record, err := service.projects.CreateSharedWithAudit(request.Context(), identity.Scope(), kind, data,
		func(record store.SharedRecord) store.AuditEvent {
			return service.auditEvent(request, "collaboration."+kind+".create", kind, record.ID, "success", "", hashValue(record), nil)
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录协作审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "COLLABORATION_CREATE_FAILED", "无法保存协作数据")
		return
	}
	writeData(response, request, http.StatusCreated, record)
}

func validateSharedCreate(service *server, identity store.Identity, kind string, data map[string]any) (string, string) {
	title, _ := data["title"].(string)
	body, _ := data["body"].(string)
	if kind == "discussions" && (len([]rune(strings.TrimSpace(title))) < 4 || len([]rune(strings.TrimSpace(body))) < 10) {
		return "INVALID_DISCUSSION", "讨论标题或正文过短"
	}
	if kind == "assignments" {
		description, _ := data["description"].(string)
		if len([]rune(strings.TrimSpace(title))) < 4 || len([]rune(strings.TrimSpace(description))) < 4 || len([]rune(description)) > 8_000 {
			return "INVALID_ASSIGNMENT", "作业标题或说明无效"
		}
	}
	if kind == "submissions" {
		for field := range submissionServerFields {
			if _, supplied := data[field]; supplied {
				return "SUBMISSION_SERVER_FIELD_FORBIDDEN", "提交不得写入评分、状态或身份等服务端字段"
			}
		}
		assignmentID, _ := data["assignmentId"].(string)
		content, _ := data["content"].(string)
		if strings.TrimSpace(assignmentID) == "" || len([]rune(content)) > 20_000 {
			return "INVALID_SUBMISSION", "提交内容无效"
		}
		if _, found, err := service.projects.GetShared(identity.Scope(), "assignments", assignmentID); err != nil || !found {
			return "ASSIGNMENT_NOT_FOUND", "作业不存在"
		}
	}
	return "", ""
}

func (service *server) handleSharedRecord(response http.ResponseWriter, request *http.Request) {
	kind, identity, ok := service.sharedRequest(response, request)
	if !ok {
		return
	}
	record, found, err := service.projects.GetShared(identity.Scope(), kind, request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "COLLABORATION_READ_FAILED", "无法读取协作数据")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "COLLABORATION_RECORD_NOT_FOUND", "记录不存在")
		return
	}
	if kind == "submissions" && !service.authorize(response, request, authorization.RelationView, submissionAuthorizationResource(record), "SUBMISSION_ACCESS_DENIED", "无权访问此提交记录") {
		return
	}
	writeData(response, request, http.StatusOK, record)
}

func (service *server) handleUpdateSharedRecord(response http.ResponseWriter, request *http.Request) {
	kind, identity, ok := service.sharedRequest(response, request)
	if !ok {
		return
	}
	existing, found, err := service.projects.GetShared(identity.Scope(), kind, request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "COLLABORATION_READ_FAILED", "无法读取协作数据")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "COLLABORATION_RECORD_NOT_FOUND", "记录不存在")
		return
	}
	owner, _ := existing.Data["authorId"].(string)
	student, _ := existing.Data["studentId"].(string)
	isTeacher := identity.Role == "admin" || identity.Role == "teacher"
	if kind == "assignments" && !isTeacher || kind == "submissions" && !isTeacher && student != identity.UserID || kind == "discussions" && identity.Role != "admin" && owner != identity.UserID {
		writeCodedError(response, request, http.StatusForbidden, "COLLABORATION_UPDATE_DENIED", "无权修改此记录")
		return
	}
	var payload struct {
		Revision int            `json:"revision"`
		Data     map[string]any `json:"data"`
	}
	if err := decodeJSON(response, request, &payload); err != nil || payload.Revision < 1 || payload.Data == nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_COLLABORATION_DATA", "协作数据无效")
		return
	}
	data := cloneMap(payload.Data)
	if kind == "submissions" && !isTeacher {
		status, _ := existing.Data["status"].(string)
		if status != "submitted" {
			writeCodedError(response, request, http.StatusConflict, "SUBMISSION_LOCKED", "已评分或已锁定的提交不能再修改")
			return
		}
		for field := range data {
			if field != "content" && field != "attachments" {
				_ = service.audit(request, "collaboration.submissions.update", "submissions", existing.ID, "denied", hashValue(existing), "", map[string]any{"reason": "student_server_field", "field": field})
				writeCodedError(response, request, http.StatusForbidden, "SUBMISSION_SERVER_FIELD_FORBIDDEN", "学生只能修改提交正文和附件")
				return
			}
		}
		if !service.authorize(response, request, authorization.RelationEdit, submissionAuthorizationResource(existing), "SUBMISSION_UPDATE_DENIED", "正式提交不可覆盖；请通过版本化重交流程提交新版本") {
			return
		}
		merged := cloneMap(existing.Data)
		for field, value := range data {
			merged[field] = value
		}
		merged["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
		data = merged
	} else {
		if kind == "discussions" {
			data["status"] = existing.Data["status"]
			data["replies"] = existing.Data["replies"]
		}
		if kind == "submissions" {
			if !service.authorize(response, request, authorization.RelationGrade, submissionAuthorizationResource(existing), "SUBMISSION_UPDATE_DENIED", "无权修改此提交记录") {
				return
			}
			for field := range data {
				if field != "score" && field != "feedback" && field != "rubricScores" {
					writeCodedError(response, request, http.StatusForbidden, "SUBMISSION_FIELD_FORBIDDEN", "教师只能写入评分与反馈字段")
					return
				}
			}
			merged := cloneMap(existing.Data)
			for field, value := range data {
				merged[field] = value
			}
			data = merged
		}
		data["authorId"] = existing.Data["authorId"]
		data["authorName"] = existing.Data["authorName"]
		data["authorRole"] = existing.Data["authorRole"]
		if kind == "submissions" {
			data["studentId"] = existing.Data["studentId"]
			data["studentName"] = existing.Data["studentName"]
			if rawScore, supplied := data["score"]; supplied && !validScore(rawScore) {
				writeCodedError(response, request, http.StatusUnprocessableEntity, "INVALID_SCORE", "评分必须在 0 至 100 之间")
				return
			}
			data["gradedBy"] = identity.UserID
			data["gradedByName"] = identity.DisplayName
			data["gradedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
			data["status"] = "graded"
		}
	}
	updated, _, conflict, err := service.projects.UpdateSharedWithAudit(request.Context(), identity.Scope(), kind, existing.ID, payload.Revision, data,
		func(before, after store.SharedRecord) store.AuditEvent {
			return service.auditEvent(request, "collaboration."+kind+".update", kind, after.ID, "success", hashValue(before), hashValue(after), nil)
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录协作审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "COLLABORATION_UPDATE_FAILED", "无法更新协作数据")
		return
	}
	if conflict {
		writeCodedError(response, request, http.StatusConflict, "REVISION_CONFLICT", "记录已被其他用户更新，请刷新后重试")
		return
	}
	writeData(response, request, http.StatusOK, updated)
}

func validScore(value any) bool {
	score, ok := value.(float64)
	return ok && score >= 0 && score <= 100
}

func (service *server) handleDeleteSharedRecord(response http.ResponseWriter, request *http.Request) {
	kind, identity, ok := service.sharedRequest(response, request)
	if !ok {
		return
	}
	if kind == "submissions" {
		_ = service.audit(request, "collaboration.submissions.delete", "submissions", request.PathValue("id"), "denied", "", "", map[string]any{"reason": "retention_workflow_required"})
		writeCodedError(response, request, http.StatusConflict, "SUBMISSION_DELETE_REQUIRES_RETENTION_WORKFLOW", "正式提交不能硬删除，需使用后续保留策略工作流")
		return
	}
	record, found, err := service.projects.GetShared(identity.Scope(), kind, request.PathValue("id"))
	if err != nil || !found {
		writeCodedError(response, request, http.StatusNotFound, "COLLABORATION_RECORD_NOT_FOUND", "记录不存在")
		return
	}
	owner, _ := record.Data["authorId"].(string)
	isTeacher := identity.Role == "admin" || identity.Role == "teacher"
	if kind == "assignments" && !isTeacher || kind == "submissions" && !isTeacher || kind == "discussions" && identity.Role != "admin" && owner != identity.UserID {
		writeCodedError(response, request, http.StatusForbidden, "COLLABORATION_DELETE_DENIED", "无权删除此记录")
		return
	}
	deleted, err := service.projects.DeleteSharedWithAudit(request.Context(), identity.Scope(), kind, record.ID,
		func(before store.SharedRecord) store.AuditEvent {
			return service.auditEvent(request, "collaboration."+kind+".delete", kind, before.ID, "success", hashValue(before), "", nil)
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录协作审计") {
		return
	}
	if err != nil || !deleted {
		writeCodedError(response, request, http.StatusInternalServerError, "COLLABORATION_DELETE_FAILED", "无法删除记录")
		return
	}
	writeData(response, request, http.StatusOK, map[string]bool{"deleted": true})
}

func (service *server) handleCreateDiscussionReply(response http.ResponseWriter, request *http.Request) {
	identity := identityFrom(request)
	record, found, err := service.projects.GetShared(identity.Scope(), "discussions", request.PathValue("id"))
	if err != nil || !found {
		writeCodedError(response, request, http.StatusNotFound, "DISCUSSION_NOT_FOUND", "讨论不存在")
		return
	}
	var payload struct {
		Body string `json:"body"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_REPLY", err.Error())
		return
	}
	payload.Body = strings.TrimSpace(payload.Body)
	if len([]rune(payload.Body)) < 2 || len([]rune(payload.Body)) > 8_000 {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_REPLY", "回复需为 2 至 8000 个字符")
		return
	}
	replies, _ := record.Data["replies"].([]any)
	replies = append(replies, map[string]any{
		"id": uuidString(), "authorId": identity.UserID, "authorName": identity.DisplayName,
		"authorRole": identity.Role, "body": payload.Body, "createdAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	data := cloneMap(record.Data)
	data["replies"] = replies
	if identity.Role == "admin" || identity.Role == "teacher" {
		data["status"] = "answered"
	}
	updated, _, conflict, err := service.projects.UpdateSharedWithAudit(request.Context(), identity.Scope(), "discussions", record.ID, record.Revision, data,
		func(before, after store.SharedRecord) store.AuditEvent {
			return service.auditEvent(request, "collaboration.discussion.reply", "discussion", after.ID, "success", hashValue(before), hashValue(after), nil)
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录回复审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "REPLY_CREATE_FAILED", "无法保存回复")
		return
	}
	if conflict {
		writeCodedError(response, request, http.StatusConflict, "REVISION_CONFLICT", "讨论已更新，请刷新后重试")
		return
	}
	writeData(response, request, http.StatusCreated, updated)
}

func uuidString() string {
	token, err := randomToken()
	if err != nil {
		return ""
	}
	return token[:24]
}
