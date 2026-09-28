package store

import (
	"strings"
	"testing"
	"time"
)

func TestPostgreSQLRebindSkipsQuotedAndCommentedQuestionMarks(t *testing.T) {
	query := "SELECT '?' AS literal, \"?\" FROM records WHERE tenant_id = ? AND note = $tag$?$tag$ -- ?\n AND workspace_id = ? /* ? */"
	got := rebind(query, dialectPostgreSQL)
	want := "SELECT '?' AS literal, \"?\" FROM records WHERE tenant_id = $1 AND note = $tag$?$tag$ -- ?\n AND workspace_id = $2 /* ? */"
	if got != want {
		t.Fatalf("unexpected rebound SQL:\n got: %s\nwant: %s", got, want)
	}
	if unchanged := rebind(query, dialectSQLite); unchanged != query {
		t.Fatalf("SQLite query must remain unchanged: %s", unchanged)
	}
}

func TestPostgreSQLTimestampArgumentsAndScansUseTimeValues(t *testing.T) {
	raw := "2026-09-08T01:02:03.456789Z"
	argument, ok := timestampArgument(dialectPostgreSQL, raw).(time.Time)
	if !ok || argument.UTC().Format(time.RFC3339Nano) != raw {
		t.Fatalf("expected parsed PostgreSQL time, got %#v", argument)
	}
	if sqlite := timestampArgument(dialectSQLite, raw); sqlite != raw {
		t.Fatalf("SQLite must retain RFC3339 text, got %#v", sqlite)
	}
	var scanned timestampText
	if err := scanned.Scan(argument); err != nil || string(scanned) != raw {
		t.Fatalf("unexpected timestamp scan value=%q err=%v", scanned, err)
	}
	if err := scanned.Scan(nil); err != nil || scanned != "" {
		t.Fatalf("nullable timestamp must scan to empty string, value=%q err=%v", scanned, err)
	}
}

func TestStoreConfigRejectsUnsafeOrMixedAdapters(t *testing.T) {
	cases := []struct {
		name   string
		config StoreConfig
		want   string
	}{
		{name: "missing adapter", config: StoreConfig{}, want: "adapter is required"},
		{name: "mixed sqlite and postgres", config: StoreConfig{Adapter: "sqlite-development", PostgresDSN: "postgres://db/app"}, want: "must be empty"},
		{name: "missing postgres DSN", config: StoreConfig{Adapter: "postgresql"}, want: "DSN is required"},
		{name: "non URL postgres DSN", config: StoreConfig{Adapter: "postgresql", PostgresDSN: "host=db dbname=app"}, want: "postgres://"},
		{name: "missing database", config: StoreConfig{Adapter: "postgresql", PostgresDSN: "postgres://db"}, want: "database name"},
		{name: "production TLS disabled", config: StoreConfig{Adapter: "postgresql", PostgresDSN: "postgres://db/app?sslmode=disable", RequireTLS: true}, want: "sslmode=verify-full"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			_, err := normalizeStoreConfig(&item.config)
			if err == nil || !strings.Contains(err.Error(), item.want) {
				t.Fatalf("expected %q error, got %v", item.want, err)
			}
		})
	}

	valid := StoreConfig{Adapter: "postgresql", PostgresDSN: "postgres://service@db.internal/skyview?sslmode=verify-full", RequireTLS: true}
	if adapter, err := normalizeStoreConfig(&valid); err != nil || adapter != AdapterPostgreSQL {
		t.Fatalf("expected valid verified PostgreSQL config, adapter=%q err=%v", adapter, err)
	}
}

func TestDevelopmentConstructorReportsExplicitAdapter(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	if projectStore.Adapter() != AdapterSQLiteDevelopment {
		t.Fatalf("unexpected adapter %q", projectStore.Adapter())
	}
}
