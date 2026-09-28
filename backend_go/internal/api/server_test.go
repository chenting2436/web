package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/store"
)

const (
	testHMACSecret  = "0123456789abcdef0123456789abcdef"
	testWorkerToken = "abcdef0123456789abcdef0123456789"
)

func testConfig() Config {
	return Config{
		AllowedOrigins: []string{"http://localhost:4182"}, DevMode: true,
		DevTenantID: "tenant-a", DevWorkspaceID: "workspace-a",
		DemoAccount: "demo@skyviewlab.local", DemoPassword: "test-password-123",
		StudentAccount: "student@skyviewlab.local", StudentPassword: "student-password-123",
		SessionTTL: time.Hour, ServiceHMACSecret: testHMACSecret,
		WorkerCredentials: []workerauth.Credential{{ID: "worker-1", Token: testWorkerToken, Scopes: []workerauth.Scope{{
			TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"audit"},
		}}}}, WorkerCredentialsSource: workerauth.SourceDevelopmentInline,
		DatabaseAdapter: "sqlite-development", DevAuthorizationFallback: true, PythonAllowInsecureHTTP: true,
	}
}

func newTestHandler(t *testing.T, config Config) http.Handler {
	t.Helper()
	handler, err := NewHandlerChecked(config)
	if err != nil {
		t.Fatal(err)
	}
	if closer, ok := handler.(interface{ Close() error }); ok {
		t.Cleanup(func() { _ = closer.Close() })
	}
	return handler
}

func TestDevelopmentInlineScopesCanBeConstructedExplicitlyByConfig(t *testing.T) {
	config := testConfig()
	config.WorkerCredentials[0].Scopes = nil
	config.DevelopmentWorkerScopes = []workerauth.Scope{{
		TenantID: config.DevTenantID, WorkspaceID: config.DevWorkspaceID,
		Slug: "paper-writing", Actions: []string{"audit"},
	}}
	_ = newTestHandler(t, config)
	if len(config.WorkerCredentials[0].Scopes) != 0 {
		t.Fatal("handler construction mutated the caller's credential slice")
	}
}

func login(t *testing.T, handler http.Handler, account, password string) *http.Cookie {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"account": account, "password": password})
	response := perform(handler, http.MethodPost, "/api/v1/auth/login", string(body), nil)
	if response.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("expected session cookie")
	}
	return cookies[0]
}

func perform(handler http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		request.AddCookie(cookie)
		if isUnsafeMethod(method) {
			request.Header.Set("Origin", "http://localhost:4182")
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestDecodeJSONRejectsTopLevelNull(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("null"))
	response := httptest.NewRecorder()
	var payload struct {
		WorkerID string `json:"workerId"`
	}
	if err := decodeJSON(response, request, &payload); err == nil || !strings.Contains(err.Error(), "JSON 对象") {
		t.Fatalf("top-level null must not satisfy an object contract: %v", err)
	}
}

func TestOptionalRequestFieldsRejectExplicitNull(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	cookie := login(t, handler, testConfig().DemoAccount, testConfig().DemoPassword)

	projectNull := perform(handler, http.MethodPost, "/api/v1/workbenches/paper-writing/projects", `{"title":"null state","state":null}`, cookie)
	if projectNull.Code != http.StatusBadRequest || errorCode(t, projectNull) != "INVALID_PROJECT" {
		t.Fatalf("explicit null project state must be rejected: %d %s", projectNull.Code, projectNull.Body.String())
	}
	projectID := createProject(t, handler, cookie, "paper-writing")
	for _, testCase := range []struct {
		name string
		body string
	}{
		{name: "job input", body: `{"slug":"paper-writing","action":"audit","input":null}`},
		{name: "idempotency key", body: `{"slug":"paper-writing","action":"audit","idempotencyKey":null}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			response := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs", testCase.body, cookie)
			if response.Code != http.StatusBadRequest || errorCode(t, response) != "INVALID_JOB" {
				t.Fatalf("explicit null must be rejected: %d %s", response.Code, response.Body.String())
			}
		})
	}
	for _, body := range []string{`{"workerId":null}`, `{"workerId":""}`, `{"workerId":" worker-1 "}`} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+testWorkerToken)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || errorCode(t, response) != "INVALID_WORKER_REQUEST" {
			t.Fatalf("invalid present workerId must be rejected for %s: %d %s", body, response.Code, response.Body.String())
		}
	}
}

func TestIdempotencyKeyRequiresOneSafeASCIIValue(t *testing.T) {
	config := testConfig()
	handler := newTestHandler(t, config)
	cookie := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, cookie, "paper-writing")
	path := "/api/v1/projects/" + projectID + "/jobs"
	body := `{"slug":"paper-writing","action":"audit","input":{}}`

	duplicate := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	duplicate.Header.Set("Content-Type", "application/json")
	duplicate.Header.Set("Origin", "http://localhost:4182")
	duplicate.Header.Add("Idempotency-Key", "first")
	duplicate.Header.Add("Idempotency-Key", "second")
	duplicate.AddCookie(cookie)
	duplicateResponse := httptest.NewRecorder()
	handler.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != http.StatusBadRequest || errorCode(t, duplicateResponse) != "INVALID_IDEMPOTENCY_KEY" {
		t.Fatalf("duplicate Idempotency-Key must be rejected: %d %s", duplicateResponse.Code, duplicateResponse.Body.String())
	}

	for _, key := range []string{" one", "one,two", "幂等键"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://localhost:4182")
		request.Header.Set("Idempotency-Key", key)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || errorCode(t, response) != "INVALID_IDEMPOTENCY_KEY" {
			t.Fatalf("unsafe Idempotency-Key %q must be rejected: %d %s", key, response.Code, response.Body.String())
		}
	}
}

func TestWorkbenchStateUsesSharedDatabaseAndRevisionCAS(t *testing.T) {
	config := testConfig()
	config.DatabaseFile = filepath.Join(t.TempDir(), "shared-workbench-state.db")
	first := newTestHandler(t, config)
	cookie := login(t, first, config.DemoAccount, config.DemoPassword)
	path := "/api/v1/workbenches/paper-writing/state"

	empty := perform(first, http.MethodGet, path, "", cookie)
	if empty.Code != http.StatusOK || empty.Header().Get("ETag") != `"workbench-state-0"` || empty.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("empty state response mismatch: %d headers=%v body=%s", empty.Code, empty.Header(), empty.Body.String())
	}
	if strings.Contains(empty.Body.String(), `"updatedAt"`) {
		t.Fatalf("an absent draft must not emit an invalid empty date-time: %s", empty.Body.String())
	}
	emptyRecord := decodeData[store.WorkbenchState](t, empty)
	if emptyRecord.Revision != 0 || len(emptyRecord.State) != 0 {
		t.Fatalf("unexpected initial state: %+v", emptyRecord)
	}

	legacyBlindWrite := perform(first, http.MethodPut, path, `{"draft":"blind-overwrite"}`, cookie)
	if legacyBlindWrite.Code != http.StatusBadRequest || errorCode(t, legacyBlindWrite) != "INVALID_WORKBENCH_STATE" {
		t.Fatalf("blind write must be rejected: %d %s", legacyBlindWrite.Code, legacyBlindWrite.Body.String())
	}
	created := perform(first, http.MethodPut, path, `{"revision":0,"state":{"draft":"v1"}}`, cookie)
	if created.Code != http.StatusOK || created.Header().Get("ETag") != `"workbench-state-1"` {
		t.Fatalf("create state failed: %d headers=%v body=%s", created.Code, created.Header(), created.Body.String())
	}
	createdRecord := decodeData[store.WorkbenchState](t, created)
	if createdRecord.Revision != 1 || createdRecord.State["draft"] != "v1" || createdRecord.UpdatedAt == "" {
		t.Fatalf("unexpected created state: %+v", createdRecord)
	}

	second := newTestHandler(t, config)
	shared := perform(second, http.MethodGet, path, "", cookie)
	if shared.Code != http.StatusOK || shared.Header().Get("ETag") != `"workbench-state-1"` {
		t.Fatalf("second replica cannot read state: %d %s", shared.Code, shared.Body.String())
	}
	sharedRecord := decodeData[store.WorkbenchState](t, shared)
	if sharedRecord.State["draft"] != "v1" || sharedRecord.Revision != 1 {
		t.Fatalf("second replica read stale state: %+v", sharedRecord)
	}

	updated := perform(second, http.MethodPut, path, `{"revision":1,"state":{"draft":"v2"}}`, cookie)
	if updated.Code != http.StatusOK || updated.Header().Get("ETag") != `"workbench-state-2"` {
		t.Fatalf("CAS update failed: %d %s", updated.Code, updated.Body.String())
	}
	stale := perform(first, http.MethodPut, path, `{"revision":1,"state":{"draft":"stale"}}`, cookie)
	if stale.Code != http.StatusConflict || errorCode(t, stale) != "WORKBENCH_STATE_REVISION_CONFLICT" {
		t.Fatalf("stale state overwrite must conflict: %d %s", stale.Code, stale.Body.String())
	}

	oversizedBody, err := json.Marshal(map[string]any{
		"revision": 2,
		"state":    map[string]any{"payload": strings.Repeat("x", store.MaxWorkbenchStateBytes)},
	})
	if err != nil {
		t.Fatal(err)
	}
	oversized := perform(first, http.MethodPut, path, string(oversizedBody), cookie)
	if oversized.Code != http.StatusRequestEntityTooLarge || errorCode(t, oversized) != "WORKBENCH_STATE_TOO_LARGE" {
		t.Fatalf("oversized state must be rejected: %d %s", oversized.Code, oversized.Body.String())
	}
}

func TestCookieSessionOriginProtection(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	cookie := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	path := "/api/v1/workbenches/paper-writing/projects"
	body := `{"title":"来源防护测试","state":{"stage":"draft"}}`

	missingOrigin := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	missingOrigin.Header.Set("Content-Type", "application/json")
	missingOrigin.AddCookie(cookie)
	missingOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingOriginResponse, missingOrigin)
	if missingOriginResponse.Code != http.StatusForbidden || errorCode(t, missingOriginResponse) != "ORIGIN_REQUIRED" {
		t.Fatalf("cookie mutation without Origin must be rejected: %d %s", missingOriginResponse.Code, missingOriginResponse.Body.String())
	}

	maliciousOrigin := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	maliciousOrigin.Header.Set("Content-Type", "application/json")
	maliciousOrigin.Header.Set("Origin", "https://attacker.invalid")
	maliciousOrigin.AddCookie(cookie)
	maliciousOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(maliciousOriginResponse, maliciousOrigin)
	if maliciousOriginResponse.Code != http.StatusForbidden || errorCode(t, maliciousOriginResponse) != "ORIGIN_NOT_ALLOWED" {
		t.Fatalf("cookie mutation from malicious Origin must be rejected: %d %s", maliciousOriginResponse.Code, maliciousOriginResponse.Body.String())
	}
	for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods"} {
		if value := maliciousOriginResponse.Header().Get(header); value != "" {
			t.Fatalf("rejected Origin must not receive %s, got %q", header, value)
		}
	}

	allowedOrigin := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	allowedOrigin.Header.Set("Content-Type", "application/json")
	allowedOrigin.Header.Set("Origin", "http://localhost:4182")
	allowedOrigin.AddCookie(cookie)
	allowedOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedOriginResponse, allowedOrigin)
	if allowedOriginResponse.Code != http.StatusCreated {
		t.Fatalf("cookie mutation from allowed Origin must succeed: %d %s", allowedOriginResponse.Code, allowedOriginResponse.Body.String())
	}
	if got := allowedOriginResponse.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:4182" {
		t.Fatalf("allowed Origin response header mismatch: %q", got)
	}

	readWithoutOrigin := httptest.NewRequest(http.MethodGet, "/api/v1/workbenches", nil)
	readWithoutOrigin.AddCookie(cookie)
	readResponse := httptest.NewRecorder()
	handler.ServeHTTP(readResponse, readWithoutOrigin)
	if readResponse.Code != http.StatusOK {
		t.Fatalf("safe cookie request without Origin must remain allowed: %d %s", readResponse.Code, readResponse.Body.String())
	}

	headWithoutOrigin := httptest.NewRequest(http.MethodHead, "/api/v1/workbenches", nil)
	headWithoutOrigin.AddCookie(cookie)
	headResponse := httptest.NewRecorder()
	handler.ServeHTTP(headResponse, headWithoutOrigin)
	if headResponse.Code == http.StatusForbidden {
		t.Fatalf("HEAD without Origin must not be rejected by the origin guard: %d", headResponse.Code)
	}

	optionsWithoutOrigin := httptest.NewRequest(http.MethodOptions, "/api/v1/workbenches", nil)
	optionsWithoutOrigin.AddCookie(cookie)
	optionsResponse := httptest.NewRecorder()
	handler.ServeHTTP(optionsResponse, optionsWithoutOrigin)
	if optionsResponse.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS without Origin must remain safe: %d", optionsResponse.Code)
	}
}

func TestCORSPreflightRejectsUnknownOriginsWithoutLeakingPolicy(t *testing.T) {
	handler := newTestHandler(t, testConfig())

	malicious := httptest.NewRequest(http.MethodOptions, "/api/v1/workbenches", nil)
	malicious.Header.Set("Origin", "https://attacker.invalid")
	malicious.Header.Set("Access-Control-Request-Method", http.MethodPost)
	malicious.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	maliciousResponse := httptest.NewRecorder()
	handler.ServeHTTP(maliciousResponse, malicious)
	if maliciousResponse.Code != http.StatusForbidden {
		t.Fatalf("unknown preflight Origin must be rejected, got %d", maliciousResponse.Code)
	}
	for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods"} {
		if value := maliciousResponse.Header().Get(header); value != "" {
			t.Fatalf("rejected preflight must not receive %s, got %q", header, value)
		}
	}

	allowed := httptest.NewRequest(http.MethodOptions, "/api/v1/workbenches", nil)
	allowed.Header.Set("Origin", "http://localhost:4182")
	allowed.Header.Set("Access-Control-Request-Method", http.MethodPost)
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusNoContent {
		t.Fatalf("allowed preflight expected 204, got %d", allowedResponse.Code)
	}
	if allowedResponse.Header().Get("Access-Control-Allow-Origin") != "http://localhost:4182" || allowedResponse.Header().Get("Access-Control-Allow-Headers") == "" || allowedResponse.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatalf("allowed preflight is missing CORS policy headers: %#v", allowedResponse.Header())
	}
}

func TestCORSSafeRequestFromUnknownOriginRunsWithoutCORSHeaders(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	request := httptest.NewRequest(http.MethodGet, "/api/v1/live", nil)
	request.Header.Set("Origin", "https://attacker.invalid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("safe request with unknown Origin should reach the handler, got %d %s", response.Code, response.Body.String())
	}
	for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods"} {
		if value := response.Header().Get(header); value != "" {
			t.Fatalf("safe request with unknown Origin must not receive %s, got %q", header, value)
		}
	}
}

func TestCORSUnsafePublicRequestFromUnknownOriginIsRejected(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"account":"nobody","password":"invalid-password"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "https://attacker.invalid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || errorCode(t, response) != "ORIGIN_NOT_ALLOWED" {
		t.Fatalf("unsafe public request with unknown Origin must be rejected: %d %s", response.Code, response.Body.String())
	}
}

func TestInternalWorkerRequestWithoutCookieOrOriginRemainsCompatible(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	request := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer "+testWorkerToken)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("worker bearer request without browser Origin must remain compatible: %d %s", response.Code, response.Body.String())
	}
}

func TestAllowedOriginsValidation(t *testing.T) {
	tests := []struct {
		name    string
		origins []string
		devMode bool
		wantErr bool
	}{
		{name: "production HTTPS", origins: []string{"https://app.example.com"}},
		{name: "production requires origin", wantErr: true},
		{name: "production rejects HTTP", origins: []string{"http://app.example.com"}, wantErr: true},
		{name: "development localhost HTTP", origins: []string{"http://localhost:4182"}, devMode: true},
		{name: "development loopback HTTP", origins: []string{"http://127.0.0.1:4182"}, devMode: true},
		{name: "development rejects remote HTTP", origins: []string{"http://192.0.2.10:4182"}, devMode: true, wantErr: true},
		{name: "wildcard", origins: []string{"https://*.example.com"}, devMode: true, wantErr: true},
		{name: "path", origins: []string{"https://app.example.com/login"}, devMode: true, wantErr: true},
		{name: "trailing slash is a path", origins: []string{"https://app.example.com/"}, devMode: true, wantErr: true},
		{name: "credentials", origins: []string{"https://user:secret@app.example.com"}, devMode: true, wantErr: true},
		{name: "query", origins: []string{"https://app.example.com?tenant=a"}, devMode: true, wantErr: true},
		{name: "fragment", origins: []string{"https://app.example.com#fragment"}, devMode: true, wantErr: true},
		{name: "empty port", origins: []string{"https://app.example.com:"}, devMode: true, wantErr: true},
		{name: "out of range port", origins: []string{"https://app.example.com:65536"}, devMode: true, wantErr: true},
		{name: "upper-case noncanonical origin", origins: []string{"HTTPS://APP.EXAMPLE.COM"}, devMode: true, wantErr: true},
		{name: "explicit default port", origins: []string{"https://app.example.com:443"}, devMode: true, wantErr: true},
		{name: "logical duplicate", origins: []string{"https://app.example.com", "HTTPS://APP.EXAMPLE.COM:443"}, devMode: true, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateAllowedOrigins(test.origins, test.devMode)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateAllowedOrigins() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestProductionConfigRejectsDevelopmentCORSFallback(t *testing.T) {
	base := Config{
		CookieSecure:       true,
		DatabaseAdapter:    "postgresql",
		DatabaseDSN:        "postgres://service@db.example.test/skyview?sslmode=verify-full",
		OIDCIssuerURL:      "https://identity.example.test/realms/skyviewlab",
		OIDCClientID:       "skyviewlab-control-plane",
		OIDCClientSecret:   "test-confidential-client-secret",
		OIDCRedirectURL:    "https://api.example.test/api/v1/auth/oidc/callback",
		OIDCWebReturnURL:   "https://app.example.test/auth/callback",
		OIDCTenantClaim:    "tenant_id",
		OIDCWorkspaceClaim: "workspace_id",
	}
	for _, origins := range [][]string{nil, []string{"http://localhost:4182", "http://127.0.0.1:4182"}} {
		config := base
		config.AllowedOrigins = origins
		if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "CORS") {
			t.Fatalf("production must reject missing or development CORS fallback %#v, got %v", origins, err)
		}
	}
}

func decodeData[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func errorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Error.Code
}

func createProject(t *testing.T, handler http.Handler, cookie *http.Cookie, slug string) string {
	t.Helper()
	response := perform(handler, http.MethodPost, "/api/v1/workbenches/"+slug+"/projects", `{"title":"测试项目","state":{"stage":"draft"}}`, cookie)
	if response.Code != http.StatusCreated {
		t.Fatalf("create project failed: %d %s", response.Code, response.Body.String())
	}
	data := decodeData[struct {
		ID string `json:"id"`
	}](t, response)
	return data.ID
}

func TestHealthAndCatalogArePublicButBusinessRoutesRequireAuthentication(t *testing.T) {
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/ready" {
			_, _ = response.Write([]byte(`{"data":{"status":"ready"}}`))
			return
		}
		if request.URL.Path != "/tools/catalog" {
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
		if request.Header.Get("X-Skyview-Service") != "go-control-plane" || request.Header.Get("X-Skyview-Signature") == "" {
			t.Fatal("expected signed catalog request")
		}
		_, _ = response.Write([]byte(`{"data":[{"slug":"paper-writing","available":true,"maturity":"prototype"},{"slug":"uav-inspection","available":true,"maturity":"prototype"},{"slug":"fusion-console","available":true,"maturity":"prototype"},{"slug":"emergency-console","available":true,"maturity":"prototype"},{"slug":"project-submission","available":false,"maturity":"security-blocked"}]}`))
	}))
	defer python.Close()
	config := testConfig()
	config.PythonServiceURL = python.URL
	handler := newTestHandler(t, config)

	health := perform(handler, http.MethodGet, "/api/v1/health", "", nil)
	if health.Code != http.StatusOK {
		t.Fatalf("health expected 200, got %d", health.Code)
	}
	catalog := perform(handler, http.MethodGet, "/api/v1/tools/catalog", "", nil)
	if catalog.Code != http.StatusOK || !strings.Contains(catalog.Body.String(), `"status":"prototype"`) || !strings.Contains(catalog.Body.String(), `"status":"security-blocked"`) || strings.Contains(catalog.Body.String(), `"available"`) || strings.Contains(catalog.Body.String(), `"maturity"`) {
		t.Fatalf("catalog expected public response: %d %s", catalog.Code, catalog.Body.String())
	}
	protected := perform(handler, http.MethodGet, "/api/v1/workbenches", "", nil)
	if protected.Code != http.StatusUnauthorized || errorCode(t, protected) != "AUTH_REQUIRED" {
		t.Fatalf("expected AUTH_REQUIRED, got %d", protected.Code)
	}
	internal := perform(handler, http.MethodPost, "/api/v1/internal/jobs/claim", `{"workerId":"worker-1"}`, nil)
	if internal.Code != http.StatusUnauthorized || errorCode(t, internal) != "WORKER_AUTH_INVALID" {
		t.Fatalf("expected worker authentication failure, got %d", internal.Code)
	}
}

func TestAPIV1AndLegacyAliasesUsePersistedSession(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	cookie := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	for _, path := range []string{"/api/workbenches?page=1", "/api/v1/workbenches?page=1", "/api/auth/me", "/api/v1/auth/me"} {
		response := perform(handler, http.MethodGet, path, "", cookie)
		if response.Code != http.StatusOK {
			t.Fatalf("%s expected 200, got %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestProductionRoutingDoesNotRegisterLegacyAPIAliases(t *testing.T) {
	service := &server{config: Config{DevMode: false}, mux: http.NewServeMux()}
	service.routes()
	for _, path := range []string{"/api/live", "/api/auth/oidc/start", "/api/workbenches"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		service.mux.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("production legacy alias %s must be unregistered, got %d", path, response.Code)
		}
	}
	v1Request := httptest.NewRequest(http.MethodGet, "/api/v1/live", nil)
	v1Response := httptest.NewRecorder()
	service.mux.ServeHTTP(v1Response, v1Request)
	if v1Response.Code != http.StatusOK {
		t.Fatalf("versioned production route was not registered: %d %s", v1Response.Code, v1Response.Body.String())
	}
}

func TestCrossTenantProjectIsNotDiscoverable(t *testing.T) {
	database := filepath.Join(t.TempDir(), "tenant-test.db")
	configA := testConfig()
	configA.DatabaseFile = database
	handlerA := newTestHandler(t, configA)
	cookieA := login(t, handlerA, configA.DemoAccount, configA.DemoPassword)
	projectID := createProject(t, handlerA, cookieA, "paper-writing")

	configB := testConfig()
	configB.DatabaseFile = database
	configB.DevTenantID = "tenant-b"
	configB.DevWorkspaceID = "workspace-b"
	configB.DemoAccount = "admin@tenant-b.local"
	handlerB := newTestHandler(t, configB)
	cookieB := login(t, handlerB, configB.DemoAccount, configB.DemoPassword)
	response := perform(handlerB, http.MethodGet, "/api/v1/projects/"+projectID, "", cookieB)
	if response.Code != http.StatusNotFound || errorCode(t, response) != "PROJECT_NOT_FOUND" {
		t.Fatalf("cross tenant lookup must be indistinguishable from missing: %d %s", response.Code, response.Body.String())
	}
}

func TestStudentCannotModifyOwnScore(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	assignmentResponse := perform(handler, http.MethodPost, "/api/v1/collaboration/assignments", `{"data":{"title":"第一周编程作业","description":"完成数组处理练习"}}`, admin)
	if assignmentResponse.Code != http.StatusCreated {
		t.Fatalf("assignment create failed: %d %s", assignmentResponse.Code, assignmentResponse.Body.String())
	}
	assignment := decodeData[struct {
		ID string `json:"id"`
	}](t, assignmentResponse)
	adminSubmission := perform(handler, http.MethodPost, "/api/v1/collaboration/submissions", `{"data":{"assignmentId":"`+assignment.ID+`","content":"admin content"}}`, admin)
	if adminSubmission.Code != http.StatusForbidden || errorCode(t, adminSubmission) != "SUBMISSION_CREATE_DENIED" {
		t.Fatalf("non-student submission must be denied: %d %s", adminSubmission.Code, adminSubmission.Body.String())
	}
	student := login(t, handler, "student@skyviewlab.local", "student-password-123")
	submissionBody := `{"data":{"assignmentId":"` + assignment.ID + `","content":"print('done')"}}`
	submissionResponse := perform(handler, http.MethodPost, "/api/v1/collaboration/submissions", submissionBody, student)
	if submissionResponse.Code != http.StatusCreated {
		t.Fatalf("submission create failed: %d %s", submissionResponse.Code, submissionResponse.Body.String())
	}
	submission := decodeData[struct {
		ID       string `json:"id"`
		Revision int    `json:"revision"`
	}](t, submissionResponse)
	gradeAttempt := `{"revision":` + strconv.Itoa(submission.Revision) + `,"data":{"content":"changed","score":100}}`
	response := perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, gradeAttempt, student)
	if response.Code != http.StatusForbidden || errorCode(t, response) != "SUBMISSION_SERVER_FIELD_FORBIDDEN" {
		t.Fatalf("student grade attempt must be forbidden: %d %s", response.Code, response.Body.String())
	}
	teacherContentAttempt := `{"revision":1,"data":{"content":"teacher changed content","score":80}}`
	response = perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, teacherContentAttempt, admin)
	if response.Code != http.StatusForbidden || errorCode(t, response) != "SUBMISSION_FIELD_FORBIDDEN" {
		t.Fatalf("teacher must not rewrite submission content: %d %s", response.Code, response.Body.String())
	}
	grade := perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, `{"revision":1,"data":{"score":80,"feedback":"完成基本要求"}}`, admin)
	if grade.Code != http.StatusOK {
		t.Fatalf("teacher grade failed: %d %s", grade.Code, grade.Body.String())
	}
	graded := decodeData[struct {
		Revision int `json:"revision"`
	}](t, grade)
	studentEdit := `{"revision":` + strconv.Itoa(graded.Revision) + `,"data":{"content":"late rewrite"}}`
	response = perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, studentEdit, student)
	if response.Code != http.StatusConflict || errorCode(t, response) != "SUBMISSION_LOCKED" {
		t.Fatalf("graded submission must be locked: %d %s", response.Code, response.Body.String())
	}
	hardDelete := perform(handler, http.MethodDelete, "/api/v1/collaboration/submissions/"+submission.ID, "", admin)
	if hardDelete.Code != http.StatusConflict || errorCode(t, hardDelete) != "SUBMISSION_DELETE_REQUIRES_RETENTION_WORKFLOW" {
		t.Fatalf("formal submission hard-delete must be blocked: %d %s", hardDelete.Code, hardDelete.Body.String())
	}
}

func TestStudentCannotReadAnotherStudentsSubmission(t *testing.T) {
	database := filepath.Join(t.TempDir(), "submission-scope.db")
	configA := testConfig()
	configA.DatabaseFile = database
	handlerA := newTestHandler(t, configA)
	admin := login(t, handlerA, configA.DemoAccount, configA.DemoPassword)
	assignmentResponse := perform(handlerA, http.MethodPost, "/api/v1/collaboration/assignments", `{"data":{"title":"租户内隔离测试作业","description":"验证提交记录按学生隔离"}}`, admin)
	if assignmentResponse.Code != http.StatusCreated {
		t.Fatalf("assignment create failed: %d %s", assignmentResponse.Code, assignmentResponse.Body.String())
	}
	assignment := decodeData[struct {
		ID string `json:"id"`
	}](t, assignmentResponse)
	studentA := login(t, handlerA, configA.StudentAccount, configA.StudentPassword)
	submissionResponse := perform(handlerA, http.MethodPost, "/api/v1/collaboration/submissions", `{"data":{"assignmentId":"`+assignment.ID+`","content":"student A private answer"}}`, studentA)
	if submissionResponse.Code != http.StatusCreated {
		t.Fatalf("submission create failed: %d %s", submissionResponse.Code, submissionResponse.Body.String())
	}
	submission := decodeData[struct {
		ID string `json:"id"`
	}](t, submissionResponse)

	configB := testConfig()
	configB.DatabaseFile = database
	configB.StudentAccount = "student-b@skyviewlab.local"
	handlerB := newTestHandler(t, configB)
	studentB := login(t, handlerB, configB.StudentAccount, configB.StudentPassword)
	get := perform(handlerB, http.MethodGet, "/api/v1/collaboration/submissions/"+submission.ID, "", studentB)
	if get.Code != http.StatusNotFound || errorCode(t, get) != "COLLABORATION_RECORD_NOT_FOUND" {
		t.Fatalf("another student's submission must be undiscoverable: %d %s", get.Code, get.Body.String())
	}
	list := perform(handlerB, http.MethodGet, "/api/v1/collaboration/submissions", "", studentB)
	if list.Code != http.StatusOK || strings.Contains(list.Body.String(), submission.ID) || strings.Contains(list.Body.String(), "student A private answer") {
		t.Fatalf("submission list leaked another student: %d %s", list.Code, list.Body.String())
	}
}

func TestClientCannotForgeFinalRun(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	projectID := createProject(t, handler, admin, "paper-writing")
	response := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/runs", `{"slug":"paper-writing","action":"audit","status":"succeeded","result":{"score":100}}`, admin)
	if response.Code != http.StatusForbidden || errorCode(t, response) != "RUN_FINALIZATION_FORBIDDEN" {
		t.Fatalf("forged run must be rejected: %d %s", response.Code, response.Body.String())
	}
	direct := perform(handler, http.MethodPost, "/api/v1/tools/paper-writing/run", `{"action":"audit","payload":{}}`, admin)
	if direct.Code != http.StatusConflict || errorCode(t, direct) != "JOB_API_REQUIRED" {
		t.Fatalf("direct compute must be rejected: %d %s", direct.Code, direct.Body.String())
	}
}

func TestJobIdempotencyLifecycleAndAudit(t *testing.T) {
	var signed bool
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		expected := signServiceRequest(testHMACSecret, request.Method, request.URL.Path,
			request.Header.Get("X-Skyview-Timestamp"), request.Header.Get("X-Skyview-Nonce"),
			request.Header.Get("X-Skyview-Service"), request.Header.Get("X-Skyview-Actor"),
			request.Header.Get("X-Skyview-Tenant"), request.Header.Get("X-Skyview-Job"), body)
		if !secureEqual(expected, request.Header.Get("X-Skyview-Signature")) || request.Header.Get("X-Skyview-Job") == "" {
			t.Fatal("invalid service signature")
		}
		signed = true
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"score":91}}`))
	}))
	defer python.Close()
	config := testConfig()
	config.PythonServiceURL = python.URL
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	path := "/api/v1/projects/" + projectID + "/jobs"
	body := `{"slug":"paper-writing","action":"audit","input":{"text":"draft"},"idempotencyKey":"job-key-1"}`
	created := perform(handler, http.MethodPost, path, body, admin)
	if created.Code != http.StatusCreated {
		t.Fatalf("job create failed: %d %s", created.Code, created.Body.String())
	}
	createdData := decodeData[struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}](t, created)
	replay := perform(handler, http.MethodPost, path, body, admin)
	if replay.Code != http.StatusOK {
		t.Fatalf("idempotent replay failed: %d %s", replay.Code, replay.Body.String())
	}
	conflict := perform(handler, http.MethodPost, path, `{"slug":"paper-writing","action":"audit","input":{"text":"other"},"idempotencyKey":"job-key-1"}`, admin)
	if conflict.Code != http.StatusConflict || errorCode(t, conflict) != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("idempotency conflict expected: %d %s", conflict.Code, conflict.Body.String())
	}

	claim := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{"workerId":"worker-1"}`))
	claim.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claim.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claim)
	if claimResponse.Code != http.StatusOK {
		t.Fatalf("job claim failed: %d %s", claimResponse.Code, claimResponse.Body.String())
	}
	claimed := decodeData[store.JobClaim](t, claimResponse)
	if claimed.Job.ID != createdData.Job.ID || claimed.ClaimToken == "" || claimResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("invalid job claim envelope: headers=%v data=%+v", claimResponse.Header(), claimed)
	}
	forgedCompletion := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+createdData.Job.ID+"/complete", strings.NewReader(`{"status":"succeeded","result":{"forged":true},"durationMs":1}`))
	forgedCompletion.Header.Set("Authorization", "Bearer "+testWorkerToken)
	forgedCompletion.Header.Set("Content-Type", "application/json")
	forgedCompletion.Header.Set(jobClaimHeader, claimed.ClaimToken)
	forgedCompletionResponse := httptest.NewRecorder()
	handler.ServeHTTP(forgedCompletionResponse, forgedCompletion)
	if forgedCompletionResponse.Code != http.StatusNotFound {
		t.Fatalf("untrusted Worker completion route must remain absent: %d %s", forgedCompletionResponse.Code, forgedCompletionResponse.Body.String())
	}

	execute := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/"+createdData.Job.ID+"/execute", strings.NewReader(`{"workerId":"worker-1"}`))
	execute.Header.Set("Authorization", "Bearer "+testWorkerToken)
	execute.Header.Set("Content-Type", "application/json")
	execute.Header.Set(jobClaimHeader, claimed.ClaimToken)
	executeResponse := httptest.NewRecorder()
	handler.ServeHTTP(executeResponse, execute)
	if executeResponse.Code != http.StatusOK || !signed || !strings.Contains(executeResponse.Body.String(), `"id":"`+createdData.Job.ID+`"`) || !strings.Contains(executeResponse.Body.String(), `"status":"succeeded"`) {
		t.Fatalf("job execute failed: %d %s", executeResponse.Code, executeResponse.Body.String())
	}
	for _, forbidden := range []string{"tenantId", "workspaceId", "projectId", "createdByUserId", "input", "result", "idempotencyKey", "workerId", "claimToken", "leaseExpiresAt"} {
		if strings.Contains(executeResponse.Body.String(), `"`+forbidden+`"`) {
			t.Fatalf("execute acknowledgement leaked %s: %s", forbidden, executeResponse.Body.String())
		}
	}
	runs := perform(handler, http.MethodGet, "/api/v1/projects/"+projectID+"/runs", "", admin)
	if runs.Code != http.StatusOK || !strings.Contains(runs.Body.String(), `"jobId":"`+createdData.Job.ID+`"`) || !strings.Contains(runs.Body.String(), `"status":"succeeded"`) || !strings.Contains(runs.Body.String(), `"result":{"score":91}`) {
		t.Fatalf("server-owned run was not finalized: %d %s", runs.Code, runs.Body.String())
	}
	audit := perform(handler, http.MethodGet, "/api/v1/audit/events?limit=100", "", admin)
	if audit.Code != http.StatusOK || !strings.Contains(audit.Body.String(), `"action":"job.execute"`) || !strings.Contains(audit.Body.String(), `"eventHash"`) {
		t.Fatalf("audit trail missing: %d %s", audit.Code, audit.Body.String())
	}
}

func TestWorkerBearerCannotImpersonateAnotherWorker(t *testing.T) {
	pythonCalled := false
	python := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		pythonCalled = true
		response.WriteHeader(http.StatusInternalServerError)
	}))
	defer python.Close()

	const workerBToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	database := filepath.Join(t.TempDir(), "worker-identity.db")
	config := testConfig()
	config.DatabaseFile = database
	config.PythonServiceURL = python.URL
	config.WorkerCredentials = append(config.WorkerCredentials, workerauth.Credential{ID: "worker-2", Token: workerBToken, Scopes: []workerauth.Scope{{
		TenantID: config.DevTenantID, WorkspaceID: config.DevWorkspaceID, Slug: "paper-writing", Actions: []string{"audit"},
	}}})
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs", `{"slug":"paper-writing","action":"audit","input":{},"idempotencyKey":"worker-binding-api"}`, admin)
	if created.Code != http.StatusCreated {
		t.Fatalf("job create failed: %d %s", created.Code, created.Body.String())
	}
	createdData := decodeData[struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}](t, created)

	claim := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{}`))
	claim.Header.Set("Authorization", "Bearer "+testWorkerToken)
	claim.Header.Set("Content-Type", "application/json")
	claimResponse := httptest.NewRecorder()
	handler.ServeHTTP(claimResponse, claim)
	if claimResponse.Code != http.StatusOK || !strings.Contains(claimResponse.Body.String(), `"workerId":"worker-1"`) {
		t.Fatalf("worker-1 claim failed: %d %s", claimResponse.Code, claimResponse.Body.String())
	}
	claimed := decodeData[store.JobClaim](t, claimResponse)
	if claimed.ClaimToken == "" {
		t.Fatal("claim response omitted the one-time capability")
	}

	spoofedClaim := httptest.NewRequest(http.MethodPost, "/api/v1/internal/jobs/claim", strings.NewReader(`{"workerId":"worker-1"}`))
	spoofedClaim.Header.Set("Authorization", "Bearer "+workerBToken)
	spoofedClaim.Header.Set("Content-Type", "application/json")
	spoofedClaimResponse := httptest.NewRecorder()
	handler.ServeHTTP(spoofedClaimResponse, spoofedClaim)
	if spoofedClaimResponse.Code != http.StatusForbidden || errorCode(t, spoofedClaimResponse) != "WORKER_IDENTITY_MISMATCH" {
		t.Fatalf("worker-2 body impersonation must be forbidden: %d %s", spoofedClaimResponse.Code, spoofedClaimResponse.Body.String())
	}

	for _, attempt := range []struct {
		name string
		path string
		body string
	}{
		{name: "execute", path: "/api/v1/internal/jobs/" + createdData.Job.ID + "/execute", body: `{}`},
	} {
		t.Run(attempt.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, attempt.path, strings.NewReader(attempt.body))
			request.Header.Set("Authorization", "Bearer "+workerBToken)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set(jobClaimHeader, claimed.ClaimToken)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || errorCode(t, response) != "WORKER_JOB_ACCESS_DENIED" {
				t.Fatalf("worker-2 %s must be forbidden: %d %s", attempt.name, response.Code, response.Body.String())
			}
		})
	}
	if pythonCalled {
		t.Fatal("unauthorized worker reached Python compute")
	}

	job := perform(handler, http.MethodGet, "/api/v1/jobs/"+createdData.Job.ID, "", admin)
	if job.Code != http.StatusOK || !strings.Contains(job.Body.String(), `"status":"running"`) || strings.Contains(job.Body.String(), `"workerId"`) || strings.Contains(job.Body.String(), "forged") {
		t.Fatalf("unauthorized worker mutated job: %d %s", job.Code, job.Body.String())
	}
	runs := perform(handler, http.MethodGet, "/api/v1/projects/"+projectID+"/runs", "", admin)
	if runs.Code != http.StatusOK || !strings.Contains(runs.Body.String(), `"status":"running"`) || strings.Contains(runs.Body.String(), "forged") {
		t.Fatalf("unauthorized worker mutated run: %d %s", runs.Code, runs.Body.String())
	}

	reader, err := store.OpenProjectStore(store.StoreConfig{Adapter: store.AdapterSQLiteDevelopment, SQLitePath: database})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Close() }()
	if _, found, err := reader.GetOutbox(store.Scope{TenantID: config.DevTenantID, WorkspaceID: config.DevWorkspaceID}, "job:"+createdData.Job.ID+":job.succeeded"); err != nil || found {
		t.Fatalf("unauthorized completion created terminal outbox found=%v err=%v", found, err)
	}
	audit := perform(handler, http.MethodGet, "/api/v1/audit/events?limit=100", "", admin)
	if audit.Code != http.StatusOK || strings.Contains(audit.Body.String(), "worker:worker-2") || strings.Contains(audit.Body.String(), `"action":"job.execute"`) || strings.Contains(audit.Body.String(), `"action":"job.complete"`) {
		t.Fatalf("unauthorized worker produced success audit evidence: %d %s", audit.Code, audit.Body.String())
	}
}

func TestServiceHMACMatchesPythonVector(t *testing.T) {
	body := []byte(`{"action":"clean","payload":{"csv":"id,1"}}`)
	got := signServiceRequest(testHMACSecret, http.MethodPost, "/tools/data-lab/run", "1788796800", "nonce-001", "go-control-plane", "user-42", "tenant-7", "job-99", body)
	want := "f137b59b93b20942e2c48c5ab012cec98ea1de30492b9ac2547ce0608aae29c0"
	if got != want {
		t.Fatalf("HMAC mismatch: got %s want %s", got, want)
	}
}

func TestProductionDefaultsFailClosed(t *testing.T) {
	_, err := NewHandlerChecked(Config{DemoAccount: "demo@example.test", DemoPassword: "unsafe-default", CookieSecure: true})
	if err == nil || !strings.Contains(err.Error(), "DEV_MODE") {
		t.Fatalf("production demo credentials must be rejected, got %v", err)
	}
	_, err = NewHandlerChecked(Config{CookieSecure: true})
	if err == nil || !strings.Contains(err.Error(), "SQLite") {
		t.Fatalf("production SQLite adapter must be rejected, got %v", err)
	}
	_, err = NewHandlerChecked(Config{CookieSecure: true, DatabaseAdapter: "postgresql"})
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("production PostgreSQL without a DSN must be rejected, got %v", err)
	}
}

func TestReadinessFailsClosedWhenServiceCredentialsAreMissing(t *testing.T) {
	config := testConfig()
	config.ServiceHMACSecret, config.WorkerCredentials, config.WorkerCredentialsSource, config.DevelopmentWorkerScopes = "", nil, "", nil
	handler := newTestHandler(t, config)
	live := perform(handler, http.MethodGet, "/api/v1/live", "", nil)
	if live.Code != http.StatusOK {
		t.Fatalf("liveness must only reflect process state: %d %s", live.Code, live.Body.String())
	}
	ready := perform(handler, http.MethodGet, "/api/v1/ready", "", nil)
	if ready.Code != http.StatusServiceUnavailable || !strings.Contains(ready.Body.String(), `"status":"not-ready"`) {
		t.Fatalf("readiness must fail closed: %d %s", ready.Code, ready.Body.String())
	}
}

func TestDevelopmentModeDoesNotCreateDefaultAccounts(t *testing.T) {
	config := testConfig()
	config.DemoAccount, config.DemoPassword = "", ""
	config.StudentAccount, config.StudentPassword = "", ""
	handler := newTestHandler(t, config)
	response := perform(handler, http.MethodPost, "/api/v1/auth/login", `{"account":"demo@skyviewlab.local","password":"SkyViewLab-demo-2026"}`, nil)
	if response.Code != http.StatusUnauthorized || errorCode(t, response) != "AUTH_INVALID_CREDENTIALS" {
		t.Fatalf("known demo credentials must not exist by default: %d %s", response.Code, response.Body.String())
	}
}
