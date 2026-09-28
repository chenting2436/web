CREATE TABLE workbench_states (
    tenant_id TEXT NOT NULL CHECK (octet_length(tenant_id) BETWEEN 1 AND 128),
    workspace_id TEXT NOT NULL CHECK (octet_length(workspace_id) BETWEEN 1 AND 128),
    user_id TEXT NOT NULL CHECK (octet_length(user_id) BETWEEN 1 AND 128),
    slug TEXT NOT NULL CHECK (octet_length(slug) BETWEEN 1 AND 128),
    state_json JSONB NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 2 AND 1048576),
    revision BIGINT NOT NULL CHECK (revision >= 1),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, user_id, slug),
    FOREIGN KEY (tenant_id, workspace_id, user_id)
        REFERENCES memberships(tenant_id, workspace_id, user_id) ON DELETE CASCADE,
    CHECK (octet_length(convert_to(state_json::text, 'UTF8')) <= 1048576)
);

CREATE INDEX idx_workbench_states_updated
    ON workbench_states(tenant_id, workspace_id, user_id, updated_at DESC);
