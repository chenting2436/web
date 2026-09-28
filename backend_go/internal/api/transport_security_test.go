package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
)

func validProductionTransportConfig() Config {
	config := Config{
		AllowedOrigins:    []string{"https://app.example.test"},
		CookieSecure:      true,
		DatabaseAdapter:   "postgresql",
		DatabaseDSN:       "postgres://service@db.example.test/skyview?sslmode=verify-full",
		PythonServiceURL:  "https://python.example.test",
		PythonServiceID:   "go-control-plane",
		ServiceHMACSecret: strings.Repeat("h", 32),
		WorkerCredentials: []workerauth.Credential{{ID: "worker-production-1", Token: strings.Repeat("w", 32), Scopes: []workerauth.Scope{{
			TenantID: "tenant-production", WorkspaceID: "workspace-production", Slug: "paper-writing", Actions: []string{"audit"},
		}}}},
		WorkerCredentialsSource: workerauth.SourceFile,
		OIDCIssuerURL:           "https://identity.example.test/realms/skyviewlab",
		OIDCClientID:            "skyviewlab-control-plane",
		OIDCClientSecret:        "production-confidential-client-secret",
		OIDCRedirectURL:         "https://api.example.test/api/v1/auth/oidc/callback",
		OIDCWebReturnURL:        "https://app.example.test/auth/complete",
		OIDCTenantClaim:         "tenant_id",
		OIDCWorkspaceClaim:      "workspace_id",
		OIDCTransactionKey:      make([]byte, 32),

		OpenFGAAPIURL:               "https://openfga.example.test",
		OpenFGAStoreID:              "01H0H015178Y2V4CX10C2KGHF4",
		OpenFGAAuthorizationModelID: "01H0H015178Y2V4CX10C2KGHF5",
		OpenFGAAPIToken:             strings.Repeat("f", 32),
		OpenFGAExpectedModelSHA256:  strings.Repeat("0", 64),
	}
	normalizeConfig(&config)
	return config
}

func TestPythonServiceURLFailsClosed(t *testing.T) {
	production := validProductionTransportConfig()
	if err := validateConfig(production); err != nil {
		t.Fatalf("valid production transport baseline failed: %v", err)
	}

	productionCases := []string{
		"http://python.example.test",
		"https://user:secret@python.example.test",
		"https://python.example.test/base",
		"https://python.example.test?tenant=a",
		"https://python.example.test#internal",
	}
	for _, target := range productionCases {
		t.Run(target, func(t *testing.T) {
			config := production
			config.PythonServiceURL = target
			if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "PYTHON_SERVICE_URL") {
				t.Fatalf("production must reject Python target %q, got %v", target, err)
			}
		})
	}

	development := testConfig()
	normalizeConfig(&development)
	development.PythonAllowInsecureHTTP = false
	development.PythonServiceURL = "http://192.0.2.10:8000"
	if err := validateConfig(development); err == nil || !strings.Contains(err.Error(), "PYTHON_SERVICE_URL") {
		t.Fatalf("development remote HTTP target without opt-in must be rejected, got %v", err)
	}
	development.PythonServiceURL = "http://localhost:8000"
	if err := validateConfig(development); err == nil || !strings.Contains(err.Error(), "PYTHON_SERVICE_URL") {
		t.Fatalf("development loopback HTTP without opt-in must be rejected, got %v", err)
	}
	development.PythonAllowInsecureHTTP = true
	for _, target := range []string{"http://localhost:8000", "http://127.0.0.1:8000", "http://python-compute:8000", "https://python.example.test"} {
		development.PythonServiceURL = target
		if err := validateConfig(development); err != nil {
			t.Fatalf("development target %q should be accepted: %v", target, err)
		}
	}

	production.PythonAllowInsecureHTTP = true
	if err := validateConfig(production); err == nil || !strings.Contains(err.Error(), "development-only") {
		t.Fatalf("production must reject the insecure HTTP override even with an HTTPS target, got %v", err)
	}
}

func TestPythonRequestTimeoutIsBoundedBelowWorkerRequestBudget(t *testing.T) {
	config := testConfig()
	normalizeConfig(&config)
	config.PythonRequestTimeout = time.Second - time.Millisecond
	if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "PYTHON_REQUEST_TIMEOUT") {
		t.Fatalf("sub-second Python timeout was accepted: %v", err)
	}
	config.PythonRequestTimeout = maximumSynchronousPythonTimeout + time.Second
	if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "durable workflow") {
		t.Fatalf("overlong synchronous Python timeout was accepted: %v", err)
	}
	config.PythonRequestTimeout = maximumSynchronousPythonTimeout
	if err := validateConfig(config); err != nil {
		t.Fatalf("maximum bounded synchronous Python timeout was rejected: %v", err)
	}
}

func TestTerminalPersistenceTimeoutIsBounded(t *testing.T) {
	config := testConfig()
	normalizeConfig(&config)
	if config.JobTerminalPersistTimeout != defaultJobTerminalPersistTimeout {
		t.Fatalf("unexpected default terminal persistence timeout: %s", config.JobTerminalPersistTimeout)
	}
	config.JobTerminalPersistTimeout = 5*time.Second - time.Millisecond
	if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "JOB_TERMINAL_PERSIST_TIMEOUT") {
		t.Fatalf("too-short terminal persistence timeout was accepted: %v", err)
	}
	config.JobTerminalPersistTimeout = maximumJobTerminalPersistTimeout + time.Second
	if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), "JOB_TERMINAL_PERSIST_TIMEOUT") {
		t.Fatalf("overlong terminal persistence timeout was accepted: %v", err)
	}
	config.JobTerminalPersistTimeout = maximumJobTerminalPersistTimeout
	if err := validateConfig(config); err != nil {
		t.Fatalf("maximum terminal persistence timeout was rejected: %v", err)
	}
}

func TestProductionRequiresServiceCredentials(t *testing.T) {
	baseline := validProductionTransportConfig()
	for _, test := range []struct {
		name      string
		configure func(*Config)
		want      string
	}{
		{name: "missing HMAC", configure: func(config *Config) { config.ServiceHMACSecret = "" }, want: "SERVICE_HMAC_SECRET"},
		{name: "missing worker authentication", configure: func(config *Config) { config.WorkerCredentials, config.WorkerCredentialsSource = nil, "" }, want: "WORKER_CREDENTIALS_FILE"},
		{name: "missing tenant claim", configure: func(config *Config) { config.OIDCTenantClaim = "" }, want: "OIDC_TENANT_CLAIM"},
		{name: "missing workspace claim", configure: func(config *Config) { config.OIDCWorkspaceClaim = "" }, want: "OIDC_WORKSPACE_CLAIM"},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := baseline
			test.configure(&config)
			if err := validateConfig(config); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("production must reject %s, got %v", test.name, err)
			}
		})
	}
	inline := baseline
	inline.WorkerCredentialsSource = workerauth.SourceDevelopmentInline
	if err := validateConfig(inline); err == nil || !strings.Contains(err.Error(), "inline") {
		t.Fatalf("production must reject legacy inline worker credentials, got %v", err)
	}
}

func TestPythonRedirectDoesNotForwardSignedRequest(t *testing.T) {
	var targetRequests atomic.Int32
	var targetSensitiveHeader atomic.Bool
	var targetBody atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		targetRequests.Add(1)
		if request.Header.Get("X-Skyview-Signature") != "" || request.Header.Get("X-Skyview-Service") != "" || request.Header.Get("X-Skyview-Actor") != "" {
			targetSensitiveHeader.Store(true)
		}
		body, _ := io.ReadAll(request.Body)
		if len(body) > 0 {
			targetBody.Store(true)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	sourceObserved := make(chan bool, 1)
	source := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		sourceObserved <- request.Header.Get("X-Skyview-Signature") != "" && request.Header.Get("X-Skyview-Service") == "go-control-plane" && string(body) == `{"action":"audit"}`
		response.Header().Set("Location", target.URL+"/stolen")
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	service := &server{
		config: Config{
			PythonServiceURL:  source.URL,
			PythonServiceID:   "go-control-plane",
			ServiceHMACSecret: testHMACSecret,
		},
		httpClient: newUpstreamHTTPClient(time.Second),
	}
	request := httptest.NewRequest(http.MethodPost, "http://api.example.test/api/v1/internal/jobs/job-1/execute", nil)
	body := []byte(`{"action":"audit"}`)
	_, status, _, err := service.pythonRequest(request, http.MethodPost, "/tools/paper-writing/run", body, "user-1", "tenant-1", "job-1")
	if err != nil {
		t.Fatalf("redirect response should be returned without following it: %v", err)
	}
	if status != http.StatusTemporaryRedirect {
		t.Fatalf("expected original 307 response, got %d", status)
	}
	if !<-sourceObserved {
		t.Fatal("source did not receive the signed request body")
	}
	if targetRequests.Load() != 0 || targetSensitiveHeader.Load() || targetBody.Load() {
		t.Fatalf("redirect target received request=%d sensitiveHeader=%v body=%v", targetRequests.Load(), targetSensitiveHeader.Load(), targetBody.Load())
	}
}
