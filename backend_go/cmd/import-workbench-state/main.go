// Command import-workbench-state is the explicit, one-time bridge from the
// retired data/workbench-state.json format to durable scoped workbench state.
// It is a dry-run unless --apply is present.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"skyviewlab/backend_go/internal/store"
)

func main() {
	if code := run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr); code != 0 {
		os.Exit(code)
	}
}

func run(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("import-workbench-state", flag.ContinueOnError)
	flags.SetOutput(stderr)
	legacyPath := flags.String("legacy-file", "./data/workbench-state.json", "path to the legacy workbench-state JSON")
	mappingPath := flags.String("mapping-file", "", "path to the explicit identity mapping manifest (required)")
	apply := flags.Bool("apply", false, "commit missing states and atomic audit evidence; default is dry-run")
	timeout := flags.Duration("timeout", 2*time.Minute, "maximum validation/import duration")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "unexpected positional arguments")
		return 2
	}
	if strings.TrimSpace(*mappingPath) == "" {
		fmt.Fprintln(stderr, "--mapping-file is required; the importer never infers legacy identities")
		return 2
	}
	if *timeout <= 0 || *timeout > 24*time.Hour {
		fmt.Fprintln(stderr, "--timeout must be greater than zero and no more than 24h")
		return 2
	}

	legacyJSON, err := readBoundedFile(*legacyPath, store.MaxLegacyWorkbenchStateFileBytes)
	if err != nil {
		fmt.Fprintf(stderr, "read legacy state file: %v\n", err)
		return 1
	}
	mappingJSON, err := readBoundedFile(*mappingPath, store.MaxLegacyWorkbenchMappingFileBytes)
	if err != nil {
		fmt.Fprintf(stderr, "read mapping file: %v\n", err)
		return 1
	}

	config, err := importStoreConfig(getenv)
	if err != nil {
		fmt.Fprintf(stderr, "database configuration rejected: %v\n", err)
		return 2
	}
	if config.Adapter == store.AdapterSQLiteDevelopment {
		info, statErr := os.Stat(config.SQLitePath)
		if statErr != nil || !info.Mode().IsRegular() {
			if statErr == nil {
				statErr = errors.New("path is not a regular file")
			}
			fmt.Fprintf(stderr, "destination SQLite database rejected: %v\n", statErr)
			return 1
		}
	}
	projectStore, err := store.OpenProjectStore(config)
	if err != nil {
		fmt.Fprintf(stderr, "open destination database: %v\n", err)
		return 1
	}
	defer func() { _ = projectStore.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	if err := projectStore.ValidateRuntimePrivileges(ctx); err != nil {
		fmt.Fprintf(stderr, "destination database privilege gate rejected the importer: %v\n", err)
		return 1
	}
	report, err := projectStore.ImportLegacyWorkbenchStates(ctx, legacyJSON, mappingJSON, *apply)
	if err != nil {
		fmt.Fprintf(stderr, "legacy workbench-state import rejected: %v\n", err)
		return 1
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		fmt.Fprintf(stderr, "write import report: %v\n", err)
		return 1
	}
	return 0
}

func importStoreConfig(getenv func(string) string) (store.StoreConfig, error) {
	if getenv == nil {
		return store.StoreConfig{}, errors.New("environment reader is required")
	}
	devMode, err := strictEnvironmentBool("DEV_MODE", getenv("DEV_MODE"), false)
	if err != nil {
		return store.StoreConfig{}, err
	}
	databaseMigrate, err := strictEnvironmentBool("DATABASE_MIGRATE", getenv("DATABASE_MIGRATE"), false)
	if err != nil {
		return store.StoreConfig{}, err
	}
	if databaseMigrate {
		return store.StoreConfig{}, errors.New("DATABASE_MIGRATE must be false; this command never changes the schema")
	}

	adapter := strings.ToLower(strings.TrimSpace(getenv("DATABASE_ADAPTER")))
	switch adapter {
	case "sqlite", store.AdapterSQLiteDevelopment:
		if !devMode {
			return store.StoreConfig{}, errors.New("sqlite-development imports require DEV_MODE=true")
		}
		path := strings.TrimSpace(getenv("DATABASE_FILE"))
		if path == "" || path == ":memory:" {
			return store.StoreConfig{}, errors.New("DATABASE_FILE must name an existing durable development database")
		}
		if strings.TrimSpace(getenv("DATABASE_URL")) != "" {
			return store.StoreConfig{}, errors.New("DATABASE_URL must be empty for sqlite-development")
		}
		return store.StoreConfig{Adapter: store.AdapterSQLiteDevelopment, SQLitePath: path, ApplyMigrations: false, RequireExistingSchema: true}, nil
	case "postgres", store.AdapterPostgreSQL:
		if devMode {
			return store.StoreConfig{}, errors.New("PostgreSQL legacy import requires DEV_MODE=false")
		}
		if strings.TrimSpace(getenv("DATABASE_FILE")) != "" {
			return store.StoreConfig{}, errors.New("DATABASE_FILE must be empty for PostgreSQL")
		}
		return store.StoreConfig{
			Adapter: store.AdapterPostgreSQL, PostgresDSN: strings.TrimSpace(getenv("DATABASE_URL")),
			ApplyMigrations: false, RequireExistingSchema: true, RequireTLS: true,
		}, nil
	case "":
		return store.StoreConfig{}, errors.New("DATABASE_ADAPTER is required")
	default:
		return store.StoreConfig{}, fmt.Errorf("unsupported DATABASE_ADAPTER %q", adapter)
	}
}

func strictEnvironmentBool(name, raw string, fallback bool) (bool, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return fallback, nil
	}
	switch value {
	case "true", "1":
		return true, nil
	case "false", "0":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true, false, 1, or 0", name)
	}
}

func readBoundedFile(path string, limit int) ([]byte, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("file path is empty")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(contents) > limit {
		return nil, fmt.Errorf("file exceeds the %d-byte limit", limit)
	}
	return contents, nil
}
