package store

func migrationWorkbenchStates(tx *databaseTx) error {
	_, err := tx.Exec(`CREATE TABLE workbench_states (
		tenant_id TEXT NOT NULL CHECK(length(CAST(tenant_id AS BLOB)) BETWEEN 1 AND 128),
		workspace_id TEXT NOT NULL CHECK(length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 128),
		user_id TEXT NOT NULL CHECK(length(CAST(user_id AS BLOB)) BETWEEN 1 AND 128),
		slug TEXT NOT NULL CHECK(length(CAST(slug AS BLOB)) BETWEEN 1 AND 128),
		state_json TEXT NOT NULL CHECK(
			length(CAST(state_json AS BLOB)) BETWEEN 2 AND 1048576
			AND json_valid(state_json)
			AND json_type(state_json) = 'object'
		),
		size_bytes INTEGER NOT NULL CHECK(
			size_bytes BETWEEN 2 AND 1048576
			AND size_bytes = length(CAST(state_json AS BLOB))
		),
		revision INTEGER NOT NULL CHECK(revision >= 1),
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY(tenant_id, workspace_id, user_id, slug),
		FOREIGN KEY(tenant_id, workspace_id, user_id)
			REFERENCES memberships(tenant_id, workspace_id, user_id) ON DELETE CASCADE
	)`)
	return err
}
