package store

import (
	"fmt"
	"time"
)

type migration struct {
	version int
	name    string
	apply   func(*databaseTx) error
}

func (store *ProjectStore) prepareSchema(applyMigrations bool) error {
	if store.adapter == AdapterPostgreSQL {
		if applyMigrations {
			return store.migratePostgreSQL()
		}
		return store.validatePostgreSQLSchema()
	}
	return store.migrateSQLite()
}

func (store *ProjectStore) migrateSQLite() error {
	if _, err := store.database.Exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`); err != nil {
		return fmt.Errorf("configure sqlite: %w", err)
	}
	if _, err := store.database.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("create migration ledger: %w", err)
	}

	for _, item := range sqliteMigrations() {
		var applied int
		if err := store.database.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, item.version).Scan(&applied); err != nil {
			return err
		}
		if applied > 0 {
			continue
		}
		tx, err := store.database.Begin()
		if err != nil {
			return err
		}
		if err := item.apply(tx); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %d (%s): %w", item.version, item.name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)`, item.version, item.name, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func sqliteMigrations() []migration {
	return []migration{
		{version: 1, name: "legacy_project_tables", apply: migrationLegacyTables},
		{version: 2, name: "identity_tenant_job_audit_foundation", apply: migrationFoundation},
		{version: 3, name: "oidc_external_identity_binding", apply: migrationOIDCIdentities},
		{version: 4, name: "canonical_user_emails", apply: migrationCanonicalUserEmails},
		{version: 5, name: "transactional_outbox", apply: migrationTransactionalOutbox},
		{version: 6, name: "oidc_login_transactions", apply: migrationOIDCLoginTransactions},
		{version: 7, name: "audit_chain_heads", apply: migrationAuditChainHeads},
		{version: 8, name: "workbench_states", apply: migrationWorkbenchStates},
		{version: 9, name: "job_outbox_leases", apply: migrationJobOutboxLeases},
		{version: 10, name: "job_execution_fence", apply: migrationJobExecutionFence},
		{version: 11, name: "audit_chain_v3", apply: migrationAuditChainV3},
	}
}

func (store *ProjectStore) validateExistingSchema() error {
	if store.adapter == AdapterPostgreSQL {
		return store.validatePostgreSQLSchema()
	}
	// These are connection-local safeguards, not schema/data mutations.
	if _, err := store.database.Exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`); err != nil {
		return fmt.Errorf("configure existing sqlite schema connection: %w", err)
	}
	items := sqliteMigrations()
	for _, item := range items {
		var name string
		if err := store.database.QueryRow(`SELECT name FROM schema_migrations WHERE version = ?`, item.version).Scan(&name); err != nil || name != item.name {
			return fmt.Errorf("%w: SQLite migration %d is missing or mismatched", ErrSchemaNotCurrent, item.version)
		}
	}
	var unsupported int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version > ?`, items[len(items)-1].version).Scan(&unsupported); err != nil {
		return fmt.Errorf("%w: cannot validate future SQLite migrations", ErrSchemaNotCurrent)
	}
	if unsupported != 0 {
		return fmt.Errorf("%w: database contains newer SQLite migrations", ErrSchemaNotCurrent)
	}
	return nil
}

func migrationLegacyTables(tx *databaseTx) error {
	_, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY, scope TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
			state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_projects_scope_slug ON projects(scope, slug, updated_at DESC);
		CREATE TABLE IF NOT EXISTS project_versions (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			scope TEXT NOT NULL, label TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS workbench_runs (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			scope TEXT NOT NULL, slug TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
			input_json TEXT NOT NULL, result_json TEXT NOT NULL, error_text TEXT NOT NULL,
			duration_ms REAL NOT NULL, created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS shared_records (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, data_json TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
	`)
	return err
}

func migrationFoundation(tx *databaseTx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS tenants (
			id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','suspended')),
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL,
			display_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','disabled')),
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(tenant_id, email)
		)`,
		`CREATE TABLE IF NOT EXISTS workspaces (
			id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active','archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			UNIQUE(tenant_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS memberships (
			tenant_id TEXT NOT NULL REFERENCES tenants(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
			user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('admin','researcher','teacher','student','reviewer','viewer')),
			status TEXT NOT NULL CHECK(status IN ('active','suspended')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			PRIMARY KEY(tenant_id, workspace_id, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
			expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
			FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
			created_by_user_id TEXT NOT NULL, slug TEXT NOT NULL, action TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')),
			input_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', error_text TEXT NOT NULL DEFAULT '',
			idempotency_key TEXT NOT NULL DEFAULT '', attempt INTEGER NOT NULL DEFAULT 0, worker_id TEXT NOT NULL DEFAULT '',
			duration_ms REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
			FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(tenant_id, workspace_id, created_by_user_id, idempotency_key) WHERE idempotency_key <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(tenant_id, workspace_id, project_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
			action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL,
			request_id TEXT NOT NULL, source_ip TEXT NOT NULL, user_agent TEXT NOT NULL,
			before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, metadata_json TEXT NOT NULL,
			previous_event_hash TEXT NOT NULL, event_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_scope_time ON audit_events(tenant_id, workspace_id, created_at DESC)`,
		`CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
		`CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}

	columns := []struct{ table, name, definition string }{
		{"projects", "tenant_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"projects", "workspace_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"projects", "owner_user_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"project_versions", "tenant_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"project_versions", "workspace_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"project_versions", "created_by_user_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"workbench_runs", "tenant_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"workbench_runs", "workspace_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"workbench_runs", "created_by_user_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"workbench_runs", "job_id", `TEXT NOT NULL DEFAULT ''`},
		{"workbench_runs", "updated_at", `TEXT NOT NULL DEFAULT ''`},
		{"shared_records", "tenant_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"shared_records", "workspace_id", `TEXT NOT NULL DEFAULT 'legacy'`},
		{"shared_records", "owner_user_id", `TEXT NOT NULL DEFAULT 'legacy'`},
	}
	for _, column := range columns {
		exists, err := columnExists(tx, column.table, column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := tx.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, column.table, column.name, column.definition)); err != nil {
				return err
			}
		}
	}

	indexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_projects_tenant_workspace_slug ON projects(tenant_id, workspace_id, slug, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_versions_tenant_project ON project_versions(tenant_id, workspace_id, project_id, created_at DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_job ON workbench_runs(job_id) WHERE job_id <> ''`,
		`CREATE INDEX IF NOT EXISTS idx_runs_tenant_project ON workbench_runs(tenant_id, workspace_id, project_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_shared_tenant_kind ON shared_records(tenant_id, workspace_id, kind, updated_at DESC)`,
	}
	for _, statement := range indexes {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	_, err := tx.Exec(`UPDATE workbench_runs SET updated_at = created_at WHERE updated_at = ''`)
	return err
}

func columnExists(tx *databaseTx, table, column string) (bool, error) {
	rows, err := tx.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull, primaryKey int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}
