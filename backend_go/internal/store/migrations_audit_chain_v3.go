package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// migrationAuditChainV3 retains every v1/v2 event verbatim while moving the
// writable head and insert guard to the unambiguous v3 framing protocol.
// SQLite cannot drop a CHECK constraint, so both small audit tables are
// rebuilt transactionally after a full hash/topology/head preflight.
func migrationAuditChainV3(tx *databaseTx) error {
	if err := preflightAuditV3Chains(tx); err != nil {
		return err
	}
	statements := []string{
		`DROP TRIGGER audit_events_chain_guard`,
		`DROP TRIGGER audit_events_no_update`,
		`DROP TRIGGER audit_events_no_delete`,
		`ALTER TABLE audit_events RENAME TO audit_events_v2`,
		`CREATE TABLE audit_events (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			actor_user_id TEXT NOT NULL,
			action TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			outcome TEXT NOT NULL,
			request_id TEXT NOT NULL,
			source_ip TEXT NOT NULL,
			user_agent TEXT NOT NULL,
			before_hash TEXT NOT NULL,
			after_hash TEXT NOT NULL,
			metadata_json TEXT NOT NULL,
			previous_event_hash TEXT NOT NULL,
			event_hash TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			sequence_number INTEGER,
			chain_version INTEGER,
			CHECK (
				(sequence_number IS NULL AND chain_version IS NULL)
				OR (sequence_number > 0 AND chain_version IN (2, 3))
			)
		)`,
		`INSERT INTO audit_events(
			id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
			outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
			previous_event_hash, event_hash, created_at, sequence_number, chain_version
		)
		SELECT id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
			outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
			previous_event_hash, event_hash, created_at, sequence_number, chain_version
		FROM audit_events_v2`,
		`DROP TABLE audit_events_v2`,
		`ALTER TABLE audit_heads RENAME TO audit_heads_v2`,
		`CREATE TABLE audit_heads (
			tenant_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			head_event_hash TEXT NOT NULL,
			last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
			chain_version INTEGER NOT NULL CHECK(chain_version = 3),
			updated_at TEXT NOT NULL,
			PRIMARY KEY(tenant_id, workspace_id)
		)`,
		`INSERT INTO audit_heads(tenant_id, workspace_id, head_event_hash, last_sequence, chain_version, updated_at)
		SELECT tenant_id, workspace_id, head_event_hash, last_sequence, 3, updated_at
		FROM audit_heads_v2`,
		`DROP TABLE audit_heads_v2`,
		`CREATE INDEX idx_audit_scope_time ON audit_events(tenant_id, workspace_id, created_at DESC)`,
		`CREATE UNIQUE INDEX idx_audit_scope_sequence ON audit_events(tenant_id, workspace_id, sequence_number)
			WHERE sequence_number IS NOT NULL`,
		`CREATE INDEX idx_audit_scope_chain_order ON audit_events(tenant_id, workspace_id, sequence_number DESC)`,
		`CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
			BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
		`CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
			BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
		`CREATE TRIGGER audit_events_chain_guard BEFORE INSERT ON audit_events FOR EACH ROW BEGIN
			SELECT CASE WHEN NEW.chain_version IS NOT 3 OR NEW.sequence_number IS NULL
				THEN RAISE(ABORT, 'audit_event_v3_required') END;
			SELECT CASE WHEN (SELECT COUNT(*) FROM audit_heads
				WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id AND chain_version = 3) <> 1
				THEN RAISE(ABORT, 'audit_head_missing') END;
			SELECT CASE WHEN NEW.previous_event_hash IS NOT (SELECT head_event_hash FROM audit_heads
				WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id)
				THEN RAISE(ABORT, 'audit_predecessor_mismatch') END;
			SELECT CASE WHEN NEW.sequence_number IS NOT (SELECT last_sequence + 1 FROM audit_heads
				WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id)
				THEN RAISE(ABORT, 'audit_sequence_mismatch') END;
		END`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("upgrade SQLite audit chain to v3: %w", err)
		}
	}
	return nil
}

// preflightAuditV3Chains is also called by the PostgreSQL migration runner
// before it executes migration 012. It recomputes every historical digest and
// proves the graph, sequence, version order, and durable head in the same
// migration transaction; the SQL migration repeats topology checks so a
// direct/manual execution still fails closed on structural corruption.
func preflightAuditV3Chains(tx *databaseTx) error {
	rows, err := tx.Query(`SELECT tenant_id, workspace_id FROM audit_heads
		UNION SELECT tenant_id, workspace_id FROM audit_events`)
	if err != nil {
		return err
	}
	scopes := make([]Scope, 0)
	for rows.Next() {
		var scope Scope
		if err := rows.Scan(&scope.TenantID, &scope.WorkspaceID); err != nil {
			_ = rows.Close()
			return err
		}
		scopes = append(scopes, scope)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}

	for _, scope := range scopes {
		records, err := loadStoredAuditEvents(tx, scope)
		if err != nil {
			return err
		}
		terminalHash, err := validateStoredAuditEvents(records, true)
		if err != nil {
			return fmt.Errorf("invalid pre-v3 audit chain for tenant %q workspace %q: %w", scope.TenantID, scope.WorkspaceID, err)
		}
		var headHash string
		var lastSequence int64
		var chainVersion int
		err = tx.QueryRow(`SELECT head_event_hash, last_sequence, chain_version FROM audit_heads
			WHERE tenant_id = ? AND workspace_id = ?`, scope.TenantID, scope.WorkspaceID).
			Scan(&headHash, &lastSequence, &chainVersion)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("invalid pre-v3 audit chain for tenant %q workspace %q: durable head is missing", scope.TenantID, scope.WorkspaceID)
		}
		if err != nil {
			return err
		}
		if headHash != terminalHash || lastSequence != int64(len(records)) || chainVersion != 2 {
			return fmt.Errorf("invalid pre-v3 audit chain for tenant %q workspace %q: durable head mismatch", scope.TenantID, scope.WorkspaceID)
		}
	}
	return nil
}
