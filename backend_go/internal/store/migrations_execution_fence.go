package store

import "fmt"

func migrationJobExecutionFence(tx *databaseTx) error {
	exists, err := columnExists(tx, "jobs", "execution_started_at")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(`ALTER TABLE jobs ADD COLUMN execution_started_at TEXT`); err != nil {
			return fmt.Errorf("add job execution fence: %w", err)
		}
	}
	for _, statement := range []string{
		`CREATE TRIGGER jobs_execution_fence_guard_insert BEFORE INSERT ON jobs
		 WHEN NEW.execution_started_at IS NOT NULL AND (
			NEW.status <> 'running' OR NEW.worker_id = '' OR NEW.claim_token_hash = '' OR NEW.lease_expires_at IS NULL
		 ) BEGIN SELECT RAISE(ABORT, 'jobs_execution_fence_state_invalid'); END`,
		`CREATE TRIGGER jobs_execution_fence_guard_update BEFORE UPDATE ON jobs
		 WHEN NEW.execution_started_at IS NOT NULL AND (
			NEW.status <> 'running' OR NEW.worker_id = '' OR NEW.claim_token_hash = '' OR NEW.lease_expires_at IS NULL
		 ) BEGIN SELECT RAISE(ABORT, 'jobs_execution_fence_state_invalid'); END`,
	} {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
