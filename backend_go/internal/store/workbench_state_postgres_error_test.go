package store

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestNormalizeWorkbenchStatePostgreSQLSizeCheck(t *testing.T) {
	databaseError := &pgconn.PgError{Code: "23514", ConstraintName: "workbench_states_state_json_check"}
	if err := normalizeWorkbenchStateDatabaseError(databaseError); !errors.Is(err, ErrWorkbenchStateTooLarge) {
		t.Fatalf("expected stable size error, got %v", err)
	}
	unrelated := &pgconn.PgError{Code: "23505", ConstraintName: "workbench_states_pkey"}
	if err := normalizeWorkbenchStateDatabaseError(unrelated); !errors.Is(err, unrelated) {
		t.Fatalf("unexpected translation of unrelated database error: %v", err)
	}
}
