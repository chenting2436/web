package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"skyviewlab/backend_go/internal/authorization"
	"skyviewlab/backend_go/internal/store"
)

func (service *server) handleWorkbenchState(response http.ResponseWriter, request *http.Request) {
	slug := request.PathValue("slug")
	if _, ok := service.catalog.Get(slug); !ok {
		writeCodedError(response, request, http.StatusNotFound, "WORKBENCH_NOT_FOUND", "工作台不存在")
		return
	}
	identity := identityFrom(request)
	if !service.authorize(response, request, authorization.RelationView, workspaceAuthorizationResource(identity), "WORKBENCH_STATE_READ_DENIED", "无权读取此工作区的草稿") {
		return
	}
	record, found, err := service.projects.GetWorkbenchState(scopeFrom(request), slug)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "WORKBENCH_STATE_READ_FAILED", "无法读取工作台草稿")
		return
	}
	if !found {
		record = store.WorkbenchState{State: map[string]any{}, Revision: 0}
	}
	setWorkbenchStateResponseHeaders(response, record.Revision)
	writeData(response, request, http.StatusOK, record)
}

func (service *server) handleSaveWorkbenchState(response http.ResponseWriter, request *http.Request) {
	slug := request.PathValue("slug")
	if _, ok := service.catalog.Get(slug); !ok {
		writeCodedError(response, request, http.StatusNotFound, "WORKBENCH_NOT_FOUND", "工作台不存在")
		return
	}
	identity := identityFrom(request)
	if identity.Role == "viewer" || identity.Role == "reviewer" {
		writeCodedError(response, request, http.StatusForbidden, "WORKBENCH_STATE_WRITE_DENIED", "当前角色不能保存此工作区的草稿")
		return
	}
	if !service.authorize(response, request, authorization.RelationEdit, workspaceAuthorizationResource(identity), "WORKBENCH_STATE_WRITE_DENIED", "当前角色不能保存此工作区的草稿") {
		return
	}
	var payload struct {
		Revision *int64         `json:"revision"`
		State    map[string]any `json:"state"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKBENCH_STATE", err.Error())
		return
	}
	if payload.Revision == nil || *payload.Revision < 0 || payload.State == nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKBENCH_STATE", "revision 和 state 必须显式提供")
		return
	}
	saved, err := service.projects.PutWorkbenchStateWithAudit(request.Context(), scopeFrom(request), slug, *payload.Revision, payload.State,
		func(before, after store.WorkbenchState) store.AuditEvent {
			return service.auditEvent(request, "workbench.state.update", "workbench", slug, "success", hashValue(before.State), hashValue(after.State),
				map[string]any{"fromRevision": *payload.Revision, "toRevision": after.Revision})
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录工作台变更审计") {
		return
	}
	if errors.Is(err, store.ErrWorkbenchStateTooLarge) {
		writeCodedError(response, request, http.StatusRequestEntityTooLarge, "WORKBENCH_STATE_TOO_LARGE", "工作台草稿不能超过 1 MiB")
		return
	}
	if errors.Is(err, store.ErrWorkbenchStateConflict) {
		writeCodedError(response, request, http.StatusConflict, "WORKBENCH_STATE_REVISION_CONFLICT", "草稿已在其他位置更新，请刷新后重试")
		return
	}
	if errors.Is(err, store.ErrInvalidWorkbenchState) {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKBENCH_STATE", "工作台草稿格式无效")
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "WORKBENCH_STATE_SAVE_FAILED", "无法保存工作台草稿")
		return
	}
	setWorkbenchStateResponseHeaders(response, saved.Revision)
	writeData(response, request, http.StatusOK, saved)
}

func setWorkbenchStateResponseHeaders(response http.ResponseWriter, revision int64) {
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("ETag", `"workbench-state-`+strconv.FormatInt(revision, 10)+`"`)
}

func (service *server) handleProjects(response http.ResponseWriter, request *http.Request) {
	slug := request.PathValue("slug")
	if _, ok := service.catalog.Get(slug); !ok {
		writeCodedError(response, request, http.StatusNotFound, "WORKBENCH_NOT_FOUND", "工作台不存在")
		return
	}
	identity := identityFrom(request)
	if !service.authorize(response, request, authorization.RelationView, workspaceAuthorizationResource(identity), "PROJECT_LIST_DENIED", "无权读取此工作区的项目") {
		return
	}
	projects, err := service.projects.ListProjects(scopeFrom(request), slug)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "PROJECT_LIST_FAILED", "无法读取项目")
		return
	}
	for _, project := range projects {
		if !service.authorize(response, request, authorization.RelationView, projectAuthorizationResource(project), "PROJECT_LIST_DENIED", "无权读取此工作区的项目") {
			return
		}
	}
	writeData(response, request, http.StatusOK, projects)
}

func (service *server) handleCreateProject(response http.ResponseWriter, request *http.Request) {
	identity := identityFrom(request)
	if identity.Role == "viewer" || identity.Role == "reviewer" {
		writeCodedError(response, request, http.StatusForbidden, "PROJECT_CREATE_DENIED", "当前角色不能创建项目")
		return
	}
	slug := request.PathValue("slug")
	if _, ok := service.catalog.Get(slug); !ok {
		writeCodedError(response, request, http.StatusNotFound, "WORKBENCH_NOT_FOUND", "工作台不存在")
		return
	}
	if !service.authorize(response, request, authorization.RelationEdit, workspaceAuthorizationResource(identity), "PROJECT_CREATE_DENIED", "当前角色不能创建项目") {
		return
	}
	var payload struct {
		Title string              `json:"title"`
		State optionalObjectValue `json:"state"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_PROJECT", err.Error())
		return
	}
	payload.Title = strings.TrimSpace(payload.Title)
	if payload.Title == "" || len([]rune(payload.Title)) > 160 {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_PROJECT_TITLE", "项目名称不能为空且最多 160 个字符")
		return
	}
	state := map[string]any{}
	if payload.State.Present {
		state = payload.State.Value
	}
	project, err := service.projects.CreateProjectWithAudit(request.Context(), identity.Scope(), slug, payload.Title, state,
		func(project store.Project) store.AuditEvent {
			return service.auditEvent(request, "project.create", "project", project.ID, "success", "", hashValue(project), map[string]any{"slug": slug})
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录项目审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "PROJECT_CREATE_FAILED", "无法创建项目")
		return
	}
	writeData(response, request, http.StatusCreated, project)
}

func (service *server) handleProject(response http.ResponseWriter, request *http.Request) {
	project, ok := service.authorizedProject(response, request, false)
	if !ok {
		return
	}
	writeData(response, request, http.StatusOK, project)
}

func (service *server) handleUpdateProject(response http.ResponseWriter, request *http.Request) {
	existing, ok := service.authorizedProject(response, request, true)
	if !ok {
		return
	}
	var payload struct {
		Title string         `json:"title"`
		State map[string]any `json:"state"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_PROJECT", err.Error())
		return
	}
	payload.Title = strings.TrimSpace(payload.Title)
	if payload.Title == "" || len([]rune(payload.Title)) > 160 || payload.State == nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_PROJECT", "项目名称或状态无效")
		return
	}
	project, found, err := service.projects.UpdateProjectWithAudit(request.Context(), scopeFrom(request), existing.ID, payload.Title, payload.State,
		func(before, after store.Project) store.AuditEvent {
			return service.auditEvent(request, "project.update", "project", after.ID, "success", hashValue(before), hashValue(after), nil)
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录项目审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "PROJECT_UPDATE_FAILED", "无法保存项目")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "PROJECT_NOT_FOUND", "项目不存在")
		return
	}
	writeData(response, request, http.StatusOK, project)
}

func (service *server) handleDeleteProject(response http.ResponseWriter, request *http.Request) {
	existing, ok := service.authorizedProject(response, request, true)
	if !ok {
		return
	}
	deleted, err := service.projects.DeleteProjectWithAudit(request.Context(), scopeFrom(request), existing.ID,
		func(before store.Project) store.AuditEvent {
			return service.auditEvent(request, "project.delete", "project", before.ID, "success", hashValue(before), "", nil)
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录项目审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "PROJECT_DELETE_FAILED", "无法删除项目")
		return
	}
	if !deleted {
		writeCodedError(response, request, http.StatusNotFound, "PROJECT_NOT_FOUND", "项目不存在")
		return
	}
	writeData(response, request, http.StatusOK, map[string]bool{"deleted": true})
}

func (service *server) handleVersions(response http.ResponseWriter, request *http.Request) {
	project, ok := service.authorizedProject(response, request, false)
	if !ok {
		return
	}
	versions, err := service.projects.ListVersions(scopeFrom(request), project.ID)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "VERSION_LIST_FAILED", "无法读取版本")
		return
	}
	writeData(response, request, http.StatusOK, versions)
}

func (service *server) handleCreateVersion(response http.ResponseWriter, request *http.Request) {
	project, ok := service.authorizedProject(response, request, true)
	if !ok {
		return
	}
	var payload struct {
		Label string         `json:"label"`
		State map[string]any `json:"state"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_VERSION", err.Error())
		return
	}
	payload.Label = strings.TrimSpace(payload.Label)
	if payload.Label == "" || len([]rune(payload.Label)) > 160 || payload.State == nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_VERSION", "版本名称或状态无效")
		return
	}
	version, found, err := service.projects.CreateVersionWithAudit(request.Context(), scopeFrom(request), project.ID, payload.Label, payload.State,
		func(version store.Version) store.AuditEvent {
			return service.auditEvent(request, "project.version.create", "project_version", version.ID, "success", "", hashValue(version), map[string]any{"projectId": project.ID})
		})
	if writeAtomicAuditFailure(response, request, err, "无法记录版本审计") {
		return
	}
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "VERSION_CREATE_FAILED", "无法创建版本")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "PROJECT_NOT_FOUND", "项目不存在")
		return
	}
	writeData(response, request, http.StatusCreated, version)
}

func (service *server) handleRuns(response http.ResponseWriter, request *http.Request) {
	project, ok := service.authorizedProject(response, request, false)
	if !ok {
		return
	}
	runs, err := service.projects.ListRuns(scopeFrom(request), project.ID)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "RUN_LIST_FAILED", "无法读取运行记录")
		return
	}
	writeData(response, request, http.StatusOK, publicRuns(runs))
}

func (service *server) handleRejectClientRun(response http.ResponseWriter, request *http.Request) {
	_ = service.audit(request, "run.finalize", "project", request.PathValue("id"), "denied", "", "", map[string]any{"reason": "server_owned_run"})
	writeCodedError(response, request, http.StatusForbidden, "RUN_FINALIZATION_FORBIDDEN", "运行记录只能由服务端作业和受信 Worker 写入")
}

func (service *server) authorizedProject(response http.ResponseWriter, request *http.Request, write bool) (store.Project, bool) {
	identity := identityFrom(request)
	project, found, err := service.projects.GetProject(identity.Scope(), request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "PROJECT_READ_FAILED", "无法读取项目")
		return store.Project{}, false
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "PROJECT_NOT_FOUND", "项目不存在")
		return store.Project{}, false
	}
	relation := authorization.RelationView
	if write {
		relation = authorization.RelationEdit
	}
	if !service.authorize(response, request, relation, projectAuthorizationResource(project), "PROJECT_ACCESS_DENIED", "无权访问此项目") {
		return store.Project{}, false
	}
	return project, true
}
