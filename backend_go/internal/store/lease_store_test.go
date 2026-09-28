package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestJobLeaseHeartbeatRecoveryAndABATokenRejection(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "lease-aba")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"secret": "private"}, "lease-aba")
	if err != nil || !inserted {
		t.Fatalf("create job inserted=%t err=%v", inserted, err)
	}
	first, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-same", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found || first.Job.ID != created.Job.ID || first.ClaimToken == "" || first.ClaimEpoch != 1 {
		t.Fatalf("first claim found=%t claim=%+v err=%v", found, first, err)
	}

	var storedHash string
	if err := projectStore.database.QueryRow(`SELECT claim_token_hash FROM jobs WHERE id = ?`, first.Job.ID).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash == first.ClaimToken || len(storedHash) != 64 {
		t.Fatalf("database must contain only a digest, got %q", storedHash)
	}
	encoded, err := json.Marshal(first.Job)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), first.ClaimToken) || strings.Contains(string(encoded), "claimToken") {
		t.Fatalf("ordinary Job leaked claim capability: %s", encoded)
	}
	if got, found, err := projectStore.GetJobForClaim(first.Job.ID, "worker-same", first.ClaimToken); err != nil || !found || got.ID != first.Job.ID {
		t.Fatalf("live claim read found=%t job=%+v err=%v", found, got, err)
	}
	if _, found, err := projectStore.GetJobForClaim("missing-job", "worker-same", first.ClaimToken); err != nil || found {
		t.Fatalf("missing job must remain distinguishable found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.GetJobForClaim(first.Job.ID, "worker-same", "wrong-token"); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("wrong token must be claim-lost found=%t err=%v", found, err)
	}

	lease, found, err := projectStore.HeartbeatJobClaim(first.Job.ID, "worker-same", first.ClaimToken, 2*time.Minute)
	if err != nil || !found || lease.ClaimEpoch != first.ClaimEpoch || lease.HeartbeatAt == "" || lease.LeaseExpiresAt == "" {
		t.Fatalf("heartbeat found=%t lease=%+v err=%v", found, lease, err)
	}
	expireJobLease(t, projectStore, first.Job.ID)
	if _, found, err := projectStore.GetJobForClaim(first.Job.ID, "worker-same", first.ClaimToken); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("expired claim read must fail before reclaim found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.CompleteJobClaim(first.Job.ID, "worker-same", first.ClaimToken, "succeeded", map[string]any{}, "", 1); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("expired claim completed before reclaim found=%t err=%v", found, err)
	}
	second, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-same", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found || second.Job.ID != first.Job.ID || second.ClaimEpoch != first.ClaimEpoch+1 || second.ClaimToken == first.ClaimToken {
		t.Fatalf("reclaim found=%t claim=%+v err=%v", found, second, err)
	}
	if _, found, err := projectStore.CompleteJobClaim(first.Job.ID, "worker-same", first.ClaimToken, "succeeded", map[string]any{"stale": true}, "", 1); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("ABA stale completion found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.HeartbeatJobClaim(first.Job.ID, "worker-same", first.ClaimToken, time.Minute); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("ABA stale heartbeat found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.CompleteJobClaim(second.Job.ID, "worker-same", second.ClaimToken, "succeeded", map[string]any{"forged": true}, "", 1); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("completion without execution fence must fail found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecution(second.Job.ID, "worker-same", second.ClaimToken); err != nil || !found {
		t.Fatalf("begin current claim found=%t err=%v", found, err)
	}
	completed, found, err := projectStore.CompleteJobClaim(second.Job.ID, "worker-same", second.ClaimToken, "succeeded", map[string]any{"ok": true}, "", 2)
	if err != nil || !found || completed.Status != "succeeded" || completed.Result["stale"] != nil {
		t.Fatalf("current claim completion found=%t job=%+v err=%v", found, completed, err)
	}
}

func TestJobMaxAttemptsFailsRunAndEmitsOneSafeEvent(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "lease-exhaustion")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"secret": "do-not-emit"}, "lease-exhaustion")
	if err != nil {
		t.Fatal(err)
	}
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-crash", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim found=%t err=%v", found, err)
	}
	if _, err := projectStore.database.Exec(`UPDATE jobs SET max_attempts = 1 WHERE id = ?`, claim.Job.ID); err != nil {
		t.Fatal(err)
	}
	expireJobLease(t, projectStore, claim.Job.ID)
	if _, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-recovery", scope, project.Slug, "analyze"), time.Minute); err != nil || found {
		t.Fatalf("exhausted job must be finalized, not reclaimed found=%t err=%v", found, err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "failed" || !strings.Contains(job.Error, "maximum job attempts") {
		t.Fatalf("unexpected exhausted job found=%t job=%+v err=%v", found, job, err)
	}
	var runStatus, runError string
	if err := projectStore.database.QueryRow(`SELECT status, error_text FROM workbench_runs WHERE job_id = ?`, job.ID).Scan(&runStatus, &runError); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || runError != job.Error {
		t.Fatalf("run/job terminal state diverged run=%q/%q job=%q/%q", runStatus, runError, job.Status, job.Error)
	}
	event, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(job.ID, jobEventFailed))
	if err != nil || !found || event.Payload["status"] != "failed" || strings.Contains(mustJSON(t, event.Payload), "do-not-emit") {
		t.Fatalf("unsafe or missing exhausted event found=%t event=%+v err=%v", found, event, err)
	}
	assertOutboxCount(t, projectStore, job.ID, jobEventFailed, 1)
	if _, found, err := projectStore.CompleteJobClaim(job.ID, "worker-crash", claim.ClaimToken, "succeeded", map[string]any{}, "", 1); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("expired owner completed exhausted job found=%t err=%v", found, err)
	}
}

func TestConcurrentJobClaimsAreUnique(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "lease-concurrent")
	const total = 40
	for index := range total {
		if _, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"index": index}, fmt.Sprintf("claim-%d", index)); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	claims := make(chan JobClaim, total)
	errorsSeen := make(chan error, total)
	var wait sync.WaitGroup
	for index := range total {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess(fmt.Sprintf("worker-%d", worker), scope, project.Slug, "analyze"), time.Minute)
			if err != nil {
				errorsSeen <- err
				return
			}
			if !found {
				errorsSeen <- errors.New("no job found")
				return
			}
			claims <- claim
		}(index)
	}
	close(start)
	wait.Wait()
	close(claims)
	close(errorsSeen)
	for err := range errorsSeen {
		t.Errorf("concurrent claim: %v", err)
	}
	seen := map[string]bool{}
	for claim := range claims {
		if seen[claim.Job.ID] {
			t.Errorf("job %s was claimed twice", claim.Job.ID)
		}
		seen[claim.Job.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("unique claims=%d, want %d", len(seen), total)
	}
}

func TestCancelAndClaimCompletionRaceHasOneTerminalOutcome(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "lease-cancel-race")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "cancel-race")
	if err != nil {
		t.Fatal(err)
	}
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-race", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, "worker-race", claim.ClaimToken); err != nil || !found {
		t.Fatalf("begin found=%t err=%v", found, err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, _, _, err := projectStore.CancelJob(scope, claim.Job.ID)
		results <- err
	}()
	go func() {
		<-start
		_, _, err := projectStore.CompleteJobClaim(claim.Job.ID, "worker-race", claim.ClaimToken, "succeeded", map[string]any{"ok": true}, "", 1)
		results <- err
	}()
	close(start)
	for range 2 {
		err := <-results
		if err != nil && !errors.Is(err, ErrInvalidJobTransition) && !errors.Is(err, ErrJobClaimLost) {
			t.Errorf("unexpected race error: %v", err)
		}
	}
	terminal, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || terminal.Status != "succeeded" {
		t.Fatalf("invalid terminal state found=%t job=%+v err=%v", found, terminal, err)
	}
	var runStatus string
	if err := projectStore.database.QueryRow(`SELECT status FROM workbench_runs WHERE job_id = ?`, terminal.ID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != terminal.Status {
		t.Fatalf("run=%q job=%q", runStatus, terminal.Status)
	}
	var terminalEvents int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ? AND event_type IN (?, ?)`,
		terminal.ID, jobEventCancelled, jobEventSucceeded).Scan(&terminalEvents); err != nil {
		t.Fatal(err)
	}
	if terminalEvents != 1 {
		t.Fatalf("terminal event count=%d, want one", terminalEvents)
	}
}

func TestCancelRejectsExecutionAfterFenceWithoutInvalidatingClaim(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "cancel-after-fence")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "cancel-after-fence")
	if err != nil {
		t.Fatal(err)
	}
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-cancel-fence", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, "worker-cancel-fence", claim.ClaimToken); err != nil || !found {
		t.Fatalf("begin found=%t err=%v", found, err)
	}
	if _, found, denied, err := projectStore.CancelJob(scope, claim.Job.ID); !found || denied || !errors.Is(err, ErrInvalidJobTransition) {
		t.Fatalf("started execution cancellation found=%t denied=%t err=%v", found, denied, err)
	}
	job, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || job.Status != "running" {
		t.Fatalf("cancellation mutated started execution found=%t job=%+v err=%v", found, job, err)
	}
	if _, found, err := projectStore.CompleteJobClaim(claim.Job.ID, "worker-cancel-fence", claim.ClaimToken, "succeeded", map[string]any{"ok": true}, "", 1); err != nil || !found {
		t.Fatalf("cancellation invalidated live execution claim found=%t err=%v", found, err)
	}
	assertOutboxCount(t, projectStore, claim.Job.ID, jobEventCancelled, 0)
	assertOutboxCount(t, projectStore, claim.Job.ID, jobEventSucceeded, 1)
}

func TestJobLeaseSurvivesRestartAndExpiredClaimIsRecovered(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease-restart.db")
	firstStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := firstStore.EnsureDevIdentity("tenant-restart", "workspace-restart", "restart@test.invalid", "Restart", "admin")
	if err != nil {
		t.Fatal(err)
	}
	project, err := firstStore.CreateProject(identity.Scope(), "python-lab", "Restart", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := firstStore.CreateJob(identity.Scope(), project.ID, project.Slug, "analyze", map[string]any{}, "restart")
	if err != nil {
		t.Fatal(err)
	}
	first, found, err := firstStore.ClaimNextJobWithLease(testJobClaimAccess("worker-before", identity.Scope(), project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("first claim found=%t err=%v", found, err)
	}
	expireJobLease(t, firstStore, first.Job.ID)
	if err := firstStore.Close(); err != nil {
		t.Fatal(err)
	}

	secondStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secondStore.Close() })
	second, found, err := secondStore.ClaimNextJobWithLease(testJobClaimAccess("worker-after", identity.Scope(), project.Slug, "analyze"), time.Minute)
	if err != nil || !found || second.Job.ID != created.Job.ID || second.ClaimEpoch != first.ClaimEpoch+1 || second.ClaimToken == first.ClaimToken {
		t.Fatalf("restart recovery found=%t claim=%+v err=%v", found, second, err)
	}
}

func TestOutboxLeaseExpiryABAConcurrencyAndDeadLetter(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-outbox-lease", "workspace-outbox-lease", "relay@test.invalid", "Relay", "admin")
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := projectStore.EnqueueOutbox(OutboxEvent{
		ID: "outbox-lease-aba", TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		AggregateType: "project", AggregateID: "project", EventType: "project.updated", Payload: map[string]any{"safe": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	first, found, err := projectStore.ClaimNextOutbox("relay-same", time.Minute)
	if err != nil || !found {
		t.Fatalf("first claim found=%t err=%v", found, err)
	}
	expireOutboxLease(t, projectStore, created.ID)
	second, found, err := projectStore.ClaimNextOutbox("relay-same", time.Minute)
	if err != nil || !found || second.ClaimEpoch != first.ClaimEpoch+1 || second.ClaimToken == first.ClaimToken {
		t.Fatalf("second claim found=%t claim=%+v err=%v", found, second, err)
	}
	if _, found, err := projectStore.AckOutbox(created.ID, "relay-same", first.ClaimToken); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("stale outbox ack found=%t err=%v", found, err)
	}
	if _, err := projectStore.database.Exec(`UPDATE outbox_events SET max_attempts = 2 WHERE id = ?`, created.ID); err != nil {
		t.Fatal(err)
	}
	dead, found, err := projectStore.FailOutbox(created.ID, "relay-same", second.ClaimToken, "downstream permanently unavailable", 0)
	if err != nil || !found || dead.DeadLetterAt == "" || dead.ProcessedAt != "" || dead.ClaimedAt != "" {
		t.Fatalf("dead letter found=%t event=%+v err=%v", found, dead, err)
	}
	if _, found, err := projectStore.ClaimNextOutbox("relay-after-dead", time.Minute); err != nil || found {
		t.Fatalf("dead letter was reclaimed found=%t err=%v", found, err)
	}
}

func TestOutboxExpiredMaxAttemptIsAutomaticallyDeadLettered(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-outbox-max", "workspace-outbox-max", "relay-max@test.invalid", "Relay", "admin")
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := projectStore.EnqueueOutbox(OutboxEvent{
		ID: "outbox-max", TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		AggregateType: "project", AggregateID: "project", EventType: "project.updated", Payload: map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim, found, err := projectStore.ClaimNextOutbox("relay-crash", time.Minute)
	if err != nil || !found {
		t.Fatalf("claim found=%t err=%v", found, err)
	}
	if _, err := projectStore.database.Exec(`UPDATE outbox_events SET max_attempts = 1 WHERE id = ?`, created.ID); err != nil {
		t.Fatal(err)
	}
	expireOutboxLease(t, projectStore, created.ID)
	if _, found, err := projectStore.AckOutbox(created.ID, "relay-crash", claim.ClaimToken); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("expired acknowledgement found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.ClaimNextOutbox("relay-recover", time.Minute); err != nil || found {
		t.Fatalf("exhausted event must be dead-lettered found=%t err=%v", found, err)
	}
	dead, found, err := projectStore.GetOutbox(identity.Scope(), created.ID)
	if err != nil || !found || dead.DeadLetterAt == "" || !strings.Contains(dead.LastError, "maximum outbox") {
		t.Fatalf("unexpected dead letter found=%t event=%+v err=%v", found, dead, err)
	}
}

func TestOutboxLeaseSurvivesRestartAndIsRecoverable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outbox-restart.db")
	firstStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := firstStore.EnsureDevIdentity("tenant-outbox-restart", "workspace-outbox-restart", "relay-restart@test.invalid", "Relay", "admin")
	if err != nil {
		t.Fatal(err)
	}
	created, _, err := firstStore.EnqueueOutbox(OutboxEvent{
		ID: "outbox-restart", TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		AggregateType: "project", AggregateID: "project", EventType: "project.updated", Payload: map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	first, found, err := firstStore.ClaimNextOutbox("relay-before", time.Minute)
	if err != nil || !found {
		t.Fatalf("first claim found=%t err=%v", found, err)
	}
	expireOutboxLease(t, firstStore, created.ID)
	if err := firstStore.Close(); err != nil {
		t.Fatal(err)
	}

	secondStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = secondStore.Close() })
	second, found, err := secondStore.ClaimNextOutbox("relay-after", time.Minute)
	if err != nil || !found || second.Event.ID != created.ID || second.ClaimEpoch != first.ClaimEpoch+1 || second.ClaimToken == first.ClaimToken {
		t.Fatalf("restart recovery found=%t claim=%+v err=%v", found, second, err)
	}
	if _, found, err := secondStore.AckOutbox(created.ID, "relay-before", first.ClaimToken); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("pre-restart owner acknowledged reclaimed event found=%t err=%v", found, err)
	}
}

func TestConcurrentOutboxClaimsAreUnique(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-outbox-concurrent", "workspace-outbox-concurrent", "relay-concurrent@test.invalid", "Relay", "admin")
	if err != nil {
		t.Fatal(err)
	}
	const total = 40
	for index := range total {
		if _, _, err := projectStore.EnqueueOutbox(OutboxEvent{
			ID: fmt.Sprintf("outbox-concurrent-%d", index), TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
			AggregateType: "project", AggregateID: fmt.Sprintf("project-%d", index), EventType: "project.updated", Payload: map[string]any{},
		}); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	claims := make(chan OutboxClaim, total)
	errorsSeen := make(chan error, total)
	var wait sync.WaitGroup
	for index := range total {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			<-start
			claim, found, err := projectStore.ClaimNextOutbox(fmt.Sprintf("relay-%d", worker), time.Minute)
			if err != nil {
				errorsSeen <- err
				return
			}
			if !found {
				errorsSeen <- errors.New("no outbox event found")
				return
			}
			claims <- claim
		}(index)
	}
	close(start)
	wait.Wait()
	close(claims)
	close(errorsSeen)
	for err := range errorsSeen {
		t.Errorf("concurrent outbox claim: %v", err)
	}
	seen := map[string]bool{}
	for claim := range claims {
		if seen[claim.Event.ID] {
			t.Errorf("outbox %s was claimed twice", claim.Event.ID)
		}
		seen[claim.Event.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("unique claims=%d, want %d", len(seen), total)
	}
}

func TestLeaseMigrationInvalidatesLegacyOwnersAndMakesWorkRecoverable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pre-lease.db")
	projectStore := newPreLeaseSQLiteStore(t, path)
	identity, err := projectStore.EnsureDevIdentity("tenant-legacy-lease", "workspace-legacy-lease", "legacy-lease@test.invalid", "Legacy", "admin")
	if err != nil {
		t.Fatal(err)
	}
	projectID := "legacy-project"
	now := "2026-01-01T00:00:00Z"
	if _, err := projectStore.database.Exec(`INSERT INTO projects(id, scope, slug, title, state_json, created_at, updated_at,
		tenant_id, workspace_id, owner_user_id) VALUES(?, ?, 'python-lab', 'Legacy', '{}', ?, ?, ?, ?, ?)`,
		projectID, legacyScope(identity.Scope()), now, now, identity.TenantID, identity.WorkspaceID, identity.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`INSERT INTO jobs(id, tenant_id, workspace_id, project_id, created_by_user_id,
		slug, action, status, input_json, result_json, error_text, idempotency_key, attempt, worker_id, duration_ms,
		created_at, started_at, updated_at, finished_at) VALUES('legacy-job', ?, ?, ?, ?, 'python-lab', 'analyze',
		'running', '{}', '{}', '', '', 2, 'old-worker', 0, ?, ?, ?, '')`, identity.TenantID, identity.WorkspaceID,
		projectID, identity.UserID, now, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`INSERT INTO workbench_runs(id, project_id, scope, tenant_id, workspace_id,
		created_by_user_id, job_id, slug, action, status, input_json, result_json, error_text, duration_ms, created_at, updated_at)
		VALUES('legacy-run', ?, ?, ?, ?, ?, 'legacy-job', 'python-lab', 'analyze', 'running', '{}', '{}', '', 0, ?, ?)`,
		projectID, legacyScope(identity.Scope()), identity.TenantID, identity.WorkspaceID, identity.UserID, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`INSERT INTO outbox_events(id, tenant_id, workspace_id, aggregate_type,
		aggregate_id, event_type, payload_json, attempt, available_at, claimed_at, claimed_by, processed_at, last_error,
		created_at, updated_at) VALUES('legacy-outbox', ?, ?, 'job', 'legacy-job', 'job.created', '{}', 4, ?, ?,
		'old-relay', NULL, '', ?, ?)`, identity.TenantID, identity.WorkspaceID, now, now, now, now); err != nil {
		t.Fatal(err)
	}

	if err := projectStore.migrateSQLite(); err != nil {
		t.Fatal(err)
	}
	var jobStatus, workerID, claimHash string
	var lease any
	var maxAttempts int
	if err := projectStore.database.QueryRow(`SELECT status, worker_id, claim_token_hash, lease_expires_at, max_attempts
		FROM jobs WHERE id = 'legacy-job'`).Scan(&jobStatus, &workerID, &claimHash, &lease, &maxAttempts); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "queued" || workerID != "" || claimHash != "" || lease != nil || maxAttempts < 3 {
		t.Fatalf("legacy job not safely invalidated status=%q worker=%q hash=%q lease=%v max=%d", jobStatus, workerID, claimHash, lease, maxAttempts)
	}
	var runStatus string
	if err := projectStore.database.QueryRow(`SELECT status FROM workbench_runs WHERE job_id = 'legacy-job'`).Scan(&runStatus); err != nil || runStatus != "queued" {
		t.Fatalf("legacy run status=%q err=%v", runStatus, err)
	}
	var claimedAt any
	var claimedBy, outboxHash string
	var outboxLease any
	var outboxMax int
	if err := projectStore.database.QueryRow(`SELECT claimed_at, claimed_by, claim_token_hash, lease_expires_at, max_attempts
		FROM outbox_events WHERE id = 'legacy-outbox'`).Scan(&claimedAt, &claimedBy, &outboxHash, &outboxLease, &outboxMax); err != nil {
		t.Fatal(err)
	}
	if claimedAt != nil || claimedBy != "" || outboxHash != "" || outboxLease != nil || outboxMax < 5 {
		t.Fatalf("legacy outbox not safely invalidated claimed=%v/%q hash=%q lease=%v max=%d", claimedAt, claimedBy, outboxHash, outboxLease, outboxMax)
	}
}

func newPreLeaseSQLiteStore(t *testing.T, path string) *ProjectStore {
	t.Helper()
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	database := &databaseHandle{raw: raw, dialect: dialectSQLite}
	store := &ProjectStore{database: database, adapter: AdapterSQLiteDevelopment}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := database.Exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
		CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	migrations := []migration{
		{1, "legacy_project_tables", migrationLegacyTables},
		{2, "identity_tenant_job_audit_foundation", migrationFoundation},
		{3, "oidc_external_identity_binding", migrationOIDCIdentities},
		{4, "canonical_user_emails", migrationCanonicalUserEmails},
		{5, "transactional_outbox", migrationTransactionalOutbox},
		{6, "oidc_login_transactions", migrationOIDCLoginTransactions},
		{7, "audit_chain_heads", migrationAuditChainHeads},
		{8, "workbench_states", migrationWorkbenchStates},
	}
	for _, item := range migrations {
		tx, err := database.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := item.apply(tx); err != nil {
			_ = tx.Rollback()
			t.Fatalf("apply pre-lease migration %d: %v", item.version, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)`, item.version, item.name, nowText()); err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func expireJobLease(t *testing.T, projectStore *ProjectStore, id string) {
	t.Helper()
	if _, err := projectStore.database.Exec(`UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000000000Z' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
}

func expireOutboxLease(t *testing.T, projectStore *ProjectStore, id string) {
	t.Helper()
	if _, err := projectStore.database.Exec(`UPDATE outbox_events SET lease_expires_at = '2000-01-01T00:00:00.000000000Z' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
}
