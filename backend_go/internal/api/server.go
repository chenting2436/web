package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	oidcauth "skyviewlab/backend_go/internal/auth/oidc"
	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/authorization"
	"skyviewlab/backend_go/internal/model"
	"skyviewlab/backend_go/internal/store"
)

var serviceContextPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`)

const (
	sessionCookie                     = "skyviewlab_session"
	maxJSONBody                       = 4 << 20
	maxPythonResponse                 = 4 << 20
	defaultPythonTarget               = "http://127.0.0.1:8000"
	defaultPythonRequestTimeout       = 30 * time.Second
	defaultJobTerminalPersistTimeout  = 30 * time.Second
	maximumSynchronousPythonTimeout   = 8 * time.Minute
	maximumJobTerminalPersistTimeout  = 2 * time.Minute
	runtimePrivilegeValidationTimeout = 5 * time.Second
)

type Config struct {
	AllowedOrigins              []string
	DevMode                     bool
	DevTenantID                 string
	DevWorkspaceID              string
	DemoAccount                 string
	DemoPassword                string
	StudentAccount              string
	StudentPassword             string
	CookieSecure                bool
	PythonServiceURL            string
	PythonAllowInsecureHTTP     bool
	PythonRequestTimeout        time.Duration
	JobTerminalPersistTimeout   time.Duration
	JobHeartbeatInterval        time.Duration
	PythonServiceID             string
	ServiceHMACSecret           string
	WorkerCredentials           []workerauth.Credential
	WorkerCredentialsSource     string
	DevelopmentWorkerScopes     []workerauth.Scope
	SessionTTL                  time.Duration
	DatabaseAdapter             string
	DatabaseFile                string
	DatabaseDSN                 string
	DatabaseMigrate             bool
	OIDCIssuerURL               string
	OIDCClientID                string
	OIDCClientSecret            string
	OIDCRedirectURL             string
	OIDCWebReturnURL            string
	OIDCTenantClaim             string
	OIDCWorkspaceClaim          string
	OIDCAllowInsecureHTTP       bool
	OIDCMaxTokenLifetime        time.Duration
	OIDCTransactionKey          []byte
	Authorizer                  authorization.Authorizer
	OpenFGAAPIURL               string
	OpenFGAStoreID              string
	OpenFGAAuthorizationModelID string
	OpenFGAAPIToken             string
	OpenFGAExpectedModelSHA256  string
	OpenFGATimeout              time.Duration
	OpenFGAAllowInsecureHTTP    bool
	DevAuthorizationFallback    bool
}

type contextKey string

const (
	requestIDKey contextKey = "request-id"
	identityKey  contextKey = "identity"
)

type server struct {
	config     Config
	catalog    *store.MemoryStore
	projects   *store.ProjectStore
	mux        *http.ServeMux
	httpClient *http.Client
	oidc       *oidcauth.Client
	oidcStart  *oidcStartRateLimiter
	workers    *workerauth.Authenticator
	authorizer authorization.Authorizer
}

type managedHandler struct {
	http.Handler
	close func() error
}

type runtimePrivilegeValidator interface {
	ValidateRuntimePrivileges(context.Context) error
}

func (handler *managedHandler) Close() error {
	return handler.close()
}

// NewHandler is kept for compatibility with existing embedding code. New code
// should use NewHandlerChecked and handle configuration failures explicitly.
func NewHandler(config Config) http.Handler {
	handler, err := NewHandlerChecked(config)
	if err != nil {
		panic(err)
	}
	return handler
}

func NewHandlerChecked(config Config) (http.Handler, error) {
	normalizeConfig(&config)
	if err := applyDevelopmentWorkerScopes(&config); err != nil {
		return nil, err
	}
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	projectStore, err := store.OpenProjectStore(store.StoreConfig{
		Adapter: config.DatabaseAdapter, SQLitePath: config.DatabaseFile, PostgresDSN: config.DatabaseDSN,
		ApplyMigrations: config.DatabaseMigrate, RequireTLS: !config.DevMode,
	})
	if err != nil {
		return nil, fmt.Errorf("open project database: %w", err)
	}
	privilegeContext, cancelPrivilegeValidation := context.WithTimeout(context.Background(), runtimePrivilegeValidationTimeout)
	err = enforceProductionRuntimePrivileges(privilegeContext, config.DevMode, projectStore)
	cancelPrivilegeValidation()
	if err != nil {
		_ = projectStore.Close()
		return nil, fmt.Errorf("validate production database identity: %w", err)
	}
	authorizer, err := buildAuthorizer(config)
	if err != nil {
		_ = projectStore.Close()
		return nil, fmt.Errorf("configure authorization: %w", err)
	}
	workerAuthenticator, err := workerauth.New(config.WorkerCredentials)
	if err != nil {
		_ = projectStore.Close()
		return nil, fmt.Errorf("configure worker authentication: %w", err)
	}
	config.WorkerCredentials = nil
	config.DevelopmentWorkerScopes = nil
	var oidcClient *oidcauth.Client
	if oidcConfigured(config) {
		var transactionStore oidcauth.TransactionStore
		if len(config.OIDCTransactionKey) == 0 {
			transactionStore = oidcauth.NewMemoryTransactionStore(oidcauth.DefaultTransactionCapacity)
		} else {
			transactionStore, err = store.NewOIDCTransactionStore(projectStore, store.OIDCTransactionStoreConfig{
				IssuerURL: config.OIDCIssuerURL, ClientID: config.OIDCClientID,
				EncryptionKey: config.OIDCTransactionKey, Capacity: oidcauth.DefaultTransactionCapacity,
			})
			if err != nil {
				_ = projectStore.Close()
				return nil, fmt.Errorf("configure OIDC transaction store: %w", err)
			}
		}
		oidcClient, err = oidcauth.New(oidcauth.Config{
			IssuerURL: config.OIDCIssuerURL, ClientID: config.OIDCClientID,
			ClientSecret: config.OIDCClientSecret, RedirectURL: config.OIDCRedirectURL,
			TenantClaim: config.OIDCTenantClaim, WorkspaceClaim: config.OIDCWorkspaceClaim,
			AllowInsecureHTTP: config.OIDCAllowInsecureHTTP, MaxTokenLifetime: config.OIDCMaxTokenLifetime,
			TransactionStore: transactionStore,
		})
		if err != nil {
			_ = projectStore.Close()
			return nil, fmt.Errorf("configure OIDC: %w", err)
		}
		config.OIDCTransactionKey = nil
	}
	oidcStartLimiter := newOIDCStartRateLimiter()
	if !config.DevMode {
		oidcStartLimiter = newOIDCStartGlobalRateLimiter()
	}
	service := &server{
		config: config, catalog: store.NewMemoryStore(),
		projects: projectStore, mux: http.NewServeMux(), httpClient: newUpstreamHTTPClient(config.PythonRequestTimeout),
		oidc: oidcClient, oidcStart: oidcStartLimiter, workers: workerAuthenticator, authorizer: authorizer,
	}
	service.routes()
	handler := service.securityHeaders(service.requestID(service.cors(service.authentication(service.mux))))
	return &managedHandler{Handler: handler, close: projectStore.Close}, nil
}

func enforceProductionRuntimePrivileges(ctx context.Context, devMode bool, validator runtimePrivilegeValidator) error {
	if devMode {
		return nil
	}
	if validator == nil {
		return store.ErrRuntimePrivilegeVerificationUnavailable
	}
	return validator.ValidateRuntimePrivileges(ctx)
}

func normalizeConfig(config *Config) {
	if config.SessionTTL <= 0 {
		config.SessionTTL = 12 * time.Hour
	}
	config.PythonServiceURL = strings.TrimSpace(config.PythonServiceURL)
	if config.PythonServiceURL == "" {
		config.PythonServiceURL = defaultPythonTarget
	}
	if config.PythonServiceID == "" {
		config.PythonServiceID = "go-control-plane"
	}
	if config.PythonRequestTimeout <= 0 {
		config.PythonRequestTimeout = defaultPythonRequestTimeout
	}
	if config.JobTerminalPersistTimeout <= 0 {
		config.JobTerminalPersistTimeout = defaultJobTerminalPersistTimeout
	}
	if config.JobHeartbeatInterval <= 0 {
		config.JobHeartbeatInterval = store.DefaultJobLease / 3
	}
	if config.DevTenantID == "" {
		config.DevTenantID = "tenant-dev"
	}
	if config.DevWorkspaceID == "" {
		config.DevWorkspaceID = "workspace-dev"
	}
	if config.DevMode && strings.TrimSpace(config.DatabaseAdapter) == "" {
		config.DatabaseAdapter = store.AdapterSQLiteDevelopment
	}
	if config.OpenFGATimeout <= 0 {
		config.OpenFGATimeout = 2 * time.Second
	}
}

func validateConfig(config Config) error {
	adapter := strings.ToLower(strings.TrimSpace(config.DatabaseAdapter))
	if !config.DevMode {
		if config.DemoAccount != "" || config.DemoPassword != "" || config.StudentAccount != "" || config.StudentPassword != "" {
			return errors.New("demo accounts are forbidden unless DEV_MODE=true")
		}
		if !config.CookieSecure {
			return errors.New("COOKIE_SECURE must be true outside development")
		}
		if adapter != "postgres" && adapter != store.AdapterPostgreSQL {
			return errors.New("production requires DATABASE_ADAPTER=postgresql; SQLite is development/test only")
		}
		if strings.TrimSpace(config.DatabaseDSN) == "" {
			return errors.New("production PostgreSQL requires DATABASE_URL")
		}
		if strings.TrimSpace(config.DatabaseFile) != "" {
			return errors.New("DATABASE_FILE is forbidden with the production PostgreSQL adapter")
		}
		if config.DatabaseMigrate {
			return errors.New("DATABASE_MIGRATE=true is migration-only outside development and cannot start the HTTP service")
		}
		if !oidcConfigured(config) {
			return errors.New("production requires OIDC issuer, client, callback, and fixed web return URL")
		}
		if config.OIDCClientSecret == "" {
			return errors.New("production OIDC requires a confidential client secret")
		}
		if strings.TrimSpace(config.OIDCTenantClaim) == "" || strings.TrimSpace(config.OIDCWorkspaceClaim) == "" {
			return errors.New("production requires explicit OIDC_TENANT_CLAIM and OIDC_WORKSPACE_CLAIM")
		}
	}
	if err := validateAllowedOrigins(config.AllowedOrigins, config.DevMode); err != nil {
		return err
	}
	if config.PythonRequestTimeout < time.Second || config.PythonRequestTimeout > maximumSynchronousPythonTimeout {
		return fmt.Errorf("PYTHON_REQUEST_TIMEOUT must be between 1s and %s; longer work requires the durable workflow runtime", maximumSynchronousPythonTimeout)
	}
	if config.JobTerminalPersistTimeout < 5*time.Second || config.JobTerminalPersistTimeout > maximumJobTerminalPersistTimeout {
		return fmt.Errorf("JOB_TERMINAL_PERSIST_TIMEOUT must be between 5s and %s", maximumJobTerminalPersistTimeout)
	}
	if config.JobHeartbeatInterval <= 0 || config.JobHeartbeatInterval >= store.DefaultJobLease {
		return errors.New("job heartbeat interval must be positive and shorter than the job lease")
	}
	if !config.DevMode && len(config.OIDCTransactionKey) != 32 {
		return errors.New("production OIDC requires a 32-byte shared transaction encryption key")
	}
	if config.OIDCAllowInsecureHTTP && !config.DevMode {
		return errors.New("OIDC insecure HTTP is development-only")
	}
	oidcValues := []string{config.OIDCIssuerURL, config.OIDCClientID, config.OIDCClientSecret, config.OIDCRedirectURL, config.OIDCWebReturnURL, config.OIDCTenantClaim, config.OIDCWorkspaceClaim}
	hasOIDCValue := false
	for _, value := range oidcValues {
		hasOIDCValue = hasOIDCValue || strings.TrimSpace(value) != ""
	}
	hasOIDCValue = hasOIDCValue || config.OIDCAllowInsecureHTTP || len(config.OIDCTransactionKey) > 0
	if hasOIDCValue && !oidcConfigured(config) {
		return errors.New("OIDC issuer, client ID, callback URL, and fixed web return URL must be configured together")
	}
	if oidcConfigured(config) {
		if err := validateOIDCReturnURL(config.OIDCWebReturnURL, config.OIDCAllowInsecureHTTP); err != nil {
			return err
		}
		if len(config.OIDCTransactionKey) != 0 && len(config.OIDCTransactionKey) != 32 {
			return errors.New("OIDC_TRANSACTION_KEY must decode to exactly 32 bytes")
		}
	}
	if err := validatePythonServiceURL(config.PythonServiceURL, config.DevMode, config.PythonAllowInsecureHTTP); err != nil {
		return err
	}
	if adapter != "sqlite" && adapter != store.AdapterSQLiteDevelopment && adapter != "postgres" && adapter != store.AdapterPostgreSQL {
		return errors.New("DATABASE_ADAPTER must be sqlite-development or postgresql")
	}
	if (adapter == "sqlite" || adapter == store.AdapterSQLiteDevelopment) && strings.TrimSpace(config.DatabaseDSN) != "" {
		return errors.New("DATABASE_URL is forbidden with sqlite-development")
	}
	if (adapter == "postgres" || adapter == store.AdapterPostgreSQL) && strings.TrimSpace(config.DatabaseFile) != "" {
		return errors.New("DATABASE_FILE is forbidden with PostgreSQL")
	}
	if (config.DemoAccount == "") != (config.DemoPassword == "") || (config.StudentAccount == "") != (config.StudentPassword == "") {
		return errors.New("development account and password must be configured together")
	}
	if !serviceContextPattern.MatchString(config.DevTenantID) || !serviceContextPattern.MatchString(config.DevWorkspaceID) || !serviceContextPattern.MatchString(config.PythonServiceID) {
		return errors.New("tenant, workspace, and service identifiers must use the service-context format")
	}
	if config.DemoPassword != "" && len(config.DemoPassword) < 12 || config.StudentPassword != "" && len(config.StudentPassword) < 12 {
		return errors.New("development passwords must contain at least 12 characters")
	}
	if err := validateWorkerAuthenticationConfig(config); err != nil {
		return err
	}
	if !config.DevMode && strings.TrimSpace(config.ServiceHMACSecret) == "" {
		return errors.New("production requires SERVICE_HMAC_SECRET")
	}
	if config.ServiceHMACSecret != "" && len(strings.TrimSpace(config.ServiceHMACSecret)) < 32 {
		return errors.New("SERVICE_HMAC_SECRET must contain at least 32 characters")
	}
	if err := validateAuthorizationConfig(config); err != nil {
		return err
	}
	return nil
}

func validateWorkerAuthenticationConfig(config Config) error {
	source := strings.TrimSpace(config.WorkerCredentialsSource)
	if !config.DevMode {
		if len(config.DevelopmentWorkerScopes) != 0 {
			return errors.New("development worker scopes are forbidden outside development")
		}
		if source != workerauth.SourceFile || len(config.WorkerCredentials) == 0 {
			return errors.New("production requires WORKER_CREDENTIALS_FILE; inline WORKER_ID/WORKER_TOKEN credentials are forbidden")
		}
	} else if source != "" && source != workerauth.SourceFile && source != workerauth.SourceDevelopmentInline {
		return errors.New("invalid worker credential source")
	}
	if len(config.WorkerCredentials) == 0 {
		if len(config.DevelopmentWorkerScopes) != 0 {
			return errors.New("development worker scopes are configured without credentials")
		}
		if source != "" {
			return errors.New("worker credential source is configured without credentials")
		}
		return nil
	}
	if source == "" {
		return errors.New("worker credentials require an explicit source")
	}
	if _, err := workerauth.New(config.WorkerCredentials); err != nil {
		return fmt.Errorf("invalid worker credentials: %w", err)
	}
	return nil
}

func applyDevelopmentWorkerScopes(config *Config) error {
	if config == nil || len(config.WorkerCredentials) == 0 {
		return nil
	}
	if config.WorkerCredentialsSource != workerauth.SourceDevelopmentInline {
		if len(config.DevelopmentWorkerScopes) != 0 {
			return errors.New("development worker scopes require development-inline credentials")
		}
		return nil
	}
	if !config.DevMode {
		return nil
	}
	credentials := make([]workerauth.Credential, len(config.WorkerCredentials))
	copy(credentials, config.WorkerCredentials)
	config.WorkerCredentials = credentials
	if len(config.DevelopmentWorkerScopes) == 0 {
		for _, credential := range config.WorkerCredentials {
			if len(credential.Scopes) == 0 {
				return errors.New("development inline workers require explicit tenant/workspace/slug/action scopes")
			}
		}
		return nil
	}
	for index := range config.WorkerCredentials {
		if len(config.WorkerCredentials[index].Scopes) != 0 {
			return errors.New("development worker scopes must be supplied either on credentials or through Config, not both")
		}
		config.WorkerCredentials[index].Scopes = cloneWorkerScopes(config.DevelopmentWorkerScopes)
	}
	return nil
}

func cloneWorkerScopes(scopes []workerauth.Scope) []workerauth.Scope {
	result := make([]workerauth.Scope, len(scopes))
	for index, scope := range scopes {
		result[index] = workerauth.Scope{
			TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
			Slug: scope.Slug, Actions: append([]string(nil), scope.Actions...),
		}
	}
	return result
}

func validatePythonServiceURL(rawURL string, devMode, allowInsecureHTTP bool) error {
	if allowInsecureHTTP && !devMode {
		return errors.New("PYTHON_ALLOW_INSECURE_HTTP is development-only")
	}
	target := strings.TrimSpace(rawURL)
	parsed, err := url.Parse(target)
	if err != nil || !parsed.IsAbs() || parsed.Opaque != "" || parsed.Host == "" {
		return errors.New("PYTHON_SERVICE_URL must be an absolute URL")
	}
	if parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return errors.New("PYTHON_SERVICE_URL must not contain credentials, path, query, or fragment")
	}
	if strings.HasSuffix(parsed.Host, ":") {
		return errors.New("PYTHON_SERVICE_URL contains an invalid port")
	}
	if port := parsed.Port(); port != "" {
		portNumber, parseErr := strconv.Atoi(port)
		if parseErr != nil || portNumber < 1 || portNumber > 65535 {
			return errors.New("PYTHON_SERVICE_URL contains an invalid port")
		}
	}

	scheme := strings.ToLower(parsed.Scheme)
	hostname := strings.ToLower(parsed.Hostname())
	if scheme == "https" && hostname != "" {
		return nil
	}
	if devMode && allowInsecureHTTP && scheme == "http" && hostname != "" {
		return nil
	}
	return errors.New("PYTHON_SERVICE_URL must use HTTPS unless DEV_MODE=true and PYTHON_ALLOW_INSECURE_HTTP=true")
}

func newUpstreamHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func validateAllowedOrigins(origins []string, devMode bool) error {
	seen := make(map[string]struct{}, len(origins))
	validCount := 0
	for _, configured := range origins {
		origin := strings.TrimSpace(configured)
		if origin == "" {
			continue
		}
		if strings.Contains(origin, "*") {
			return errors.New("CORS_ORIGINS must not contain wildcards")
		}
		parsed, err := url.Parse(origin)
		if err != nil || !parsed.IsAbs() || parsed.Opaque != "" || parsed.Host == "" {
			return fmt.Errorf("CORS origin %q must be an absolute origin", origin)
		}
		if parsed.User != nil || parsed.Path != "" || parsed.RawPath != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
			return fmt.Errorf("CORS origin %q must not contain credentials, path, query, or fragment", origin)
		}
		scheme := strings.ToLower(parsed.Scheme)
		hostname := strings.ToLower(parsed.Hostname())
		if hostname == "" {
			return fmt.Errorf("CORS origin %q must contain a hostname", origin)
		}
		if strings.HasSuffix(parsed.Host, ":") {
			return fmt.Errorf("CORS origin %q contains an invalid port", origin)
		}
		if scheme != "https" {
			loopbackHTTP := devMode && scheme == "http" && (hostname == "localhost" || hostname == "127.0.0.1")
			if !loopbackHTTP {
				return fmt.Errorf("CORS origin %q must use HTTPS; development HTTP is limited to localhost or 127.0.0.1", origin)
			}
		}
		port := parsed.Port()
		if port != "" {
			portNumber, err := strconv.Atoi(port)
			if err != nil || portNumber < 1 || portNumber > 65535 {
				return fmt.Errorf("CORS origin %q contains an invalid port", origin)
			}
		}
		if (port == "443" && scheme == "https") || (port == "80" && scheme == "http") {
			port = ""
		}
		canonicalHost := hostname
		if strings.Contains(canonicalHost, ":") {
			canonicalHost = "[" + canonicalHost + "]"
		}
		canonical := scheme + "://" + canonicalHost
		if port != "" {
			canonical += ":" + port
		}
		// The runtime allowlist performs an exact comparison against the
		// browser's serialized Origin value. Requiring canonical configuration
		// prevents an accepted value such as an upper-case host or an explicit
		// default port from becoming an allowlist entry that can never match.
		if origin != canonical {
			return fmt.Errorf("CORS origin %q must use canonical form %q", origin, canonical)
		}
		if _, duplicate := seen[canonical]; duplicate {
			return fmt.Errorf("CORS origin %q is duplicated", origin)
		}
		seen[canonical] = struct{}{}
		validCount++
	}
	if !devMode && validCount == 0 {
		return errors.New("production requires at least one HTTPS CORS origin")
	}
	return nil
}

func oidcConfigured(config Config) bool {
	return strings.TrimSpace(config.OIDCIssuerURL) != "" && strings.TrimSpace(config.OIDCClientID) != "" && strings.TrimSpace(config.OIDCRedirectURL) != "" && strings.TrimSpace(config.OIDCWebReturnURL) != ""
}

func (service *server) routes() {
	service.registerAPI("/api/v1")
	if service.config.DevMode {
		service.registerAPI("/api")
	}
	service.mux.HandleFunc("POST /api/v1/internal/jobs/claim", service.handleClaimJob)
	service.mux.HandleFunc("POST /api/v1/internal/jobs/{id}/execute", service.handleExecuteJob)
	service.mux.HandleFunc("POST /api/v1/internal/jobs/{id}/heartbeat", service.handleHeartbeatJob)
}

func (service *server) registerAPI(prefix string) {
	handle := func(method, path string, handler http.HandlerFunc) {
		service.mux.HandleFunc(method+" "+prefix+path, handler)
	}
	handle(http.MethodGet, "/health", service.handleHealth)
	handle(http.MethodGet, "/live", service.handleLive)
	handle(http.MethodGet, "/ready", service.handleReady)
	handle(http.MethodPost, "/auth/login", service.handleLogin)
	handle(http.MethodGet, "/auth/oidc/start", service.handleOIDCStart)
	handle(http.MethodGet, "/auth/oidc/callback", service.handleOIDCCallback)
	handle(http.MethodPost, "/auth/logout", service.handleLogout)
	handle(http.MethodGet, "/auth/me", service.handleCurrentUser)
	handle(http.MethodGet, "/workbenches", service.handleWorkbenches)
	handle(http.MethodGet, "/workbenches/{slug}", service.handleWorkbench)
	handle(http.MethodGet, "/workbenches/{slug}/state", service.handleWorkbenchState)
	handle(http.MethodPut, "/workbenches/{slug}/state", service.handleSaveWorkbenchState)
	handle(http.MethodGet, "/workbenches/{slug}/projects", service.handleProjects)
	handle(http.MethodPost, "/workbenches/{slug}/projects", service.handleCreateProject)
	handle(http.MethodGet, "/projects/{id}", service.handleProject)
	handle(http.MethodPut, "/projects/{id}", service.handleUpdateProject)
	handle(http.MethodDelete, "/projects/{id}", service.handleDeleteProject)
	handle(http.MethodGet, "/projects/{id}/versions", service.handleVersions)
	handle(http.MethodPost, "/projects/{id}/versions", service.handleCreateVersion)
	handle(http.MethodGet, "/projects/{id}/runs", service.handleRuns)
	handle(http.MethodPost, "/projects/{id}/runs", service.handleRejectClientRun)
	handle(http.MethodGet, "/projects/{id}/jobs", service.handleJobs)
	handle(http.MethodPost, "/projects/{id}/jobs", service.handleCreateJob)
	handle(http.MethodGet, "/jobs/{id}", service.handleJob)
	handle(http.MethodPost, "/jobs/{id}/cancel", service.handleCancelJob)
	handle(http.MethodGet, "/collaboration/{kind}", service.handleSharedRecords)
	handle(http.MethodPost, "/collaboration/{kind}", service.handleCreateSharedRecord)
	handle(http.MethodGet, "/collaboration/{kind}/{id}", service.handleSharedRecord)
	handle(http.MethodPut, "/collaboration/{kind}/{id}", service.handleUpdateSharedRecord)
	handle(http.MethodDelete, "/collaboration/{kind}/{id}", service.handleDeleteSharedRecord)
	handle(http.MethodPost, "/collaboration/discussions/{id}/replies", service.handleCreateDiscussionReply)
	handle(http.MethodGet, "/tools/catalog", service.handleToolCatalog)
	handle(http.MethodPost, "/tools/{slug}/run", service.handleRejectDirectToolRun)
	handle(http.MethodPost, "/analysis/text", service.handleRejectDirectToolRun)
	handle(http.MethodGet, "/audit/events", service.handleAuditEvents)
}

func (service *server) handleHealth(response http.ResponseWriter, request *http.Request) {
	service.handleReady(response, request)
}

func (service *server) handleLive(response http.ResponseWriter, request *http.Request) {
	writeData(response, request, http.StatusOK, map[string]string{"service": "go-api", "status": "live", "apiVersion": "v1"})
}

func (service *server) handleReady(response http.ResponseWriter, request *http.Request) {
	checks := map[string]any{}
	ready := true
	if err := service.projects.Ping(); err != nil {
		ready = false
		checks["database"] = map[string]any{"ok": false}
	} else {
		checks["database"] = map[string]any{"ok": true, "adapter": service.projects.Adapter()}
	}
	serviceAuthOK := len(service.config.ServiceHMACSecret) >= 32 && service.workers.Ready()
	checks["serviceAuthentication"] = map[string]any{
		"ok": serviceAuthOK, "mode": "hmac-sha256-and-bound-worker-bearer",
	}
	if !serviceAuthOK {
		ready = false
	}
	identityProviderOK := false
	identityProviderMode := "unconfigured"
	if service.oidc != nil {
		identityProviderMode = "oidc"
		identityContext, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		identityProviderOK = service.oidc.Ready(identityContext) == nil
	} else if service.config.DevMode && (service.config.DemoAccount != "" || service.config.StudentAccount != "") {
		identityProviderMode = "development-local"
		identityProviderOK = true
	}
	checks["identityProvider"] = map[string]any{"ok": identityProviderOK, "mode": identityProviderMode}
	if !identityProviderOK {
		ready = false
	}
	authorizationOK := false
	authorizationMode := "unconfigured"
	if service.authorizer != nil {
		authorizationMode = service.authorizer.Mode()
		authorizationContext, cancel := context.WithTimeout(request.Context(), service.config.OpenFGATimeout)
		defer cancel()
		authorizationOK = service.authorizer.Ready(authorizationContext) == nil
	}
	checks["authorization"] = map[string]any{
		"ok": authorizationOK, "mode": authorizationMode,
		"productionReady": authorizationOK && authorizationMode == "openfga",
	}
	if !authorizationOK {
		ready = false
	}
	pythonOK := false
	if serviceAuthOK {
		readinessContext, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		readinessRequest := request.WithContext(readinessContext)
		_, status, _, err := service.pythonRequest(readinessRequest, http.MethodGet, "/ready", nil, "readiness", service.config.DevTenantID, "readiness")
		pythonOK = err == nil && status >= 200 && status < 300
	}
	checks["pythonCompute"] = map[string]any{"ok": pythonOK}
	if !pythonOK {
		ready = false
	}
	status := http.StatusOK
	statusText := "ready"
	if !ready {
		status = http.StatusServiceUnavailable
		statusText = "not-ready"
	}
	writeData(response, request, status, map[string]any{"service": "go-api", "status": statusText, "apiVersion": "v1", "checks": checks})
}

func (service *server) handleWorkbenches(response http.ResponseWriter, request *http.Request) {
	page := 1
	if raw := request.URL.Query().Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			writeCodedError(response, request, http.StatusBadRequest, "INVALID_PAGE", "page 必须是大于 0 的整数")
			return
		}
		page = parsed
	}
	writeData(response, request, http.StatusOK, service.catalog.List(page, 9))
}

func (service *server) handleWorkbench(response http.ResponseWriter, request *http.Request) {
	item, ok := service.catalog.Get(request.PathValue("slug"))
	if !ok {
		writeCodedError(response, request, http.StatusNotFound, "WORKBENCH_NOT_FOUND", "工作台不存在")
		return
	}
	writeData(response, request, http.StatusOK, item)
}

func (service *server) handleToolCatalog(response http.ResponseWriter, request *http.Request) {
	body, status, _, err := service.pythonRequest(request, http.MethodGet, "/tools/catalog", nil, "public", "public", "")
	if err != nil {
		writeCodedError(response, request, http.StatusBadGateway, "COMPUTE_SERVICE_UNAVAILABLE", "Python 计算服务暂不可用")
		return
	}
	if status < 200 || status >= 300 {
		writeCodedError(response, request, http.StatusBadGateway, "COMPUTE_CATALOG_UNAVAILABLE", "无法读取计算能力目录")
		return
	}
	var upstream struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &upstream); err != nil {
		writeCodedError(response, request, http.StatusBadGateway, "COMPUTE_CATALOG_INVALID", "计算能力目录格式无效")
		return
	}
	result := make([]map[string]any, 0, len(upstream.Data))
	for _, item := range upstream.Data {
		slug, _ := item["slug"].(string)
		capability, exists := service.catalog.Get(slug)
		if !exists {
			continue
		}
		delete(item, "available")
		delete(item, "maturity")
		item["status"] = capability.Status
		item["executionAllowed"] = capability.ExecutionAllowed
		item["productionReady"] = false
		result = append(result, item)
	}
	writeData(response, request, http.StatusOK, result)
}

func (service *server) handleRejectDirectToolRun(response http.ResponseWriter, request *http.Request) {
	_ = service.audit(request, "job.direct_execute", "workbench", request.PathValue("slug"), "denied", "", "", map[string]any{"reason": "job_api_required"})
	writeCodedError(response, request, http.StatusConflict, "JOB_API_REQUIRED", "计算必须通过项目作业接口创建，客户端不能直接执行并上报结果")
}

func (service *server) authentication(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodOptions || isPublicRequest(request) || strings.HasPrefix(request.URL.Path, "/api/v1/internal/jobs/") {
			next.ServeHTTP(response, request)
			return
		}
		cookie, err := request.Cookie(sessionCookie)
		if err != nil || strings.TrimSpace(cookie.Value) == "" {
			writeCodedError(response, request, http.StatusUnauthorized, "AUTH_REQUIRED", "请先登录")
			return
		}
		identity, ok, err := service.projects.GetSession(request.Context(), hashToken(cookie.Value))
		if err != nil {
			writeCodedError(response, request, http.StatusInternalServerError, "SESSION_LOOKUP_FAILED", "无法验证登录会话")
			return
		}
		if !ok {
			writeCodedError(response, request, http.StatusUnauthorized, "SESSION_INVALID", "登录会话已失效")
			return
		}
		ctx := context.WithValue(request.Context(), identityKey, identity)
		next.ServeHTTP(response, request.WithContext(ctx))
	})
}

func isPublicRequest(request *http.Request) bool {
	path := strings.TrimSuffix(request.URL.Path, "/")
	if request.Method == http.MethodGet && (path == "/api/health" || path == "/api/v1/health" || path == "/api/live" || path == "/api/v1/live" || path == "/api/ready" || path == "/api/v1/ready" || path == "/api/tools/catalog" || path == "/api/v1/tools/catalog" || path == "/api/auth/oidc/start" || path == "/api/v1/auth/oidc/start" || path == "/api/auth/oidc/callback" || path == "/api/v1/auth/oidc/callback") {
		return true
	}
	return request.Method == http.MethodPost && (path == "/api/auth/login" || path == "/api/v1/auth/login")
}

func identityFrom(request *http.Request) store.Identity {
	identity, _ := request.Context().Value(identityKey).(store.Identity)
	return identity
}

func scopeFrom(request *http.Request) store.Scope {
	return identityFrom(request).Scope()
}

func (service *server) pythonRequest(request *http.Request, method, path string, body []byte, actor, tenant, job string) ([]byte, int, string, error) {
	if service.config.ServiceHMACSecret == "" {
		return nil, 0, "", errors.New("service HMAC is not configured")
	}
	target := strings.TrimRight(service.config.PythonServiceURL, "/") + path
	upstreamRequest, err := http.NewRequestWithContext(request.Context(), method, target, strings.NewReader(string(body)))
	if err != nil {
		return nil, 0, "", err
	}
	if len(body) > 0 {
		upstreamRequest.Header.Set("Content-Type", "application/json")
	}
	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	nonce, err := randomToken()
	if err != nil {
		return nil, 0, "", err
	}
	upstreamRequest.Header.Set("X-Skyview-Service", service.config.PythonServiceID)
	upstreamRequest.Header.Set("X-Skyview-Timestamp", timestamp)
	upstreamRequest.Header.Set("X-Skyview-Nonce", nonce)
	upstreamRequest.Header.Set("X-Skyview-Actor", actor)
	upstreamRequest.Header.Set("X-Skyview-Tenant", tenant)
	upstreamRequest.Header.Set("X-Skyview-Job", job)
	upstreamRequest.Header.Set("X-Skyview-Signature", signServiceRequest(service.config.ServiceHMACSecret, method, path, timestamp, nonce, service.config.PythonServiceID, actor, tenant, job, body))
	upstreamRequest.Header.Set("X-Request-ID", requestID(request))

	upstreamResponse, err := service.httpClient.Do(upstreamRequest)
	if err != nil {
		return nil, 0, "", err
	}
	defer upstreamResponse.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(upstreamResponse.Body, maxPythonResponse+1))
	if err != nil {
		return nil, 0, "", err
	}
	if len(responseBody) > maxPythonResponse {
		return nil, 0, "", errors.New("compute response exceeds limit")
	}
	contentType := upstreamResponse.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json; charset=utf-8"
	}
	return responseBody, upstreamResponse.StatusCode, contentType, nil
}

func signServiceRequest(secret, method, path, timestamp, nonce, serviceID, actor, tenant, job string, body []byte) string {
	bodyDigest := sha256.Sum256(body)
	canonical := strings.Join([]string{
		"skyview-hmac-v1", strings.ToUpper(method), path, timestamp, nonce, serviceID,
		actor, tenant, job, hex.EncodeToString(bodyDigest[:]),
	}, "\n")
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func (service *server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		id := strings.TrimSpace(request.Header.Get("X-Request-ID"))
		if id == "" || len(id) > 128 {
			id, _ = randomToken()
		}
		response.Header().Set("X-Request-ID", id)
		next.ServeHTTP(response, request.WithContext(context.WithValue(request.Context(), requestIDKey, id)))
	})
}

func (service *server) cors(next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(service.config.AllowedOrigins))
	for _, origin := range service.config.AllowedOrigins {
		if normalized := strings.TrimSpace(origin); normalized != "" {
			allowed[normalized] = struct{}{}
		}
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		originValues := request.Header.Values("Origin")
		hasOrigin := len(originValues) > 0
		origin := ""
		originAllowed := false
		if len(originValues) == 1 {
			origin = originValues[0]
			_, originAllowed = allowed[origin]
		}

		// Browsers attach Origin to unsafe requests and preflights. Reject an
		// unrecognized, empty, or duplicated Origin for those requests before
		// CORS response headers are emitted. A safe request with an unknown
		// Origin is processed without CORS response headers, so the browser
		// cannot expose its response and safe endpoints do not gain an
		// undocumented blanket 403 response.
		if hasOrigin && !originAllowed && (isUnsafeMethod(request.Method) || request.Method == http.MethodOptions) {
			writeCodedError(response, request, http.StatusForbidden, "ORIGIN_NOT_ALLOWED", "请求来源不受信任")
			return
		}
		if originAllowed {
			response.Header().Set("Access-Control-Allow-Origin", origin)
			response.Header().Set("Access-Control-Allow-Credentials", "true")
			response.Header().Add("Vary", "Origin")
		}
		if request.Method == http.MethodOptions {
			if originAllowed {
				response.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID, Idempotency-Key")
				response.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
			}
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if isUnsafeMethod(request.Method) {
			if _, err := request.Cookie(sessionCookie); err == nil && !hasOrigin {
				writeCodedError(response, request, http.StatusForbidden, "ORIGIN_REQUIRED", "会话请求缺少来源信息")
				return
			}
		}
		next.ServeHTTP(response, request)
	})
}

func isUnsafeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func (service *server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(response, request)
	})
}

func decodeJSON(response http.ResponseWriter, request *http.Request, destination any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxJSONBody))
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return fmt.Errorf("请求内容不是有效 JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("请求只能包含一个 JSON 对象")
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || trimmed[0] != '{' {
		return errors.New("请求内容必须是 JSON 对象")
	}
	payloadDecoder := json.NewDecoder(bytes.NewReader(trimmed))
	payloadDecoder.DisallowUnknownFields()
	if err := payloadDecoder.Decode(destination); err != nil {
		return fmt.Errorf("请求内容不是有效 JSON: %w", err)
	}
	return nil
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func hashToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func requestID(request *http.Request) string {
	id, _ := request.Context().Value(requestIDKey).(string)
	return id
}

func sourceIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err == nil {
		return host
	}
	return request.RemoteAddr
}

func hashValue(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	encoded, _ := json.Marshal(value)
	var clone map[string]any
	if err := json.Unmarshal(encoded, &clone); err != nil {
		return map[string]any{}
	}
	return clone
}

func secureEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (service *server) audit(request *http.Request, action, resourceType, resourceID, outcome, beforeHash, afterHash string, metadata map[string]any) error {
	_, err := service.projects.AppendAuditContext(request.Context(), service.auditEvent(request, action, resourceType, resourceID, outcome, beforeHash, afterHash, metadata))
	return err
}

func truncateText(value string, limit int) string {
	characters := []rune(value)
	if len(characters) <= limit {
		return value
	}
	return string(characters[:limit])
}

func (service *server) requireWorker(response http.ResponseWriter, request *http.Request) (workerauth.Identity, bool) {
	if !service.workers.Ready() {
		writeCodedError(response, request, http.StatusServiceUnavailable, "WORKER_AUTH_NOT_CONFIGURED", "Worker 身份尚未配置")
		return workerauth.Identity{}, false
	}
	identity, ok := service.workers.AuthenticateAuthorization(request.Header.Values("Authorization"))
	if !ok {
		writeCodedError(response, request, http.StatusUnauthorized, "WORKER_AUTH_INVALID", "Worker 身份无效")
		return workerauth.Identity{}, false
	}
	return identity, true
}

func writeData(response http.ResponseWriter, request *http.Request, status int, data any) {
	writeJSON(response, status, map[string]any{"data": data, "requestId": requestID(request)})
}

func writeError(response http.ResponseWriter, request *http.Request, status int, message string) {
	writeCodedError(response, request, status, defaultErrorCode(status), message)
}

func writeCodedError(response http.ResponseWriter, request *http.Request, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"error":   map[string]string{"code": code, "message": message},
		"message": message, "requestId": requestID(request),
	})
}

func defaultErrorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "INVALID_ARGUMENT"
	case http.StatusUnauthorized:
		return "AUTH_REQUIRED"
	case http.StatusForbidden:
		return "ACCESS_DENIED"
	case http.StatusNotFound:
		return "RESOURCE_NOT_FOUND"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusBadGateway:
		return "UPSTREAM_UNAVAILABLE"
	default:
		return "INTERNAL_ERROR"
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func userModel(identity store.Identity) model.User {
	return model.User{
		ID: identity.UserID, TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		DisplayName: identity.DisplayName, Email: identity.Email, Role: identity.Role,
	}
}
