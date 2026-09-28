ALTER TABLE audit_events
    ADD COLUMN hash_metadata_text TEXT;

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_hash_metadata_valid CHECK (
        hash_metadata_text IS NULL
        OR (
            octet_length(hash_metadata_text) BETWEEN 2 AND 1048576
            AND jsonb_typeof(hash_metadata_text::jsonb) = 'object'
            AND hash_metadata_text::jsonb = metadata_json
        )
    );

-- The runtime role receives EXECUTE only on this function and no direct write
-- privilege on audit_events or audit_heads. The function owner is the
-- migration role, and every object/function reference is either pg_catalog or
-- explicitly public-qualified to prevent search-path substitution.
CREATE FUNCTION public.append_audit_event_v2(
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
AS $secured_audit_append$
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
        p_tenant_id, p_workspace_id, '', 0, 2, CURRENT_TIMESTAMP
    ) ON CONFLICT(tenant_id, workspace_id) DO NOTHING;

    SELECT head_event_hash, last_sequence, chain_version
      INTO current_head_hash, current_last_sequence, current_chain_version
      FROM public.audit_heads
     WHERE tenant_id = p_tenant_id
       AND workspace_id = p_workspace_id
     FOR UPDATE;

    IF NOT FOUND OR current_chain_version <> 2 THEN
        RAISE EXCEPTION 'audit_head_invalid' USING ERRCODE = '55000';
    END IF;
    IF current_last_sequence = 9223372036854775807 THEN
        RAISE EXCEPTION 'audit_sequence_exhausted' USING ERRCODE = '22003';
    END IF;
    next_sequence := current_last_sequence + 1;

    -- Obtain the event timestamp only after serialization on the scope head.
    -- Concurrent writers can no longer receive a later sequence with an
    -- earlier timestamp merely because they waited for this lock.
    created_at_value := clock_timestamp();
    canonical_created_at_text := to_char(
        created_at_value AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    );
    canonical_created_at_text := regexp_replace(canonical_created_at_text, '0+Z$', 'Z');
    canonical_created_at_text := replace(canonical_created_at_text, '.Z', 'Z');

    canonical_payload := array_to_string(ARRAY[
        'skyviewlab.audit.v2',
        '2',
        next_sequence::text,
        p_id,
        p_tenant_id,
        p_workspace_id,
        p_actor_user_id,
        p_action,
        p_resource_type,
        p_resource_id,
        p_outcome,
        p_request_id,
        p_source_ip,
        p_user_agent,
        p_before_hash,
        p_after_hash,
        p_metadata_text,
        current_head_hash,
        canonical_created_at_text
    ], chr(10));
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
        next_sequence, 2, created_at_value, p_metadata_text
    );

    UPDATE public.audit_heads
       SET head_event_hash = calculated_event_hash,
           last_sequence = next_sequence,
           chain_version = 2,
        updated_at = created_at_value
     WHERE tenant_id = p_tenant_id
       AND workspace_id = p_workspace_id
       AND head_event_hash = current_head_hash
       AND last_sequence = current_last_sequence
       AND chain_version = 2;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'audit_head_changed' USING ERRCODE = '40001';
    END IF;

    RETURN QUERY SELECT
        next_sequence,
        current_head_hash,
        calculated_event_hash,
        created_at_value;
END;
$secured_audit_append$;

REVOKE ALL PRIVILEGES ON FUNCTION public.append_audit_event_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

COMMENT ON FUNCTION public.append_audit_event_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) IS 'Sole production-runtime entry point for serialized v2 audit-chain appends';
