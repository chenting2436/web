package store

import "fmt"

func migrationJobOutboxLeases(tx *databaseTx) error {
	columns := []struct{ table, name, definition string }{
		{"jobs", "claim_epoch", `INTEGER NOT NULL DEFAULT 0 CHECK(claim_epoch >= 0)`},
		{"jobs", "claim_token_hash", `TEXT NOT NULL DEFAULT '' CHECK(claim_token_hash = '' OR length(claim_token_hash) = 64)`},
		{"jobs", "lease_expires_at", `TEXT`},
		{"jobs", "heartbeat_at", `TEXT`},
		{"jobs", "max_attempts", `INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 1000)`},
		{"outbox_events", "claim_epoch", `INTEGER NOT NULL DEFAULT 0 CHECK(claim_epoch >= 0)`},
		{"outbox_events", "claim_token_hash", `TEXT NOT NULL DEFAULT '' CHECK(claim_token_hash = '' OR length(claim_token_hash) = 64)`},
		{"outbox_events", "lease_expires_at", `TEXT`},
		{"outbox_events", "max_attempts", `INTEGER NOT NULL DEFAULT 10 CHECK(max_attempts BETWEEN 1 AND 10000)`},
		{"outbox_events", "dead_letter_at", `TEXT`},
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

	statements := []string{
		`UPDATE workbench_runs SET status = 'queued', updated_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now')
		 WHERE status = 'running' AND job_id IN (SELECT id FROM jobs WHERE status = 'running')`,
		`UPDATE jobs SET status = 'queued', worker_id = '', claim_token_hash = '', lease_expires_at = NULL,
		 heartbeat_at = NULL, max_attempts = MAX(3, attempt + 1),
		 updated_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now') WHERE status = 'running'`,
		`UPDATE jobs SET max_attempts = MAX(3, attempt + 1) WHERE max_attempts <= attempt`,
		`UPDATE outbox_events SET available_at = MIN(available_at, STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now')),
		 claimed_at = NULL, claimed_by = '', claim_token_hash = '', lease_expires_at = NULL,
		 max_attempts = MAX(10, attempt + 1), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now')
		 WHERE processed_at IS NULL`,
		`UPDATE outbox_events SET claimed_at = NULL, claimed_by = '', claim_token_hash = '', lease_expires_at = NULL,
		 max_attempts = MAX(10, attempt), updated_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now')
		 WHERE processed_at IS NOT NULL`,
		`DROP INDEX IF EXISTS idx_jobs_queue`,
		`CREATE INDEX idx_jobs_queue ON jobs(status, lease_expires_at, created_at, id) WHERE status IN ('queued','running')`,
		`DROP INDEX IF EXISTS idx_outbox_ready`,
		`CREATE INDEX idx_outbox_ready ON outbox_events(available_at, lease_expires_at, created_at, id)
		 WHERE processed_at IS NULL AND dead_letter_at IS NULL`,
		`CREATE INDEX idx_outbox_dead_letter ON outbox_events(dead_letter_at, created_at, id) WHERE dead_letter_at IS NOT NULL`,
		`CREATE TRIGGER jobs_lease_guard_insert BEFORE INSERT ON jobs
		 WHEN NEW.claim_epoch < 0 OR NEW.max_attempts NOT BETWEEN 1 AND 1000
		 OR (NEW.claim_token_hash <> '' AND (length(NEW.claim_token_hash) <> 64 OR NEW.claim_token_hash GLOB '*[^0-9a-f]*'))
		 OR (NEW.status = 'running' AND (NEW.worker_id = '' OR NEW.claim_token_hash = '' OR NEW.lease_expires_at IS NULL OR NEW.heartbeat_at IS NULL))
		 OR (NEW.status <> 'running' AND (NEW.claim_token_hash <> '' OR NEW.lease_expires_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL))
		 BEGIN SELECT RAISE(ABORT, 'jobs_lease_state_invalid'); END`,
		`CREATE TRIGGER jobs_lease_guard_update BEFORE UPDATE ON jobs
		 WHEN NEW.claim_epoch < 0 OR NEW.max_attempts NOT BETWEEN 1 AND 1000
		 OR (NEW.claim_token_hash <> '' AND (length(NEW.claim_token_hash) <> 64 OR NEW.claim_token_hash GLOB '*[^0-9a-f]*'))
		 OR (NEW.status = 'running' AND (NEW.worker_id = '' OR NEW.claim_token_hash = '' OR NEW.lease_expires_at IS NULL OR NEW.heartbeat_at IS NULL))
		 OR (NEW.status <> 'running' AND (NEW.claim_token_hash <> '' OR NEW.lease_expires_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL))
		 BEGIN SELECT RAISE(ABORT, 'jobs_lease_state_invalid'); END`,
		`CREATE TRIGGER outbox_lease_guard_insert BEFORE INSERT ON outbox_events
		 WHEN NEW.claim_epoch < 0 OR NEW.max_attempts NOT BETWEEN 1 AND 10000
		 OR (NEW.claim_token_hash <> '' AND (length(NEW.claim_token_hash) <> 64 OR NEW.claim_token_hash GLOB '*[^0-9a-f]*'))
		 OR (NEW.processed_at IS NOT NULL AND NEW.dead_letter_at IS NOT NULL)
		 OR (NEW.claim_token_hash = '' AND (NEW.claimed_at IS NOT NULL OR NEW.claimed_by <> '' OR NEW.lease_expires_at IS NOT NULL))
		 OR (NEW.claim_token_hash <> '' AND (NEW.claimed_at IS NULL OR NEW.claimed_by = '' OR NEW.lease_expires_at IS NULL OR NEW.processed_at IS NOT NULL OR NEW.dead_letter_at IS NOT NULL))
		 BEGIN SELECT RAISE(ABORT, 'outbox_lease_state_invalid'); END`,
		`CREATE TRIGGER outbox_lease_guard_update BEFORE UPDATE ON outbox_events
		 WHEN NEW.claim_epoch < 0 OR NEW.max_attempts NOT BETWEEN 1 AND 10000
		 OR (NEW.claim_token_hash <> '' AND (length(NEW.claim_token_hash) <> 64 OR NEW.claim_token_hash GLOB '*[^0-9a-f]*'))
		 OR (NEW.processed_at IS NOT NULL AND NEW.dead_letter_at IS NOT NULL)
		 OR (NEW.claim_token_hash = '' AND (NEW.claimed_at IS NOT NULL OR NEW.claimed_by <> '' OR NEW.lease_expires_at IS NOT NULL))
		 OR (NEW.claim_token_hash <> '' AND (NEW.claimed_at IS NULL OR NEW.claimed_by = '' OR NEW.lease_expires_at IS NULL OR NEW.processed_at IS NOT NULL OR NEW.dead_letter_at IS NOT NULL))
		 BEGIN SELECT RAISE(ABORT, 'outbox_lease_state_invalid'); END`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
