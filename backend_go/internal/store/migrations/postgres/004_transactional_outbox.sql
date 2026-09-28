CREATE TABLE outbox_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    available_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ,
    claimed_by TEXT NOT NULL DEFAULT '',
    processed_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id)
);

CREATE INDEX idx_outbox_ready
    ON outbox_events(available_at, created_at, id)
    WHERE processed_at IS NULL AND claimed_at IS NULL;

CREATE INDEX idx_outbox_scope_aggregate
    ON outbox_events(tenant_id, workspace_id, aggregate_type, aggregate_id, created_at DESC);
