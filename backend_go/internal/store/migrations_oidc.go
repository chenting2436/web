package store

func migrationOIDCIdentities(tx *databaseTx) error {
	statements := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id, id)`,
		`CREATE TABLE IF NOT EXISTS oidc_identities (
			issuer_hash TEXT NOT NULL CHECK(length(issuer_hash) = 64),
			issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 2048),
			subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
			tenant_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			PRIMARY KEY(issuer_hash, subject, tenant_id),
			UNIQUE(tenant_id, user_id, issuer_hash),
			FOREIGN KEY(tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_oidc_identities_user ON oidc_identities(tenant_id, user_id)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func migrationCanonicalUserEmails(tx *databaseTx) error {
	// Build the case-insensitive uniqueness guard before rewriting legacy rows.
	// Existing case-only duplicates therefore abort and roll back the migration
	// instead of being merged onto an arbitrary external identity.
	statements := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_canonical ON users(tenant_id, lower(email))`,
		`UPDATE users SET email = lower(trim(email))`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
