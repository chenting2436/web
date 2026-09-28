package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Job struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenantId"`
	WorkspaceID     string         `json:"workspaceId"`
	ProjectID       string         `json:"projectId"`
	CreatedByUserID string         `json:"createdByUserId"`
	Slug            string         `json:"slug"`
	Action          string         `json:"action"`
	Status          string         `json:"status"`
	Input           map[string]any `json:"input"`
	Result          map[string]any `json:"result"`
	Error           string         `json:"error,omitempty"`
	IdempotencyKey  string         `json:"idempotencyKey,omitempty"`
	Attempt         int            `json:"attempt"`
	WorkerID        string         `json:"workerId,omitempty"`
	DurationMS      float64        `json:"durationMs"`
	CreatedAt       string         `json:"createdAt"`
	StartedAt       string         `json:"startedAt,omitempty"`
	UpdatedAt       string         `json:"updatedAt"`
	FinishedAt      string         `json:"finishedAt,omitempty"`
}

type JobRun struct {
	Job Job `json:"job"`
	Run Run `json:"run"`
}

const (
	DefaultJobLease = 30 * time.Second
	maximumJobLease = 24 * time.Hour
)

var jobClaimContextPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`)
var jobClaimCapabilityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// JobClaim is an internal worker capability. ClaimToken is deliberately kept
// out of Job, so browser-facing job reads and lists cannot serialize it by
// accident. A token is shown only once to the worker that acquired the lease;
// the database stores its SHA-256 digest.
type JobClaim struct {
	Job            Job    `json:"job"`
	ClaimToken     string `json:"claimToken"`
	ClaimEpoch     int64  `json:"claimEpoch"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
	HeartbeatAt    string `json:"heartbeatAt"`
}

type JobLease struct {
	ClaimEpoch     int64  `json:"claimEpoch"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
	HeartbeatAt    string `json:"heartbeatAt"`
}

// JobClaimScope is a server-authorized worker dispatch boundary. It is kept in
// the store package (rather than accepting a predicate assembled by the API)
// so both the candidate lock and the claim update apply the same policy.
type JobClaimScope struct {
	TenantID    string
	WorkspaceID string
	Slug        string
	Actions     []string
}

type JobClaimAccess struct {
	WorkerID string
	Scopes   []JobClaimScope
}

func (store *ProjectStore) CreateJob(scope Scope, projectID, slug, action string, input map[string]any, idempotencyKey string) (JobRun, bool, error) {
	return store.createJob(context.Background(), scope, projectID, slug, action, input, idempotencyKey, nil)
}

func (store *ProjectStore) CreateJobWithAudit(scope Scope, projectID, slug, action string, input map[string]any, idempotencyKey string, audit func(JobRun) AuditEvent) (JobRun, bool, error) {
	return store.CreateJobWithAuditContext(context.Background(), scope, projectID, slug, action, input, idempotencyKey, audit)
}

func (store *ProjectStore) CreateJobWithAuditContext(ctx context.Context, scope Scope, projectID, slug, action string, input map[string]any, idempotencyKey string, audit func(JobRun) AuditEvent) (JobRun, bool, error) {
	if audit == nil {
		return JobRun{}, false, errors.New("job-create audit factory is required")
	}
	return store.createJob(ctx, scope, projectID, slug, action, input, idempotencyKey, audit)
}

func (store *ProjectStore) createJob(ctx context.Context, scope Scope, projectID, slug, action string, input map[string]any, idempotencyKey string, audit func(JobRun) AuditEvent) (JobRun, bool, error) {
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return JobRun{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setUserRLSContext(scope); err != nil {
		return JobRun{}, false, err
	}

	var projectSlug string
	if err := tx.QueryRowContext(ctx, `SELECT slug FROM projects WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, projectID).Scan(&projectSlug); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return JobRun{}, false, nil
		}
		return JobRun{}, false, err
	}
	if projectSlug != slug {
		return JobRun{}, false, fmt.Errorf("job slug does not match project")
	}
	if idempotencyKey != "" {
		replay, found, err := getIdempotentJobRunTx(ctx, tx, scope, projectID, slug, action, input, idempotencyKey)
		if err != nil {
			return JobRun{}, false, err
		}
		if found {
			if err := tx.Commit(); err != nil {
				return JobRun{}, false, err
			}
			return replay, false, nil
		}
	}

	inputJSON, err := json.Marshal(input)
	if err != nil {
		return JobRun{}, false, err
	}
	now := nowText()
	job := Job{
		ID: uuid.NewString(), TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, ProjectID: projectID,
		CreatedByUserID: scope.UserID, Slug: slug, Action: action, Status: "queued", Input: input,
		Result: map[string]any{}, IdempotencyKey: idempotencyKey, CreatedAt: now, UpdatedAt: now,
	}
	insertQuery := `INSERT INTO jobs(id, tenant_id, workspace_id, project_id, created_by_user_id, slug, action, status,
		input_json, result_json, error_text, idempotency_key, attempt, worker_id, duration_ms, created_at, started_at, updated_at, finished_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', ?, '{}', '', ?, 0, '', 0, ?, ?, ?, ?)`
	if idempotencyKey != "" {
		// The partial unique index is the concurrency authority. The initial
		// lookup above is only a fast path; this clause closes the read/insert
		// race when another replica commits the same key in between.
		insertQuery += ` ON CONFLICT(tenant_id, workspace_id, created_by_user_id, idempotency_key)
			WHERE idempotency_key <> '' DO NOTHING`
	}
	inserted, err := tx.ExecContext(ctx, insertQuery, job.ID, scope.TenantID,
		scope.WorkspaceID, projectID, scope.UserID, slug, action, tx.json(inputJSON), idempotencyKey,
		tx.timestamp(now), tx.optionalTimestamp(""), tx.timestamp(now), tx.optionalTimestamp(""))
	if err != nil {
		return JobRun{}, false, err
	}
	insertedRows, err := inserted.RowsAffected()
	if err != nil {
		return JobRun{}, false, err
	}
	if insertedRows == 0 {
		replay, found, err := getIdempotentJobRunTx(ctx, tx, scope, projectID, slug, action, input, idempotencyKey)
		if err != nil {
			return JobRun{}, false, err
		}
		if !found {
			return JobRun{}, false, errors.New("idempotent job conflict could not be resolved")
		}
		if err := tx.Commit(); err != nil {
			return JobRun{}, false, err
		}
		return replay, false, nil
	}
	run := Run{
		ID: uuid.NewString(), JobID: job.ID, ProjectID: projectID, Slug: slug, Action: action,
		Status: "queued", Input: input, Result: map[string]any{}, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workbench_runs(id, project_id, scope, tenant_id, workspace_id, created_by_user_id,
		job_id, slug, action, status, input_json, result_json, error_text, duration_ms, created_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, '{}', '', 0, ?, ?)`, run.ID, projectID, legacyScope(scope),
		scope.TenantID, scope.WorkspaceID, scope.UserID, job.ID, slug, action, tx.json(inputJSON), tx.timestamp(now), tx.timestamp(now)); err != nil {
		return JobRun{}, false, err
	}
	if err := store.enqueueJobLifecycleTx(tx, job, jobEventCreated); err != nil {
		return JobRun{}, false, err
	}
	jobRun := JobRun{Job: job, Run: run}
	if audit != nil {
		if err := store.appendBusinessAuditTxContext(ctx, tx, scope, audit(jobRun)); err != nil {
			return JobRun{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return JobRun{}, false, err
	}
	return jobRun, true, nil
}

func (store *ProjectStore) GetJob(scope Scope, id string) (Job, bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return Job{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	job, err := scanJob(tx.QueryRow(jobSelect+` WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, false, err
	}
	return job, true, nil
}

// GetJobInternal is a development/test compatibility path. Production worker
// handlers must use GetJobInternalForWorker so PostgreSQL RLS receives the
// exact server-authenticated capability set before the row is read.
func (store *ProjectStore) GetJobInternal(id string) (Job, bool, error) {
	if store.adapter == AdapterPostgreSQL {
		return Job{}, false, errors.New("PostgreSQL internal job read requires exact worker access")
	}
	job, err := scanJob(store.database.QueryRow(jobSelect+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	return job, err == nil, err
}

func (store *ProjectStore) GetJobInternalForWorker(access JobClaimAccess, id string) (Job, bool, error) {
	return store.GetJobInternalForWorkerContext(context.Background(), access, id)
}

func (store *ProjectStore) GetJobInternalForWorkerContext(ctx context.Context, access JobClaimAccess, id string) (Job, bool, error) {
	scopePredicate, scopeArguments, err := jobClaimScopePredicate(access.Scopes)
	if err != nil {
		return Job{}, false, err
	}
	tx, err := store.beginWorkerTransaction(ctx, access)
	if err != nil {
		return Job{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	arguments := append([]any{id}, scopeArguments...)
	job, err := scanJob(tx.QueryRowContext(ctx, jobSelect+` WHERE id = ? AND (`+scopePredicate+`)`, arguments...))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Job{}, false, err
	}
	return job, true, nil
}

// GetJobForClaim atomically validates a live capability and returns its job
// input without extending the lease. A missing ID returns found=false; an
// existing row with a stale/wrong claim returns found=true, ErrJobClaimLost.
func (store *ProjectStore) GetJobForClaim(id, workerID, claimToken string) (Job, bool, error) {
	return store.getJobForClaim(nil, id, workerID, claimToken)
}

func (store *ProjectStore) GetJobForClaimForWorker(access JobClaimAccess, id, claimToken string) (Job, bool, error) {
	return store.getJobForClaim(&access, id, access.WorkerID, claimToken)
}

func (store *ProjectStore) getJobForClaim(access *JobClaimAccess, id, workerID, claimToken string) (Job, bool, error) {
	id, workerID, claimToken = strings.TrimSpace(id), strings.TrimSpace(workerID), strings.TrimSpace(claimToken)
	if id == "" || workerID == "" || claimToken == "" {
		return Job{}, false, ErrJobClaimLost
	}
	tx, err := store.database.Begin()
	if err != nil {
		return Job{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if access != nil {
		if err := tx.setWorkerRLSContext(*access); err != nil {
			return Job{}, false, err
		}
	} else if store.adapter == AdapterPostgreSQL {
		return Job{}, false, errors.New("PostgreSQL job claim read requires exact worker access")
	}
	nowExpression := databaseNowExpression(store.adapter)
	job, err := scanJob(tx.QueryRow(jobSelect+` WHERE id = ? AND status = 'running' AND worker_id = ?
		AND claim_token_hash = ? AND lease_expires_at > `+nowExpression, id, workerID, claimTokenDigest(claimToken)))
	if err == nil {
		if err := tx.Commit(); err != nil {
			return Job{}, false, err
		}
		return job, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, err
	}
	var exists int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM jobs WHERE id = ?`, id).Scan(&exists); err != nil {
		return Job{}, false, err
	}
	if exists == 0 {
		return Job{}, false, nil
	}
	return Job{}, true, ErrJobClaimLost
}

func (store *ProjectStore) ListJobs(scope Scope, projectID string) ([]Job, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.Query(jobSelect+` WHERE tenant_id = ? AND workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 200`, scope.TenantID, scope.WorkspaceID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []Job{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (store *ProjectStore) CancelJob(scope Scope, id string) (Job, bool, bool, error) {
	return store.cancelJob(context.Background(), scope, id, nil)
}

func (store *ProjectStore) CancelJobWithAudit(scope Scope, id string, audit func(Job, Job) AuditEvent) (Job, bool, bool, error) {
	return store.CancelJobWithAuditContext(context.Background(), scope, id, audit)
}

func (store *ProjectStore) CancelJobWithAuditContext(ctx context.Context, scope Scope, id string, audit func(Job, Job) AuditEvent) (Job, bool, bool, error) {
	if audit == nil {
		return Job{}, false, false, errors.New("job-cancel audit factory is required")
	}
	return store.cancelJob(ctx, scope, id, audit)
}

func (store *ProjectStore) cancelJob(ctx context.Context, scope Scope, id string, audit func(Job, Job) AuditEvent) (Job, bool, bool, error) {
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return Job{}, false, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setUserRLSContext(scope); err != nil {
		return Job{}, false, false, err
	}
	job, found, err := getJobByScopeTx(ctx, tx, scope, id, true)
	if err != nil || !found {
		return Job{}, found, false, err
	}
	if scope.Role != "admin" && job.CreatedByUserID != scope.UserID {
		return Job{}, true, true, nil
	}
	if job.Status != "queued" && job.Status != "running" {
		return job, true, false, ErrInvalidJobTransition
	}
	before := job
	now := nowText()
	result, err := tx.ExecContext(ctx, `UPDATE jobs SET status = 'canceled', worker_id = '', claim_token_hash = '',
		lease_expires_at = NULL, heartbeat_at = NULL, execution_started_at = NULL, updated_at = ?, finished_at = ?
		WHERE id = ? AND tenant_id = ? AND workspace_id = ?
		AND (status = 'queued' OR (status = 'running' AND execution_started_at IS NULL))`,
		tx.timestamp(now), tx.timestamp(now), id, scope.TenantID, scope.WorkspaceID)
	if err != nil {
		return Job{}, true, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return Job{}, true, false, ErrInvalidJobTransition
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workbench_runs SET status = 'canceled', updated_at = ? WHERE job_id = ?`, tx.timestamp(now), id); err != nil {
		return Job{}, true, false, err
	}
	job, err = getJobByIDTxContext(ctx, tx, id)
	if err != nil {
		return Job{}, true, false, err
	}
	if err := store.enqueueJobLifecycleTx(tx, job, jobEventCancelled); err != nil {
		return Job{}, true, false, err
	}
	if audit != nil {
		if err := store.appendBusinessAuditTxContext(ctx, tx, scope, audit(before, job)); err != nil {
			return Job{}, true, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Job{}, true, false, err
	}
	return job, true, false, nil
}

func (store *ProjectStore) ClaimNextJob(access JobClaimAccess) (Job, bool, error) {
	claim, found, err := store.ClaimNextJobWithLease(access, DefaultJobLease)
	return claim.Job, found, err
}

// ClaimNextJobWithLease atomically claims a queued job or takes over an
// expired lease only when compute has not started. Database time is the sole
// authority for lease eligibility. If compute started before a lease was lost,
// the job is terminalized instead of replayed because its external side effects
// cannot be proven absent. Expired jobs that consumed max_attempts are also
// failed (including their run and outbox event) before the search continues.
func (store *ProjectStore) ClaimNextJobWithLease(access JobClaimAccess, leaseDuration time.Duration) (JobClaim, bool, error) {
	return store.claimNextJobWithLease(context.Background(), access, leaseDuration, nil, nil)
}

func (store *ProjectStore) ClaimNextJobWithLeaseAndAudit(access JobClaimAccess, leaseDuration time.Duration, auditClaim func(JobClaim) AuditEvent, auditExhausted func(Job) AuditEvent) (JobClaim, bool, error) {
	if auditClaim == nil || auditExhausted == nil {
		return JobClaim{}, false, errors.New("job-claim and exhausted-job audit factories are required")
	}
	return store.claimNextJobWithLease(context.Background(), access, leaseDuration, auditClaim, auditExhausted)
}

func (store *ProjectStore) ClaimNextJobWithLeaseAndAuditContext(ctx context.Context, access JobClaimAccess, leaseDuration time.Duration, auditClaim func(JobClaim) AuditEvent, auditExhausted func(Job) AuditEvent) (JobClaim, bool, error) {
	if auditClaim == nil || auditExhausted == nil {
		return JobClaim{}, false, errors.New("job-claim and exhausted-job audit factories are required")
	}
	return store.claimNextJobWithLease(ctx, access, leaseDuration, auditClaim, auditExhausted)
}

func (store *ProjectStore) claimNextJobWithLease(ctx context.Context, access JobClaimAccess, leaseDuration time.Duration, auditClaim func(JobClaim) AuditEvent, auditExhausted func(Job) AuditEvent) (JobClaim, bool, error) {
	access.WorkerID = strings.TrimSpace(access.WorkerID)
	leaseSeconds, err := normalizedLeaseSeconds(access.WorkerID, leaseDuration, maximumJobLease)
	if err != nil {
		return JobClaim{}, false, err
	}
	scopePredicate, scopeArguments, err := jobClaimScopePredicate(access.Scopes)
	if err != nil {
		return JobClaim{}, false, err
	}

	for {
		tx, err := store.database.BeginContext(ctx)
		if err != nil {
			return JobClaim{}, false, err
		}
		if err := tx.setWorkerRLSContext(access); err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}
		var id, status string
		var attempt, maxAttempts, executionStarted int
		err = tx.QueryRow(jobClaimCandidateQuery(store.adapter, scopePredicate), scopeArguments...).Scan(&id, &status, &attempt, &maxAttempts, &executionStarted)
		if errors.Is(err, sql.ErrNoRows) {
			_ = tx.Rollback()
			return JobClaim{}, false, nil
		}
		if err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}

		if status == "running" && executionStarted == 1 {
			failed, err := store.failLostExecutionLeaseJobTx(tx, id)
			if err != nil {
				_ = tx.Rollback()
				return JobClaim{}, false, err
			}
			if !failed {
				_ = tx.Rollback()
				continue
			}
			if auditExhausted != nil {
				terminal, err := getJobByIDTx(tx, id)
				if err != nil {
					_ = tx.Rollback()
					return JobClaim{}, false, err
				}
				auditScope := Scope{TenantID: terminal.TenantID, WorkspaceID: terminal.WorkspaceID, UserID: "worker:" + access.WorkerID, Role: "service"}
				if err := store.appendBusinessAuditTxContext(ctx, tx, auditScope, auditExhausted(terminal)); err != nil {
					_ = tx.Rollback()
					return JobClaim{}, false, err
				}
			}
			if err := tx.Commit(); err != nil {
				return JobClaim{}, false, err
			}
			continue
		}

		if attempt >= maxAttempts {
			if err := store.failExhaustedJobTx(tx, id); err != nil {
				_ = tx.Rollback()
				return JobClaim{}, false, err
			}
			if auditExhausted != nil {
				failed, err := getJobByIDTx(tx, id)
				if err != nil {
					_ = tx.Rollback()
					return JobClaim{}, false, err
				}
				auditScope := Scope{TenantID: failed.TenantID, WorkspaceID: failed.WorkspaceID, UserID: "worker:" + access.WorkerID, Role: "service"}
				if err := store.appendBusinessAuditTxContext(ctx, tx, auditScope, auditExhausted(failed)); err != nil {
					_ = tx.Rollback()
					return JobClaim{}, false, err
				}
			}
			if err := tx.Commit(); err != nil {
				return JobClaim{}, false, err
			}
			continue
		}

		token, tokenHash, err := newClaimToken()
		if err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}
		nowExpression := databaseNowExpression(store.adapter)
		leaseExpression := databaseLeaseExpression(store.adapter)
		updateArguments := []any{access.WorkerID, tokenHash, leaseSeconds, id}
		updateArguments = append(updateArguments, scopeArguments...)
		result, err := tx.Exec(`UPDATE jobs SET status = 'running', worker_id = ?, attempt = attempt + 1,
			claim_epoch = claim_epoch + 1, claim_token_hash = ?, lease_expires_at = `+leaseExpression+`,
			heartbeat_at = `+nowExpression+`, execution_started_at = NULL, started_at = CASE WHEN started_at IS NULL OR CAST(started_at AS TEXT) = ''
			THEN `+nowExpression+` ELSE started_at END, updated_at = `+nowExpression+`
			WHERE id = ? AND attempt < max_attempts AND
			(status = 'queued' OR (status = 'running' AND lease_expires_at <= `+nowExpression+` AND execution_started_at IS NULL))
			AND (`+scopePredicate+`)`, updateArguments...)
		if err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}
		if affected == 0 {
			_ = tx.Rollback()
			continue
		}
		if _, err := tx.Exec(`UPDATE workbench_runs SET status = 'running', error_text = '', updated_at = `+nowExpression+` WHERE job_id = ?`, id); err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}
		claim, err := getJobClaimTx(tx, id, token)
		if err != nil {
			_ = tx.Rollback()
			return JobClaim{}, false, err
		}
		if auditClaim != nil {
			auditScope := Scope{TenantID: claim.Job.TenantID, WorkspaceID: claim.Job.WorkspaceID, UserID: "worker:" + access.WorkerID, Role: "service"}
			if err := store.appendBusinessAuditTxContext(ctx, tx, auditScope, auditClaim(claim)); err != nil {
				_ = tx.Rollback()
				return JobClaim{}, false, err
			}
		}
		if err := tx.Commit(); err != nil {
			return JobClaim{}, false, err
		}
		return claim, true, nil
	}
}

func jobClaimCandidateQuery(adapter, scopePredicate string) string {
	nowExpression := databaseNowExpression(adapter)
	query := `SELECT id, status, attempt, max_attempts,
		CASE WHEN execution_started_at IS NOT NULL THEN 1 ELSE 0 END FROM jobs
		WHERE (status = 'queued' OR (status = 'running' AND lease_expires_at <= ` + nowExpression + `))
		AND (` + scopePredicate + `)
		ORDER BY created_at, id LIMIT 1`
	if adapter == AdapterPostgreSQL {
		query += ` FOR UPDATE SKIP LOCKED`
	}
	return query
}

func jobClaimScopePredicate(scopes []JobClaimScope) (string, []any, error) {
	if len(scopes) == 0 || len(scopes) > 64 {
		return "", nil, errors.New("worker job claim requires between 1 and 64 scopes")
	}
	predicates := make([]string, 0, len(scopes))
	arguments := make([]any, 0)
	seenBoundaries := make(map[string]struct{}, len(scopes))
	for index, scope := range scopes {
		tenantID, workspaceID := strings.TrimSpace(scope.TenantID), strings.TrimSpace(scope.WorkspaceID)
		if tenantID != scope.TenantID || workspaceID != scope.WorkspaceID ||
			!jobClaimContextPattern.MatchString(tenantID) || !jobClaimContextPattern.MatchString(workspaceID) {
			return "", nil, fmt.Errorf("worker job claim scope %d has an invalid tenant/workspace boundary", index)
		}
		slug := strings.TrimSpace(scope.Slug)
		if slug != scope.Slug || !jobClaimCapabilityPattern.MatchString(slug) {
			return "", nil, fmt.Errorf("worker job claim scope %d contains invalid slug", index)
		}
		boundary := tenantID + "\x00" + workspaceID + "\x00" + slug
		if _, exists := seenBoundaries[boundary]; exists {
			return "", nil, fmt.Errorf("worker job claim scope %d duplicates tenant/workspace/slug boundary", index)
		}
		seenBoundaries[boundary] = struct{}{}
		if len(scope.Actions) == 0 || len(scope.Actions) > 256 {
			return "", nil, fmt.Errorf("worker job claim scope %d requires a bounded action allowlist", index)
		}
		actionPlaceholders, actionValues, err := jobClaimAllowlist("action", index, scope.Actions)
		if err != nil {
			return "", nil, err
		}
		predicates = append(predicates, `(tenant_id = ? AND workspace_id = ? AND slug = ? AND action IN (`+
			strings.Join(actionPlaceholders, ",")+`))`)
		arguments = append(arguments, tenantID, workspaceID, slug)
		arguments = append(arguments, actionValues...)
	}
	return strings.Join(predicates, " OR "), arguments, nil
}

func jobClaimAllowlist(kind string, scopeIndex int, values []string) ([]string, []any, error) {
	placeholders := make([]string, len(values))
	arguments := make([]any, len(values))
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		if value != strings.TrimSpace(value) || !jobClaimCapabilityPattern.MatchString(value) {
			return nil, nil, fmt.Errorf("worker job claim scope %d contains invalid %s entry", scopeIndex, kind)
		}
		if _, exists := seen[value]; exists {
			return nil, nil, fmt.Errorf("worker job claim scope %d contains duplicate %s %q", scopeIndex, kind, value)
		}
		seen[value] = struct{}{}
		placeholders[index] = "?"
		arguments[index] = value
	}
	return placeholders, arguments, nil
}

const JobAttemptsExhaustedError = "maximum job attempts exhausted after lease expiry"
const JobExecutionLeaseLostError = "job execution lease expired after compute started; automatic replay is forbidden"

func (store *ProjectStore) failExhaustedJobTx(tx *databaseTx, id string) error {
	nowExpression := databaseNowExpression(store.adapter)
	result, err := tx.Exec(`UPDATE jobs SET status = 'failed', worker_id = '', claim_token_hash = '',
		lease_expires_at = NULL, heartbeat_at = NULL, execution_started_at = NULL, error_text = ?, updated_at = `+nowExpression+`,
		finished_at = `+nowExpression+` WHERE id = ? AND status IN ('queued','running') AND attempt >= max_attempts`,
		JobAttemptsExhaustedError, id)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return nil
	}
	if _, err := tx.Exec(`UPDATE workbench_runs SET status = 'failed', error_text = ?, updated_at = `+nowExpression+` WHERE job_id = ?`, JobAttemptsExhaustedError, id); err != nil {
		return err
	}
	job, err := getJobByIDTx(tx, id)
	if err != nil {
		return err
	}
	return store.enqueueJobLifecycleTx(tx, job, jobEventFailed)
}

func (store *ProjectStore) failLostExecutionLeaseJobTx(tx *databaseTx, id string) (bool, error) {
	nowExpression := databaseNowExpression(store.adapter)
	result, err := tx.Exec(`UPDATE jobs SET status = 'failed', worker_id = '', claim_token_hash = '',
		lease_expires_at = NULL, heartbeat_at = NULL, execution_started_at = NULL, error_text = ?, updated_at = `+nowExpression+`,
		finished_at = `+nowExpression+` WHERE id = ? AND status = 'running'
		AND lease_expires_at <= `+nowExpression+` AND execution_started_at IS NOT NULL`,
		JobExecutionLeaseLostError, id)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return false, err
	}
	if _, err := tx.Exec(`UPDATE workbench_runs SET status = 'failed', error_text = ?, updated_at = `+nowExpression+` WHERE job_id = ?`, JobExecutionLeaseLostError, id); err != nil {
		return false, err
	}
	job, err := getJobByIDTx(tx, id)
	if err != nil {
		return false, err
	}
	if err := store.enqueueJobLifecycleTx(tx, job, jobEventFailed); err != nil {
		return false, err
	}
	return true, nil
}

var ErrInvalidJobTransition = errors.New("invalid job transition")
var ErrIdempotencyConflict = errors.New("idempotency key reused with different request")
var ErrJobWorkerMismatch = errors.New("job is not owned by this worker")
var ErrJobClaimLost = errors.New("job claim is invalid or its lease has expired")
var ErrJobExecutionStarted = errors.New("job execution already started for this claim")

// BeginJobExecution is the single-use fence in front of the compute service.
// A retry carrying the same live claim cannot start the same attempt twice.
// A lease that expires after this fence is consumed is never automatically
// replayed; the claim path terminalizes it for explicit operator recovery.
func (store *ProjectStore) BeginJobExecution(id, workerID, claimToken string) (Job, bool, error) {
	return store.beginJobExecution(context.Background(), nil, id, workerID, claimToken, nil)
}

func (store *ProjectStore) BeginJobExecutionWithAudit(id, workerID, claimToken string, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	if audit == nil {
		return Job{}, false, errors.New("job-execution-start audit factory is required")
	}
	return store.beginJobExecution(context.Background(), nil, id, workerID, claimToken, audit)
}

// BeginJobExecutionForWorkerWithAudit binds the same exact authorization set
// used during claim to the PostgreSQL transaction that consumes the claim.
func (store *ProjectStore) BeginJobExecutionForWorkerWithAudit(access JobClaimAccess, id, claimToken string, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	return store.BeginJobExecutionForWorkerWithAuditContext(context.Background(), access, id, claimToken, audit)
}

func (store *ProjectStore) BeginJobExecutionForWorkerWithAuditContext(ctx context.Context, access JobClaimAccess, id, claimToken string, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	if audit == nil {
		return Job{}, false, errors.New("job-execution-start audit factory is required")
	}
	return store.beginJobExecution(ctx, &access, id, access.WorkerID, claimToken, audit)
}

func (store *ProjectStore) beginJobExecution(ctx context.Context, access *JobClaimAccess, id, workerID, claimToken string, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	id, workerID, claimToken = strings.TrimSpace(id), strings.TrimSpace(workerID), strings.TrimSpace(claimToken)
	if id == "" || workerID == "" || claimToken == "" {
		return Job{}, false, ErrJobClaimLost
	}
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return Job{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if access != nil {
		if err := tx.setWorkerRLSContext(*access); err != nil {
			return Job{}, false, err
		}
	} else if store.adapter == AdapterPostgreSQL {
		return Job{}, false, errors.New("PostgreSQL job execution requires exact worker access")
	}
	before, err := getJobByIDTxLocked(tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	nowExpression := databaseNowExpression(store.adapter)
	tokenHash := claimTokenDigest(claimToken)
	result, err := tx.Exec(`UPDATE jobs SET execution_started_at = `+nowExpression+`, updated_at = `+nowExpression+`
		WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token_hash = ?
		AND lease_expires_at > `+nowExpression+` AND execution_started_at IS NULL`, id, workerID, tokenHash)
	if err != nil {
		return Job{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Job{}, false, err
	}
	if affected == 0 {
		var exists, sameLiveClaim, executionStarted int
		if err := tx.QueryRow(`SELECT COUNT(*),
			COALESCE(MAX(CASE WHEN status = 'running' AND worker_id = ? AND claim_token_hash = ?
			AND lease_expires_at > `+nowExpression+` THEN 1 ELSE 0 END), 0),
			COALESCE(MAX(CASE WHEN status = 'running' AND worker_id = ? AND claim_token_hash = ?
			AND lease_expires_at > `+nowExpression+` AND execution_started_at IS NOT NULL THEN 1 ELSE 0 END), 0)
			FROM jobs WHERE id = ?`, workerID, tokenHash, workerID, tokenHash, id).
			Scan(&exists, &sameLiveClaim, &executionStarted); err != nil {
			return Job{}, false, err
		}
		if exists == 0 {
			return Job{}, false, nil
		}
		if sameLiveClaim == 1 && executionStarted == 1 {
			return Job{}, true, ErrJobExecutionStarted
		}
		return Job{}, true, ErrJobClaimLost
	}
	job, err := getJobByIDTx(tx, id)
	if err != nil {
		return Job{}, true, err
	}
	if audit != nil {
		auditScope := Scope{TenantID: job.TenantID, WorkspaceID: job.WorkspaceID, UserID: "worker:" + workerID, Role: "service"}
		if err := store.appendBusinessAuditTxContext(ctx, tx, auditScope, audit(before, job)); err != nil {
			return Job{}, true, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Job{}, true, err
	}
	return job, true, nil
}

// CompleteJob is retained for compatibility with trusted in-process callers.
// Worker-facing paths must use CompleteJobForWorker so ownership is enforced by
// the same UPDATE that writes the terminal state.
func (store *ProjectStore) CompleteJob(id, status string, result map[string]any, errorText string, durationMS float64) (Job, bool, error) {
	return store.completeJob(context.Background(), nil, id, "", "", false, false, status, result, errorText, durationMS, nil)
}

// CompleteJobForWorker is a temporary trusted in-process compatibility path.
// It cannot provide ABA protection and must never be exposed as a network
// completion command.
func (store *ProjectStore) CompleteJobForWorker(id, workerID, status string, result map[string]any, errorText string, durationMS float64) (Job, bool, error) {
	workerID = strings.TrimSpace(workerID)
	if workerID == "" {
		return Job{}, false, ErrJobWorkerMismatch
	}
	return store.completeJob(context.Background(), nil, id, workerID, "", true, false, status, result, errorText, durationMS, nil)
}

func (store *ProjectStore) CompleteJobClaim(id, workerID, claimToken, status string, result map[string]any, errorText string, durationMS float64) (Job, bool, error) {
	workerID = strings.TrimSpace(workerID)
	if workerID == "" || strings.TrimSpace(claimToken) == "" {
		return Job{}, false, ErrJobClaimLost
	}
	return store.completeJob(context.Background(), nil, id, workerID, claimTokenDigest(claimToken), true, true, status, result, errorText, durationMS, nil)
}

func (store *ProjectStore) CompleteJobClaimWithAudit(id, workerID, claimToken, status string, result map[string]any, errorText string, durationMS float64, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	workerID = strings.TrimSpace(workerID)
	if workerID == "" || strings.TrimSpace(claimToken) == "" {
		return Job{}, false, ErrJobClaimLost
	}
	if audit == nil {
		return Job{}, false, errors.New("job-completion audit factory is required")
	}
	return store.completeJob(context.Background(), nil, id, workerID, claimTokenDigest(claimToken), true, true, status, result, errorText, durationMS, audit)
}

func (store *ProjectStore) CompleteJobClaimForWorkerWithAudit(access JobClaimAccess, id, claimToken, status string, result map[string]any, errorText string, durationMS float64, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	return store.CompleteJobClaimForWorkerWithAuditContext(context.Background(), access, id, claimToken, status, result, errorText, durationMS, audit)
}

func (store *ProjectStore) CompleteJobClaimForWorkerWithAuditContext(ctx context.Context, access JobClaimAccess, id, claimToken, status string, result map[string]any, errorText string, durationMS float64, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	if strings.TrimSpace(access.WorkerID) == "" || strings.TrimSpace(claimToken) == "" {
		return Job{}, false, ErrJobClaimLost
	}
	if audit == nil {
		return Job{}, false, errors.New("job-completion audit factory is required")
	}
	return store.completeJob(ctx, &access, id, access.WorkerID, claimTokenDigest(claimToken), true, true, status, result, errorText, durationMS, audit)
}

func (store *ProjectStore) completeJob(ctx context.Context, access *JobClaimAccess, id, workerID, tokenHash string, requireWorker, requireClaim bool, status string, result map[string]any, errorText string, durationMS float64, audit func(Job, Job) AuditEvent) (Job, bool, error) {
	if status != "succeeded" && status != "failed" {
		return Job{}, false, ErrInvalidJobTransition
	}
	eventType := jobEventSucceeded
	if status == "failed" {
		eventType = jobEventFailed
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return Job{}, false, err
	}
	now := nowText()
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return Job{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if access != nil {
		if err := tx.setWorkerRLSContext(*access); err != nil {
			return Job{}, false, err
		}
	} else if store.adapter == AdapterPostgreSQL {
		return Job{}, false, errors.New("PostgreSQL job completion requires exact worker access")
	}
	before, err := getJobByIDTxLocked(tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, err
	}
	var updated sql.Result
	if requireClaim {
		nowExpression := databaseNowExpression(store.adapter)
		updated, err = tx.Exec(`UPDATE jobs SET status = ?, result_json = ?, error_text = ?, duration_ms = ?,
			worker_id = '', claim_token_hash = '', lease_expires_at = NULL, heartbeat_at = NULL, execution_started_at = NULL,
			updated_at = `+nowExpression+`, finished_at = `+nowExpression+`
			WHERE id = ? AND status = 'running' AND worker_id = ? AND claim_token_hash = ?
			AND lease_expires_at > `+nowExpression+` AND execution_started_at IS NOT NULL`, status, tx.json(resultJSON), errorText, durationMS, id, workerID, tokenHash)
	} else if requireWorker {
		nowExpression := databaseNowExpression(store.adapter)
		updated, err = tx.Exec(`UPDATE jobs SET status = ?, result_json = ?, error_text = ?, duration_ms = ?,
			worker_id = '', claim_token_hash = '', lease_expires_at = NULL, heartbeat_at = NULL, execution_started_at = NULL,
			updated_at = `+nowExpression+`, finished_at = `+nowExpression+`
			WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_expires_at > `+nowExpression,
			status, tx.json(resultJSON), errorText, durationMS, id, workerID)
	} else {
		updated, err = tx.Exec(`UPDATE jobs SET status = ?, result_json = ?, error_text = ?, duration_ms = ?,
			worker_id = '', claim_token_hash = '', lease_expires_at = NULL, heartbeat_at = NULL, execution_started_at = NULL, updated_at = ?, finished_at = ?
			WHERE id = ? AND status = 'running'`, status, tx.json(resultJSON), errorText, durationMS, tx.timestamp(now), tx.timestamp(now), id)
	}
	if err != nil {
		return Job{}, false, err
	}
	affected, err := updated.RowsAffected()
	if err != nil {
		return Job{}, false, err
	}
	if affected == 0 {
		existing, readErr := getJobByIDTx(tx, id)
		if errors.Is(readErr, sql.ErrNoRows) {
			return Job{}, false, nil
		}
		if readErr != nil {
			return Job{}, false, readErr
		}
		if requireClaim {
			return Job{}, true, ErrJobClaimLost
		}
		if requireWorker && existing.Status == "running" && existing.WorkerID != workerID {
			return Job{}, true, ErrJobWorkerMismatch
		}
		return Job{}, true, ErrInvalidJobTransition
	}
	if _, err := tx.Exec(`UPDATE workbench_runs SET status = ?, result_json = ?, error_text = ?, duration_ms = ?, updated_at = ? WHERE job_id = ?`, status, tx.json(resultJSON), errorText, durationMS, tx.timestamp(now), id); err != nil {
		return Job{}, true, err
	}
	job, err := getJobByIDTx(tx, id)
	if err != nil {
		return Job{}, true, err
	}
	if err := store.enqueueJobLifecycleTx(tx, job, eventType); err != nil {
		return Job{}, true, err
	}
	if audit != nil {
		auditScope := Scope{TenantID: job.TenantID, WorkspaceID: job.WorkspaceID, UserID: before.CreatedByUserID}
		if requireWorker {
			auditScope.UserID = "worker:" + workerID
			auditScope.Role = "service"
		}
		if err := store.appendBusinessAuditTxContext(ctx, tx, auditScope, audit(before, job)); err != nil {
			return Job{}, true, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Job{}, true, err
	}
	return job, true, nil
}

func (store *ProjectStore) HeartbeatJobClaim(id, workerID, claimToken string, leaseDuration time.Duration) (JobLease, bool, error) {
	return store.heartbeatJobClaim(context.Background(), nil, id, workerID, claimToken, leaseDuration)
}

func (store *ProjectStore) HeartbeatJobClaimForWorker(access JobClaimAccess, id, claimToken string, leaseDuration time.Duration) (JobLease, bool, error) {
	return store.HeartbeatJobClaimForWorkerContext(context.Background(), access, id, claimToken, leaseDuration)
}

func (store *ProjectStore) HeartbeatJobClaimForWorkerContext(ctx context.Context, access JobClaimAccess, id, claimToken string, leaseDuration time.Duration) (JobLease, bool, error) {
	return store.heartbeatJobClaim(ctx, &access, id, access.WorkerID, claimToken, leaseDuration)
}

func (store *ProjectStore) heartbeatJobClaim(ctx context.Context, access *JobClaimAccess, id, workerID, claimToken string, leaseDuration time.Duration) (JobLease, bool, error) {
	workerID = strings.TrimSpace(workerID)
	leaseSeconds, err := normalizedLeaseSeconds(workerID, leaseDuration, maximumJobLease)
	if err != nil || strings.TrimSpace(id) == "" || strings.TrimSpace(claimToken) == "" {
		if err != nil {
			return JobLease{}, false, err
		}
		return JobLease{}, false, ErrJobClaimLost
	}
	tokenHash := claimTokenDigest(claimToken)
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return JobLease{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if access != nil {
		if err := tx.setWorkerRLSContext(*access); err != nil {
			return JobLease{}, false, err
		}
	} else if store.adapter == AdapterPostgreSQL {
		return JobLease{}, false, errors.New("PostgreSQL job heartbeat requires exact worker access")
	}
	nowExpression := databaseNowExpression(store.adapter)
	leaseExpression := databaseLeaseExpression(store.adapter)
	result, err := tx.Exec(`UPDATE jobs SET heartbeat_at = `+nowExpression+`, lease_expires_at = `+leaseExpression+`,
		updated_at = `+nowExpression+` WHERE id = ? AND status = 'running' AND worker_id = ?
		AND claim_token_hash = ? AND lease_expires_at > `+nowExpression, leaseSeconds, id, workerID, tokenHash)
	if err != nil {
		return JobLease{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return JobLease{}, false, err
	}
	if affected == 0 {
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM jobs WHERE id = ?`, id).Scan(&exists); err != nil {
			return JobLease{}, false, err
		}
		return JobLease{}, exists > 0, ErrJobClaimLost
	}
	lease, err := getJobLeaseTx(tx, id)
	if err != nil {
		return JobLease{}, true, err
	}
	if err := tx.Commit(); err != nil {
		return JobLease{}, true, err
	}
	return lease, true, nil
}

const (
	jobEventCreated   = "job.created"
	jobEventSucceeded = "job.succeeded"
	jobEventFailed    = "job.failed"
	jobEventCancelled = "job.cancelled"
)

func jobLifecycleEventID(jobID, eventType string) string {
	return "job:" + jobID + ":" + eventType
}

// enqueueJobLifecycleTx deliberately excludes job input, result, and error
// fields. Those values can contain credentials or customer data and belong in
// the scoped job record, not in an integration event payload.
func (store *ProjectStore) enqueueJobLifecycleTx(tx *databaseTx, job Job, eventType string) error {
	_, _, err := store.enqueueTx(tx, OutboxEvent{
		ID:            jobLifecycleEventID(job.ID, eventType),
		TenantID:      job.TenantID,
		WorkspaceID:   job.WorkspaceID,
		AggregateType: "job",
		AggregateID:   job.ID,
		EventType:     eventType,
		Payload: map[string]any{
			"schemaVersion": 1,
			"tenantId":      job.TenantID,
			"workspaceId":   job.WorkspaceID,
			"projectId":     job.ProjectID,
			"jobId":         job.ID,
			"status":        job.Status,
		},
	})
	return err
}

const jobSelect = `SELECT id, tenant_id, workspace_id, project_id, created_by_user_id, slug, action, status,
	input_json, result_json, error_text, idempotency_key, attempt, worker_id, duration_ms, created_at, started_at, updated_at, finished_at FROM jobs`

func getJobByIDTx(tx *databaseTx, id string) (Job, error) {
	return getJobByIDTxContext(context.Background(), tx, id)
}

func getJobByIDTxContext(ctx context.Context, tx *databaseTx, id string) (Job, error) {
	return scanJob(tx.QueryRowContext(ctx, jobSelect+` WHERE id = ?`, id))
}

func getJobByIDTxLocked(tx *databaseTx, id string) (Job, error) {
	query := jobSelect + ` WHERE id = ?`
	if tx.dialect == dialectPostgreSQL {
		query += ` FOR UPDATE`
	}
	return scanJob(tx.QueryRow(query, id))
}

func getJobByScopeTx(ctx context.Context, tx *databaseTx, scope Scope, id string, lock bool) (Job, bool, error) {
	query := jobSelect + ` WHERE tenant_id = ? AND workspace_id = ? AND id = ?`
	if lock && tx.dialect == dialectPostgreSQL {
		query += ` FOR UPDATE`
	}
	job, err := scanJob(tx.QueryRowContext(ctx, query, scope.TenantID, scope.WorkspaceID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	return job, err == nil, err
}

func getJobByIdempotencyTx(ctx context.Context, tx *databaseTx, scope Scope, key string) (Job, bool, error) {
	job, err := scanJob(tx.QueryRowContext(ctx, jobSelect+` WHERE tenant_id = ? AND workspace_id = ? AND created_by_user_id = ? AND idempotency_key = ?`, scope.TenantID, scope.WorkspaceID, scope.UserID, key))
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	return job, err == nil, err
}

func getIdempotentJobRunTx(ctx context.Context, tx *databaseTx, scope Scope, projectID, slug, action string, input map[string]any, key string) (JobRun, bool, error) {
	existing, found, err := getJobByIdempotencyTx(ctx, tx, scope, key)
	if err != nil || !found {
		return JobRun{}, found, err
	}
	if existing.ProjectID != projectID || existing.Slug != slug || existing.Action != action || !sameJSONValue(existing.Input, input) {
		return JobRun{}, false, ErrIdempotencyConflict
	}
	run, err := getRunByJobTx(ctx, tx, existing.ID)
	if err != nil {
		return JobRun{}, false, err
	}
	return JobRun{Job: existing, Run: run}, true, nil
}

func sameJSONValue(left, right any) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func getRunByJobTx(ctx context.Context, tx *databaseTx, jobID string) (Run, error) {
	return scanRun(tx.QueryRowContext(ctx, `SELECT id, job_id, project_id, slug, action, status, input_json, result_json, error_text, duration_ms, created_at, updated_at FROM workbench_runs WHERE job_id = ?`, jobID))
}

func scanJob(row rowScanner) (Job, error) {
	var job Job
	var inputJSON, resultJSON string
	var createdAt, startedAt, updatedAt, finishedAt timestampText
	if err := row.Scan(&job.ID, &job.TenantID, &job.WorkspaceID, &job.ProjectID, &job.CreatedByUserID, &job.Slug,
		&job.Action, &job.Status, &inputJSON, &resultJSON, &job.Error, &job.IdempotencyKey, &job.Attempt,
		&job.WorkerID, &job.DurationMS, &createdAt, &startedAt, &updatedAt, &finishedAt); err != nil {
		return Job{}, err
	}
	job.CreatedAt, job.StartedAt, job.UpdatedAt, job.FinishedAt = string(createdAt), string(startedAt), string(updatedAt), string(finishedAt)
	if err := json.Unmarshal([]byte(inputJSON), &job.Input); err != nil {
		return Job{}, err
	}
	if err := json.Unmarshal([]byte(resultJSON), &job.Result); err != nil {
		return Job{}, err
	}
	return job, nil
}

func getJobClaimTx(tx *databaseTx, id, token string) (JobClaim, error) {
	job, err := getJobByIDTx(tx, id)
	if err != nil {
		return JobClaim{}, err
	}
	var claim JobClaim
	var leaseExpiresAt, heartbeatAt timestampText
	if err := tx.QueryRow(`SELECT claim_epoch, lease_expires_at, heartbeat_at FROM jobs WHERE id = ?`, id).
		Scan(&claim.ClaimEpoch, &leaseExpiresAt, &heartbeatAt); err != nil {
		return JobClaim{}, err
	}
	claim.Job = job
	claim.ClaimToken = token
	claim.LeaseExpiresAt = string(leaseExpiresAt)
	claim.HeartbeatAt = string(heartbeatAt)
	return claim, nil
}

func getJobLeaseTx(tx *databaseTx, id string) (JobLease, error) {
	var lease JobLease
	var leaseExpiresAt, heartbeatAt timestampText
	if err := tx.QueryRow(`SELECT claim_epoch, lease_expires_at, heartbeat_at FROM jobs WHERE id = ?`, id).
		Scan(&lease.ClaimEpoch, &leaseExpiresAt, &heartbeatAt); err != nil {
		return JobLease{}, err
	}
	lease.LeaseExpiresAt = string(leaseExpiresAt)
	lease.HeartbeatAt = string(heartbeatAt)
	return lease, nil
}

func newClaimToken() (string, string, error) {
	material := make([]byte, 32)
	if _, err := rand.Read(material); err != nil {
		return "", "", fmt.Errorf("generate claim token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(material)
	digest := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(digest[:]), nil
}

func claimTokenDigest(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func normalizedLeaseSeconds(owner string, duration, maximum time.Duration) (int64, error) {
	if strings.TrimSpace(owner) == "" {
		return 0, errors.New("lease owner ID is required")
	}
	if len(owner) > 256 {
		return 0, errors.New("lease owner ID exceeds limit")
	}
	if duration <= 0 || duration > maximum {
		return 0, fmt.Errorf("lease duration must be between one second and %s", maximum)
	}
	seconds := int64(duration / time.Second)
	if duration%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return seconds, nil
}

func databaseNowExpression(adapter string) string {
	if adapter == AdapterPostgreSQL {
		// CURRENT_TIMESTAMP is fixed at transaction start. Lease checks must use
		// wall-clock database time even after waiting on row/audit-head locks.
		return "clock_timestamp()"
	}
	return "STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now')"
}

func databaseLeaseExpression(adapter string) string {
	if adapter == AdapterPostgreSQL {
		return "clock_timestamp() + (? * INTERVAL '1 second')"
	}
	return "STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', 'now', '+' || ? || ' seconds')"
}
