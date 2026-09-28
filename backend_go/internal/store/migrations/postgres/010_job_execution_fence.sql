ALTER TABLE jobs
    ADD COLUMN execution_started_at TIMESTAMPTZ;

ALTER TABLE jobs
    ADD CONSTRAINT jobs_execution_fence_state_valid CHECK (
        execution_started_at IS NULL
        OR (
            status = 'running'
            AND worker_id <> ''
            AND claim_token_hash <> ''
            AND lease_expires_at IS NOT NULL
        )
    );

COMMENT ON COLUMN jobs.execution_started_at IS
    'Single-use fence for the current claim epoch; reset only by a new lease claim.';
