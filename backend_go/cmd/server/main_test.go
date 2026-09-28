package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/store"
)

func TestProductionMigrationModeRunsOnceWithoutStartingHTTP(t *testing.T) {
	values := map[string]string{
		"DEV_MODE":         "false",
		"DATABASE_MIGRATE": "true",
		"DATABASE_ADAPTER": "postgresql",
		"DATABASE_URL":     "postgres://migrator@database.internal/skyviewlab?sslmode=verify-full",
	}
	readKeys := map[string]bool{}
	getenv := func(key string) string {
		readKeys[key] = true
		return values[key]
	}
	migrationCalls, serverCalls := 0, 0
	err := runProcess(context.Background(), getenv, processDependencies{
		migrate: func(_ context.Context, config store.StoreConfig) error {
			migrationCalls++
			if config.Adapter != store.AdapterPostgreSQL || !config.ApplyMigrations || !config.RequireTLS || config.PostgresDSN != values["DATABASE_URL"] {
				t.Fatalf("unexpected migration config: %+v", config)
			}
			return nil
		},
		serve: func() error {
			serverCalls++
			return errors.New("HTTP must not start")
		},
	})
	if err != nil || migrationCalls != 1 || serverCalls != 0 {
		t.Fatalf("migration-only result err=%v migrations=%d servers=%d", err, migrationCalls, serverCalls)
	}
	for _, forbidden := range []string{"WORKER_CREDENTIALS_FILE", "WORKER_ID", "WORKER_TOKEN", "OIDC_ISSUER_URL", "OIDC_CLIENT_SECRET", "OPENFGA_API_TOKEN", "SERVICE_HMAC_SECRET", "GO_API_ADDRESS"} {
		if readKeys[forbidden] {
			t.Fatalf("migration-only startup read unrelated service setting %s", forbidden)
		}
	}
}

func TestDevelopmentInlineWorkerScopesAreExactAndCatalogBound(t *testing.T) {
	t.Setenv("WORKER_CAPABILITIES_JSON", `[{"slug":"paper-writing","actions":["audit","outline"]},{"slug":"research-radar","actions":["search"]}]`)
	scopes, err := developmentWorkerScopesFromEnvironment(true, workerauth.SourceDevelopmentInline, "tenant-dev", "workspace-dev")
	if err != nil || len(scopes) != 2 {
		t.Fatalf("development scopes=%+v err=%v", scopes, err)
	}
	wantActionCounts := map[string]int{"paper-writing": 2, "research-radar": 1}
	for _, scope := range scopes {
		if scope.TenantID != "tenant-dev" || scope.WorkspaceID != "workspace-dev" || len(scope.Actions) != wantActionCounts[scope.Slug] {
			t.Fatalf("scope was not exactly bound: %+v", scope)
		}
	}

	for _, testCase := range []struct {
		name string
		raw  string
	}{
		{name: "missing", raw: ""},
		{name: "missing actions", raw: `[{"slug":"paper-writing","actions":[]}]`},
		{name: "wildcard action", raw: `[{"slug":"paper-writing","actions":["*"]}]`},
		{name: "duplicate action", raw: `[{"slug":"paper-writing","actions":["audit","audit"]}]`},
		{name: "unknown catalog slug", raw: `[{"slug":"not-in-catalog","actions":["audit"]}]`},
		{name: "unknown field", raw: `[{"slug":"paper-writing","actions":["audit"],"tenantId":"forged"}]`},
		{name: "duplicate slug scope", raw: `[{"slug":"paper-writing","actions":["audit"]},{"slug":"paper-writing","actions":["outline"]}]`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("WORKER_CAPABILITIES_JSON", testCase.raw)
			if _, err := developmentWorkerScopesFromEnvironment(true, workerauth.SourceDevelopmentInline, "tenant-dev", "workspace-dev"); err == nil {
				t.Fatal("unsafe development worker scope was accepted")
			}
		})
	}

	t.Setenv("WORKER_CAPABILITIES_JSON", `[{"slug":"paper-writing","actions":["audit"]}]`)
	if _, err := developmentWorkerScopesFromEnvironment(false, workerauth.SourceFile, "tenant", "workspace"); err == nil || !strings.Contains(err.Error(), "development inline") {
		t.Fatalf("file credentials accepted inline scope environment: %v", err)
	}
}

func TestNormalAndDevelopmentMigrationModesUseHTTPPath(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		values map[string]string
	}{
		{name: "normal production", values: map[string]string{"DEV_MODE": "false", "DATABASE_MIGRATE": "false"}},
		{name: "development compatibility", values: map[string]string{"DEV_MODE": "true", "DATABASE_MIGRATE": "true"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			migrationCalls, serverCalls := 0, 0
			err := runProcess(context.Background(), func(key string) string { return testCase.values[key] }, processDependencies{
				migrate: func(context.Context, store.StoreConfig) error { migrationCalls++; return nil },
				serve:   func() error { serverCalls++; return nil },
			})
			if err != nil || migrationCalls != 0 || serverCalls != 1 {
				t.Fatalf("startup result err=%v migrations=%d servers=%d", err, migrationCalls, serverCalls)
			}
		})
	}
}

func TestProductionMigrationConfigFailsClosed(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		values map[string]string
	}{
		{name: "adapter missing", values: map[string]string{"DATABASE_URL": "postgres://db/app?sslmode=verify-full"}},
		{name: "SQLite forbidden", values: map[string]string{"DATABASE_ADAPTER": "sqlite-development", "DATABASE_URL": "postgres://db/app?sslmode=verify-full"}},
		{name: "file forbidden", values: map[string]string{"DATABASE_ADAPTER": "postgresql", "DATABASE_URL": "postgres://db/app?sslmode=verify-full", "DATABASE_FILE": "app.db"}},
		{name: "DSN missing", values: map[string]string{"DATABASE_ADAPTER": "postgresql"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := productionMigrationStoreConfig(func(key string) string { return testCase.values[key] }); err == nil {
				t.Fatal("unsafe migration configuration must be rejected")
			}
		})
	}
}
