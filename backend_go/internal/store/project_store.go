package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Scope is derived from an authenticated session. It must never be populated
// from request JSON, query parameters, or untrusted forwarding headers.
type Scope struct {
	TenantID    string
	WorkspaceID string
	UserID      string
	Role        string
}

type Project struct {
	ID          string         `json:"id"`
	TenantID    string         `json:"tenantId"`
	WorkspaceID string         `json:"workspaceId"`
	OwnerUserID string         `json:"ownerUserId"`
	Slug        string         `json:"slug"`
	Title       string         `json:"title"`
	State       map[string]any `json:"state"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}

type Version struct {
	ID        string         `json:"id"`
	ProjectID string         `json:"projectId"`
	Label     string         `json:"label"`
	State     map[string]any `json:"state"`
	CreatedAt string         `json:"createdAt"`
}

type Run struct {
	ID         string         `json:"id"`
	JobID      string         `json:"jobId"`
	ProjectID  string         `json:"projectId"`
	Slug       string         `json:"slug"`
	Action     string         `json:"action"`
	Status     string         `json:"status"`
	Input      map[string]any `json:"input"`
	Result     map[string]any `json:"result"`
	Error      string         `json:"error,omitempty"`
	DurationMS float64        `json:"durationMs"`
	CreatedAt  string         `json:"createdAt"`
	UpdatedAt  string         `json:"updatedAt"`
}

type SharedRecord struct {
	ID          string         `json:"id"`
	TenantID    string         `json:"tenantId"`
	WorkspaceID string         `json:"workspaceId"`
	Kind        string         `json:"kind"`
	Revision    int            `json:"revision"`
	Data        map[string]any `json:"data"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}

type ProjectStore struct {
	database *databaseHandle
	adapter  string
}

// NewProjectStore preserves the development/test constructor. Production code
// must use OpenProjectStore with an explicit PostgreSQL configuration.
func NewProjectStore(path string) (*ProjectStore, error) {
	return OpenProjectStore(StoreConfig{Adapter: AdapterSQLiteDevelopment, SQLitePath: path, ApplyMigrations: true})
}

func OpenProjectStore(config StoreConfig) (*ProjectStore, error) {
	if config.ApplyMigrations && config.RequireExistingSchema {
		return nil, errors.New("store cannot apply migrations while requiring an existing schema")
	}
	database, adapter, err := openDatabase(config)
	if err != nil {
		return nil, err
	}
	result := &ProjectStore{database: database, adapter: adapter}
	var schemaErr error
	if config.RequireExistingSchema {
		schemaErr = result.validateExistingSchema()
	} else {
		schemaErr = result.prepareSchema(config.ApplyMigrations)
	}
	if schemaErr != nil {
		_ = database.Close()
		return nil, schemaErr
	}
	return result, nil
}

func (store *ProjectStore) Adapter() string {
	return store.adapter
}

func (store *ProjectStore) Close() error {
	return store.database.Close()
}

func (store *ProjectStore) Ping() error {
	return store.database.Ping()
}

func (store *ProjectStore) ListProjects(scope Scope, slug string) ([]Project, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	query := `SELECT id, tenant_id, workspace_id, owner_user_id, slug, title, state_json, created_at, updated_at
		FROM projects WHERE tenant_id = ? AND workspace_id = ? AND slug = ?`
	args := []any{scope.TenantID, scope.WorkspaceID, slug}
	if scope.Role == "student" || scope.Role == "viewer" {
		query += ` AND owner_user_id = ?`
		args = append(args, scope.UserID)
	}
	query += ` ORDER BY updated_at DESC`
	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects := []Project{}
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return projects, nil
}

func (store *ProjectStore) CreateProject(scope Scope, slug, title string, state map[string]any) (Project, error) {
	now := nowText()
	project := Project{
		ID: uuid.NewString(), TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
		OwnerUserID: scope.UserID, Slug: slug, Title: title, State: state,
		CreatedAt: now, UpdatedAt: now,
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return Project{}, err
	}
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return Project{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.Exec(`INSERT INTO projects(id, scope, tenant_id, workspace_id, owner_user_id, slug, title, state_json, created_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, project.ID, legacyScope(scope), scope.TenantID, scope.WorkspaceID, scope.UserID, slug, title, tx.json(encoded), tx.timestamp(now), tx.timestamp(now)); err != nil {
		return Project{}, err
	}
	if err := tx.Commit(); err != nil {
		return Project{}, err
	}
	return project, nil
}

func (store *ProjectStore) GetProject(scope Scope, id string) (Project, bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return Project{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	row := tx.QueryRow(`SELECT id, tenant_id, workspace_id, owner_user_id, slug, title, state_json, created_at, updated_at
		FROM projects WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, id)
	project, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, false, nil
	}
	if err != nil {
		return Project{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Project{}, false, err
	}
	return project, true, nil
}

func (store *ProjectStore) UpdateProject(scope Scope, id, title string, state map[string]any) (Project, bool, error) {
	encoded, err := json.Marshal(state)
	if err != nil {
		return Project{}, false, err
	}
	now := nowText()
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return Project{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(`UPDATE projects SET title = ?, state_json = ?, updated_at = ?
		WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, title, tx.json(encoded), tx.timestamp(now), scope.TenantID, scope.WorkspaceID, id)
	if err != nil {
		return Project{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return Project{}, false, err
	}
	project, ok, err := getProjectTx(context.Background(), tx, scope, id)
	if err != nil || !ok {
		return Project{}, ok, err
	}
	if err := tx.Commit(); err != nil {
		return Project{}, false, err
	}
	return project, true, nil
}

func (store *ProjectStore) DeleteProject(scope Scope, id string) (bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(`DELETE FROM projects WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, id)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return affected > 0, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (store *ProjectStore) CreateVersion(scope Scope, projectID, label string, state map[string]any) (Version, bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return Version{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, ok, err := getProjectTx(context.Background(), tx, scope, projectID); err != nil || !ok {
		return Version{}, ok, err
	}
	createdAt := nowText()
	version := Version{ID: uuid.NewString(), ProjectID: projectID, Label: label, State: state, CreatedAt: createdAt}
	encoded, err := json.Marshal(state)
	if err != nil {
		return Version{}, false, err
	}
	if _, err = tx.Exec(`INSERT INTO project_versions(id, project_id, scope, tenant_id, workspace_id, created_by_user_id, label, state_json, created_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, version.ID, projectID, legacyScope(scope), scope.TenantID, scope.WorkspaceID, scope.UserID, label, tx.json(encoded), tx.timestamp(createdAt)); err != nil {
		return Version{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Version{}, false, err
	}
	return version, true, nil
}

func (store *ProjectStore) ListVersions(scope Scope, projectID string) ([]Version, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.Query(`SELECT id, project_id, label, state_json, created_at FROM project_versions
		WHERE tenant_id = ? AND workspace_id = ? AND project_id = ? ORDER BY created_at DESC`, scope.TenantID, scope.WorkspaceID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	versions := []Version{}
	for rows.Next() {
		var version Version
		var createdAt timestampText
		var encoded string
		if err := rows.Scan(&version.ID, &version.ProjectID, &version.Label, &encoded, &createdAt); err != nil {
			return nil, err
		}
		version.CreatedAt = string(createdAt)
		if err := json.Unmarshal([]byte(encoded), &version.State); err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return versions, nil
}

func (store *ProjectStore) ListRuns(scope Scope, projectID string) ([]Run, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.Query(`SELECT id, job_id, project_id, slug, action, status, input_json, result_json, error_text, duration_ms, created_at, updated_at
		FROM workbench_runs WHERE tenant_id = ? AND workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 200`, scope.TenantID, scope.WorkspaceID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []Run{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return runs, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanProject(row rowScanner) (Project, error) {
	var project Project
	var encoded string
	var createdAt, updatedAt timestampText
	if err := row.Scan(&project.ID, &project.TenantID, &project.WorkspaceID, &project.OwnerUserID, &project.Slug, &project.Title, &encoded, &createdAt, &updatedAt); err != nil {
		return Project{}, err
	}
	project.CreatedAt, project.UpdatedAt = string(createdAt), string(updatedAt)
	if err := json.Unmarshal([]byte(encoded), &project.State); err != nil {
		return Project{}, fmt.Errorf("decode project state: %w", err)
	}
	return project, nil
}

func scanRun(row rowScanner) (Run, error) {
	var run Run
	var inputJSON, resultJSON string
	var createdAt, updatedAt timestampText
	if err := row.Scan(&run.ID, &run.JobID, &run.ProjectID, &run.Slug, &run.Action, &run.Status, &inputJSON, &resultJSON, &run.Error, &run.DurationMS, &createdAt, &updatedAt); err != nil {
		return Run{}, err
	}
	run.CreatedAt, run.UpdatedAt = string(createdAt), string(updatedAt)
	if err := json.Unmarshal([]byte(inputJSON), &run.Input); err != nil {
		return Run{}, err
	}
	if err := json.Unmarshal([]byte(resultJSON), &run.Result); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (store *ProjectStore) ListShared(scope Scope, kind string) ([]SharedRecord, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	query := `SELECT id, tenant_id, workspace_id, kind, revision, data_json, created_at, updated_at FROM shared_records
		WHERE tenant_id = ? AND workspace_id = ? AND kind = ?`
	args := []any{scope.TenantID, scope.WorkspaceID, kind}
	if kind == "submissions" && scope.Role != "admin" && scope.Role != "teacher" {
		query += ` AND owner_user_id = ?`
		args = append(args, scope.UserID)
	}
	query += ` ORDER BY updated_at DESC`
	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []SharedRecord{}
	for rows.Next() {
		record, err := scanShared(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return records, nil
}

func (store *ProjectStore) GetShared(scope Scope, kind, id string) (SharedRecord, bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return SharedRecord{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	query := `SELECT id, tenant_id, workspace_id, kind, revision, data_json, created_at, updated_at FROM shared_records
		WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ?`
	args := []any{scope.TenantID, scope.WorkspaceID, kind, id}
	if kind == "submissions" && scope.Role != "admin" && scope.Role != "teacher" {
		query += ` AND owner_user_id = ?`
		args = append(args, scope.UserID)
	}
	record, err := scanShared(tx.QueryRow(query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return SharedRecord{}, false, nil
	}
	if err != nil {
		return SharedRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return SharedRecord{}, false, err
	}
	return record, true, nil
}

func (store *ProjectStore) CreateShared(scope Scope, kind string, data map[string]any) (SharedRecord, error) {
	now := nowText()
	record := SharedRecord{ID: uuid.NewString(), TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Kind: kind, Revision: 1, Data: data, CreatedAt: now, UpdatedAt: now}
	encoded, err := json.Marshal(data)
	if err != nil {
		return SharedRecord{}, err
	}
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return SharedRecord{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.Exec(`INSERT INTO shared_records(id, tenant_id, workspace_id, owner_user_id, kind, revision, data_json, created_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.ID, scope.TenantID, scope.WorkspaceID, scope.UserID, kind, record.Revision, tx.json(encoded), tx.timestamp(now), tx.timestamp(now)); err != nil {
		return SharedRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return SharedRecord{}, err
	}
	return record, nil
}

func (store *ProjectStore) UpdateShared(scope Scope, kind, id string, revision int, data map[string]any) (SharedRecord, bool, bool, error) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return SharedRecord{}, false, false, err
	}
	now := nowText()
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return SharedRecord{}, false, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(`UPDATE shared_records SET revision = revision + 1, data_json = ?, updated_at = ?
		WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ? AND revision = ?`, tx.json(encoded), tx.timestamp(now), scope.TenantID, scope.WorkspaceID, kind, id, revision)
	if err != nil {
		return SharedRecord{}, false, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return SharedRecord{}, false, false, err
	}
	if affected == 0 {
		record, lookupErr := scanShared(tx.QueryRow(`SELECT id, tenant_id, workspace_id, kind, revision, data_json, created_at, updated_at FROM shared_records
			WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, kind, id))
		if errors.Is(lookupErr, sql.ErrNoRows) {
			return SharedRecord{}, false, false, nil
		}
		if lookupErr != nil {
			return SharedRecord{}, false, false, lookupErr
		}
		return record, true, true, nil
	}
	record, err := scanShared(tx.QueryRow(`SELECT id, tenant_id, workspace_id, kind, revision, data_json, created_at, updated_at FROM shared_records
		WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, kind, id))
	if err != nil {
		return SharedRecord{}, false, false, err
	}
	if err := tx.Commit(); err != nil {
		return SharedRecord{}, false, false, err
	}
	return record, true, false, nil
}

func (store *ProjectStore) DeleteShared(scope Scope, kind, id string) (bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(`DELETE FROM shared_records WHERE tenant_id = ? AND workspace_id = ? AND kind = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, kind, id)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return affected > 0, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func scanShared(row rowScanner) (SharedRecord, error) {
	var record SharedRecord
	var encoded string
	var createdAt, updatedAt timestampText
	if err := row.Scan(&record.ID, &record.TenantID, &record.WorkspaceID, &record.Kind, &record.Revision, &encoded, &createdAt, &updatedAt); err != nil {
		return SharedRecord{}, err
	}
	record.CreatedAt, record.UpdatedAt = string(createdAt), string(updatedAt)
	if err := json.Unmarshal([]byte(encoded), &record.Data); err != nil {
		return SharedRecord{}, err
	}
	return record, nil
}

func legacyScope(scope Scope) string {
	return scope.TenantID + "|" + scope.WorkspaceID
}

func nowText() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
