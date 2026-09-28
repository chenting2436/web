package store

import "fmt"

// Recovering a pgx-truncated v1 timestamp requires at most 1,000 SHA-256
// candidates per event. Larger installations must benchmark and verify an
// offline, write-frozen snapshot instead of entering an unbounded migration
// transaction.
const maxOnlineLegacyAuditPrecisionRecoveryEvents = 10_000

type auditChainSeed struct {
	scope        Scope
	terminalHash string
	eventCount   int
}

func migrationAuditChainHeads(tx *databaseTx) error {
	seeds, err := preflightLegacyAuditChains(tx)
	if err != nil {
		return err
	}
	columns := []struct {
		name       string
		definition string
	}{
		{name: "sequence_number", definition: `INTEGER CHECK(sequence_number IS NULL OR sequence_number > 0)`},
		{name: "chain_version", definition: `INTEGER CHECK(chain_version IS NULL OR chain_version = 2)`},
	}
	for _, column := range columns {
		exists, err := columnExists(tx, "audit_events", column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := tx.Exec(fmt.Sprintf(`ALTER TABLE audit_events ADD COLUMN %s %s`, column.name, column.definition)); err != nil {
				return err
			}
		}
	}

	if _, err := tx.Exec(`CREATE TABLE audit_heads (
		tenant_id TEXT NOT NULL,
		workspace_id TEXT NOT NULL,
		head_event_hash TEXT NOT NULL,
		last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
		chain_version INTEGER NOT NULL CHECK(chain_version = 2),
		updated_at TEXT NOT NULL,
		PRIMARY KEY(tenant_id, workspace_id)
	)`); err != nil {
		return err
	}
	for _, seed := range seeds {
		if _, err := tx.Exec(`INSERT INTO audit_heads(tenant_id, workspace_id, head_event_hash, last_sequence, chain_version, updated_at)
			VALUES(?, ?, ?, ?, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, seed.scope.TenantID, seed.scope.WorkspaceID,
			seed.terminalHash, seed.eventCount); err != nil {
			return err
		}
	}

	statements := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_scope_sequence ON audit_events(tenant_id, workspace_id, sequence_number) WHERE sequence_number IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_audit_scope_chain_order ON audit_events(tenant_id, workspace_id, sequence_number DESC)`,
		`CREATE TRIGGER IF NOT EXISTS audit_events_chain_guard BEFORE INSERT ON audit_events FOR EACH ROW BEGIN
			SELECT CASE WHEN NEW.chain_version IS NOT 2 OR NEW.sequence_number IS NULL
				THEN RAISE(ABORT, 'audit_event_v2_required') END;
			SELECT CASE WHEN (SELECT COUNT(*) FROM audit_heads WHERE tenant_id = NEW.tenant_id AND workspace_id = NEW.workspace_id) <> 1
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
			return err
		}
	}
	return nil
}

func preflightLegacyAuditChains(database auditRows) ([]auditChainSeed, error) {
	if auditRowsUsePostgreSQL(database) {
		countRows, err := database.Query(`SELECT COUNT(*) FROM audit_events`)
		if err != nil {
			return nil, err
		}
		var eventCount int64
		if !countRows.Next() {
			_ = countRows.Close()
			return nil, fmt.Errorf("count legacy PostgreSQL audit events: no result")
		}
		if err := countRows.Scan(&eventCount); err != nil {
			_ = countRows.Close()
			return nil, err
		}
		if err := countRows.Close(); err != nil {
			return nil, err
		}
		if err := validateOnlineLegacyAuditRecoverySize(eventCount); err != nil {
			return nil, err
		}
	}
	scopeRows, err := database.Query(`SELECT DISTINCT tenant_id, workspace_id FROM audit_events`)
	if err != nil {
		return nil, err
	}
	scopes := make([]Scope, 0)
	for scopeRows.Next() {
		var scope Scope
		if err := scopeRows.Scan(&scope.TenantID, &scope.WorkspaceID); err != nil {
			_ = scopeRows.Close()
			return nil, err
		}
		scopes = append(scopes, scope)
	}
	if err := scopeRows.Err(); err != nil {
		_ = scopeRows.Close()
		return nil, err
	}
	if err := scopeRows.Close(); err != nil {
		return nil, err
	}

	seeds := make([]auditChainSeed, 0, len(scopes))
	for _, scope := range scopes {
		records, err := loadLegacyStoredAuditEvents(database, scope)
		if err != nil {
			return nil, err
		}
		terminal, err := validateStoredAuditEvents(records, true)
		if err != nil {
			return nil, fmt.Errorf("invalid legacy audit chain for tenant %q workspace %q: %w", scope.TenantID, scope.WorkspaceID, err)
		}
		seeds = append(seeds, auditChainSeed{scope: scope, terminalHash: terminal, eventCount: len(records)})
	}
	return seeds, nil
}

func validateOnlineLegacyAuditRecoverySize(eventCount int64) error {
	if eventCount < 0 {
		return fmt.Errorf("legacy PostgreSQL audit event count is invalid")
	}
	if eventCount > maxOnlineLegacyAuditPrecisionRecoveryEvents {
		return fmt.Errorf(
			"legacy PostgreSQL audit chain has %d events, exceeding the online precision-recovery limit %d; freeze audit writes and validate a restored offline snapshot before migration",
			eventCount, maxOnlineLegacyAuditPrecisionRecoveryEvents,
		)
	}
	return nil
}
