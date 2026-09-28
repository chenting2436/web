package api

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/store"
)

func TestExecutePersistsTerminalFailureAfterWorkerDisconnect(t *testing.T) {
	workerContext, cancelWorker := context.WithCancel(context.Background())
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		cancelWorker()
		panic(http.ErrAbortHandler)
	}))
	defer python.Close()

	config := testConfig()
	config.PythonServiceURL = python.URL
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"disconnect-terminal"}`, admin)
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	claim := decodeData[store.JobClaim](t, claimResponse)

	execute := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/execute", strings.NewReader(`{}`)).WithContext(workerContext)
	execute.Header.Set("Authorization", "Bearer "+testWorkerToken)
	execute.Header.Set("Content-Type", "application/json")
	execute.Header.Set(jobClaimHeader, claim.ClaimToken)
	handler.ServeHTTP(httptest.NewRecorder(), execute)

	read := perform(handler, http.MethodGet, "/api/v1/jobs/"+jobID, "", admin)
	if read.Code != http.StatusOK {
		t.Fatalf("read terminal job: %d %s", read.Code, read.Body.String())
	}
	job := decodeData[PublicJob](t, read)
	if job.Status != "failed" || !strings.Contains(job.Error, "outcome indeterminate") || !strings.Contains(job.Error, "automatic replay is forbidden") {
		t.Fatalf("disconnected execution was not durably terminalized: %+v", job)
	}
}

func TestExecuteReportsTerminalPersistenceInfrastructureFailureAsUnavailable(t *testing.T) {
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"ok":true}}`))
	}))
	defer python.Close()

	databaseFile := filepath.Join(t.TempDir(), "terminal-persistence.db")
	config := testConfig()
	config.DatabaseFile = databaseFile
	config.PythonServiceURL = python.URL
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"terminal-persistence-unavailable"}`, admin)
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	claim := decodeData[store.JobClaim](t, claimResponse)

	database, err := sql.Open("sqlite", databaseFile)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`CREATE TRIGGER fail_terminal_outbox BEFORE INSERT ON outbox_events
		WHEN NEW.event_type = 'job.succeeded'
		BEGIN SELECT RAISE(ABORT, 'terminal persistence unavailable'); END`)
	_ = database.Close()
	if err != nil {
		t.Fatal(err)
	}

	execute := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/execute", strings.NewReader(`{}`))
	execute.Header.Set("Authorization", "Bearer "+testWorkerToken)
	execute.Header.Set("Content-Type", "application/json")
	execute.Header.Set(jobClaimHeader, claim.ClaimToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, execute)
	if response.Code != http.StatusServiceUnavailable || errorCode(t, response) != "JOB_TERMINAL_PERSISTENCE_UNAVAILABLE" {
		t.Fatalf("infrastructure failure was misreported: %d %s", response.Code, response.Body.String())
	}

	read := perform(handler, http.MethodGet, "/api/v1/jobs/"+jobID, "", admin)
	job := decodeData[PublicJob](t, read)
	if read.Code != http.StatusOK || job.Status != "running" {
		t.Fatalf("failed terminal transaction partially committed: %d job=%+v", read.Code, job)
	}
}

func TestExecutePersistsFailedTerminalStateAfterTransientHeartbeatError(t *testing.T) {
	databaseFile := filepath.Join(t.TempDir(), "heartbeat-transient.db")
	releasePython := make(chan struct{})
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		database, err := sql.Open("sqlite", databaseFile)
		if err != nil {
			t.Errorf("open heartbeat fixture database: %v", err)
			return
		}
		_, err = database.Exec(`CREATE TRIGGER fail_running_heartbeat BEFORE UPDATE OF heartbeat_at ON jobs
			WHEN NEW.status = 'running' AND NEW.heartbeat_at IS NOT NULL
			BEGIN SELECT RAISE(ABORT, 'transient heartbeat storage failure'); END`)
		_ = database.Close()
		if err != nil {
			t.Errorf("install heartbeat failure trigger: %v", err)
			return
		}
		select {
		case <-request.Context().Done():
		case <-releasePython:
		}
	}))
	defer python.Close()
	defer close(releasePython)

	config := testConfig()
	config.DatabaseFile = databaseFile
	config.PythonServiceURL = python.URL
	config.JobHeartbeatInterval = 20 * time.Millisecond
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"heartbeat-transient"}`, admin)
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	claim := decodeData[store.JobClaim](t, claimResponse)

	execute := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/execute", strings.NewReader(`{}`))
	execute.Header.Set("Authorization", "Bearer "+testWorkerToken)
	execute.Header.Set("Content-Type", "application/json")
	execute.Header.Set(jobClaimHeader, claim.ClaimToken)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(response, execute)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("execute did not stop after the heartbeat storage error")
	}
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"failed"`) {
		t.Fatalf("heartbeat uncertainty was not durably failed: %d %s", response.Code, response.Body.String())
	}

	read := perform(handler, http.MethodGet, "/api/v1/jobs/"+jobID, "", admin)
	job := decodeData[PublicJob](t, read)
	if read.Code != http.StatusOK || job.Status != "failed" || !strings.Contains(job.Error, "heartbeat persistence failure") || !strings.Contains(job.Error, "automatic replay is forbidden") {
		t.Fatalf("heartbeat uncertainty left the job non-terminal: %d %+v", read.Code, job)
	}
	database, err := sql.Open("sqlite", databaseFile)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var failedEvents int
	if err := database.QueryRow(`SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ? AND event_type = 'job.failed'`, jobID).Scan(&failedEvents); err != nil || failedEvents != 1 {
		t.Fatalf("failed terminal outbox evidence mismatch: count=%d err=%v", failedEvents, err)
	}
	audit := perform(handler, http.MethodGet, "/api/v1/audit/events?limit=100", "", admin)
	if audit.Code != http.StatusOK || !strings.Contains(audit.Body.String(), `"action":"job.execute"`) || !strings.Contains(audit.Body.String(), `"outcome":"failed"`) {
		t.Fatalf("failed terminal audit evidence missing: %d %s", audit.Code, audit.Body.String())
	}
}

func TestExecuteEndpointFencesConcurrentReplayOfSameClaim(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls atomic.Int32
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		entered <- struct{}{}
		<-release
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"ok":true}}`))
	}))
	defer python.Close()

	config := testConfig()
	config.PythonServiceURL = python.URL
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"execute-fence-api"}`, admin)
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	claim := decodeData[store.JobClaim](t, claimResponse)

	executeRequest := func() *http.Request {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/execute", strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+testWorkerToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(jobClaimHeader, claim.ClaimToken)
		return request
	}
	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(firstResponse, executeRequest())
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("first execution did not reach compute service")
	}

	replayResponse := httptest.NewRecorder()
	handler.ServeHTTP(replayResponse, executeRequest())
	if replayResponse.Code != http.StatusConflict || errorCode(t, replayResponse) != "JOB_EXECUTION_ALREADY_STARTED" {
		close(release)
		t.Fatalf("concurrent replay was not fenced: %d %s", replayResponse.Code, replayResponse.Body.String())
	}
	close(release)
	select {
	case <-firstDone:
	case <-time.After(2 * time.Second):
		t.Fatal("first execution did not finish")
	}
	if firstResponse.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("execution result=%d calls=%d body=%s", firstResponse.Code, calls.Load(), firstResponse.Body.String())
	}
}

func TestExecuteRenewsLeaseAfterAuditedFenceBeforeCallingCompute(t *testing.T) {
	var calls atomic.Int32
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"ok":true}}`))
	}))
	defer python.Close()

	databaseFile := filepath.Join(t.TempDir(), "pre-compute-lease.db")
	config := testConfig()
	config.DatabaseFile = databaseFile
	config.PythonServiceURL = python.URL
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"pre-compute-renewal"}`, admin)
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	claim := decodeData[store.JobClaim](t, claimResponse)

	database, err := sql.Open("sqlite", databaseFile)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`CREATE TRIGGER expire_execution_lease_after_audit
		AFTER UPDATE OF head_event_hash ON audit_heads
		BEGIN
			UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00Z'
			WHERE id = '` + jobID + `' AND execution_started_at IS NOT NULL AND status = 'running';
		END`)
	_ = database.Close()
	if err != nil {
		t.Fatal(err)
	}

	execute := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/execute", strings.NewReader(`{}`))
	execute.Header.Set("Authorization", "Bearer "+testWorkerToken)
	execute.Header.Set("Content-Type", "application/json")
	execute.Header.Set(jobClaimHeader, claim.ClaimToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, execute)
	if response.Code != http.StatusConflict || errorCode(t, response) != "JOB_CLAIM_LOST" {
		t.Fatalf("expired post-fence lease was not rejected: %d %s", response.Code, response.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatalf("compute started without a post-fence live lease: calls=%d", calls.Load())
	}
}

func TestWorkerJobClaimCapabilityAndHeartbeatAreEnforced(t *testing.T) {
	pythonCalled := false
	config := testConfig()
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{"text":"draft"},"idempotencyKey":"lease-api"}`, admin)
	if created.Code != http.StatusCreated {
		t.Fatalf("create job: %d %s", created.Code, created.Body.String())
	}
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	if claimResponse.Code != http.StatusOK || claimResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("claim: %d headers=%v body=%s", claimResponse.Code, claimResponse.Header(), claimResponse.Body.String())
	}
	claim := decodeData[store.JobClaim](t, claimResponse)
	if claim.Job.ID != jobID || claim.ClaimToken == "" || claim.ClaimEpoch < 1 || claim.LeaseExpiresAt == "" || claim.HeartbeatAt == "" {
		t.Fatalf("incomplete claim capability: %+v", claim)
	}

	for _, test := range []struct {
		name       string
		tokens     []string
		wantStatus int
		wantCode   string
	}{
		{name: "missing", wantStatus: http.StatusUnauthorized, wantCode: "JOB_CLAIM_REQUIRED"},
		{name: "malformed", tokens: []string{"not-a-valid-capability"}, wantStatus: http.StatusUnauthorized, wantCode: "JOB_CLAIM_REQUIRED"},
		{name: "multiple", tokens: []string{claim.ClaimToken, claim.ClaimToken}, wantStatus: http.StatusUnauthorized, wantCode: "JOB_CLAIM_REQUIRED"},
		{name: "wrong", tokens: []string{"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}, wantStatus: http.StatusConflict, wantCode: "JOB_CLAIM_LOST"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/execute", strings.NewReader(`{}`))
			request.Header.Set("Authorization", "Bearer "+testWorkerToken)
			request.Header.Set("Content-Type", "application/json")
			for _, token := range test.tokens {
				request.Header.Add(jobClaimHeader, token)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus || errorCode(t, response) != test.wantCode {
				t.Fatalf("got %d %s", response.Code, response.Body.String())
			}
		})
	}
	if pythonCalled {
		t.Fatal("invalid claim capability reached Python")
	}

	heartbeat := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/heartbeat", strings.NewReader(`{}`))
	heartbeat.Header.Set("Authorization", "Bearer "+testWorkerToken)
	heartbeat.Header.Set("Content-Type", "application/json")
	heartbeat.Header.Set(jobClaimHeader, claim.ClaimToken)
	heartbeatResponse := httptest.NewRecorder()
	handler.ServeHTTP(heartbeatResponse, heartbeat)
	if heartbeatResponse.Code != http.StatusOK || heartbeatResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("heartbeat: %d headers=%v body=%s", heartbeatResponse.Code, heartbeatResponse.Header(), heartbeatResponse.Body.String())
	}
	lease := decodeData[store.JobLease](t, heartbeatResponse)
	if lease.ClaimEpoch != claim.ClaimEpoch || lease.LeaseExpiresAt == "" || lease.HeartbeatAt == "" {
		t.Fatalf("invalid heartbeat lease: %+v", lease)
	}

	forgedCompletion := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+jobID+"/complete",
		strings.NewReader(`{"status":"succeeded","result":{"score":1},"durationMs":1}`))
	forgedCompletion.Header.Set("Authorization", "Bearer "+testWorkerToken)
	forgedCompletion.Header.Set("Content-Type", "application/json")
	forgedCompletion.Header.Set(jobClaimHeader, claim.ClaimToken)
	forgedCompletionResponse := httptest.NewRecorder()
	handler.ServeHTTP(forgedCompletionResponse, forgedCompletion)
	if forgedCompletionResponse.Code != http.StatusNotFound {
		t.Fatalf("external completion route must not exist: %d %s", forgedCompletionResponse.Code, forgedCompletionResponse.Body.String())
	}

	audit := perform(handler, http.MethodGet, "/api/v1/audit/events?limit=100", "", admin)
	if audit.Code != http.StatusOK || strings.Contains(audit.Body.String(), claim.ClaimToken) {
		t.Fatalf("audit leaked claim capability: %d %s", audit.Code, audit.Body.String())
	}
}

func TestWorkerClaimUsesAuthenticatedActionScopeAndMinimalProjection(t *testing.T) {
	config := testConfig()
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")

	blocked := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"outline","input":{"marker":"blocked-private-input"},"idempotencyKey":"blocked-action"}`, admin)
	if blocked.Code != http.StatusCreated {
		t.Fatalf("create blocked fixture: %d %s", blocked.Code, blocked.Body.String())
	}
	blockedID := decodeData[PublicJobRun](t, blocked).Job.ID
	allowed := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{"marker":"allowed-private-input"},"idempotencyKey":"allowed-action"}`, admin)
	if allowed.Code != http.StatusCreated {
		t.Fatalf("create allowed fixture: %d %s", allowed.Code, allowed.Body.String())
	}
	allowedID := decodeData[PublicJobRun](t, allowed).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claimRequest)
	if claimResponse.Code != http.StatusOK || claimResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("claim failed: %d headers=%v body=%s", claimResponse.Code, claimResponse.Header(), claimResponse.Body.String())
	}
	claim := decodeData[store.JobClaim](t, claimResponse)
	if claim.Job.ID != allowedID || claim.Job.WorkerID != "worker-1" || claim.ClaimToken == "" {
		t.Fatalf("worker claimed outside its exact action scope: %+v", claim)
	}
	for _, forbidden := range []string{"blocked-private-input", "allowed-private-input", config.DevTenantID, config.DevWorkspaceID, projectID, `"slug"`, `"action"`, `"input"`} {
		if strings.Contains(claimResponse.Body.String(), forbidden) {
			t.Errorf("minimum worker projection leaked %q: %s", forbidden, claimResponse.Body.String())
		}
	}

	secondClaim := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	secondClaim.Header.Set("Authorization", "Bearer "+testWorkerToken)
	secondClaim.Header.Set("Content-Type", "application/json")
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, secondClaim)
	if secondResponse.Code != http.StatusNoContent {
		t.Fatalf("disallowed queued job was claimable: %d %s", secondResponse.Code, secondResponse.Body.String())
	}
	blockedRead := perform(handler, http.MethodGet, "/api/v1/jobs/"+blockedID, "", admin)
	if blockedRead.Code != http.StatusOK || !strings.Contains(blockedRead.Body.String(), `"status":"queued"`) {
		t.Fatalf("disallowed job was mutated: %d %s", blockedRead.Code, blockedRead.Body.String())
	}
}

func TestWorkerScopeNarrowingImmediatelyBlocksExistingClaim(t *testing.T) {
	databaseFile := filepath.Join(t.TempDir(), "worker-scope-rotation.db")
	config := testConfig()
	config.DatabaseFile = databaseFile
	first := newTestHandler(t, config)
	admin := login(t, first, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, first, admin, "paper-writing")
	created := perform(first, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs",
		`{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"scope-rotation"}`, admin)
	jobID := decodeData[PublicJobRun](t, created).Job.ID

	claimRequest := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claimRequest.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	first.ServeHTTP(claimResponse, claimRequest)
	claim := decodeData[store.JobClaim](t, claimResponse)
	if claim.ClaimToken == "" {
		t.Fatalf("missing claim: %d %s", claimResponse.Code, claimResponse.Body.String())
	}

	rotated := config
	rotated.WorkerCredentials = []workerauth.Credential{{ID: "worker-1", Token: testWorkerToken, Scopes: []workerauth.Scope{{
		TenantID: config.DevTenantID, WorkspaceID: config.DevWorkspaceID, Slug: "paper-writing", Actions: []string{"outline"},
	}}}}
	second := newTestHandler(t, rotated)
	for _, testCase := range []struct {
		name string
		path string
		body string
	}{
		{name: "execute", path: "/api/v1/internal/jobs/" + jobID + "/execute", body: `{}`},
		{name: "heartbeat", path: "/api/v1/internal/jobs/" + jobID + "/heartbeat", body: `{}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, testCase.path, strings.NewReader(testCase.body))
			request.Header.Set("Authorization", "Bearer "+testWorkerToken)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set(jobClaimHeader, claim.ClaimToken)
			response := httptest.NewRecorder()
			second.ServeHTTP(response, request)
			if response.Code != http.StatusNotFound || errorCode(t, response) != "JOB_NOT_FOUND" {
				t.Fatalf("narrowed worker scope was not enforced: %d %s", response.Code, response.Body.String())
			}
		})
	}
	read := perform(first, http.MethodGet, "/api/v1/jobs/"+jobID, "", admin)
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `"status":"running"`) {
		t.Fatalf("denied operations mutated job: %d %s", read.Code, read.Body.String())
	}
}
