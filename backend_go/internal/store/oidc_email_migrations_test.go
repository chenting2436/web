package store

import (
	"strings"
	"testing"
)

func TestPostgreSQLCanonicalEmailMigrationGuardsBeforeRewrite(t *testing.T) {
	items, err := loadPostgresMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var migrationSQL string
	for _, item := range items {
		if item.version == 3 && item.name == "canonical_user_emails" {
			migrationSQL = item.sql
			break
		}
	}
	if migrationSQL == "" {
		t.Fatal("canonical user email migration is missing")
	}
	indexPosition := strings.Index(migrationSQL, "CREATE UNIQUE INDEX users_tenant_email_canonical_key")
	rewritePosition := strings.Index(migrationSQL, "UPDATE users")
	for _, required := range []string{"ON users (tenant_id, lower(email))", "CHECK (email = lower(btrim(email)))"} {
		if !strings.Contains(migrationSQL, required) {
			t.Fatalf("canonical email migration is missing %q", required)
		}
	}
	if indexPosition < 0 || rewritePosition < 0 || indexPosition > rewritePosition {
		t.Fatal("case-insensitive uniqueness must be established before legacy emails are rewritten")
	}
}
