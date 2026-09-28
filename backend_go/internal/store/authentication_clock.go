package store

import (
	"errors"
	"time"
)

func authenticationDatabaseNowExpression(dialect databaseDialect) string {
	if dialect == dialectPostgreSQL {
		return "clock_timestamp()"
	}
	return "STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', CURRENT_TIMESTAMP)"
}

func authenticationDatabaseExpiryExpression(dialect databaseDialect) string {
	if dialect == dialectPostgreSQL {
		return "clock_timestamp() + (? * INTERVAL '1 second')"
	}
	return "STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', CURRENT_TIMESTAMP, '+' || ? || ' seconds')"
}

func authenticationDatabasePastExpression(dialect databaseDialect) string {
	if dialect == dialectPostgreSQL {
		return "clock_timestamp() - (? * INTERVAL '1 second')"
	}
	return "STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', CURRENT_TIMESTAMP, '-' || ? || ' seconds')"
}

func authenticationDatabaseFreshExpression(dialect databaseDialect, column string) string {
	if dialect == dialectPostgreSQL {
		return column + " > clock_timestamp()"
	}
	return "COALESCE(JULIANDAY(" + column + ") > JULIANDAY(CURRENT_TIMESTAMP), 0)"
}

func authenticationDatabaseMonotonicTimestampExpression(dialect databaseDialect, column string) string {
	if dialect == dialectPostgreSQL {
		return "GREATEST(" + column + ", clock_timestamp())"
	}
	return "CASE WHEN JULIANDAY(" + column + ") >= JULIANDAY(CURRENT_TIMESTAMP) THEN " + column + " ELSE " + authenticationDatabaseNowExpression(dialect) + " END"
}

func normalizedAuthenticationTTLSeconds(ttl time.Duration) (int64, error) {
	if ttl <= 0 {
		return 0, errors.New("authentication TTL must be positive")
	}
	seconds := int64(ttl / time.Second)
	if ttl%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return seconds, nil
}

func parseDatabaseTimestamp(value timestampText) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, string(value))
}
