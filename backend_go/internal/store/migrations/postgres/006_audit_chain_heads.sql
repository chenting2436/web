ALTER TABLE audit_events
    ADD COLUMN sequence_number BIGINT,
    ADD COLUMN chain_version SMALLINT;

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_chain_fields_valid CHECK (
        (sequence_number IS NULL AND chain_version IS NULL)
        OR (sequence_number > 0 AND chain_version = 2)
    );

-- Refuse to establish a head for any legacy graph that is not one complete,
-- non-branching chain. Choosing one of multiple terminal events here would
-- conceal an already-forked audit history.
DO $audit_chain_validation$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM audit_events child
        WHERE child.previous_event_hash <> ''
          AND NOT EXISTS (
              SELECT 1
              FROM audit_events parent
              WHERE parent.tenant_id = child.tenant_id
                AND parent.workspace_id = child.workspace_id
                AND parent.event_hash = child.previous_event_hash
          )
    ) THEN
        RAISE EXCEPTION 'invalid legacy audit chain: missing or cross-scope predecessor';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM audit_events
        GROUP BY tenant_id, workspace_id
        HAVING COUNT(*) FILTER (WHERE previous_event_hash = '') <> 1
    ) THEN
        RAISE EXCEPTION 'invalid legacy audit chain: each scope must have exactly one root';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM audit_events
        WHERE previous_event_hash <> ''
        GROUP BY tenant_id, workspace_id, previous_event_hash
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'invalid legacy audit chain: predecessor has multiple children';
    END IF;

    IF EXISTS (
        WITH scope_counts AS (
            SELECT tenant_id, workspace_id, COUNT(*) AS event_count
            FROM audit_events
            GROUP BY tenant_id, workspace_id
        ), terminal_counts AS (
            SELECT candidate.tenant_id, candidate.workspace_id, COUNT(*) AS terminal_count
            FROM audit_events candidate
            WHERE NOT EXISTS (
                SELECT 1
                FROM audit_events child
                WHERE child.tenant_id = candidate.tenant_id
                  AND child.workspace_id = candidate.workspace_id
                  AND child.previous_event_hash = candidate.event_hash
            )
            GROUP BY candidate.tenant_id, candidate.workspace_id
        )
        SELECT 1
        FROM scope_counts
        LEFT JOIN terminal_counts USING (tenant_id, workspace_id)
        WHERE COALESCE(terminal_counts.terminal_count, 0) <> 1
    ) THEN
        RAISE EXCEPTION 'invalid legacy audit chain: each scope must have exactly one terminal event';
    END IF;

    IF EXISTS (
        WITH RECURSIVE reachable AS (
            SELECT tenant_id, workspace_id, event_hash
            FROM audit_events
            WHERE previous_event_hash = ''
            UNION ALL
            SELECT child.tenant_id, child.workspace_id, child.event_hash
            FROM reachable parent
            JOIN audit_events child
              ON child.tenant_id = parent.tenant_id
             AND child.workspace_id = parent.workspace_id
             AND child.previous_event_hash = parent.event_hash
        ), totals AS (
            SELECT tenant_id, workspace_id, COUNT(*) AS event_count
            FROM audit_events
            GROUP BY tenant_id, workspace_id
        ), reached AS (
            SELECT tenant_id, workspace_id, COUNT(*) AS event_count
            FROM reachable
            GROUP BY tenant_id, workspace_id
        )
        SELECT 1
        FROM totals
        LEFT JOIN reached USING (tenant_id, workspace_id)
        WHERE totals.event_count <> COALESCE(reached.event_count, 0)
    ) THEN
        RAISE EXCEPTION 'invalid legacy audit chain: cycle or disconnected component';
    END IF;
END;
$audit_chain_validation$;

CREATE TABLE audit_heads (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    head_event_hash TEXT NOT NULL,
    last_sequence BIGINT NOT NULL CHECK (last_sequence >= 0),
    chain_version SMALLINT NOT NULL CHECK (chain_version = 2),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, workspace_id)
);

INSERT INTO audit_heads(tenant_id, workspace_id, head_event_hash, last_sequence, chain_version)
SELECT terminal.tenant_id, terminal.workspace_id, terminal.event_hash, totals.event_count, 2
FROM audit_events terminal
JOIN (
    SELECT tenant_id, workspace_id, COUNT(*) AS event_count
    FROM audit_events
    GROUP BY tenant_id, workspace_id
) totals USING (tenant_id, workspace_id)
WHERE NOT EXISTS (
    SELECT 1
    FROM audit_events child
    WHERE child.tenant_id = terminal.tenant_id
      AND child.workspace_id = terminal.workspace_id
      AND child.previous_event_hash = terminal.event_hash
);

CREATE UNIQUE INDEX idx_audit_scope_sequence
    ON audit_events(tenant_id, workspace_id, sequence_number)
    WHERE sequence_number IS NOT NULL;

CREATE INDEX idx_audit_scope_chain_order
    ON audit_events(tenant_id, workspace_id, sequence_number DESC);

CREATE FUNCTION validate_audit_event_chain_insert() RETURNS trigger
LANGUAGE plpgsql
AS $audit_chain_guard$
DECLARE
    expected_hash TEXT;
    expected_sequence BIGINT;
BEGIN
    SELECT head_event_hash, last_sequence + 1
      INTO expected_hash, expected_sequence
      FROM audit_heads
     WHERE tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'audit_head_missing';
    END IF;
    IF NEW.chain_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'audit_event_v2_required';
    END IF;
    IF NEW.previous_event_hash IS DISTINCT FROM expected_hash THEN
        RAISE EXCEPTION 'audit_predecessor_mismatch';
    END IF;
    IF NEW.sequence_number IS DISTINCT FROM expected_sequence THEN
        RAISE EXCEPTION 'audit_sequence_mismatch';
    END IF;
    RETURN NEW;
END;
$audit_chain_guard$;

CREATE TRIGGER audit_events_chain_guard
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION validate_audit_event_chain_insert();
