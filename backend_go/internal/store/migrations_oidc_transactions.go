package store

func migrationOIDCLoginTransactions(tx *databaseTx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS oidc_login_transactions (
			state_hash TEXT PRIMARY KEY CHECK(length(state_hash) = 64),
			sealed_payload BLOB NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_oidc_login_transactions_expiry ON oidc_login_transactions(expires_at)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
