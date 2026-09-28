-- Runtime row isolation is enforced by PostgreSQL in addition to the scoped
-- WHERE clauses in the application. The runtime role is neither an owner nor
-- BYPASSRLS; the release-time privilege verifier proves both properties.
-- Application context is transaction-local and absent context matches no row.

-- This migrator-owned, runtime-read-only ledger seals the exact deparsed
-- policy/function/trigger definitions installed below. Startup and release
-- verification compare the live catalog back to these hashes, so a policy
-- altered after migration cannot pass merely because its name still matches.
CREATE TABLE public.runtime_security_contracts (
    object_kind TEXT NOT NULL CHECK (object_kind IN ('policy', 'function', 'trigger')),
    object_identity TEXT NOT NULL,
    definition_hash TEXT NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (object_kind, object_identity)
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workbench_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oidc_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workbench_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY skyview_tenant_scope ON public.tenants
	FOR SELECT
    USING (
        id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND COALESCE(current_setting('skyview.actor_kind', true), '') IN ('user', 'oidc')
    );

CREATE POLICY skyview_user_scope ON public.users
	FOR SELECT
    USING (
        tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND (
            (
                COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
                AND (
                    id = COALESCE(current_setting('skyview.user_id', true), '')
                    OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
                )
            )
            OR COALESCE(current_setting('skyview.actor_kind', true), '') = 'oidc'
        )
    );

CREATE POLICY skyview_workspace_scope ON public.workspaces
	FOR SELECT
    USING (
        tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND COALESCE(current_setting('skyview.actor_kind', true), '') IN ('user', 'oidc')
    );

CREATE POLICY skyview_membership_scope ON public.memberships
	FOR SELECT
    USING (
        tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND (
            (
                COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
                AND (
                    user_id = COALESCE(current_setting('skyview.user_id', true), '')
                    OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
                )
            )
            OR COALESCE(current_setting('skyview.actor_kind', true), '') = 'oidc'
        )
    );

CREATE POLICY skyview_project_select_scope ON public.projects
    FOR SELECT
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
    );

CREATE POLICY skyview_project_insert_scope ON public.projects
    FOR INSERT
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
    );

CREATE POLICY skyview_project_update_scope ON public.projects
    FOR UPDATE
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
			OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher', 'researcher')
		)
    )
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
			OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher', 'researcher')
		)
    );

CREATE POLICY skyview_project_delete_scope ON public.projects
    FOR DELETE
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
			OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher', 'researcher')
		)
    );

CREATE POLICY skyview_project_version_scope ON public.project_versions
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
    )
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
    );

CREATE POLICY skyview_session_scope ON public.sessions
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND user_id = COALESCE(current_setting('skyview.user_id', true), '')
    )
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND user_id = COALESCE(current_setting('skyview.user_id', true), '')
    );

CREATE POLICY skyview_job_select_scope ON public.jobs
    FOR SELECT
    USING (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
			AND (
				created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher', 'researcher', 'reviewer')
			)
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    );

CREATE POLICY skyview_job_insert_scope ON public.jobs
    FOR INSERT
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
    );

CREATE POLICY skyview_job_update_scope ON public.jobs
    FOR UPDATE
    USING (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
			AND (
				created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
			)
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    )
    WITH CHECK (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
			AND (
				created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
			)
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    );

CREATE POLICY skyview_run_select_scope ON public.workbench_runs
    FOR SELECT
    USING (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
			AND (
				created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher', 'researcher', 'reviewer')
			)
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    );

CREATE POLICY skyview_run_insert_scope ON public.workbench_runs
    FOR INSERT
    WITH CHECK (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
            AND created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    );

CREATE POLICY skyview_run_update_scope ON public.workbench_runs
    FOR UPDATE
    USING (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
			AND (
				created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
			)
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    )
    WITH CHECK (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
			AND (
				created_by_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
			)
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE worker_scope.value->>'tenantId' = tenant_id
                  AND worker_scope.value->>'workspaceId' = workspace_id
                  AND worker_scope.value->>'slug' = slug
                  AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = action
                  )
            )
        )
    );

CREATE POLICY skyview_shared_record_select_scope ON public.shared_records
    FOR SELECT
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			kind <> 'submissions'
			OR owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
			OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher')
		)
    );

CREATE POLICY skyview_shared_record_insert_scope ON public.shared_records
    FOR INSERT
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
		AND (
			kind = 'discussions'
			OR (kind = 'assignments' AND COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher'))
			OR (kind = 'submissions' AND COALESCE(current_setting('skyview.role', true), '') = 'student')
		)
    );

CREATE POLICY skyview_shared_record_update_scope ON public.shared_records
    FOR UPDATE
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			kind = 'discussions'
			OR (kind = 'assignments' AND COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher'))
			OR (
				kind = 'submissions'
				AND (
					owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
					OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher')
				)
			)
		)
    )
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			kind = 'discussions'
			OR (kind = 'assignments' AND COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher'))
			OR (
				kind = 'submissions'
				AND (
					owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
					OR COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher')
				)
			)
		)
    );

CREATE POLICY skyview_shared_record_delete_scope ON public.shared_records
    FOR DELETE
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND (
			(kind = 'discussions' AND (
				owner_user_id = COALESCE(current_setting('skyview.user_id', true), '')
				OR COALESCE(current_setting('skyview.role', true), '') = 'admin'
			))
			OR (kind = 'assignments' AND COALESCE(current_setting('skyview.role', true), '') IN ('admin', 'teacher'))
		)
    );

CREATE POLICY skyview_audit_event_scope ON public.audit_events
    FOR SELECT
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND COALESCE(current_setting('skyview.role', true), '') = 'admin'
    );

CREATE POLICY skyview_audit_head_scope ON public.audit_heads
    FOR SELECT
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
		AND COALESCE(current_setting('skyview.role', true), '') = 'admin'
    );

CREATE POLICY skyview_oidc_identity_scope ON public.oidc_identities
    USING (
        tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'oidc'
            OR (
                COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
                AND user_id = COALESCE(current_setting('skyview.user_id', true), '')
            )
        )
    )
    WITH CHECK (
        tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND user_id = COALESCE(current_setting('skyview.user_id', true), '')
    );

CREATE POLICY skyview_outbox_select_scope ON public.outbox_events
    FOR SELECT
    USING (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
            AND COALESCE(current_setting('skyview.role', true), '') = 'admin'
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'relay'
            AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.relay_scopes', true), ''), '[]')::jsonb
                ) AS relay_scope(value)
                WHERE relay_scope.value->>'tenantId' = tenant_id
                  AND relay_scope.value->>'workspaceId' = workspace_id
                  AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(relay_scope.value->'eventTypes') AS allowed_event(value)
                      WHERE allowed_event.value = event_type
                )
            )
        )
        OR (
			COALESCE(current_setting('skyview.actor_kind', true), '') IN ('user', 'worker', 'system')
            AND COALESCE(current_setting('skyview.operation', true), '') = 'outbox_enqueue'
            AND id = COALESCE(current_setting('skyview.outbox_event_id', true), '')
            AND (
                (
                    COALESCE(current_setting('skyview.actor_kind', true), '') = 'system'
                    AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
                    AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
                )
				OR (
					COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
					AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
					AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
				)
                OR (
                    COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
                    AND aggregate_type = 'job'
                    AND EXISTS (
                        SELECT 1
                        FROM public.jobs scoped_job
                        CROSS JOIN jsonb_array_elements(
                            COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                        ) AS worker_scope(value)
                        WHERE scoped_job.id = outbox_events.aggregate_id
                          AND scoped_job.tenant_id = outbox_events.tenant_id
                          AND scoped_job.workspace_id = outbox_events.workspace_id
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
        )
    );

CREATE POLICY skyview_outbox_insert_scope ON public.outbox_events
    FOR INSERT
    WITH CHECK (
        (
            COALESCE(current_setting('skyview.actor_kind', true), '') IN ('user', 'system')
            AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
            AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        )
        OR (
            COALESCE(current_setting('skyview.actor_kind', true), '') = 'worker'
            AND outbox_events.aggregate_type = 'job'
            AND EXISTS (
                SELECT 1
                FROM public.jobs scoped_job
                CROSS JOIN jsonb_array_elements(
                    COALESCE(NULLIF(current_setting('skyview.worker_scopes', true), ''), '[]')::jsonb
                ) AS worker_scope(value)
                WHERE scoped_job.id = outbox_events.aggregate_id
                  AND scoped_job.tenant_id = outbox_events.tenant_id
                  AND scoped_job.workspace_id = outbox_events.workspace_id
                  AND worker_scope.value->>'tenantId' = scoped_job.tenant_id
                  AND worker_scope.value->>'workspaceId' = scoped_job.workspace_id
                  AND worker_scope.value->>'slug' = scoped_job.slug
                  AND EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(worker_scope.value->'actions') AS allowed_action(value)
                      WHERE allowed_action.value = scoped_job.action
                  )
            )
        )
    );

CREATE POLICY skyview_outbox_update_scope ON public.outbox_events
    FOR UPDATE
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'relay'
        AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                COALESCE(NULLIF(current_setting('skyview.relay_scopes', true), ''), '[]')::jsonb
            ) AS relay_scope(value)
            WHERE relay_scope.value->>'tenantId' = tenant_id
              AND relay_scope.value->>'workspaceId' = workspace_id
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(relay_scope.value->'eventTypes') AS allowed_event(value)
                  WHERE allowed_event.value = event_type
              )
        )
    )
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'relay'
        AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(
                COALESCE(NULLIF(current_setting('skyview.relay_scopes', true), ''), '[]')::jsonb
            ) AS relay_scope(value)
            WHERE relay_scope.value->>'tenantId' = tenant_id
              AND relay_scope.value->>'workspaceId' = workspace_id
              AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(relay_scope.value->'eventTypes') AS allowed_event(value)
                  WHERE allowed_event.value = event_type
              )
        )
    );

CREATE POLICY skyview_workbench_state_scope ON public.workbench_states
    USING (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND user_id = COALESCE(current_setting('skyview.user_id', true), '')
    )
    WITH CHECK (
        COALESCE(current_setting('skyview.actor_kind', true), '') = 'user'
        AND tenant_id = COALESCE(current_setting('skyview.tenant_id', true), '')
        AND workspace_id = COALESCE(current_setting('skyview.workspace_id', true), '')
        AND user_id = COALESCE(current_setting('skyview.user_id', true), '')
    );

-- RLS prevents moving a row outside the active tenant/workspace, while this
-- trigger also makes ownership and authorization-relevant identity columns
-- immutable inside that boundary. Business updates may change only the fields
-- intentionally omitted from each trigger's argument list.
CREATE FUNCTION public.reject_identity_column_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $reject_identity_column_mutation$
DECLARE
    column_index INTEGER;
    old_row JSONB := to_jsonb(OLD);
    new_row JSONB := to_jsonb(NEW);
BEGIN
    FOR column_index IN 0..TG_NARGS - 1 LOOP
        IF old_row->TG_ARGV[column_index] IS DISTINCT FROM new_row->TG_ARGV[column_index] THEN
            RAISE EXCEPTION 'immutable_identity_column:%', TG_ARGV[column_index]
                USING ERRCODE = '23000';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$reject_identity_column_mutation$;

REVOKE ALL PRIVILEGES ON FUNCTION public.reject_identity_column_mutation() FROM PUBLIC;

CREATE TRIGGER projects_immutable_identity
BEFORE UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'id', 'tenant_id', 'workspace_id', 'owner_user_id', 'slug', 'created_at'
);

CREATE TRIGGER sessions_immutable_identity
BEFORE UPDATE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'token_hash', 'tenant_id', 'workspace_id', 'user_id', 'expires_at', 'created_at'
);

CREATE TRIGGER jobs_immutable_identity
BEFORE UPDATE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'id', 'tenant_id', 'workspace_id', 'project_id', 'created_by_user_id',
    'slug', 'action', 'idempotency_key', 'created_at'
);

CREATE TRIGGER runs_immutable_identity
BEFORE UPDATE ON public.workbench_runs
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'id', 'tenant_id', 'workspace_id', 'project_id', 'created_by_user_id',
    'job_id', 'slug', 'action', 'created_at'
);

CREATE TRIGGER shared_records_immutable_identity
BEFORE UPDATE ON public.shared_records
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'id', 'tenant_id', 'workspace_id', 'owner_user_id', 'kind', 'created_at'
);

CREATE TRIGGER oidc_identities_immutable_identity
BEFORE UPDATE ON public.oidc_identities
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'issuer_hash', 'issuer', 'subject', 'tenant_id', 'user_id', 'created_at'
);

CREATE TRIGGER outbox_events_immutable_identity
BEFORE UPDATE ON public.outbox_events
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'id', 'tenant_id', 'workspace_id', 'aggregate_type', 'aggregate_id',
    'event_type', 'payload_json', 'created_at'
);

CREATE TRIGGER workbench_states_immutable_identity
BEFORE UPDATE ON public.workbench_states
FOR EACH ROW EXECUTE FUNCTION public.reject_identity_column_mutation(
    'tenant_id', 'workspace_id', 'user_id', 'slug', 'created_at'
);

-- Authentication starts with possession of a high-entropy session token, so
-- no tenant/user GUC exists yet. This narrowly scoped SECURITY DEFINER function
-- resolves exactly one SHA-256 token digest, uses database time, and returns no
-- row for an expired/disabled identity. Direct table SELECT remains RLS-denied.
CREATE FUNCTION public.resolve_session_identity_v1(p_token_hash TEXT)
RETURNS TABLE (
    user_id TEXT,
    tenant_id TEXT,
    workspace_id TEXT,
    email TEXT,
    display_name TEXT,
    role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $resolve_session_identity$
BEGIN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;

    DELETE FROM public.sessions expired
     WHERE expired.token_hash = p_token_hash
       AND expired.expires_at <= clock_timestamp();

    RETURN QUERY
    WITH eligible AS (
        SELECT s.token_hash, s.user_id, s.tenant_id, s.workspace_id,
               u.email, u.display_name, m.role
          FROM public.sessions s
          JOIN public.users u
            ON u.id = s.user_id AND u.tenant_id = s.tenant_id AND u.status = 'active'
          JOIN public.memberships m
            ON m.tenant_id = s.tenant_id
           AND m.workspace_id = s.workspace_id
           AND m.user_id = s.user_id
           AND m.status = 'active'
          JOIN public.tenants t
            ON t.id = s.tenant_id AND t.status = 'active'
          JOIN public.workspaces w
            ON w.id = s.workspace_id AND w.tenant_id = s.tenant_id AND w.status = 'active'
         WHERE s.token_hash = p_token_hash
           AND s.expires_at > clock_timestamp()
    )
    UPDATE public.sessions target
       SET last_seen_at = clock_timestamp()
      FROM eligible
     WHERE target.token_hash = eligible.token_hash
    RETURNING eligible.user_id, eligible.tenant_id, eligible.workspace_id,
              eligible.email, eligible.display_name, eligible.role;
END;
$resolve_session_identity$;

REVOKE ALL PRIVILEGES ON FUNCTION public.resolve_session_identity_v1(TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.resolve_session_identity_v1(TEXT)
IS 'Resolve and touch one active session by its 256-bit token digest without exposing tenant tables';

-- Harden the PG009 audit entry point against arbitrary cross-scope calls. A
-- user/OIDC event must match the full authenticated context. A Worker event
-- must name a job which itself matches one exact tenant/workspace/slug/action
-- capability in the server-supplied transaction-local scope document.
CREATE OR REPLACE FUNCTION public.append_audit_event_v2(
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

    created_at_value := clock_timestamp();
    canonical_created_at_text := to_char(
        created_at_value AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    );
    canonical_created_at_text := regexp_replace(canonical_created_at_text, '0+Z$', 'Z');
    canonical_created_at_text := replace(canonical_created_at_text, '.Z', 'Z');

    canonical_payload := array_to_string(ARRAY[
        'skyviewlab.audit.v2', '2', next_sequence::text, p_id, p_tenant_id,
        p_workspace_id, p_actor_user_id, p_action, p_resource_type,
        p_resource_id, p_outcome, p_request_id, p_source_ip, p_user_agent,
        p_before_hash, p_after_hash, p_metadata_text, current_head_hash,
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

    RETURN QUERY SELECT next_sequence, current_head_hash, calculated_event_hash, created_at_value;
END;
$secured_audit_append$;

REVOKE ALL PRIVILEGES ON FUNCTION public.append_audit_event_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;

COMMENT ON FUNCTION public.append_audit_event_v2(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) IS 'RLS-context-bound production-runtime entry point for serialized v2 audit-chain appends';

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
    to_regprocedure('public.append_audit_event_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text)')
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
