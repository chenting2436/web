package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/authorization"
	"skyviewlab/backend_go/internal/store"
)

const (
	jobClaimHeader             = "X-Skyview-Job-Claim"
	jobClaimTokenEncodedLength = 43
)

func (service *server) handleCreateJob(response http.ResponseWriter, request *http.Request) {
	project, ok := service.authorizedProject(response, request, true)
	if !ok {
		return
	}
	var payload struct {
		Slug           string              `json:"slug"`
		Action         string              `json:"action"`
		Input          optionalObjectValue `json:"input"`
		IdempotencyKey optionalStringValue `json:"idempotencyKey"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_JOB", err.Error())
		return
	}
	payload.Slug = strings.TrimSpace(payload.Slug)
	payload.Action = strings.TrimSpace(payload.Action)
	workbench, exists := service.catalog.Get(payload.Slug)
	if !exists || payload.Slug != project.Slug || payload.Action == "" || len([]rune(payload.Action)) > 80 {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_JOB", "作业的工作台或动作无效")
		return
	}
	if !workbench.ExecutionAllowed {
		writeCodedError(response, request, http.StatusConflict, "CAPABILITY_EXECUTION_BLOCKED", "该工作台尚未通过运行时安全门禁")
		return
	}
	headerKey, headerPresent, validHeader := optionalIdempotencyHeader(request)
	if !validHeader {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_IDEMPOTENCY_KEY", "幂等键必须是 1 至 128 个安全 ASCII 字符，且请求头只能出现一次")
		return
	}
	bodyKey := ""
	bodyPresent := payload.IdempotencyKey.Present
	if bodyPresent {
		bodyKey = payload.IdempotencyKey.Value
		if !validIdempotencyKey(bodyKey) {
			writeCodedError(response, request, http.StatusBadRequest, "INVALID_IDEMPOTENCY_KEY", "幂等键必须是 1 至 128 个安全 ASCII 字符")
			return
		}
	}
	if headerPresent && bodyPresent && headerKey != bodyKey {
		writeCodedError(response, request, http.StatusBadRequest, "IDEMPOTENCY_KEY_MISMATCH", "请求头和请求体中的幂等键不一致")
		return
	}
	key := bodyKey
	if headerPresent {
		key = headerKey
	}
	input := map[string]any{}
	if payload.Input.Present {
		input = payload.Input.Value
	}
	encodedInput, err := json.Marshal(input)
	if err != nil || len(encodedInput) > 1<<20 {
		writeCodedError(response, request, http.StatusRequestEntityTooLarge, "JOB_INPUT_TOO_LARGE", "作业输入最多为 1 MiB")
		return
	}
	jobRun, created, err := service.projects.CreateJobWithAuditContext(request.Context(), scopeFrom(request), project.ID, payload.Slug, payload.Action, input, key,
		func(jobRun store.JobRun) store.AuditEvent {
			return service.auditEvent(request, "job.create", "job", jobRun.Job.ID, "created", "", hashValue(jobRun.Job), map[string]any{"idempotentReplay": false})
		})
	if err != nil {
		if err == store.ErrIdempotencyConflict {
			writeCodedError(response, request, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同的作业请求")
			return
		}
		if writeAtomicAuditFailure(response, request, err, "无法记录作业审计") {
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_CREATE_FAILED", "无法创建计算作业")
		return
	}
	if jobRun.Job.ID == "" {
		writeCodedError(response, request, http.StatusNotFound, "PROJECT_NOT_FOUND", "项目不存在")
		return
	}
	status := http.StatusCreated
	if !created {
		status = http.StatusOK
	}
	writeData(response, request, status, publicJobRun(jobRun))
}

func (service *server) handleJobs(response http.ResponseWriter, request *http.Request) {
	project, ok := service.authorizedProject(response, request, false)
	if !ok {
		return
	}
	jobs, err := service.projects.ListJobs(scopeFrom(request), project.ID)
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_LIST_FAILED", "无法读取计算作业")
		return
	}
	writeData(response, request, http.StatusOK, publicJobs(jobs))
}

func (service *server) handleJob(response http.ResponseWriter, request *http.Request) {
	identity := identityFrom(request)
	job, found, err := service.projects.GetJob(identity.Scope(), request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_READ_FAILED", "无法读取计算作业")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	if !service.authorize(response, request, authorization.RelationView, jobAuthorizationResource(job), "JOB_ACCESS_DENIED", "无权访问此计算作业") {
		return
	}
	writeData(response, request, http.StatusOK, publicJob(job))
}

func (service *server) handleCancelJob(response http.ResponseWriter, request *http.Request) {
	identity := identityFrom(request)
	existing, found, err := service.projects.GetJob(identity.Scope(), request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_READ_FAILED", "无法读取计算作业")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	if !service.authorize(response, request, authorization.RelationCancel, jobAuthorizationResource(existing), "JOB_CANCEL_DENIED", "无权取消此计算作业") {
		return
	}
	job, found, denied, err := service.projects.CancelJobWithAuditContext(request.Context(), scopeFrom(request), request.PathValue("id"),
		func(before, after store.Job) store.AuditEvent {
			return service.auditEvent(request, "job.cancel", "job", after.ID, "success", hashValue(before), hashValue(after), nil)
		})
	if err != nil {
		if err == store.ErrInvalidJobTransition {
			writeCodedError(response, request, http.StatusConflict, "JOB_INVALID_TRANSITION", "当前作业状态不能取消")
			return
		}
		if writeAtomicAuditFailure(response, request, err, "无法记录作业审计") {
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_CANCEL_FAILED", "无法取消计算作业")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	if denied {
		writeCodedError(response, request, http.StatusForbidden, "JOB_CANCEL_DENIED", "无权取消此计算作业")
		return
	}
	writeData(response, request, http.StatusOK, publicJob(job))
}

func (service *server) handleClaimJob(response http.ResponseWriter, request *http.Request) {
	authenticatedWorker, authenticated := service.requireWorker(response, request)
	if !authenticated {
		return
	}
	workerID := authenticatedWorker.WorkerID
	var payload struct {
		WorkerID optionalStringValue `json:"workerId"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKER_REQUEST", err.Error())
		return
	}
	if !workerRequestMatchesIdentity(response, request, payload.WorkerID, workerID) {
		return
	}
	claim, found, err := service.projects.ClaimNextJobWithLeaseAndAuditContext(request.Context(), workerJobClaimAccess(authenticatedWorker), store.DefaultJobLease,
		func(claim store.JobClaim) store.AuditEvent {
			auditRequest := request.WithContext(withIdentity(request, workerIdentity(claim.Job, workerID)))
			return service.auditEvent(auditRequest, "job.claim", "job", claim.Job.ID, "success", "", hashValue(claim.Job),
				map[string]any{"workerId": workerID, "claimEpoch": claim.ClaimEpoch, "leaseExpiresAt": claim.LeaseExpiresAt})
		},
		func(failed store.Job) store.AuditEvent {
			auditRequest := request.WithContext(withIdentity(request, workerIdentity(failed, workerID)))
			action := "job.attempts_exhausted"
			if failed.Error == store.JobExecutionLeaseLostError {
				action = "job.execution_lease_lost"
			}
			return service.auditEvent(auditRequest, action, "job", failed.ID, "failed", "", hashValue(failed),
				map[string]any{"workerId": workerID, "attempt": failed.Attempt, "error": failed.Error})
		})
	if err != nil {
		if writeAtomicAuditFailure(response, request, err, "无法记录作业审计") {
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_CLAIM_FAILED", "无法领取计算作业")
		return
	}
	if !found {
		response.Header().Set("Cache-Control", "no-store")
		response.WriteHeader(http.StatusNoContent)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeData(response, request, http.StatusOK, workerJobClaim(claim))
}

func (service *server) handleExecuteJob(response http.ResponseWriter, request *http.Request) {
	authenticatedWorker, authenticated := service.requireWorker(response, request)
	if !authenticated {
		return
	}
	workerID := authenticatedWorker.WorkerID
	workerAccess := workerJobClaimAccess(authenticatedWorker)
	var payload struct {
		WorkerID optionalStringValue `json:"workerId"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKER_REQUEST", err.Error())
		return
	}
	if !workerRequestMatchesIdentity(response, request, payload.WorkerID, workerID) {
		return
	}
	claimToken, ok := requireJobClaimToken(response, request)
	if !ok {
		return
	}
	job, found, err := service.projects.GetJobInternalForWorkerContext(request.Context(), workerAccess, request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_READ_FAILED", "无法读取计算作业")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	if !secureEqual(workerID, job.WorkerID) {
		writeCodedError(response, request, http.StatusForbidden, "WORKER_JOB_ACCESS_DENIED", "该 Worker 无权执行此作业")
		return
	}
	if job.Status != "running" {
		writeCodedError(response, request, http.StatusConflict, "JOB_CLAIM_LOST", "作业租约已失效或已被重新领取")
		return
	}
	job, found, err = service.projects.BeginJobExecutionForWorkerWithAuditContext(request.Context(), workerAccess, job.ID, claimToken,
		func(before, after store.Job) store.AuditEvent {
			auditRequest := request.WithContext(withIdentity(request, workerIdentity(after, workerID)))
			return service.auditEvent(auditRequest, "job.execution.started", "job", after.ID, "success", hashValue(before), hashValue(after),
				map[string]any{"workerId": workerID, "attempt": after.Attempt})
		})
	if err != nil {
		if err == store.ErrJobClaimLost {
			writeCodedError(response, request, http.StatusConflict, "JOB_CLAIM_LOST", "作业租约已失效或已被重新领取")
			return
		}
		if err == store.ErrJobExecutionStarted {
			writeCodedError(response, request, http.StatusConflict, "JOB_EXECUTION_ALREADY_STARTED", "当前作业尝试已经开始执行")
			return
		}
		if writeAtomicAuditFailure(response, request, err, "无法记录作业执行审计") {
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_READ_FAILED", "无法验证作业租约")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	// The execution-fence transaction can wait behind the scoped audit-head
	// lock. Renew once after that commit, using database wall-clock time, so no
	// compute process starts from a lease that expired while its start evidence
	// was being serialized.
	if _, heartbeatFound, heartbeatErr := service.projects.HeartbeatJobClaimForWorkerContext(request.Context(), workerAccess, job.ID, claimToken, store.DefaultJobLease); heartbeatErr != nil || !heartbeatFound {
		if heartbeatErr == store.ErrJobClaimLost || !heartbeatFound {
			writeCodedError(response, request, http.StatusConflict, "JOB_CLAIM_LOST", "作业在开始执行前租约已失效")
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_HEARTBEAT_FAILED", "无法在执行前续租计算作业")
		return
	}
	pythonPayload, err := json.Marshal(map[string]any{"action": job.Action, "payload": job.Input})
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_PAYLOAD_ENCODE_FAILED", "无法编码计算请求")
		return
	}
	started := time.Now()
	executionContext, cancelExecution := context.WithCancel(request.Context())
	heartbeatStopped := make(chan struct{})
	heartbeatDone := make(chan jobHeartbeatMonitorResult, 1)
	go service.keepJobClaimAlive(executionContext, cancelExecution, heartbeatStopped, heartbeatDone, workerAccess, job.ID, claimToken)
	body, upstreamStatus, _, upstreamErr := service.pythonRequest(request.WithContext(executionContext), http.MethodPost, "/tools/"+job.Slug+"/run", pythonPayload, job.CreatedByUserID, job.TenantID, job.ID)
	close(heartbeatStopped)
	cancelExecution()
	heartbeatResult := <-heartbeatDone
	durationMS := float64(time.Since(started).Microseconds()) / 1000
	finalStatus := "succeeded"
	result := map[string]any{}
	errorText := ""
	if upstreamErr != nil {
		finalStatus = "failed"
		switch {
		case request.Context().Err() != nil || errors.Is(upstreamErr, context.Canceled):
			errorText = "compute execution outcome indeterminate after request cancellation; automatic replay is forbidden"
		case errors.Is(upstreamErr, context.DeadlineExceeded):
			errorText = "compute execution outcome indeterminate after timeout; automatic replay is forbidden"
		default:
			errorText = "compute service unavailable"
		}
	} else {
		var envelope struct {
			Data  map[string]any `json:"data"`
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			finalStatus = "failed"
			errorText = "compute service returned invalid JSON"
		} else if upstreamStatus < 200 || upstreamStatus >= 300 {
			finalStatus = "failed"
			errorText = strings.TrimSpace(envelope.Error.Code + ": " + envelope.Error.Message)
			if errorText == ":" || errorText == "" {
				errorText = "compute service rejected the job"
			}
		} else if envelope.Data == nil {
			finalStatus = "failed"
			errorText = "compute service response is missing data"
		} else {
			result = envelope.Data
		}
	}
	if heartbeatResult.err != nil {
		finalStatus = "failed"
		result = map[string]any{}
		if heartbeatResult.claimLost {
			errorText = "compute execution outcome indeterminate after job lease loss; automatic replay is forbidden"
		} else {
			errorText = "compute execution outcome indeterminate after heartbeat persistence failure; automatic replay is forbidden"
		}
	}
	// Once the execution fence has been consumed, terminal persistence must not
	// inherit a disconnected worker's canceled HTTP context. Otherwise compute
	// may finish while the database remains running until lease expiry. The
	// bounded detached context cannot make the external call replayable; if this
	// commit still fails, the claim path terminalizes the expired started attempt.
	terminalContext, cancelTerminal := context.WithTimeout(context.WithoutCancel(request.Context()), service.config.JobTerminalPersistTimeout)
	defer cancelTerminal()
	completed, completedFound, completeErr := service.projects.CompleteJobClaimForWorkerWithAuditContext(terminalContext, workerAccess, job.ID, claimToken, finalStatus, result, errorText, durationMS,
		func(before, after store.Job) store.AuditEvent {
			auditRequest := request.WithContext(withIdentity(request, workerIdentity(after, workerID)))
			return service.auditEvent(auditRequest, "job.execute", "job", after.ID, after.Status, hashValue(before), hashValue(after),
				map[string]any{"workerId": workerID, "upstreamStatus": upstreamStatus})
		})
	if completeErr != nil {
		if errors.Is(completeErr, store.ErrJobClaimLost) {
			writeCodedError(response, request, http.StatusConflict, "JOB_CLAIM_LOST", "作业租约已失效或已被重新领取")
			return
		}
		if errors.Is(completeErr, store.ErrInvalidJobTransition) || errors.Is(completeErr, store.ErrJobWorkerMismatch) {
			writeCodedError(response, request, http.StatusConflict, "JOB_INVALID_TRANSITION", "无法写入作业终态")
			return
		}
		if writeAtomicAuditFailure(response, request, completeErr, "无法记录作业审计") {
			return
		}
		writeCodedError(response, request, http.StatusServiceUnavailable, "JOB_TERMINAL_PERSISTENCE_UNAVAILABLE", "作业计算已结束，但终态持久化暂时不可用；禁止自动重放")
		return
	}
	if !completedFound {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeData(response, request, http.StatusOK, workerJobResult(completed))
}

func (service *server) handleHeartbeatJob(response http.ResponseWriter, request *http.Request) {
	authenticatedWorker, authenticated := service.requireWorker(response, request)
	if !authenticated {
		return
	}
	workerID := authenticatedWorker.WorkerID
	workerAccess := workerJobClaimAccess(authenticatedWorker)
	var payload struct {
		WorkerID optionalStringValue `json:"workerId"`
	}
	if err := decodeJSON(response, request, &payload); err != nil {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKER_REQUEST", err.Error())
		return
	}
	if !workerRequestMatchesIdentity(response, request, payload.WorkerID, workerID) {
		return
	}
	claimToken, ok := requireJobClaimToken(response, request)
	if !ok {
		return
	}
	existing, found, err := service.projects.GetJobInternalForWorkerContext(request.Context(), workerAccess, request.PathValue("id"))
	if err != nil {
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_READ_FAILED", "无法读取计算作业")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	if !secureEqual(workerID, existing.WorkerID) {
		writeCodedError(response, request, http.StatusForbidden, "WORKER_JOB_ACCESS_DENIED", "该 Worker 无权续租此作业")
		return
	}
	lease, found, err := service.projects.HeartbeatJobClaimForWorkerContext(request.Context(), workerAccess, existing.ID, claimToken, store.DefaultJobLease)
	if err != nil {
		if err == store.ErrJobClaimLost {
			writeCodedError(response, request, http.StatusConflict, "JOB_CLAIM_LOST", "作业租约已失效或已被重新领取")
			return
		}
		writeCodedError(response, request, http.StatusInternalServerError, "JOB_HEARTBEAT_FAILED", "无法续租计算作业")
		return
	}
	if !found {
		writeCodedError(response, request, http.StatusNotFound, "JOB_NOT_FOUND", "计算作业不存在")
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	writeData(response, request, http.StatusOK, lease)
}

type jobHeartbeatMonitorResult struct {
	err       error
	claimLost bool
}

func (service *server) keepJobClaimAlive(ctx context.Context, cancel context.CancelFunc, stopped <-chan struct{}, done chan<- jobHeartbeatMonitorResult, access store.JobClaimAccess, jobID, claimToken string) {
	result := jobHeartbeatMonitorResult{}
	defer func() { done <- result }()
	ticker := time.NewTicker(service.config.JobHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stopped:
			return
		case <-ticker.C:
			_, found, err := service.projects.HeartbeatJobClaimForWorkerContext(ctx, access, jobID, claimToken, store.DefaultJobLease)
			if err != nil || !found {
				select {
				case <-stopped:
					return
				default:
				}
				if err == nil {
					err = store.ErrJobClaimLost
				}
				result.err = err
				result.claimLost = errors.Is(err, store.ErrJobClaimLost)
				cancel()
				return
			}
		}
	}
}

func requireJobClaimToken(response http.ResponseWriter, request *http.Request) (string, bool) {
	values := request.Header.Values(jobClaimHeader)
	if len(values) != 1 {
		writeCodedError(response, request, http.StatusUnauthorized, "JOB_CLAIM_REQUIRED", "需要唯一的作业租约凭据")
		return "", false
	}
	token := values[0]
	if token == "" || token != strings.TrimSpace(token) || strings.Contains(token, ",") || len(token) != jobClaimTokenEncodedLength {
		writeCodedError(response, request, http.StatusUnauthorized, "JOB_CLAIM_REQUIRED", "作业租约凭据格式无效")
		return "", false
	}
	material, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(material) != 32 || base64.RawURLEncoding.EncodeToString(material) != token {
		writeCodedError(response, request, http.StatusUnauthorized, "JOB_CLAIM_REQUIRED", "作业租约凭据格式无效")
		return "", false
	}
	return token, true
}

func workerRequestMatchesIdentity(response http.ResponseWriter, request *http.Request, claimedWorkerID optionalStringValue, authenticatedWorkerID string) bool {
	if !claimedWorkerID.Present {
		return true
	}
	value := claimedWorkerID.Value
	if value == "" || value != strings.TrimSpace(value) || len(value) > 128 {
		writeCodedError(response, request, http.StatusBadRequest, "INVALID_WORKER_REQUEST", "workerId 出现时必须是非空且不含首尾空白的字符串")
		return false
	}
	if !secureEqual(value, authenticatedWorkerID) {
		writeCodedError(response, request, http.StatusForbidden, "WORKER_IDENTITY_MISMATCH", "workerId 与 Bearer 凭据绑定身份不一致")
		return false
	}
	return true
}

func optionalIdempotencyHeader(request *http.Request) (string, bool, bool) {
	values := request.Header.Values("Idempotency-Key")
	if len(values) == 0 {
		return "", false, true
	}
	if len(values) != 1 || !validIdempotencyKey(values[0]) {
		return "", true, false
	}
	return values[0], true, true
}

func validIdempotencyKey(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') {
			continue
		}
		switch character {
		case '-', '.', '_', '~', ':', '/', '+', '=':
			continue
		default:
			return false
		}
	}
	return true
}

func workerIdentity(job store.Job, workerID string) store.Identity {
	return store.Identity{UserID: "worker:" + workerID, TenantID: job.TenantID, WorkspaceID: job.WorkspaceID, Role: "service"}
}

func workerJobClaimAccess(identity workerauth.Identity) store.JobClaimAccess {
	scopes := make([]store.JobClaimScope, len(identity.Scopes))
	for index, scope := range identity.Scopes {
		scopes[index] = store.JobClaimScope{
			TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
			Slug: scope.Slug, Actions: append([]string(nil), scope.Actions...),
		}
	}
	return store.JobClaimAccess{WorkerID: identity.WorkerID, Scopes: scopes}
}
