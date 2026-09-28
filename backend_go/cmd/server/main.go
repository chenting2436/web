package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"skyviewlab/backend_go/internal/api"
	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/store"
)

func main() {
	err := runProcess(context.Background(), os.Getenv, processDependencies{
		migrate: store.RunPostgreSQLMigrations,
		serve:   runHTTPServer,
	})
	if err != nil {
		log.Fatalf("SkyViewLab Go process failed: %v", err)
	}
}

type processDependencies struct {
	migrate func(context.Context, store.StoreConfig) error
	serve   func() error
}

// runProcess selects the migration-only path before any HTTP, worker, OIDC,
// OpenFGA, or Python configuration is read. This keeps the release migrator
// identity out of the long-running service process by construction.
func runProcess(ctx context.Context, getenv func(string) string, dependencies processDependencies) error {
	devMode := boolValue(getenv("DEV_MODE"), false)
	databaseMigrate := boolValue(getenv("DATABASE_MIGRATE"), false)
	if databaseMigrate && !devMode {
		if dependencies.migrate == nil {
			return errors.New("production migration runner is unavailable")
		}
		config, err := productionMigrationStoreConfig(getenv)
		if err != nil {
			return err
		}
		if err := dependencies.migrate(ctx, config); err != nil {
			return fmt.Errorf("production migration-only process failed: %w", err)
		}
		log.Print("SkyViewLab PostgreSQL migrations completed; migration-only process exiting")
		return nil
	}
	if dependencies.serve == nil {
		return errors.New("HTTP server runner is unavailable")
	}
	return dependencies.serve()
}

func productionMigrationStoreConfig(getenv func(string) string) (store.StoreConfig, error) {
	adapter := strings.ToLower(strings.TrimSpace(getenv("DATABASE_ADAPTER")))
	if adapter != "postgres" && adapter != store.AdapterPostgreSQL {
		return store.StoreConfig{}, errors.New("production migration-only process requires DATABASE_ADAPTER=postgresql")
	}
	if strings.TrimSpace(getenv("DATABASE_FILE")) != "" {
		return store.StoreConfig{}, errors.New("DATABASE_FILE is forbidden for production migrations")
	}
	dsn := strings.TrimSpace(getenv("DATABASE_URL"))
	if dsn == "" {
		return store.StoreConfig{}, errors.New("production migration-only process requires DATABASE_URL")
	}
	return store.StoreConfig{
		Adapter: adapter, PostgresDSN: dsn, ApplyMigrations: true, RequireTLS: true,
	}, nil
}

func runHTTPServer() error {
	address := env("GO_API_ADDRESS", "127.0.0.1:8080")
	devMode := boolEnv("DEV_MODE", false)
	demoAccount, demoPassword, studentAccount, studentPassword := "", "", "", ""
	if devMode {
		demoAccount = strings.TrimSpace(os.Getenv("DEMO_ACCOUNT"))
		demoPassword = strings.TrimSpace(os.Getenv("DEMO_PASSWORD"))
		studentAccount = strings.TrimSpace(os.Getenv("STUDENT_ACCOUNT"))
		studentPassword = strings.TrimSpace(os.Getenv("STUDENT_PASSWORD"))
	}
	databaseAdapter := strings.ToLower(strings.TrimSpace(os.Getenv("DATABASE_ADAPTER")))
	if databaseAdapter == "" && devMode {
		databaseAdapter = "sqlite-development"
	}
	databaseFile := strings.TrimSpace(os.Getenv("DATABASE_FILE"))
	if databaseFile == "" && (databaseAdapter == "sqlite" || databaseAdapter == "sqlite-development") {
		databaseFile = env("DATABASE_FILE", "./data/skyviewlab.db")
	}
	devTenantID := env("DEV_TENANT_ID", "tenant-dev")
	devWorkspaceID := env("DEV_WORKSPACE_ID", "workspace-dev")
	workerCredentials, workerCredentialsSource, err := workerCredentialsFromEnvironment(devMode)
	if err != nil {
		return fmt.Errorf("invalid worker authentication configuration: %w", err)
	}
	developmentWorkerScopes, err := developmentWorkerScopesFromEnvironment(devMode, workerCredentialsSource, devTenantID, devWorkspaceID)
	if err != nil {
		return fmt.Errorf("invalid development worker scope configuration: %w", err)
	}
	pythonRequestTimeout := durationEnv("PYTHON_REQUEST_TIMEOUT", 30*time.Second)
	jobTerminalPersistTimeout := durationEnv("JOB_TERMINAL_PERSIST_TIMEOUT", 30*time.Second)
	handler, err := api.NewHandlerChecked(api.Config{
		AllowedOrigins:              strings.Split(env("CORS_ORIGINS", "http://localhost:4182,http://127.0.0.1:4182"), ","),
		DevMode:                     devMode,
		DevTenantID:                 devTenantID,
		DevWorkspaceID:              devWorkspaceID,
		DemoAccount:                 demoAccount,
		DemoPassword:                demoPassword,
		StudentAccount:              studentAccount,
		StudentPassword:             studentPassword,
		CookieSecure:                boolEnv("COOKIE_SECURE", !devMode),
		PythonServiceURL:            env("PYTHON_SERVICE_URL", "http://127.0.0.1:8000"),
		PythonAllowInsecureHTTP:     boolEnv("PYTHON_ALLOW_INSECURE_HTTP", false),
		PythonRequestTimeout:        pythonRequestTimeout,
		JobTerminalPersistTimeout:   jobTerminalPersistTimeout,
		PythonServiceID:             env("PYTHON_SERVICE_ID", "go-control-plane"),
		ServiceHMACSecret:           os.Getenv("SERVICE_HMAC_SECRET"),
		WorkerCredentials:           workerCredentials,
		WorkerCredentialsSource:     workerCredentialsSource,
		DevelopmentWorkerScopes:     developmentWorkerScopes,
		SessionTTL:                  12 * time.Hour,
		DatabaseAdapter:             databaseAdapter,
		DatabaseFile:                databaseFile,
		DatabaseDSN:                 strings.TrimSpace(os.Getenv("DATABASE_URL")),
		DatabaseMigrate:             boolEnv("DATABASE_MIGRATE", false),
		OIDCIssuerURL:               strings.TrimSpace(os.Getenv("OIDC_ISSUER_URL")),
		OIDCClientID:                strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID")),
		OIDCClientSecret:            os.Getenv("OIDC_CLIENT_SECRET"),
		OIDCRedirectURL:             strings.TrimSpace(os.Getenv("OIDC_REDIRECT_URL")),
		OIDCWebReturnURL:            strings.TrimSpace(os.Getenv("OIDC_WEB_RETURN_URL")),
		OIDCTenantClaim:             strings.TrimSpace(os.Getenv("OIDC_TENANT_CLAIM")),
		OIDCWorkspaceClaim:          strings.TrimSpace(os.Getenv("OIDC_WORKSPACE_CLAIM")),
		OIDCAllowInsecureHTTP:       boolEnv("OIDC_ALLOW_INSECURE_HTTP", false),
		OIDCMaxTokenLifetime:        durationEnv("OIDC_MAX_TOKEN_LIFETIME", time.Hour),
		OIDCTransactionKey:          base64SecretEnv("OIDC_TRANSACTION_KEY"),
		OpenFGAAPIURL:               strings.TrimSpace(os.Getenv("OPENFGA_API_URL")),
		OpenFGAStoreID:              strings.TrimSpace(os.Getenv("OPENFGA_STORE_ID")),
		OpenFGAAuthorizationModelID: strings.TrimSpace(os.Getenv("OPENFGA_AUTHORIZATION_MODEL_ID")),
		OpenFGAAPIToken:             os.Getenv("OPENFGA_API_TOKEN"),
		OpenFGAExpectedModelSHA256:  strings.TrimSpace(os.Getenv("OPENFGA_MODEL_SHA256")),
		OpenFGATimeout:              durationEnv("OPENFGA_TIMEOUT", 2*time.Second),
		OpenFGAAllowInsecureHTTP:    boolEnv("OPENFGA_ALLOW_INSECURE_HTTP", false),
		DevAuthorizationFallback:    boolEnv("DEV_AUTHORIZATION_FALLBACK", false),
	})
	for index := range workerCredentials {
		workerCredentials[index] = workerauth.Credential{}
	}
	workerCredentials = nil
	if err != nil {
		return fmt.Errorf("invalid server configuration: %w", err)
	}
	if closer, ok := handler.(interface{ Close() error }); ok {
		defer func() { _ = closer.Close() }()
	}

	server := &http.Server{
		Addr: address, Handler: handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// The synchronous execution bridge is transitional until Temporal is
		// integrated. Its server write budget must exceed the bounded Python
		// request budget so a committed terminal state is not hidden by a
		// competing response deadline.
		WriteTimeout:   pythonRequestTimeout + jobTerminalPersistTimeout + 15*time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 64 << 10,
	}

	go func() {
		log.Printf("SkyViewLab Go API listening on http://%s", address)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	return nil
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string, fallback bool) bool {
	return boolValue(os.Getenv(key), fallback)
}

func boolValue(value string, fallback bool) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return strings.EqualFold(value, "true") || value == "1"
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		log.Fatalf("%s must be a positive duration", key)
	}
	return parsed
}

func base64SecretEnv(key string) []byte {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil {
		log.Fatalf("%s must be standard padded base64", key)
	}
	return decoded
}

func workerCredentialsFromEnvironment(devMode bool) ([]workerauth.Credential, string, error) {
	credentialsFile := strings.TrimSpace(os.Getenv("WORKER_CREDENTIALS_FILE"))
	workerID := os.Getenv("WORKER_ID")
	workerToken := os.Getenv("WORKER_TOKEN")
	if credentialsFile != "" {
		if workerID != "" || workerToken != "" {
			return nil, "", errors.New("WORKER_CREDENTIALS_FILE cannot be combined with WORKER_ID or WORKER_TOKEN")
		}
		credentials, err := workerauth.LoadFile(credentialsFile)
		if err != nil {
			return nil, "", err
		}
		return credentials, workerauth.SourceFile, nil
	}
	if !devMode {
		if workerID != "" || workerToken != "" {
			return nil, "", errors.New("inline WORKER_ID/WORKER_TOKEN credentials are forbidden outside development")
		}
		return nil, "", errors.New("production requires WORKER_CREDENTIALS_FILE")
	}
	if (workerID == "") != (workerToken == "") {
		return nil, "", errors.New("development WORKER_ID and WORKER_TOKEN must be configured together")
	}
	if workerID == "" {
		return nil, "", nil
	}
	credentials := []workerauth.Credential{{ID: workerID, Token: workerToken}}
	if err := workerauth.ValidateCredentialSecret(workerID, workerToken); err != nil {
		return nil, "", err
	}
	return credentials, workerauth.SourceDevelopmentInline, nil
}

func developmentWorkerScopesFromEnvironment(devMode bool, source, tenantID, workspaceID string) ([]workerauth.Scope, error) {
	rawCapabilities := os.Getenv("WORKER_CAPABILITIES_JSON")
	if source != workerauth.SourceDevelopmentInline {
		if strings.TrimSpace(rawCapabilities) != "" {
			return nil, errors.New("WORKER_CAPABILITIES_JSON requires development inline worker credentials")
		}
		return nil, nil
	}
	if !devMode {
		return nil, errors.New("development worker scopes are forbidden outside development")
	}
	if rawCapabilities == "" || rawCapabilities != strings.TrimSpace(rawCapabilities) || len(rawCapabilities) > 32<<10 {
		return nil, errors.New("WORKER_CAPABILITIES_JSON must be a non-empty bounded JSON array")
	}
	var capabilities []struct {
		Slug    string   `json:"slug"`
		Actions []string `json:"actions"`
	}
	decoder := json.NewDecoder(bytes.NewBufferString(rawCapabilities))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&capabilities); err != nil {
		return nil, fmt.Errorf("decode WORKER_CAPABILITIES_JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("WORKER_CAPABILITIES_JSON contains trailing JSON")
	}
	if len(capabilities) == 0 || len(capabilities) > workerauth.MaxScopesPerWorker {
		return nil, fmt.Errorf("WORKER_CAPABILITIES_JSON must contain 1 to %d entries", workerauth.MaxScopesPerWorker)
	}
	allowedCatalogSlugs := store.NewMemoryStore().ExecutableSlugs()
	catalog := make(map[string]struct{}, len(allowedCatalogSlugs))
	for _, slug := range allowedCatalogSlugs {
		catalog[slug] = struct{}{}
	}
	scopes := make([]workerauth.Scope, len(capabilities))
	for index, capability := range capabilities {
		if _, ok := catalog[capability.Slug]; !ok {
			return nil, fmt.Errorf("WORKER_CAPABILITIES_JSON contains non-executable catalog slug %q", capability.Slug)
		}
		scopes[index] = workerauth.Scope{
			TenantID: tenantID, WorkspaceID: workspaceID, Slug: capability.Slug,
			Actions: append([]string(nil), capability.Actions...),
		}
	}
	if _, err := workerauth.New([]workerauth.Credential{{
		ID: "development-scope-validator", Token: strings.Repeat("v", workerauth.MinTokenBytes), Scopes: scopes,
	}}); err != nil {
		return nil, fmt.Errorf("invalid WORKER_CAPABILITIES_JSON: %w", err)
	}
	return scopes, nil
}
