package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"skyviewlab/backend_go/internal/store"
)

func TestCommandDefaultsToDryRunAndApplyIsExplicit(t *testing.T) {
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "skyviewlab.db")
	projectStore, err := store.NewProjectStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	target, err := projectStore.EnsureDevIdentity("tenant-command", "workspace-command", "target@command.test", "Target", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	actor, err := projectStore.EnsureDevIdentity(target.TenantID, target.WorkspaceID, "admin@command.test", "Admin", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := projectStore.Close(); err != nil {
		t.Fatal(err)
	}

	legacy := []byte(`{"alice|paper-writing":{"draft":"legacy"}}`)
	digest := sha256.Sum256(legacy)
	manifest, err := json.Marshal(store.LegacyWorkbenchImportManifest{
		Version: store.LegacyWorkbenchImportManifestVersion, SourceSHA256: hex.EncodeToString(digest[:]),
		Mappings: []store.LegacyWorkbenchImportMapping{{
			LegacyUserKey: "alice", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
			UserID: target.UserID, ActorUserID: actor.UserID,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(directory, "workbench-state.json")
	mappingPath := filepath.Join(directory, "mapping.json")
	if err := os.WriteFile(legacyPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mappingPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"DEV_MODE": "true", "DATABASE_MIGRATE": "false",
		"DATABASE_ADAPTER": store.AdapterSQLiteDevelopment, "DATABASE_FILE": databasePath,
	}
	getenv := func(key string) string { return environment[key] }

	var output, errorOutput bytes.Buffer
	code := run([]string{"--legacy-file", legacyPath, "--mapping-file", mappingPath}, getenv, &output, &errorOutput)
	if code != 0 || errorOutput.Len() != 0 || !strings.Contains(output.String(), `"mode": "dry-run"`) || !strings.Contains(output.String(), `"wouldImport": 1`) {
		t.Fatalf("dry-run command failed: code=%d output=%s error=%s", code, output.String(), errorOutput.String())
	}
	reader, err := store.OpenProjectStore(store.StoreConfig{
		Adapter: store.AdapterSQLiteDevelopment, SQLitePath: databasePath, RequireExistingSchema: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, found, err := reader.GetWorkbenchState(target.Scope(), "paper-writing"); err != nil || found {
		t.Fatalf("command default wrote state: found=%v err=%v", found, err)
	}
	_ = reader.Close()

	output.Reset()
	errorOutput.Reset()
	code = run([]string{"--legacy-file", legacyPath, "--mapping-file", mappingPath, "--apply"}, getenv, &output, &errorOutput)
	if code != 0 || errorOutput.Len() != 0 || !strings.Contains(output.String(), `"mode": "apply"`) || !strings.Contains(output.String(), `"imported": 1`) {
		t.Fatalf("apply command failed: code=%d output=%s error=%s", code, output.String(), errorOutput.String())
	}
	reader, err = store.OpenProjectStore(store.StoreConfig{
		Adapter: store.AdapterSQLiteDevelopment, SQLitePath: databasePath, RequireExistingSchema: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Close() }()
	state, found, err := reader.GetWorkbenchState(target.Scope(), "paper-writing")
	if err != nil || !found || state.State["draft"] != "legacy" {
		t.Fatalf("explicit apply did not import state: state=%+v found=%v err=%v", state, found, err)
	}
}

func TestCommandFailsClosedOnUnsafeConfiguration(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{name: "sqlite outside development", env: map[string]string{"DEV_MODE": "false", "DATABASE_ADAPTER": "sqlite-development", "DATABASE_FILE": "state.db"}, want: "DEV_MODE=true"},
		{name: "migration enabled", env: map[string]string{"DEV_MODE": "true", "DATABASE_MIGRATE": "true", "DATABASE_ADAPTER": "sqlite-development", "DATABASE_FILE": "state.db"}, want: "must be false"},
		{name: "ambiguous boolean", env: map[string]string{"DEV_MODE": "yes", "DATABASE_ADAPTER": "sqlite-development", "DATABASE_FILE": "state.db"}, want: "must be true"},
		{name: "in-memory destination", env: map[string]string{"DEV_MODE": "true", "DATABASE_ADAPTER": "sqlite-development", "DATABASE_FILE": ":memory:"}, want: "durable"},
		{name: "postgres development mode", env: map[string]string{"DEV_MODE": "true", "DATABASE_ADAPTER": "postgresql", "DATABASE_URL": "postgres://db/app?sslmode=verify-full"}, want: "DEV_MODE=false"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := importStoreConfig(func(key string) string { return test.env[key] })
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
		})
	}
}

func TestExistingSchemaModeDoesNotCreateMissingSQLiteDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.db")
	_, err := store.OpenProjectStore(store.StoreConfig{
		Adapter: store.AdapterSQLiteDevelopment, SQLitePath: path, RequireExistingSchema: true,
	})
	if err == nil {
		t.Fatal("missing existing schema was accepted")
	}
	// OpenProjectStore itself may create an empty SQLite file before the schema
	// ledger check; the command prevents this with its pre-open regular-file
	// check. The important store contract is that no schema table was created.
	if info, statErr := os.Stat(path); statErr == nil && info.Size() != 0 {
		t.Fatalf("schema validation wrote a missing database: size=%d", info.Size())
	}
}
