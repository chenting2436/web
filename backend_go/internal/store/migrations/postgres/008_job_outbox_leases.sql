ALTER TABLE jobs
    ADD COLUMN claim_epoch BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN claim_token_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN lease_expires_at TIMESTAMPTZ,
    ADD COLUMN heartbeat_at TIMESTAMPTZ,
    ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;

-- A rolling deployment cannot safely let a pre-lease worker finish work after
-- the new ownership rules are installed. In-flight rows are therefore made
-- immediately reclaimable, while retaining their attempt history and granting
-- at least one new-style attempt.
UPDATE workbench_runs
SET status = 'queued', updated_at = CURRENT_TIMESTAMP
WHERE status = 'running'
  AND job_id IN (SELECT id FROM jobs WHERE status = 'running');

UPDATE jobs
SET status = 'queued',
    worker_id = '',
    claim_token_hash = '',
    lease_expires_at = NULL,
    heartbeat_at = NULL,
    max_attempts = GREATEST(3, attempt + 1),
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'running';

UPDATE jobs
SET max_attempts = GREATEST(3, attempt + 1)
WHERE max_attempts <= attempt;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_claim_epoch_nonnegative CHECK (claim_epoch >= 0),
    ADD CONSTRAINT jobs_max_attempts_valid CHECK (max_attempts BETWEEN 1 AND 1000),
    ADD CONSTRAINT jobs_claim_hash_format CHECK (
        claim_token_hash = '' OR claim_token_hash ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT jobs_lease_state_valid CHECK (
        (
            status = 'running'
            AND worker_id <> ''
            AND claim_token_hash <> ''
            AND lease_expires_at IS NOT NULL
            AND heartbeat_at IS NOT NULL
        )
        OR
        (
            status <> 'running'
            AND claim_token_hash = ''
            AND lease_expires_at IS NULL
            AND heartbeat_at IS NULL
        )
    );

DROP INDEX idx_jobs_queue;
CREATE INDEX idx_jobs_queue
    ON jobs(status, lease_expires_at, created_at, id)
    WHERE status IN ('queued', 'running');

ALTER TABLE outbox_events
    ADD COLUMN claim_epoch BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN claim_token_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN lease_expires_at TIMESTAMPTZ,
    ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN dead_letter_at TIMESTAMPTZ;

-- Old relay ownership is invalidated. Unprocessed messages become immediately
-- reclaimable; processed messages remain terminal.
UPDATE outbox_events
SET available_at = LEAST(available_at, CURRENT_TIMESTAMP),
    claimed_at = NULL,
    claimed_by = '',
    claim_token_hash = '',
    lease_expires_at = NULL,
    max_attempts = GREATEST(10, attempt + 1),
    updated_at = CURRENT_TIMESTAMP
WHERE processed_at IS NULL;

UPDATE outbox_events
SET claimed_at = NULL,
    claimed_by = '',
    claim_token_hash = '',
    lease_expires_at = NULL,
    max_attempts = GREATEST(10, attempt),
    updated_at = CURRENT_TIMESTAMP
WHERE processed_at IS NOT NULL;

ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_claim_epoch_nonnegative CHECK (claim_epoch >= 0),
    ADD CONSTRAINT outbox_max_attempts_valid CHECK (max_attempts BETWEEN 1 AND 10000),
    ADD CONSTRAINT outbox_claim_hash_format CHECK (
        claim_token_hash = '' OR claim_token_hash ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT outbox_terminal_exclusive CHECK (
        NOT (processed_at IS NOT NULL AND dead_letter_at IS NOT NULL)
    ),
    ADD CONSTRAINT outbox_lease_state_valid CHECK (
        (
            claim_token_hash = ''
            AND claimed_at IS NULL
            AND claimed_by = ''
            AND lease_expires_at IS NULL
        )
        OR
        (
            claim_token_hash <> ''
            AND claimed_at IS NOT NULL
            AND claimed_by <> ''
            AND lease_expires_at IS NOT NULL
            AND processed_at IS NULL
            AND dead_letter_at IS NULL
        )
    );

DROP INDEX idx_outbox_ready;
CREATE INDEX idx_outbox_ready
    ON outbox_events(available_at, lease_expires_at, created_at, id)
    WHERE processed_at IS NULL AND dead_letter_at IS NULL;

CREATE INDEX idx_outbox_dead_letter
    ON outbox_events(dead_letter_at, created_at, id)
    WHERE dead_letter_at IS NOT NULL;
