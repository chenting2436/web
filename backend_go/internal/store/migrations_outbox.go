package store

func migrationTransactionalOutbox(tx *databaseTx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS outbox_events (
			id TEXT PRIMARY KEY,
			tenant_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			aggregate_type TEXT NOT NULL,
			aggregate_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
			available_at TEXT NOT NULL,
			claimed_at TEXT,
			claimed_by TEXT NOT NULL DEFAULT '',
			processed_at TEXT,
			last_error TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY(tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox_events(processed_at, claimed_at, available_at, created_at, id)`,
		`CREATE INDEX IF NOT EXISTS idx_outbox_scope_aggregate ON outbox_events(tenant_id, workspace_id, aggregate_type, aggregate_id, created_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
