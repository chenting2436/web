package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestJobCreateContextCancellationRollsBackJobRunAndOutbox(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-create-context-cancel")
	ctx, cancel := context.WithCancel(context.Background())
	_, _, err := projectStore.CreateJobWithAuditContext(ctx, scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "atomic-create-context-cancel",
		func(created JobRun) AuditEvent {
			cancel()
			return atomicTestAudit(scope, "job.create", "job", created.Job.ID)
		})
	if !errors.Is(err, ErrAtomicAuditWrite) || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected atomic context cancellation, got %v", err)
	}
	assertTableCount(t, projectStore, "jobs", 0)
	assertTableCount(t, projectStore, "workbench_runs", 0)
	assertTableCount(t, projectStore, "outbox_events", 0)
}

func TestJobCancelContextCancellationRollsBackStateRunAndOutbox(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-cancel-context-cancel")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-cancel-context-cancel")
	if err != nil || !inserted {
		t.Fatalf("create fixture inserted=%v err=%v", inserted, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, found, denied, err := projectStore.CancelJobWithAuditContext(ctx, scope, created.Job.ID,
		func(before, after Job) AuditEvent {
			cancel()
			return atomicTestAudit(scope, "job.cancel", "job", after.ID)
		})
	if !found || denied || !errors.Is(err, ErrAtomicAuditWrite) || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel found=%v denied=%v err=%v", found, denied, err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "queued" || job.FinishedAt != "" {
		t.Fatalf("canceled request escaped rollback: job=%+v found=%v err=%v", job, found, err)
	}
	assertJobRunStatus(t, projectStore, job.ID, "queued")
	assertOutboxCount(t, projectStore, job.ID, jobEventCancelled, 0)
}

func TestJobCreateRollsBackJobRunAndOutboxWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-create-audit")
	forceAtomicAuditFailure(t, projectStore)
	_, _, err := projectStore.CreateJobWithAudit(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "atomic-create",
		func(created JobRun) AuditEvent { return atomicTestAudit(scope, "job.create", "job", created.Job.ID) })
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit failure, got %v", err)
	}
	assertTableCount(t, projectStore, "jobs", 0)
	assertTableCount(t, projectStore, "workbench_runs", 0)
	assertTableCount(t, projectStore, "outbox_events", 0)
}

func TestJobCancelRollsBackJobRunAndOutboxWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-cancel-audit")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-cancel")
	if err != nil || !inserted {
		t.Fatalf("create fixture inserted=%v err=%v", inserted, err)
	}
	forceAtomicAuditFailure(t, projectStore)
	_, found, denied, err := projectStore.CancelJobWithAudit(scope, created.Job.ID,
		func(before, after Job) AuditEvent { return atomicTestAudit(scope, "job.cancel", "job", after.ID) })
	if !found || denied || !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("cancel found=%v denied=%v err=%v", found, denied, err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "queued" || job.FinishedAt != "" {
		t.Fatalf("cancel escaped rollback: job=%+v found=%v err=%v", job, found, err)
	}
	assertJobRunStatus(t, projectStore, job.ID, "queued")
	assertOutboxCount(t, projectStore, job.ID, jobEventCancelled, 0)
}

func TestJobClaimRollsBackCapabilityAndRunWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-claim-audit")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-claim")
	if err != nil || !inserted {
		t.Fatalf("create fixture inserted=%v err=%v", inserted, err)
	}
	workerID := "worker-claim-audit"
	forceAtomicAuditFailure(t, projectStore)
	_, _, err = projectStore.ClaimNextJobWithLeaseAndAudit(testJobClaimAccess(workerID, scope, project.Slug, "analyze"), time.Minute,
		func(claim JobClaim) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, workerID), "job.claim", "job", claim.Job.ID)
		},
		func(failed Job) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, workerID), "job.attempts_exhausted", "job", failed.ID)
		})
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected claim audit failure, got %v", err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "queued" || job.WorkerID != "" || job.Attempt != 0 {
		t.Fatalf("claim capability escaped rollback: job=%+v found=%v err=%v", job, found, err)
	}
	var tokenHash string
	var lease any
	if err := projectStore.database.QueryRow(`SELECT claim_token_hash, lease_expires_at FROM jobs WHERE id = ?`, job.ID).Scan(&tokenHash, &lease); err != nil {
		t.Fatal(err)
	}
	if tokenHash != "" || lease != nil {
		t.Fatalf("claim capability persisted after audit failure: tokenHash=%q lease=%v", tokenHash, lease)
	}
	assertJobRunStatus(t, projectStore, job.ID, "queued")
}

func TestJobCompletionRollsBackTerminalStateRunAndOutboxWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-complete-audit")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-complete")
	if err != nil || !inserted {
		t.Fatalf("create fixture inserted=%v err=%v", inserted, err)
	}
	workerID := "worker-complete-audit"
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess(workerID, scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim fixture found=%v err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, workerID, claim.ClaimToken); err != nil || !found {
		t.Fatalf("begin fixture found=%v err=%v", found, err)
	}
	forceAtomicAuditFailure(t, projectStore)
	_, found, err = projectStore.CompleteJobClaimWithAudit(claim.Job.ID, workerID, claim.ClaimToken, "succeeded", map[string]any{"ok": true}, "", 3,
		func(before, after Job) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, workerID), "job.complete", "job", after.ID)
		})
	if !found || !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("completion found=%v err=%v", found, err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "running" || job.WorkerID != workerID || job.Result["ok"] != nil || job.FinishedAt != "" {
		t.Fatalf("terminal completion escaped rollback: job=%+v found=%v err=%v", job, found, err)
	}
	if _, claimFound, err := projectStore.GetJobForClaim(job.ID, workerID, claim.ClaimToken); err != nil || !claimFound {
		t.Fatalf("live claim was not restored by rollback: found=%v err=%v", claimFound, err)
	}
	assertJobRunStatus(t, projectStore, job.ID, "running")
	assertOutboxCount(t, projectStore, job.ID, jobEventSucceeded, 0)
}

func TestJobExecutionStartRollsBackFenceWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-execution-start-audit")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-execution-start")
	if err != nil {
		t.Fatal(err)
	}
	workerID := "worker-execution-start-audit"
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess(workerID, scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found || claim.Job.ID != created.Job.ID {
		t.Fatalf("claim fixture found=%v err=%v", found, err)
	}
	forceAtomicAuditFailure(t, projectStore)
	_, found, err = projectStore.BeginJobExecutionWithAudit(claim.Job.ID, workerID, claim.ClaimToken,
		func(before, after Job) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, workerID), "job.execution.started", "job", after.ID)
		})
	if !found || !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("execution start found=%v err=%v", found, err)
	}
	var started any
	if err := projectStore.database.QueryRow(`SELECT execution_started_at FROM jobs WHERE id = ?`, claim.Job.ID).Scan(&started); err != nil {
		t.Fatal(err)
	}
	if started != nil {
		t.Fatalf("execution fence escaped audit rollback: %v", started)
	}
	if _, claimFound, err := projectStore.GetJobForClaim(claim.Job.ID, workerID, claim.ClaimToken); err != nil || !claimFound {
		t.Fatalf("claim changed after execution audit rollback: found=%v err=%v", claimFound, err)
	}
}

func TestJobExecutionStartReplayDoesNotAppendAnotherAuditEvent(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-execution-replay")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-execution-replay")
	if err != nil {
		t.Fatal(err)
	}
	workerID := "worker-execution-replay"
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess(workerID, scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found || claim.Job.ID != created.Job.ID {
		t.Fatalf("claim fixture found=%v err=%v", found, err)
	}
	factoryCalls := 0
	factory := func(before, after Job) AuditEvent {
		factoryCalls++
		return atomicTestAudit(workerAuditScope(scope, workerID), "job.execution.started", "job", after.ID)
	}
	if _, found, err := projectStore.BeginJobExecutionWithAudit(claim.Job.ID, workerID, claim.ClaimToken, factory); err != nil || !found {
		t.Fatalf("execution start found=%v err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecutionWithAudit(claim.Job.ID, workerID, claim.ClaimToken, factory); !found || !errors.Is(err, ErrJobExecutionStarted) {
		t.Fatalf("execution replay found=%v err=%v", found, err)
	}
	if factoryCalls != 1 {
		t.Fatalf("execution replay invoked audit factory %d times, want one", factoryCalls)
	}
	events, err := projectStore.ListAudit(scope, 10)
	if err != nil || len(events) != 1 || events[0].Action != "job.execution.started" {
		t.Fatalf("execution replay appended audit: events=%+v err=%v", events, err)
	}
}

func TestExhaustedJobRollsBackTerminalStateAndOutboxWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-exhausted-audit")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-exhausted")
	if err != nil {
		t.Fatal(err)
	}
	workerID := "worker-exhausted-audit"
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess(workerID, scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim fixture found=%v err=%v", found, err)
	}
	if _, err := projectStore.database.Exec(`UPDATE jobs SET max_attempts = 1 WHERE id = ?`, claim.Job.ID); err != nil {
		t.Fatal(err)
	}
	expireJobLease(t, projectStore, claim.Job.ID)
	recoveryWorker := "worker-recovery-audit"
	forceAtomicAuditFailure(t, projectStore)
	_, _, err = projectStore.ClaimNextJobWithLeaseAndAudit(testJobClaimAccess(recoveryWorker, scope, project.Slug, "analyze"), time.Minute,
		func(next JobClaim) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, recoveryWorker), "job.claim", "job", next.Job.ID)
		},
		func(failed Job) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, recoveryWorker), "job.attempts_exhausted", "job", failed.ID)
		})
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected exhausted-job audit failure, got %v", err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "running" || job.Error != "" || job.FinishedAt != "" {
		t.Fatalf("exhausted terminal state escaped rollback: job=%+v found=%v err=%v", job, found, err)
	}
	assertJobRunStatus(t, projectStore, job.ID, "running")
	assertOutboxCount(t, projectStore, job.ID, jobEventFailed, 0)
}

func TestLostExecutionLeaseRollsBackTerminalStateAndOutboxWhenAuditFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-lost-execution-audit")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "atomic-lost-execution")
	if err != nil {
		t.Fatal(err)
	}
	workerID := "worker-lost-execution-audit"
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess(workerID, scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim fixture found=%v err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, workerID, claim.ClaimToken); err != nil || !found {
		t.Fatalf("begin execution found=%v err=%v", found, err)
	}
	expireJobLease(t, projectStore, claim.Job.ID)
	recoveryWorker := "worker-lost-execution-recovery"
	forceAtomicAuditFailure(t, projectStore)
	_, _, err = projectStore.ClaimNextJobWithLeaseAndAudit(testJobClaimAccess(recoveryWorker, scope, project.Slug, "analyze"), time.Minute,
		func(next JobClaim) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, recoveryWorker), "job.claim", "job", next.Job.ID)
		},
		func(failed Job) AuditEvent {
			return atomicTestAudit(workerAuditScope(scope, recoveryWorker), "job.execution_lease_lost", "job", failed.ID)
		})
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected lost-execution audit failure, got %v", err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "running" || job.Error != "" || job.FinishedAt != "" {
		t.Fatalf("lost-execution terminal state escaped rollback: job=%+v found=%v err=%v", job, found, err)
	}
	var executionStarted any
	if err := projectStore.database.QueryRow(`SELECT execution_started_at FROM jobs WHERE id = ?`, job.ID).Scan(&executionStarted); err != nil {
		t.Fatal(err)
	}
	if executionStarted == nil {
		t.Fatal("execution fence was cleared despite audit rollback")
	}
	assertJobRunStatus(t, projectStore, job.ID, "running")
	assertOutboxCount(t, projectStore, job.ID, jobEventFailed, 0)
}

func TestIdempotentJobReplayDoesNotAppendAnotherAuditEvent(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "atomic-replay-audit")
	factoryCalls := 0
	factory := func(created JobRun) AuditEvent {
		factoryCalls++
		return atomicTestAudit(scope, "job.create", "job", created.Job.ID)
	}
	created, inserted, err := projectStore.CreateJobWithAudit(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "same-request", factory)
	if err != nil || !inserted {
		t.Fatalf("create inserted=%v err=%v", inserted, err)
	}
	replayed, inserted, err := projectStore.CreateJobWithAudit(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "same-request", factory)
	if err != nil || inserted || replayed.Job.ID != created.Job.ID {
		t.Fatalf("replay inserted=%v job=%s err=%v", inserted, replayed.Job.ID, err)
	}
	if factoryCalls != 1 {
		t.Fatalf("idempotent replay invoked audit factory %d times, want one", factoryCalls)
	}
	events, err := projectStore.ListAudit(scope, 10)
	if err != nil || len(events) != 1 || events[0].ResourceID != created.Job.ID {
		t.Fatalf("idempotent replay appended audit: events=%+v err=%v", events, err)
	}
}

func workerAuditScope(scope Scope, workerID string) Scope {
	return Scope{TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, UserID: "worker:" + workerID, Role: "service"}
}

func assertJobRunStatus(t *testing.T, projectStore *ProjectStore, jobID, want string) {
	t.Helper()
	var got string
	if err := projectStore.database.QueryRow(`SELECT status FROM workbench_runs WHERE job_id = ?`, jobID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("run status=%q, want %q", got, want)
	}
}
