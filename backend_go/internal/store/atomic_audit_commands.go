package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// ErrAtomicAuditWrite identifies an audit append failure that caused its
// surrounding business transaction to roll back.
var ErrAtomicAuditWrite = errors.New("atomic business audit write failed")

// auditedMutation is the only transaction boundary used by the user-facing
// business commands below. A successful mutation is never committed unless
// its current-version audit event has also been appended and the audit-chain head advanced
// in the same database transaction.
func auditedMutation[T any](ctx context.Context, store *ProjectStore, scope Scope, mutate func(*databaseTx) (T, *AuditEvent, error)) (T, error) {
	var zero T
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setUserRLSContext(scope); err != nil {
		return zero, err
	}

	value, event, err := mutate(tx)
	if err != nil {
		return zero, err
	}
	// A nil event is reserved for a no-op outcome such as not-found or an
	// optimistic-concurrency conflict. No business row changed, so rollback the
	// read-only transaction and preserve the caller's existing result semantics.
	if event == nil {
		return value, nil
	}
	if err := store.appendBusinessAuditTxContext(ctx, tx, scope, *event); err != nil {
		return zero, err
	}
	if err := tx.Commit(); err != nil {
		return zero, fmt.Errorf("commit audited business mutation: %w", err)
	}
	return value, nil
}

func validateBusinessAudit(scope Scope, event AuditEvent) error {
	if event.TenantID != scope.TenantID || event.WorkspaceID != scope.WorkspaceID || event.ActorUserID != scope.UserID {
		return errors.New("business audit scope does not match authenticated mutation scope")
	}
	if event.Outcome == "" || event.Outcome == "denied" || event.Action == "" || event.ResourceType == "" || event.ResourceID == "" {
		return errors.New("business audit must describe a concrete committed resource mutation")
	}
	return nil
}

func (store *ProjectStore) appendBusinessAuditTx(tx *databaseTx, scope Scope, event AuditEvent) error {
	return store.appendBusinessAuditTxContext(context.Background(), tx, scope, event)
}

func (store *ProjectStore) appendBusinessAuditTxContext(ctx context.Context, tx *databaseTx, scope Scope, event AuditEvent) error {
	if err := validateBusinessAudit(scope, event); err != nil {
		return err
	}
	if _, err := store.appendAuditTxContext(ctx, tx, event); err != nil {
		return fmt.Errorf("%w: %w", ErrAtomicAuditWrite, err)
	}
	return nil
}

type projectMutationResult struct {
	Project Project
	Found   bool
}

func (store *ProjectStore) CreateProjectWithAudit(ctx context.Context, scope Scope, slug, title string, state map[string]any, audit func(Project) AuditEvent) (Project, error) {
	if audit == nil {
		return Project{}, errors.New("project audit factory is required")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return Project{}, err
	}
	return auditedMutation(ctx, store, scope, func(tx *databaseTx) (Project, *AuditEvent, error) {
		now := nowText()
		id := uuid.NewString()
		if _, err := tx.ExecContext(ctx, `INSERT INTO projects(id, scope, tenant_id, workspace_id, owner_user_id, slug, title, state_json, created_at, updated_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, legacyScope(scope), scope.TenantID, scope.WorkspaceID, scope.UserID,
			slug, title, tx.json(encoded), tx.timestamp(now), tx.timestamp(now)); err != nil {
			return Project{}, nil, err
		}
		project, found, err := getProjectTx(ctx, tx, scope, id)
		if err != nil || !found {
			if err == nil {
				err = errors.New("created project could not be read in its transaction")
			}
			return Project{}, nil, err
		}
		event := audit(project)
		return project, &event, nil
	})
}

func (store *ProjectStore) UpdateProjectWithAudit(ctx context.Context, scope Scope, id, title string, state map[string]any, audit func(Project, Project) AuditEvent) (Project, bool, error) {
	if audit == nil {
		return Project{}, false, errors.New("project audit factory is required")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return Project{}, false, err
	}
	result, err := auditedMutation(ctx, store, scope, func(tx *databaseTx) (projectMutationResult, *AuditEvent, error) {
		before, found, err := getProjectTx(ctx, tx, scope, id)
		if err != nil || !found {
			return projectMutationResult{Found: found}, nil, err
		}
		now := nowText()
		updated, err := tx.ExecContext(ctx, `UPDATE projects SET title = ?, state_json = ?, updated_at = ?
			WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, title, tx.json(encoded), tx.timestamp(now), scope.TenantID, scope.WorkspaceID, id)
		if err != nil {
			return projectMutationResult{}, nil, err
		}
		affected, err := updated.RowsAffected()
		if err != nil {
			return projectMutationResult{}, nil, err
		}
		if affected != 1 {
			return projectMutationResult{Found: false}, nil, nil
		}
		after, found, err := getProjectTx(ctx, tx, scope, id)
		if err != nil || !found {
			if err == nil {
				err = errors.New("updated project could not be read in its transaction")
			}
			return projectMutationResult{}, nil, err
		}
		event := audit(before, after)
		return projectMutationResult{Project: after, Found: true}, &event, nil
	})
	return result.Project, result.Found, err
}

func (store *ProjectStore) DeleteProjectWithAudit(ctx context.Context, scope Scope, id string, audit func(Project) AuditEvent) (bool, error) {
	if audit == nil {
		return false, errors.New("project audit factory is required")
	}
	return auditedMutation(ctx, store, scope, func(tx *databaseTx) (bool, *AuditEvent, error) {
		before, found, err := getProjectTx(ctx, tx, scope, id)
		if err != nil || !found {
			return false, nil, err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM projects WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, id)
		if err != nil {
			return false, nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return false, nil, err
		}
		if affected != 1 {
			return false, nil, nil
		}
		event := audit(before)
		return true, &event, nil
	})
}

func (store *ProjectStore) CreateVersionWithAudit(ctx context.Context, scope Scope, projectID, label string, state map[string]any, audit func(Version) AuditEvent) (Version, bool, error) {
	if audit == nil {
		return Version{}, false, errors.New("version audit factory is required")
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return Version{}, false, err
	}
	type result struct {
		Version Version
		Found   bool
	}
	value, err := auditedMutation(ctx, store, scope, func(tx *databaseTx) (result, *AuditEvent, error) {
		if _, found, err := getProjectTx(ctx, tx, scope, projectID); err != nil || !found {
			return result{Found: found}, nil, err
		}
		id, createdAt := uuid.NewString(), nowText()
		if _, err := tx.ExecContext(ctx, `INSERT INTO project_versions(id, project_id, scope, tenant_id, workspace_id, created_by_user_id, label, state_json, created_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, projectID, legacyScope(scope), scope.TenantID, scope.WorkspaceID, scope.UserID,
			label, tx.json(encoded), tx.timestamp(createdAt)); err != nil {
			return result{}, nil, err
		}
		version, err := getVersionTx(ctx, tx, scope, projectID, id)
		if err != nil {
			return result{}, nil, err
		}
		event := audit(version)
		return result{Version: version, Found: true}, &event, nil
	})
	return value.Version, value.Found, err
}

func getProjectTx(ctx context.Context, tx *databaseTx, scope Scope, id string) (Project, bool, error) {
	query := `SELECT id, tenant_id, workspace_id, owner_user_id, slug, title, state_json, created_at, updated_at
		FROM projects WHERE tenant_id = ? AND workspace_id = ? AND id = ?`
	if tx.dialect == dialectPostgreSQL {
		query += ` FOR UPDATE`
	}
	project, err := scanProject(tx.QueryRowContext(ctx, query, scope.TenantID, scope.WorkspaceID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, false, nil
	}
	return project, err == nil, err
}

func getVersionTx(ctx context.Context, tx *databaseTx, scope Scope, projectID, id string) (Version, error) {
	var version Version
	var encoded string
	var createdAt timestampText
	err := tx.QueryRowContext(ctx, `SELECT id, project_id, label, state_json, created_at FROM project_versions
		WHERE tenant_id = ? AND workspace_id = ? AND project_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, projectID, id).
		Scan(&version.ID, &version.ProjectID, &version.Label, &encoded, &createdAt)
	if err != nil {
		return Version{}, err
	}
	version.CreatedAt = string(createdAt)
	if err := json.Unmarshal([]byte(encoded), &version.State); err != nil {
		return Version{}, err
	}
	return version, nil
}

type sharedMutationResult struct {
	Record   SharedRecord
	Exists   bool
	Conflict bool
}

func (store *ProjectStore) CreateSharedWithAudit(ctx context.Context, scope Scope, kind string, data map[string]any, audit func(SharedRecord) AuditEvent) (SharedRecord, error) {
	if audit == nil {
		return SharedRecord{}, errors.New("shared-record audit factory is required")
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return SharedRecord{}, err
	}
	return auditedMutation(ctx, store, scope, func(tx *databaseTx) (SharedRecord, *AuditEvent, error) {
		id, now := uuid.NewString(), nowText()
		if _, err := tx.ExecContext(ctx, `INSERT INTO shared_records(id, tenant_id, workspace_id, owner_user_id, kind, revision, data_json, created_at, updated_at)
			VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)`, id, scope.TenantID, scope.WorkspaceID, scope.UserID, kind,
			tx.json(encoded), tx.timestamp(now), tx.timestamp(now)); err != nil {
			return SharedRecord{}, nil, err
		}
		record, found, err := getSharedTx(ctx, tx, scope, kind, id)
		if err != nil || !found {
			if err == nil {
				err = errors.New("created shared record could not be read in its transaction")
			}
			return SharedRecord{}, nil, err
		}
		event := audit(record)
		return record, &event, nil
	})
}

func (store *ProjectStore) UpdateSharedWithAudit(ctx context.Context, scope Scope, kind, id string, revision int, data map[string]any, audit func(SharedRecord, SharedRecord) AuditEvent) (SharedRecord, bool, bool, error) {
	if audit == nil {
		return SharedRecord{}, false, false, errors.New("shared-record audit factory is required")
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return SharedRecord{}, false, false, err
	}
	value, err := auditedMutation(ctx, store, scope, func(tx *databaseTx) (sharedMutationResult, *AuditEvent, error) {
		before, found, err := getSharedTx(ctx, tx, scope, kind, id)
		if err != nil || !found {
			return sharedMutationResult{Exists: found}, nil, err
		}
		if before.Revision != revision {
			return sharedMutationResult{Exists: true, Conflict: true}, nil, nil
		}
		now := nowText()
		result, err := tx.ExecContext(ctx, `UPDATE shared_records SET revision = revision + 1, data_json = ?, updated_at = ?
			WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ? AND revision = ?`, tx.json(encoded), tx.timestamp(now),
			scope.TenantID, scope.WorkspaceID, kind, id, revision)
		if err != nil {
			return sharedMutationResult{}, nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return sharedMutationResult{}, nil, err
		}
		if affected != 1 {
			_, exists, lookupErr := getSharedTx(ctx, tx, scope, kind, id)
			return sharedMutationResult{Exists: exists, Conflict: exists}, nil, lookupErr
		}
		after, found, err := getSharedTx(ctx, tx, scope, kind, id)
		if err != nil || !found {
			if err == nil {
				err = errors.New("updated shared record could not be read in its transaction")
			}
			return sharedMutationResult{}, nil, err
		}
		event := audit(before, after)
		return sharedMutationResult{Record: after, Exists: true}, &event, nil
	})
	return value.Record, value.Exists, value.Conflict, err
}

func (store *ProjectStore) DeleteSharedWithAudit(ctx context.Context, scope Scope, kind, id string, audit func(SharedRecord) AuditEvent) (bool, error) {
	if audit == nil {
		return false, errors.New("shared-record audit factory is required")
	}
	return auditedMutation(ctx, store, scope, func(tx *databaseTx) (bool, *AuditEvent, error) {
		before, found, err := getSharedTx(ctx, tx, scope, kind, id)
		if err != nil || !found {
			return false, nil, err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM shared_records WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, kind, id)
		if err != nil {
			return false, nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return false, nil, err
		}
		if affected != 1 {
			return false, nil, nil
		}
		event := audit(before)
		return true, &event, nil
	})
}

func getSharedTx(ctx context.Context, tx *databaseTx, scope Scope, kind, id string) (SharedRecord, bool, error) {
	query := `SELECT id, tenant_id, workspace_id, kind, revision, data_json, created_at, updated_at FROM shared_records
		WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ?`
	args := []any{scope.TenantID, scope.WorkspaceID, kind, id}
	if kind == "submissions" && scope.Role != "admin" && scope.Role != "teacher" {
		query += ` AND owner_user_id = ?`
		args = append(args, scope.UserID)
	}
	if tx.dialect == dialectPostgreSQL {
		query += ` FOR UPDATE`
	}
	record, err := scanShared(tx.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return SharedRecord{}, false, nil
	}
	return record, err == nil, err
}

func (store *ProjectStore) PutWorkbenchStateWithAudit(ctx context.Context, scope Scope, slug string, expectedRevision int64, state map[string]any, audit func(WorkbenchState, WorkbenchState) AuditEvent) (WorkbenchState, error) {
	if audit == nil {
		return WorkbenchState{}, errors.New("workbench-state audit factory is required")
	}
	if err := validateWorkbenchStateScope(scope, slug); err != nil {
		return WorkbenchState{}, err
	}
	if expectedRevision < 0 {
		return WorkbenchState{}, fmt.Errorf("%w: expected revision must be zero or greater", ErrInvalidWorkbenchState)
	}
	encoded, normalized, err := normalizeWorkbenchState(state)
	if err != nil {
		return WorkbenchState{}, err
	}
	return auditedMutation(ctx, store, scope, func(tx *databaseTx) (WorkbenchState, *AuditEvent, error) {
		before, found, err := getWorkbenchStateTx(ctx, tx, scope, slug)
		if err != nil {
			return WorkbenchState{}, nil, err
		}
		if !found {
			before = WorkbenchState{}
		}
		saved, err := putWorkbenchStateTx(ctx, tx, scope, slug, expectedRevision, encoded, normalized)
		if err != nil {
			return WorkbenchState{}, nil, err
		}
		event := audit(before, saved)
		return saved, &event, nil
	})
}

func getWorkbenchStateTx(ctx context.Context, tx *databaseTx, scope Scope, slug string) (WorkbenchState, bool, error) {
	record, err := scanWorkbenchState(tx.QueryRowContext(ctx, `SELECT state.state_json, state.revision, state.updated_at
		FROM workbench_states state
		JOIN memberships membership
			ON membership.tenant_id = state.tenant_id
			AND membership.workspace_id = state.workspace_id
			AND membership.user_id = state.user_id
			AND membership.status = 'active'
		WHERE state.tenant_id = ? AND state.workspace_id = ? AND state.user_id = ? AND state.slug = ?`,
		scope.TenantID, scope.WorkspaceID, scope.UserID, slug))
	if errors.Is(err, sql.ErrNoRows) {
		return WorkbenchState{}, false, nil
	}
	return record, err == nil, err
}

func putWorkbenchStateTx(ctx context.Context, tx *databaseTx, scope Scope, slug string, expectedRevision int64, encoded []byte, normalized map[string]any) (WorkbenchState, error) {
	databaseNow := workbenchStateNowExpression(tx.dialect)
	var row rowScanner
	if expectedRevision == 0 {
		row = tx.QueryRowContext(ctx, `INSERT INTO workbench_states(
			tenant_id, workspace_id, user_id, slug, state_json, size_bytes, revision, created_at, updated_at
		) SELECT ?, ?, ?, ?, ?, ?, 1, `+databaseNow+`, `+databaseNow+`
		FROM memberships
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND status = 'active'
		ON CONFLICT(tenant_id, workspace_id, user_id, slug) DO NOTHING
		RETURNING state_json, revision, updated_at`, scope.TenantID, scope.WorkspaceID, scope.UserID, slug, tx.json(encoded), len(encoded),
			scope.TenantID, scope.WorkspaceID, scope.UserID)
	} else {
		row = tx.QueryRowContext(ctx, `UPDATE workbench_states
		SET state_json = ?, size_bytes = ?, revision = revision + 1, updated_at = `+databaseNow+`
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND slug = ? AND revision = ?
			AND EXISTS (
				SELECT 1 FROM memberships
				WHERE memberships.tenant_id = workbench_states.tenant_id
					AND memberships.workspace_id = workbench_states.workspace_id
					AND memberships.user_id = workbench_states.user_id
					AND memberships.status = 'active'
			)
		RETURNING state_json, revision, updated_at`, tx.json(encoded), len(encoded), scope.TenantID, scope.WorkspaceID, scope.UserID, slug, expectedRevision)
	}
	record, err := scanWorkbenchState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkbenchState{}, ErrWorkbenchStateConflict
	}
	if err != nil {
		return WorkbenchState{}, normalizeWorkbenchStateDatabaseError(err)
	}
	record.State = normalized
	return record, nil
}
