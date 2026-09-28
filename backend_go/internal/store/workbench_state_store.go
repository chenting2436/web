package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	MaxWorkbenchStateBytes    = 1 << 20
	maxWorkbenchStateKeyBytes = 128
)

var (
	ErrWorkbenchStateConflict = errors.New("workbench state revision conflict")
	ErrWorkbenchStateTooLarge = errors.New("workbench state exceeds 1 MiB")
	ErrInvalidWorkbenchState  = errors.New("invalid workbench state")
)

// WorkbenchState is one user's durable draft for a workbench. State is always
// detached from caller-owned maps before it enters or leaves the store.
type WorkbenchState struct {
	State     map[string]any `json:"state"`
	Revision  int64          `json:"revision"`
	UpdatedAt string         `json:"updatedAt,omitempty"`
}

// GetWorkbenchState uses the complete authenticated scope. A record from a
// different tenant, workspace, or user is indistinguishable from a missing
// record.
func (store *ProjectStore) GetWorkbenchState(scope Scope, slug string) (WorkbenchState, bool, error) {
	if err := validateWorkbenchStateScope(scope, slug); err != nil {
		return WorkbenchState{}, false, err
	}
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return WorkbenchState{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	row := tx.QueryRow(`SELECT state.state_json, state.revision, state.updated_at
		FROM workbench_states state
		JOIN memberships membership
			ON membership.tenant_id = state.tenant_id
			AND membership.workspace_id = state.workspace_id
			AND membership.user_id = state.user_id
			AND membership.status = 'active'
		WHERE state.tenant_id = ? AND state.workspace_id = ? AND state.user_id = ? AND state.slug = ?`,
		scope.TenantID, scope.WorkspaceID, scope.UserID, slug)
	record, err := scanWorkbenchState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkbenchState{}, false, nil
	}
	if err != nil {
		return WorkbenchState{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return WorkbenchState{}, false, err
	}
	return record, true, nil
}

// PutWorkbenchState is intentionally compare-and-swap only. Revision zero may
// create a new record; a positive revision may update exactly that revision.
// There is no blind overwrite mode.
func (store *ProjectStore) PutWorkbenchState(scope Scope, slug string, expectedRevision int64, state map[string]any) (WorkbenchState, error) {
	if err := validateWorkbenchStateScope(scope, slug); err != nil {
		return WorkbenchState{}, err
	}
	if expectedRevision < 0 {
		return WorkbenchState{}, fmt.Errorf("%w: expected revision must be zero or greater", ErrInvalidWorkbenchState)
	}
	encoded, normalized, err := normalizeWorkbenchState(state)
	if err != nil {
		return WorkbenchState{}, err
	}
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return WorkbenchState{}, err
	}
	defer func() { _ = tx.Rollback() }()
	databaseNow := workbenchStateNowExpression(tx.dialect)
	var row rowScanner
	if expectedRevision == 0 {
		row = tx.QueryRow(`INSERT INTO workbench_states(
			tenant_id, workspace_id, user_id, slug, state_json, size_bytes, revision, created_at, updated_at
		) SELECT ?, ?, ?, ?, ?, ?, 1, `+databaseNow+`, `+databaseNow+`
		FROM memberships
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND status = 'active'
		ON CONFLICT(tenant_id, workspace_id, user_id, slug) DO NOTHING
		RETURNING state_json, revision, updated_at`,
			scope.TenantID, scope.WorkspaceID, scope.UserID, slug, tx.json(encoded), len(encoded),
			scope.TenantID, scope.WorkspaceID, scope.UserID)
	} else {
		row = tx.QueryRow(`UPDATE workbench_states
		SET state_json = ?, size_bytes = ?, revision = revision + 1, updated_at = `+databaseNow+`
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND slug = ? AND revision = ?
			AND EXISTS (
				SELECT 1 FROM memberships
				WHERE memberships.tenant_id = workbench_states.tenant_id
					AND memberships.workspace_id = workbench_states.workspace_id
					AND memberships.user_id = workbench_states.user_id
					AND memberships.status = 'active'
			)
		RETURNING state_json, revision, updated_at`,
			tx.json(encoded), len(encoded), scope.TenantID, scope.WorkspaceID,
			scope.UserID, slug, expectedRevision)
	}
	record, err := scanWorkbenchState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkbenchState{}, ErrWorkbenchStateConflict
	}
	if err != nil {
		return WorkbenchState{}, normalizeWorkbenchStateDatabaseError(err)
	}
	// Use the already-normalized, detached value. This also avoids an unnecessary
	// second allocation on the successful write path while preserving the exact
	// value accepted by validation.
	record.State = normalized
	if err := tx.Commit(); err != nil {
		return WorkbenchState{}, err
	}
	return record, nil
}

// PostgreSQL JSONB may add canonical spacing and normalize numbers, so its
// stored representation can cross the 1 MiB constraint even when the compact
// request representation was just below the limit. Keep that deterministic
// storage rejection in the public 413 contract instead of surfacing a 500.
func normalizeWorkbenchStateDatabaseError(err error) error {
	var pgError *pgconn.PgError
	if errors.As(err, &pgError) && pgError.Code == "23514" && strings.HasPrefix(pgError.ConstraintName, "workbench_states_") {
		return ErrWorkbenchStateTooLarge
	}
	return err
}

func scanWorkbenchState(row rowScanner) (WorkbenchState, error) {
	var record WorkbenchState
	var encoded string
	var updatedAt timestampText
	if err := row.Scan(&encoded, &record.Revision, &updatedAt); err != nil {
		return WorkbenchState{}, err
	}
	record.UpdatedAt = string(updatedAt)
	state, err := decodeWorkbenchState([]byte(encoded))
	if err != nil {
		return WorkbenchState{}, fmt.Errorf("decode workbench state: %w", err)
	}
	record.State = state
	return record, nil
}

func normalizeWorkbenchState(state map[string]any) ([]byte, map[string]any, error) {
	if state == nil {
		return nil, nil, fmt.Errorf("%w: state must be a JSON object", ErrInvalidWorkbenchState)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: encode state: %v", ErrInvalidWorkbenchState, err)
	}
	normalized, err := decodeWorkbenchState(encoded)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrInvalidWorkbenchState, err)
	}
	encoded, err = json.Marshal(normalized)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: encode normalized state: %v", ErrInvalidWorkbenchState, err)
	}
	if len(encoded) > MaxWorkbenchStateBytes {
		return nil, nil, ErrWorkbenchStateTooLarge
	}
	return encoded, normalized, nil
}

func decodeWorkbenchState(encoded []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var state map[string]any
	if err := decoder.Decode(&state); err != nil {
		return nil, err
	}
	if state == nil {
		return nil, errors.New("state must be a JSON object")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("state contains trailing JSON data")
		}
		return nil, fmt.Errorf("state contains trailing JSON data: %w", err)
	}
	return state, nil
}

func workbenchStateNowExpression(dialect databaseDialect) string {
	if dialect == dialectPostgreSQL {
		return "CURRENT_TIMESTAMP"
	}
	return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
}

func validateWorkbenchStateScope(scope Scope, slug string) error {
	for name, value := range map[string]string{
		"tenant ID": scope.TenantID, "workspace ID": scope.WorkspaceID, "user ID": scope.UserID,
	} {
		if err := validateWorkbenchStateKey(name, value, false); err != nil {
			return err
		}
	}
	return validateWorkbenchStateKey("slug", slug, true)
}

func validateWorkbenchStateKey(name, value string, slug bool) error {
	if value == "" || len(value) > maxWorkbenchStateKeyBytes || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return fmt.Errorf("%w: %s must contain 1 to %d valid UTF-8 bytes without surrounding whitespace", ErrInvalidWorkbenchState, name, maxWorkbenchStateKeyBytes)
	}
	for index, character := range value {
		if unicode.IsControl(character) || (slug && !(character == '-' || character == '_' || character == '.' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9')) {
			return fmt.Errorf("%w: %s contains an unsafe character at byte %d", ErrInvalidWorkbenchState, name, index)
		}
	}
	return nil
}
