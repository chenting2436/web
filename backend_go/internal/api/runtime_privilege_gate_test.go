package api

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

type recordingRuntimePrivilegeValidator struct {
	calls int
	err   error
}

func (validator *recordingRuntimePrivilegeValidator) ValidateRuntimePrivileges(ctx context.Context) error {
	validator.calls++
	if ctx == nil {
		return errors.New("missing context")
	}
	return validator.err
}

func TestProductionRuntimePrivilegeGateIsMandatory(t *testing.T) {
	want := errors.New("unsafe identity")
	validator := &recordingRuntimePrivilegeValidator{err: want}
	err := enforceProductionRuntimePrivileges(context.Background(), false, validator)
	if !errors.Is(err, want) || validator.calls != 1 {
		t.Fatalf("production gate result = %v calls=%d", err, validator.calls)
	}
	if err := enforceProductionRuntimePrivileges(context.Background(), false, nil); err == nil {
		t.Fatal("a missing production privilege validator must fail closed")
	}
}

func TestDevelopmentRuntimePrivilegeGateIsSkipped(t *testing.T) {
	validator := &recordingRuntimePrivilegeValidator{err: errors.New("must not run")}
	if err := enforceProductionRuntimePrivileges(context.Background(), true, validator); err != nil || validator.calls != 0 {
		t.Fatalf("development gate must be skipped, err=%v calls=%d", err, validator.calls)
	}
}

func TestProductionHTTPConfigRejectsMigrationMode(t *testing.T) {
	err := validateConfig(Config{
		CookieSecure: true, DatabaseAdapter: "postgresql",
		DatabaseDSN:     "postgres://runtime@database.internal/skyviewlab?sslmode=verify-full",
		DatabaseMigrate: true,
	})
	if err == nil || !strings.Contains(err.Error(), "migration-only") {
		t.Fatalf("production HTTP service must reject DATABASE_MIGRATE=true, got %v", err)
	}
}

func TestNewHandlerCheckedContainsProductionPrivilegeGate(t *testing.T) {
	contents, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	openIndex := strings.Index(source, "projectStore, err := store.OpenProjectStore")
	gateIndex := strings.Index(source, "enforceProductionRuntimePrivileges(privilegeContext, config.DevMode, projectStore)")
	handlerIndex := strings.Index(source, "return &managedHandler")
	if openIndex < 0 || gateIndex <= openIndex || handlerIndex <= gateIndex {
		t.Fatal("NewHandlerChecked must validate the runtime database identity after opening the store and before returning a handler")
	}
}
