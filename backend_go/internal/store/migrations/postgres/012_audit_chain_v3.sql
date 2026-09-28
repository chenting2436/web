-- Audit v3 replaces newline-delimited hashing with named, UTF-8 byte-length
-- frames. Existing v1/v2 rows remain immutable and verifiable; only the
-- current writable head and secured append entry point advance to v3.
--
-- Before changing any catalog object, prove that the complete PG011 security
-- contract still matches the live public-schema catalog. This is deliberately
-- bidirectional: a missing object, an unsealed extra object, a NULL hash, or a
-- changed definition all abort the migration before its first persistent
-- mutation. The PG011 ledger remains the immutable input to this check; it is
-- only replaced after every v3 change and golden-vector assertion succeeds.
DO $runtime_security_contract_preflight$
DECLARE
    mismatch RECORD;
BEGIN
    IF to_regclass('public.runtime_security_contracts') IS NULL THEN
        RAISE EXCEPTION 'runtime_security_contract_preflight_missing_ledger'
            USING ERRCODE = '55000';
    END IF;

    WITH current_security_contracts(object_kind, object_identity, definition_hash) AS (
        SELECT
            'policy',
            relation.relname || '.' || policy.polname,
            encode(sha256(convert_to(array_to_string(ARRAY[
                policy.polcmd::text,
                policy.polpermissive::text,
                policy.polroles::text,
                COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''),
                COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
            ], chr(10)), 'UTF8')), 'hex')
        FROM pg_policy policy
        JOIN pg_class relation ON relation.oid = policy.polrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'

        UNION ALL

        SELECT
            'function',
            function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')',
            encode(sha256(convert_to(array_to_string(ARRAY[
                pg_get_userbyid(function_entry.proowner),
                function_entry.prosecdef::text,
                COALESCE(function_entry.proconfig::text, ''),
                pg_get_functiondef(function_entry.oid)
            ], chr(10)), 'UTF8')), 'hex')
        FROM pg_proc function_entry
        JOIN pg_namespace namespace ON namespace.oid = function_entry.pronamespace
        WHERE namespace.nspname = 'public'

        UNION ALL

        SELECT
            'trigger',
            relation.relname || '.' || trigger_entry.tgname,
            encode(sha256(convert_to(array_to_string(ARRAY[
                trigger_entry.tgenabled::text,
                pg_get_triggerdef(trigger_entry.oid, true)
            ], chr(10)), 'UTF8')), 'hex')
        FROM pg_trigger trigger_entry
        JOIN pg_class relation ON relation.oid = trigger_entry.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND NOT trigger_entry.tgisinternal
    ), contract_mismatches AS (
        SELECT
            COALESCE(sealed.object_kind, current_contract.object_kind) AS object_kind,
            COALESCE(sealed.object_identity, current_contract.object_identity) AS object_identity,
            sealed.definition_hash AS sealed_hash,
            current_contract.definition_hash AS current_hash
        FROM public.runtime_security_contracts sealed
        FULL OUTER JOIN current_security_contracts current_contract
          ON current_contract.object_kind = sealed.object_kind
         AND current_contract.object_identity = sealed.object_identity
        WHERE sealed.object_identity IS NULL
           OR current_contract.object_identity IS NULL
           OR sealed.definition_hash IS NULL
           OR current_contract.definition_hash IS NULL
           OR sealed.definition_hash IS DISTINCT FROM current_contract.definition_hash
    )
    SELECT object_kind, object_identity, sealed_hash, current_hash
      INTO mismatch
      FROM contract_mismatches
     ORDER BY object_kind, object_identity
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'runtime_security_contract_preflight_mismatch:%:%:sealed=%:live=%',
            mismatch.object_kind,
            mismatch.object_identity,
            COALESCE(mismatch.sealed_hash, '<missing-or-null>'),
            COALESCE(mismatch.current_hash, '<missing-or-null>')
            USING ERRCODE = '55000';
    END IF;
END;
$runtime_security_contract_preflight$;

DO $audit_v3_preflight$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.audit_events
        WHERE NOT (
            (sequence_number IS NULL AND chain_version IS NULL)
            OR (sequence_number > 0 AND chain_version = 2)
        )
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_invalid_event_version';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_heads WHERE chain_version <> 2) THEN
        RAISE EXCEPTION 'audit_v3_preflight_invalid_head_version';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.audit_events event
        WHERE NOT EXISTS (
            SELECT 1 FROM public.audit_heads head
            WHERE head.tenant_id = event.tenant_id
              AND head.workspace_id = event.workspace_id
        )
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_missing_head';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.audit_events child
        WHERE child.previous_event_hash <> ''
          AND NOT EXISTS (
              SELECT 1 FROM public.audit_events parent
              WHERE parent.tenant_id = child.tenant_id
                AND parent.workspace_id = child.workspace_id
                AND parent.event_hash = child.previous_event_hash
          )
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_missing_or_cross_scope_predecessor';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.audit_events
        GROUP BY tenant_id, workspace_id
        HAVING COUNT(*) FILTER (WHERE previous_event_hash = '') <> 1
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_invalid_root_count';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.audit_events
        WHERE previous_event_hash <> ''
        GROUP BY tenant_id, workspace_id, previous_event_hash
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_fork';
    END IF;
    IF EXISTS (
        WITH RECURSIVE reachable AS (
            SELECT event.tenant_id, event.workspace_id, event.event_hash,
                   event.chain_version, event.sequence_number, 1::BIGINT AS depth
            FROM public.audit_events event
            WHERE event.previous_event_hash = ''
            UNION ALL
            SELECT child.tenant_id, child.workspace_id, child.event_hash,
                   child.chain_version, child.sequence_number, parent.depth + 1
            FROM reachable parent
            JOIN public.audit_events child
              ON child.tenant_id = parent.tenant_id
             AND child.workspace_id = parent.workspace_id
             AND child.previous_event_hash = parent.event_hash
        ), totals AS (
            SELECT tenant_id, workspace_id, COUNT(*) AS event_count
            FROM public.audit_events
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
        RAISE EXCEPTION 'audit_v3_preflight_cycle_or_disconnected_component';
    END IF;
    IF EXISTS (
        WITH RECURSIVE reachable AS (
            SELECT event.tenant_id, event.workspace_id, event.event_hash,
                   event.previous_event_hash, event.chain_version,
                   event.sequence_number, 1::BIGINT AS depth
            FROM public.audit_events event
            WHERE event.previous_event_hash = ''
            UNION ALL
            SELECT child.tenant_id, child.workspace_id, child.event_hash,
                   child.previous_event_hash, child.chain_version,
                   child.sequence_number, parent.depth + 1
            FROM reachable parent
            JOIN public.audit_events child
              ON child.tenant_id = parent.tenant_id
             AND child.workspace_id = parent.workspace_id
             AND child.previous_event_hash = parent.event_hash
        )
        SELECT 1 FROM reachable
        WHERE (chain_version = 2 AND sequence_number <> depth)
           OR (chain_version IS NULL AND sequence_number IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_sequence_mismatch';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.audit_events child
        JOIN public.audit_events parent
          ON parent.tenant_id = child.tenant_id
         AND parent.workspace_id = child.workspace_id
         AND parent.event_hash = child.previous_event_hash
        WHERE COALESCE(child.chain_version, 1) < COALESCE(parent.chain_version, 1)
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_version_regression';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.audit_heads head
        WHERE head.last_sequence <> (
                  SELECT COUNT(*) FROM public.audit_events event
                  WHERE event.tenant_id = head.tenant_id
                    AND event.workspace_id = head.workspace_id
              )
           OR head.head_event_hash <> COALESCE((
                  SELECT terminal.event_hash
                  FROM public.audit_events terminal
                  WHERE terminal.tenant_id = head.tenant_id
                    AND terminal.workspace_id = head.workspace_id
                    AND NOT EXISTS (
                        SELECT 1 FROM public.audit_events child
                        WHERE child.tenant_id = terminal.tenant_id
                          AND child.workspace_id = terminal.workspace_id
                          AND child.previous_event_hash = terminal.event_hash
                    )
              ), '')
    ) THEN
        RAISE EXCEPTION 'audit_v3_preflight_head_mismatch';
    END IF;
END;
$audit_v3_preflight$;

ALTER TABLE public.audit_events
    DROP CONSTRAINT audit_events_chain_fields_valid;
ALTER TABLE public.audit_events
    ADD CONSTRAINT audit_events_chain_fields_valid CHECK (
        (sequence_number IS NULL AND chain_version IS NULL)
        OR (sequence_number > 0 AND chain_version IN (2, 3))
    );

ALTER TABLE public.audit_heads
    DROP CONSTRAINT audit_heads_chain_version_check;
UPDATE public.audit_heads SET chain_version = 3;
ALTER TABLE public.audit_heads
    ADD CONSTRAINT audit_heads_chain_version_v3_valid CHECK (chain_version = 3);

CREATE OR REPLACE FUNCTION public.validate_audit_event_chain_insert() RETURNS trigger
LANGUAGE plpgsql
AS $audit_chain_guard$
DECLARE
    expected_hash TEXT;
    expected_sequence BIGINT;
    expected_chain_version SMALLINT;
BEGIN
    SELECT head_event_hash, last_sequence + 1, chain_version
      INTO expected_hash, expected_sequence, expected_chain_version
      FROM public.audit_heads
     WHERE tenant_id = NEW.tenant_id
       AND workspace_id = NEW.workspace_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'audit_head_missing';
    END IF;
    IF expected_chain_version <> 3 OR NEW.chain_version IS DISTINCT FROM 3 THEN
        RAISE EXCEPTION 'audit_event_v3_required';
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

CREATE FUNCTION public.audit_chain_v3_frame(p_name TEXT, p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $audit_chain_v3_frame$
    SELECT octet_length(p_name)::text || ':' || p_name
        || octet_length(p_value)::text || ':' || p_value
$audit_chain_v3_frame$;

REVOKE ALL PRIVILEGES ON FUNCTION public.audit_chain_v3_frame(TEXT, TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.audit_chain_v3_frame(TEXT, TEXT)
IS 'Internal audit-v3 named UTF-8 byte-length frame encoder; not runtime-executable';

CREATE FUNCTION public.append_audit_event_v3(
    p_id TEXT,
    p_tenant_id TEXT,
    p_workspace_id TEXT,
    p_actor_user_id TEXT,
    p_action TEXT,
    p_resource_type TEXT,
    p_resource_id TEXT,
    p_outcome TEXT,
    p_request_id TEXT,
    p_source_ip TEXT,
    p_user_agent TEXT,
    p_before_hash TEXT,
    p_after_hash TEXT,
    p_metadata_text TEXT
)
RETURNS TABLE (
    appended_sequence BIGINT,
    appended_previous_event_hash TEXT,
    appended_event_hash TEXT,
    appended_created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $secured_audit_append_v3$
DECLARE
    metadata_value JSONB;
    created_at_value TIMESTAMPTZ;
    canonical_created_at_text TEXT;
    current_head_hash TEXT;
    current_last_sequence BIGINT;
    current_chain_version SMALLINT;
    next_sequence BIGINT;
    canonical_payload TEXT;
    calculated_event_hash TEXT;
    actor_kind TEXT;
    context_worker_id TEXT;
    context_worker_scopes JSONB;
    job_slug TEXT;
    job_action TEXT;
BEGIN
    IF p_id IS NULL OR p_tenant_id IS NULL OR p_workspace_id IS NULL
       OR p_actor_user_id IS NULL OR p_action IS NULL OR p_resource_type IS NULL
       OR p_resource_id IS NULL OR p_outcome IS NULL OR p_request_id IS NULL
       OR p_source_ip IS NULL OR p_user_agent IS NULL OR p_before_hash IS NULL
       OR p_after_hash IS NULL OR p_metadata_text IS NULL
       OR p_id = '' OR p_tenant_id = '' OR p_workspace_id = '' THEN
        RAISE EXCEPTION 'audit_argument_invalid' USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_id) > 128
       OR octet_length(p_tenant_id) > 128
       OR octet_length(p_workspace_id) > 128
       OR octet_length(p_actor_user_id) > 256
       OR octet_length(p_action) > 256
       OR octet_length(p_resource_type) > 256
       OR octet_length(p_resource_id) > 512
       OR octet_length(p_outcome) > 128
       OR octet_length(p_request_id) > 256
       OR octet_length(p_source_ip) > 256
       OR octet_length(p_user_agent) > 8192
       OR octet_length(p_before_hash) > 256
       OR octet_length(p_after_hash) > 256
       OR octet_length(p_metadata_text) NOT BETWEEN 2 AND 1048576 THEN
        RAISE EXCEPTION 'audit_argument_too_large' USING ERRCODE = '22023';
    END IF;

    actor_kind := COALESCE(current_setting('skyview.actor_kind', true), '');
    IF actor_kind = 'user' THEN
        IF p_tenant_id <> COALESCE(current_setting('skyview.tenant_id', true), '')
           OR p_workspace_id <> COALESCE(current_setting('skyview.workspace_id', true), '')
           OR p_actor_user_id <> COALESCE(current_setting('skyview.user_id', true), '') THEN
            RAISE EXCEPTION 'audit_scope_denied' USING ERRCODE = '42501';
        END IF;
    ELSIF actor_kind = 'worker' THEN
        context_worker_id := COALESCE(current_setting('skyview.worker_id', true), '');
        IF context_worker_id = '' OR p_actor_user_id <> 'worker:' || context_worker_id
           OR p_resource_type <> 'job' THEN
            RAISE EXCEPTION 'audit_scope_denied' USING ERRCODE = '42501';
        END IF;
        BEGIN
            context_worker_scopes := COALESCE(
                NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]'
            )::jsonb;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'audit_scope_denied' USING ERRCODE = '42501';
        END;
        SELECT scoped_job.slug, scoped_job.action
          INTO job_slug, job_action
          FROM public.jobs scoped_job
         WHERE scoped_job.id = p_resource_id
           AND scoped_job.tenant_id = p_tenant_id
           AND scoped_job.workspace_id = p_workspace_id;
        IF NOT FOUND OR NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(context_worker_scopes) AS worker_scope(value)
             WHERE worker_scope.value->>'tenantId' = p_tenant_id
               AND worker_scope.value->>'workspaceId' = p_workspace_id
               AND worker_scope.value->>'slug' = job_slug
               AND EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                    WHERE allowed_action.value = job_action
               )
        ) THEN
            RAISE EXCEPTION 'audit_scope_denied' USING ERRCODE = '42501';
        END IF;
    ELSE
        RAISE EXCEPTION 'audit_context_required' USING ERRCODE = '42501';
    END IF;

    BEGIN
        metadata_value := p_metadata_text::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit_metadata_invalid' USING ERRCODE = '22023';
    END;
    IF jsonb_typeof(metadata_value) <> 'object' THEN
        RAISE EXCEPTION 'audit_metadata_must_be_object' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.audit_heads(
        tenant_id, workspace_id, head_event_hash, last_sequence, chain_version, updated_at
    ) VALUES (
        p_tenant_id, p_workspace_id, '', 0, 3, CURRENT_TIMESTAMP
    ) ON CONFLICT(tenant_id, workspace_id) DO NOTHING;

    SELECT head_event_hash, last_sequence, chain_version
      INTO current_head_hash, current_last_sequence, current_chain_version
      FROM public.audit_heads
     WHERE tenant_id = p_tenant_id
       AND workspace_id = p_workspace_id
     FOR UPDATE;

    IF NOT FOUND OR current_chain_version <> 3 THEN
        RAISE EXCEPTION 'audit_head_invalid' USING ERRCODE = '55000';
    END IF;
    IF current_last_sequence = 9223372036854775807 THEN
        RAISE EXCEPTION 'audit_sequence_exhausted' USING ERRCODE = '22003';
    END IF;
    next_sequence := current_last_sequence + 1;

    created_at_value := clock_timestamp();
    canonical_created_at_text := to_char(
        created_at_value AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    );
    canonical_created_at_text := regexp_replace(canonical_created_at_text, '0+Z$', 'Z');
    canonical_created_at_text := replace(canonical_created_at_text, '.Z', 'Z');

    canonical_payload := array_to_string(ARRAY[
        public.audit_chain_v3_frame('format', 'skyviewlab.audit.v3'),
        public.audit_chain_v3_frame('chain_version', '3'),
        public.audit_chain_v3_frame('sequence_number', next_sequence::text),
        public.audit_chain_v3_frame('id', p_id),
        public.audit_chain_v3_frame('tenant_id', p_tenant_id),
        public.audit_chain_v3_frame('workspace_id', p_workspace_id),
        public.audit_chain_v3_frame('actor_user_id', p_actor_user_id),
        public.audit_chain_v3_frame('action', p_action),
        public.audit_chain_v3_frame('resource_type', p_resource_type),
        public.audit_chain_v3_frame('resource_id', p_resource_id),
        public.audit_chain_v3_frame('outcome', p_outcome),
        public.audit_chain_v3_frame('request_id', p_request_id),
        public.audit_chain_v3_frame('source_ip', p_source_ip),
        public.audit_chain_v3_frame('user_agent', p_user_agent),
        public.audit_chain_v3_frame('before_hash', p_before_hash),
        public.audit_chain_v3_frame('after_hash', p_after_hash),
        public.audit_chain_v3_frame('metadata_json', p_metadata_text),
        public.audit_chain_v3_frame('previous_event_hash', current_head_hash),
        public.audit_chain_v3_frame('created_at', canonical_created_at_text)
    ], '');
    calculated_event_hash := encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex');

    INSERT INTO public.audit_events(
        id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
        outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
        previous_event_hash, event_hash, sequence_number, chain_version, created_at,
        hash_metadata_text
    ) VALUES (
        p_id, p_tenant_id, p_workspace_id, p_actor_user_id, p_action, p_resource_type,
        p_resource_id, p_outcome, p_request_id, p_source_ip, p_user_agent, p_before_hash,
        p_after_hash, metadata_value, current_head_hash, calculated_event_hash,
        next_sequence, 3, created_at_value, p_metadata_text
    );

    UPDATE public.audit_heads
       SET head_event_hash = calculated_event_hash,
           last_sequence = next_sequence,
           chain_version = 3,
           updated_at = created_at_value
     WHERE tenant_id = p_tenant_id
       AND workspace_id = p_workspace_id
       AND head_event_hash = current_head_hash
       AND last_sequence = current_last_sequence
       AND chain_version = 3;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'audit_head_changed' USING ERRCODE = '40001';
    END IF;

    RETURN QUERY SELECT next_sequence, current_head_hash, calculated_event_hash, created_at_value;
END;
$secured_audit_append_v3$;

REVOKE ALL PRIVILEGES ON FUNCTION public.append_audit_event_v3(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

COMMENT ON FUNCTION public.append_audit_event_v3(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) IS 'RLS-context-bound production-runtime entry point for serialized v3 audit-chain appends';

-- The former v2 writer is removed so a stale runtime cannot append ambiguous
-- newline-delimited records after the head has advanced to protocol v3.
DROP FUNCTION public.append_audit_event_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
);

-- INSERT and INSERT ... ON CONFLICT may touch only the exact event named by
-- the server-side enqueue primitive. Job lifecycle messages are additionally
-- tied to the durable job state, deterministic ID, payload, and actor scope.
DROP POLICY skyview_outbox_insert_scope ON public.outbox_events;
CREATE POLICY skyview_outbox_insert_scope ON public.outbox_events
    FOR INSERT
    WITH CHECK (
        COALESCE(current_setting('skyview.operation', true), '') = 'outbox_enqueue'
        AND id = COALESCE(current_setting('skyview.outbox_event_id', true), '')
        AND (
            (
                COALESCE(current_setting('skyview.actor_kind', true), '') IN ('user', 'system')
                AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
                AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
                AND (
                    aggregate_type <> 'job'
                    OR EXISTS (
                        SELECT 1 FROM public.jobs scoped_job
                        WHERE scoped_job.id = outbox_events.aggregate_id
                          AND scoped_job.tenant_id = outbox_events.tenant_id
                          AND scoped_job.workspace_id = outbox_events.workspace_id
                          AND outbox_events.id = 'job:' || scoped_job.id || ':' || outbox_events.event_type
                          AND (
                              (outbox_events.event_type = 'job.created' AND scoped_job.status = 'queued')
                              OR (outbox_events.event_type = 'job.cancelled' AND scoped_job.status = 'canceled')
                              OR (
                                  COALESCE(current_setting('skyview.actor_kind', true), '') = 'system'
                                  AND (
                                      (outbox_events.event_type = 'job.succeeded' AND scoped_job.status = 'succeeded')
                                      OR (outbox_events.event_type = 'job.failed' AND scoped_job.status = 'failed')
                                  )
                              )
                          )
                          AND outbox_events.payload_json->>'schemaVersion' = '1'
                          AND outbox_events.payload_json->>'tenantId' = scoped_job.tenant_id
                          AND outbox_events.payload_json->>'workspaceId' = scoped_job.workspace_id
                          AND outbox_events.payload_json->>'projectId' = scoped_job.project_id
                          AND outbox_events.payload_json->>'jobId' = scoped_job.id
                          AND outbox_events.payload_json->>'status' = scoped_job.status
                    )
                )
            )
            OR (
                COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
                AND outbox_events.aggregate_type = 'job'
                AND outbox_events.event_type IN ('job.succeeded', 'job.failed')
                AND EXISTS (
                    SELECT 1
                    FROM public.jobs scoped_job
                    CROSS JOIN jsonb_array_elements(
                        COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                    ) AS worker_scope(value)
                    WHERE scoped_job.id = outbox_events.aggregate_id
                      AND scoped_job.tenant_id = outbox_events.tenant_id
                      AND scoped_job.workspace_id = outbox_events.workspace_id
                      AND outbox_events.id = 'job:' || scoped_job.id || ':' || outbox_events.event_type
                      AND (
                          (outbox_events.event_type = 'job.succeeded' AND scoped_job.status = 'succeeded')
                          OR (outbox_events.event_type = 'job.failed' AND scoped_job.status = 'failed')
                      )
                      AND outbox_events.payload_json->>'schemaVersion' = '1'
                      AND outbox_events.payload_json->>'tenantId' = scoped_job.tenant_id
                      AND outbox_events.payload_json->>'workspaceId' = scoped_job.workspace_id
                      AND outbox_events.payload_json->>'projectId' = scoped_job.project_id
                      AND outbox_events.payload_json->>'jobId' = scoped_job.id
                      AND outbox_events.payload_json->>'status' = scoped_job.status
                      AND worker_scope.value->>'tenantId' = scoped_job.tenant_id
                      AND worker_scope.value->>'workspaceId' = scoped_job.workspace_id
                      AND worker_scope.value->>'slug' = scoped_job.slug
                      AND EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                          WHERE allowed_action.value = scoped_job.action
                      )
                )
            )
        )
    );

-- PostgreSQL/Go golden vector. The migration aborts if UTF-8 byte lengths or
-- field order drift from the application implementation.
DO $audit_v3_golden_vector$
DECLARE
    canonical_payload TEXT;
    calculated_hash TEXT;
    collision_left TEXT;
    collision_right TEXT;
BEGIN
    canonical_payload := array_to_string(ARRAY[
        public.audit_chain_v3_frame('format', 'skyviewlab.audit.v3'),
        public.audit_chain_v3_frame('chain_version', '3'),
        public.audit_chain_v3_frame('sequence_number', '42'),
        public.audit_chain_v3_frame('id', 'evt-黄金'),
        public.audit_chain_v3_frame('tenant_id', 'tenant-a'),
        public.audit_chain_v3_frame('workspace_id', 'workspace-1'),
        public.audit_chain_v3_frame('actor_user_id', 'user:α'),
        public.audit_chain_v3_frame('action', E'paper\nreview'),
        public.audit_chain_v3_frame('resource_type', '报告'),
        public.audit_chain_v3_frame('resource_id', 'resource:42'),
        public.audit_chain_v3_frame('outcome', 'success'),
        public.audit_chain_v3_frame('request_id', 'req-1'),
        public.audit_chain_v3_frame('source_ip', '2001:db8::1'),
        public.audit_chain_v3_frame('user_agent', E'SkyView/3\n测试'),
        public.audit_chain_v3_frame('before_hash', ''),
        public.audit_chain_v3_frame('after_hash', 'after:hash'),
        public.audit_chain_v3_frame('metadata_json', E'{"line":"一\\n二","n":1}'),
        public.audit_chain_v3_frame('previous_event_hash', repeat('a', 64)),
        public.audit_chain_v3_frame('created_at', '2026-09-08T12:34:56.123456Z')
    ], '');
    calculated_hash := encode(sha256(convert_to(canonical_payload, 'UTF8')), 'hex');
    IF calculated_hash <> 'f15b56a60e43cf350e996fab1ab830dd506d4e7d5e0cd0a96847a45e79f2d3d5' THEN
        RAISE EXCEPTION 'audit_v3_golden_vector_mismatch:%', calculated_hash;
    END IF;

    IF array_to_string(ARRAY[E'x\ny', 'z'], chr(10))
       IS DISTINCT FROM array_to_string(ARRAY['x', E'y\nz'], chr(10)) THEN
        RAISE EXCEPTION 'audit_v2_collision_fixture_invalid';
    END IF;
    collision_left := public.audit_chain_v3_frame('action', E'x\ny')
        || public.audit_chain_v3_frame('resource_type', 'z');
    collision_right := public.audit_chain_v3_frame('action', 'x')
        || public.audit_chain_v3_frame('resource_type', E'y\nz');
    IF collision_left = collision_right
       OR sha256(convert_to(collision_left, 'UTF8')) = sha256(convert_to(collision_right, 'UTF8')) THEN
        RAISE EXCEPTION 'audit_v3_cross_field_collision';
    END IF;
END;
$audit_v3_golden_vector$;

-- Reseal every security-critical catalog definition changed above. The
-- runtime gate compares this ledger bidirectionally with live definitions.
DELETE FROM public.runtime_security_contracts;

INSERT INTO public.runtime_security_contracts(object_kind, object_identity, definition_hash)
SELECT
    'policy',
    relation.relname || '.' || policy.polname,
    encode(sha256(convert_to(array_to_string(ARRAY[
        policy.polcmd::text,
        policy.polpermissive::text,
        policy.polroles::text,
        COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''),
        COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
    ], chr(10)), 'UTF8')), 'hex')
FROM pg_policy policy
JOIN pg_class relation ON relation.oid = policy.polrelid
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public';

INSERT INTO public.runtime_security_contracts(object_kind, object_identity, definition_hash)
SELECT
    'function',
    function_entry.proname || '(' || pg_get_function_identity_arguments(function_entry.oid) || ')',
    encode(sha256(convert_to(array_to_string(ARRAY[
        pg_get_userbyid(function_entry.proowner),
        function_entry.prosecdef::text,
        COALESCE(function_entry.proconfig::text, ''),
        pg_get_functiondef(function_entry.oid)
    ], chr(10)), 'UTF8')), 'hex')
FROM pg_proc function_entry
WHERE function_entry.oid IN (
    to_regprocedure('public.reject_audit_event_mutation()'),
    to_regprocedure('public.validate_audit_event_chain_insert()'),
    to_regprocedure('public.reject_identity_column_mutation()'),
    to_regprocedure('public.resolve_session_identity_v1(text)'),
    to_regprocedure('public.audit_chain_v3_frame(text,text)'),
    to_regprocedure('public.append_audit_event_v3(text,text,text,text,text,text,text,text,text,text,text,text,text,text)')
);

INSERT INTO public.runtime_security_contracts(object_kind, object_identity, definition_hash)
SELECT
    'trigger',
    reviewed.table_name || '.' || reviewed.trigger_name,
    CASE WHEN trigger_entry.oid IS NULL THEN NULL ELSE
        encode(sha256(convert_to(array_to_string(ARRAY[
            trigger_entry.tgenabled::text,
            pg_get_triggerdef(trigger_entry.oid, true)
        ], chr(10)), 'UTF8')), 'hex')
    END
FROM (VALUES
    ('audit_events', 'audit_events_no_update'),
    ('audit_events', 'audit_events_no_delete'),
    ('audit_events', 'audit_events_chain_guard'),
    ('projects', 'projects_immutable_identity'),
    ('sessions', 'sessions_immutable_identity'),
    ('jobs', 'jobs_immutable_identity'),
    ('workbench_runs', 'runs_immutable_identity'),
    ('shared_records', 'shared_records_immutable_identity'),
    ('oidc_identities', 'oidc_identities_immutable_identity'),
    ('outbox_events', 'outbox_events_immutable_identity'),
    ('workbench_states', 'workbench_states_immutable_identity')
) AS reviewed(table_name, trigger_name)
LEFT JOIN pg_class relation
  ON relation.relname = reviewed.table_name
 AND relation.relnamespace = 'public'::regnamespace
LEFT JOIN pg_trigger trigger_entry
  ON trigger_entry.tgrelid = relation.oid
 AND trigger_entry.tgname = reviewed.trigger_name
 AND NOT trigger_entry.tgisinternal;
