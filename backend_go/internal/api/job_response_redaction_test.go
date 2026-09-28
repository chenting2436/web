package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
)

func TestBrowserJobAndRunResponsesNeverExposePrivateExecutionData(t *testing.T) {
	const (
		privateTenant      = "tenant-never-public-9472"
		privateWorkspace   = "workspace-never-public-5831"
		privateInput       = "input-never-public-1209"
		privateIdempotency = "idempotency-never-public-8614"
		privateWorkerID    = "worker-never-public-7395"
		privateWorkerToken = "worker-token-never-public-7395-abcdef"
	)

	config := testConfig()
	config.DevTenantID = privateTenant
	config.DevWorkspaceID = privateWorkspace
	config.WorkerCredentials = []workerauth.Credential{{ID: privateWorkerID, Token: privateWorkerToken, Scopes: []workerauth.Scope{{
		TenantID: privateTenant, WorkspaceID: privateWorkspace, Slug: "paper-writing", Actions: []string{"audit"},
	}}}}
	handler := newTestHandler(t, config)
	cookie := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, cookie, "paper-writing")
	jobPath := "/api/v1/projects/" + projectID + "/jobs"
	requestBody, err := json.Marshal(map[string]any{
		"slug": "paper-writing", "action": "audit",
		"input":          map[string]any{"privatePrompt": privateInput},
		"idempotencyKey": privateIdempotency,
	})
	if err != nil {
		t.Fatal(err)
	}

	created := perform(handler, http.MethodPost, jobPath, string(requestBody), cookie)
	if created.Code != http.StatusCreated {
		t.Fatalf("create job failed: %d %s", created.Code, created.Body.String())
	}
	assertBrowserJobResponseRedacted(t, "create", created, privateTenant, privateWorkspace, privateInput, privateIdempotency, privateWorkerID, privateWorkerToken)
	createdData := decodeData[PublicJobRun](t, created)
	if createdData.Job.ID == "" || createdData.Job.ProjectID != projectID || createdData.Run.JobID != createdData.Job.ID {
		t.Fatalf("public create response lost required UI fields: %+v", createdData)
	}

	read := perform(handler, http.MethodGet, "/api/v1/jobs/"+createdData.Job.ID, "", cookie)
	if read.Code != http.StatusOK {
		t.Fatalf("get job failed: %d %s", read.Code, read.Body.String())
	}
	assertBrowserJobResponseRedacted(t, "get", read, privateTenant, privateWorkspace, privateInput, privateIdempotency, privateWorkerID, privateWorkerToken)

	listed := perform(handler, http.MethodGet, jobPath, "", cookie)
	if listed.Code != http.StatusOK {
		t.Fatalf("list jobs failed: %d %s", listed.Code, listed.Body.String())
	}
	assertBrowserJobResponseRedacted(t, "list", listed, privateTenant, privateWorkspace, privateInput, privateIdempotency, privateWorkerID, privateWorkerToken)

	// Claim is a minimum routing capability. The compute input remains
	// server-side and is resolved only after the worker proves the claim token.
	claim := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claim.Header.Set("Authorization", "Bearer "+privateWorkerToken)
	claim.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claim)
	claimBody := claimResponse.Body.String()
	if claimResponse.Code != http.StatusOK || !strings.Contains(claimBody, privateWorkerID) {
		t.Fatalf("internal worker claim was not minimally projected: %d %s", claimResponse.Code, claimResponse.Body.String())
	}
	for _, forbidden := range []string{privateTenant, privateWorkspace, privateInput, privateIdempotency, `"projectId"`, `"createdByUserId"`, `"slug"`, `"action"`, `"input"`, `"result"`} {
		if strings.Contains(claimBody, forbidden) {
			t.Fatalf("internal worker claim leaked %q: %s", forbidden, claimBody)
		}
	}

	claimedRead := perform(handler, http.MethodGet, "/api/v1/jobs/"+createdData.Job.ID, "", cookie)
	if claimedRead.Code != http.StatusOK || !strings.Contains(claimedRead.Body.String(), `"status":"running"`) {
		t.Fatalf("get claimed job failed: %d %s", claimedRead.Code, claimedRead.Body.String())
	}
	assertBrowserJobResponseRedacted(t, "get claimed", claimedRead, privateTenant, privateWorkspace, privateInput, privateIdempotency, privateWorkerID, privateWorkerToken)

	canceled := perform(handler, http.MethodPost, "/api/v1/jobs/"+createdData.Job.ID+"/cancel", "", cookie)
	if canceled.Code != http.StatusOK || !strings.Contains(canceled.Body.String(), `"status":"canceled"`) {
		t.Fatalf("cancel job failed: %d %s", canceled.Code, canceled.Body.String())
	}
	assertBrowserJobResponseRedacted(t, "cancel", canceled, privateTenant, privateWorkspace, privateInput, privateIdempotency, privateWorkerID, privateWorkerToken)

	runs := perform(handler, http.MethodGet, "/api/v1/projects/"+projectID+"/runs", "", cookie)
	if runs.Code != http.StatusOK || !strings.Contains(runs.Body.String(), `"jobId":"`+createdData.Job.ID+`"`) {
		t.Fatalf("list runs failed: %d %s", runs.Code, runs.Body.String())
	}
	assertBrowserJobResponseRedacted(t, "runs", runs, privateTenant, privateWorkspace, privateInput, privateIdempotency, privateWorkerID, privateWorkerToken)
}

func assertBrowserJobResponseRedacted(t *testing.T, operation string, response *httptest.ResponseRecorder, privateValues ...string) {
	t.Helper()
	body := response.Body.Bytes()
	for _, value := range privateValues {
		if strings.Contains(string(body), value) {
			t.Errorf("%s response exposed private marker %q: %s", operation, value, string(body))
		}
	}
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("%s response is not JSON: %v", operation, err)
	}
	forbidden := map[string]struct{}{
		"tenantId": {}, "workspaceId": {}, "createdByUserId": {}, "input": {},
		"idempotencyKey": {}, "workerId": {}, "claimToken": {}, "claimEpoch": {},
		"leaseExpiresAt": {}, "heartbeatAt": {},
	}
	assertJSONKeysAbsent(t, operation, document, forbidden)
}

func assertJSONKeysAbsent(t *testing.T, operation string, value any, forbidden map[string]struct{}) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, blocked := forbidden[key]; blocked {
				t.Errorf("%s response exposed private field %q", operation, key)
			}
			assertJSONKeysAbsent(t, operation, child, forbidden)
		}
	case []any:
		for _, child := range typed {
			assertJSONKeysAbsent(t, operation, child, forbidden)
		}
	}
}
