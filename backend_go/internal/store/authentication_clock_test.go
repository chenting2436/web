package store

import (
	"strings"
	"testing"
	"time"
)

func TestAuthenticationClockExpressionsAreDatabaseAuthoritative(t *testing.T) {
	if value := authenticationDatabaseNowExpression(dialectPostgreSQL); value != "clock_timestamp()" {
		t.Fatalf("PostgreSQL authentication freshness must use wall-clock database time, got %q", value)
	}
	if value := authenticationDatabaseExpiryExpression(dialectPostgreSQL); !strings.HasPrefix(value, "clock_timestamp()") {
		t.Fatalf("PostgreSQL authentication expiry must be created from database time, got %q", value)
	}
	for _, value := range []string{
		authenticationDatabaseNowExpression(dialectSQLite),
		authenticationDatabaseExpiryExpression(dialectSQLite),
		authenticationDatabasePastExpression(dialectSQLite),
		authenticationDatabaseFreshExpression(dialectSQLite, "expires_at"),
	} {
		if !strings.Contains(value, "CURRENT_TIMESTAMP") {
			t.Fatalf("SQLite authentication time must come from CURRENT_TIMESTAMP, got %q", value)
		}
	}
	if value := authenticationDatabaseFreshExpression(dialectPostgreSQL, "expires_at"); value != "expires_at > clock_timestamp()" {
		t.Fatalf("PostgreSQL authentication freshness must use database wall time, got %q", value)
	}
	if value := authenticationDatabasePastExpression(dialectPostgreSQL); !strings.HasPrefix(value, "clock_timestamp()") {
		t.Fatalf("PostgreSQL authentication admission windows must use database wall time, got %q", value)
	}
	if value := authenticationDatabaseMonotonicTimestampExpression(dialectPostgreSQL, "last_seen_at"); value != "GREATEST(last_seen_at, clock_timestamp())" {
		t.Fatalf("PostgreSQL last-seen updates must be database-owned and monotonic, got %q", value)
	}
	if value := authenticationDatabaseMonotonicTimestampExpression(dialectSQLite, "last_seen_at"); !strings.Contains(value, "CURRENT_TIMESTAMP") || !strings.HasPrefix(value, "CASE WHEN JULIANDAY(") {
		t.Fatalf("SQLite last-seen updates must be database-owned and monotonic, got %q", value)
	}
}

func TestAuthenticationTTLRoundsUpWithoutAllowingNonPositiveValues(t *testing.T) {
	if value, err := normalizedAuthenticationTTLSeconds(time.Nanosecond); err != nil || value != 1 {
		t.Fatalf("sub-second TTL must round up to one second: value=%d err=%v", value, err)
	}
	if value, err := normalizedAuthenticationTTLSeconds(1500 * time.Millisecond); err != nil || value != 2 {
		t.Fatalf("fractional TTL must round up: value=%d err=%v", value, err)
	}
	if _, err := normalizedAuthenticationTTLSeconds(0); err == nil {
		t.Fatal("non-positive authentication TTL must fail closed")
	}
}
