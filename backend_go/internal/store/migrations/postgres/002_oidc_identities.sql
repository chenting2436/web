CREATE TABLE oidc_identities (
    issuer_hash TEXT NOT NULL CHECK (length(issuer_hash) = 64),
    issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
    subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (issuer_hash, subject, tenant_id),
    UNIQUE (tenant_id, user_id, issuer_hash),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_oidc_identities_user
    ON oidc_identities(tenant_id, user_id);
