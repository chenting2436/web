package store

import (
	"strings"
	"testing"
)

func TestPostgreSQLLeasesUseWallClockInsteadOfTransactionStart(t *testing.T) {
	if now := databaseNowExpression(AdapterPostgreSQL); now != "clock_timestamp()" {
		t.Fatalf("PostgreSQL lease clock = %q", now)
	}
	if lease := databaseLeaseExpression(AdapterPostgreSQL); !strings.HasPrefix(lease, "clock_timestamp()") {
		t.Fatalf("PostgreSQL lease deadline does not use wall clock: %q", lease)
	}
}
