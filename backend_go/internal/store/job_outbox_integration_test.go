package store

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestConcurrentIdempotentJobCreationReturnsOneJob(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "concurrent-idempotency")
	const callers = 50
	var wait sync.WaitGroup
	var createdCount atomic.Int32
	ids := make(chan string, callers)
	errorsSeen := make(chan error, callers)
	start := make(chan struct{})

	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			jobRun, created, err := projectStore.CreateJob(
				scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "one-logical-request",
			)
			if err != nil {
				errorsSeen <- err
				return
			}
			if created {
				createdCount.Add(1)
			}
			ids <- jobRun.Job.ID
		}()
	}
	close(start)
	wait.Wait()
	close(ids)
	close(errorsSeen)

	for err := range errorsSeen {
		t.Errorf("idempotent caller failed: %v", err)
	}
	firstID := ""
	seen := 0
	for id := range ids {
		seen++
		if firstID == "" {
			firstID = id
		}
		if id != firstID {
			t.Errorf("idempotent callers received different jobs: %q and %q", firstID, id)
		}
	}
	if seen != callers || createdCount.Load() != 1 {
		t.Fatalf("callers=%d created=%d, want %d callers and one insert", seen, createdCount.Load(), callers)
	}
	assertTableCount(t, projectStore, "jobs", 1)
	assertTableCount(t, projectStore, "workbench_runs", 1)
	assertOutboxCount(t, projectStore, firstID, jobEventCreated, 1)
}

func TestJobCreatedOutboxIsReadableSafeAndIdempotent(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "created")
	input := map[string]any{"prompt": "customer-secret-do-not-publish"}

	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", input, "stable-request")
	if err != nil || !inserted {
		t.Fatalf("create job inserted=%t err=%v", inserted, err)
	}
	eventID := jobLifecycleEventID(created.Job.ID, jobEventCreated)
	event, found, err := projectStore.GetOutbox(scope, eventID)
	if err != nil || !found {
		t.Fatalf("read created event found=%t err=%v", found, err)
	}
	assertJobOutboxEvent(t, event, created.Job, jobEventCreated)
	if strings.Contains(mustJSON(t, event.Payload), "customer-secret-do-not-publish") {
		t.Fatal("job input leaked into outbox payload")
	}

	replayed, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", input, "stable-request")
	if err != nil || inserted || replayed.Job.ID != created.Job.ID {
		t.Fatalf("idempotent create replay inserted=%t job=%s err=%v", inserted, replayed.Job.ID, err)
	}
	assertOutboxCount(t, projectStore, created.Job.ID, jobEventCreated, 1)
}

func TestJobTerminalOutboxEventsAreCompleteAndNotDuplicated(t *testing.T) {
	tests := []struct {
		name       string
		eventType  string
		wantStatus string
		transition func(*ProjectStore, Scope, Job) error
	}{
		{
			name: "succeeded", eventType: jobEventSucceeded, wantStatus: "succeeded",
			transition: func(store *ProjectStore, _ Scope, job Job) error {
				_, _, err := store.CompleteJob(job.ID, "succeeded", map[string]any{"private": "result-secret"}, "", 12)
				return err
			},
		},
		{
			name: "failed", eventType: jobEventFailed, wantStatus: "failed",
			transition: func(store *ProjectStore, _ Scope, job Job) error {
				_, _, err := store.CompleteJob(job.ID, "failed", map[string]any{}, "credential-like-error-secret", 13)
				return err
			},
		},
		{
			name: "cancelled", eventType: jobEventCancelled, wantStatus: "canceled",
			transition: func(store *ProjectStore, scope Scope, job Job) error {
				_, _, forbidden, err := store.CancelJob(scope, job.ID)
				if forbidden {
					t.Fatal("fixture owner was forbidden from canceling its job")
				}
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			projectStore, scope, project := newJobOutboxFixture(t, test.name)
			created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"secret": "input-secret"}, "request-"+test.name)
			if err != nil || !inserted {
				t.Fatalf("create job inserted=%t err=%v", inserted, err)
			}
			job := created.Job
			if test.eventType != jobEventCancelled {
				job, _, err = projectStore.ClaimNextJob(testJobClaimAccess("worker-"+test.name, scope, project.Slug, "analyze"))
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := test.transition(projectStore, scope, job); err != nil {
				t.Fatal(err)
			}
			terminal, found, err := projectStore.GetJob(scope, job.ID)
			if err != nil || !found || terminal.Status != test.wantStatus {
				t.Fatalf("terminal job found=%t status=%q err=%v", found, terminal.Status, err)
			}
			event, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(job.ID, test.eventType))
			if err != nil || !found {
				t.Fatalf("read terminal event found=%t err=%v", found, err)
			}
			assertJobOutboxEvent(t, event, terminal, test.eventType)
			payload := mustJSON(t, event.Payload)
			for _, secret := range []string{"input-secret", "result-secret", "credential-like-error-secret"} {
				if strings.Contains(payload, secret) {
					t.Fatalf("sensitive job field %q leaked into outbox payload", secret)
				}
			}

			if err := test.transition(projectStore, scope, terminal); !errors.Is(err, ErrInvalidJobTransition) {
				t.Fatalf("duplicate terminal transition error=%v, want %v", err, ErrInvalidJobTransition)
			}
			assertOutboxCount(t, projectStore, job.ID, test.eventType, 1)
		})
	}
}

func TestCompleteJobForWorkerRejectsWrongWorkerAtomically(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "worker-binding")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "worker-binding")
	if err != nil || !inserted {
		t.Fatalf("create job inserted=%t err=%v", inserted, err)
	}
	running, found, err := projectStore.ClaimNextJob(testJobClaimAccess("worker-owner", scope, project.Slug, "analyze"))
	if err != nil || !found || running.ID != created.Job.ID {
		t.Fatalf("claim job found=%t job=%s err=%v", found, running.ID, err)
	}

	if _, found, err := projectStore.CompleteJobForWorker(running.ID, "worker-attacker", "succeeded", map[string]any{"forged": true}, "", 1); !found || !errors.Is(err, ErrJobWorkerMismatch) {
		t.Fatalf("wrong worker completion found=%t err=%v, want %v", found, err, ErrJobWorkerMismatch)
	}
	after, found, err := projectStore.GetJob(scope, running.ID)
	if err != nil || !found || after.Status != "running" || after.Result["forged"] != nil || after.FinishedAt != "" {
		t.Fatalf("wrong worker changed job found=%t job=%#v err=%v", found, after, err)
	}
	var runStatus string
	if err := projectStore.database.QueryRow(`SELECT status FROM workbench_runs WHERE job_id = ?`, running.ID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "running" {
		t.Fatalf("wrong worker changed run status=%q", runStatus)
	}
	if _, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(running.ID, jobEventSucceeded)); err != nil || found {
		t.Fatalf("wrong worker emitted terminal outbox found=%t err=%v", found, err)
	}

	completed, found, err := projectStore.CompleteJobForWorker(running.ID, " worker-owner ", "succeeded", map[string]any{"ok": true}, "", 2)
	if err != nil || !found || completed.Status != "succeeded" {
		t.Fatalf("owning worker completion found=%t job=%#v err=%v", found, completed, err)
	}
	if _, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(running.ID, jobEventSucceeded)); err != nil || !found {
		t.Fatalf("owning worker terminal outbox found=%t err=%v", found, err)
	}
}

func TestJobAndOutboxRollBackTogetherWhenCreatedEventFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "created-rollback")
	installOutboxFailureTrigger(t, projectStore, jobEventCreated)

	if _, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "rollback-created"); err == nil {
		t.Fatal("job creation unexpectedly committed when its outbox insert failed")
	}
	assertTableCount(t, projectStore, "jobs", 0)
	assertTableCount(t, projectStore, "workbench_runs", 0)
	assertTableCount(t, projectStore, "outbox_events", 0)
}

func TestJobAndOutboxRollBackTogetherWhenTerminalEventFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "terminal-rollback")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "rollback-terminal")
	if err != nil || !inserted {
		t.Fatalf("create job inserted=%t err=%v", inserted, err)
	}
	running, found, err := projectStore.ClaimNextJob(testJobClaimAccess("rollback-worker", scope, project.Slug, "analyze"))
	if err != nil || !found || running.ID != created.Job.ID {
		t.Fatalf("claim job found=%t job=%s err=%v", found, running.ID, err)
	}
	installOutboxFailureTrigger(t, projectStore, jobEventSucceeded)

	if _, _, err := projectStore.CompleteJob(running.ID, "succeeded", map[string]any{"value": 2}, "", 10); err == nil {
		t.Fatal("job completion unexpectedly committed when its outbox insert failed")
	}
	after, found, err := projectStore.GetJob(scope, running.ID)
	if err != nil || !found || after.Status != "running" || after.FinishedAt != "" {
		t.Fatalf("job terminal mutation escaped rollback found=%t job=%#v err=%v", found, after, err)
	}
	var runStatus string
	if err := projectStore.database.QueryRow(`SELECT status FROM workbench_runs WHERE job_id = ?`, running.ID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "running" {
		t.Fatalf("run terminal mutation escaped rollback status=%q", runStatus)
	}
	if _, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(running.ID, jobEventSucceeded)); err != nil || found {
		t.Fatalf("failed terminal event became visible found=%t err=%v", found, err)
	}
}

func TestJobAndOutboxRollBackTogetherWhenCancelledEventFails(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "cancel-rollback")
	created, inserted, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{"value": 1}, "rollback-cancel")
	if err != nil || !inserted {
		t.Fatalf("create job inserted=%t err=%v", inserted, err)
	}
	installOutboxFailureTrigger(t, projectStore, jobEventCancelled)

	if _, found, forbidden, err := projectStore.CancelJob(scope, created.Job.ID); err == nil || !found || forbidden {
		t.Fatalf("job cancellation found=%t forbidden=%t err=%v, want transactional failure", found, forbidden, err)
	}
	after, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || after.Status != "queued" || after.FinishedAt != "" {
		t.Fatalf("job cancellation escaped rollback found=%t job=%#v err=%v", found, after, err)
	}
	var runStatus string
	if err := projectStore.database.QueryRow(`SELECT status FROM workbench_runs WHERE job_id = ?`, created.Job.ID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" {
		t.Fatalf("run cancellation escaped rollback status=%q", runStatus)
	}
	if _, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(created.Job.ID, jobEventCancelled)); err != nil || found {
		t.Fatalf("failed cancellation event became visible found=%t err=%v", found, err)
	}
}

func newJobOutboxFixture(t *testing.T, suffix string) (*ProjectStore, Scope, Project) {
	t.Helper()
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-job-"+suffix, "workspace-job-"+suffix, suffix+"@jobs.test", "Job Owner", "admin")
	if err != nil {
		t.Fatal(err)
	}
	project, err := projectStore.CreateProject(identity.Scope(), "python-lab", "Outbox fixture", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	return projectStore, identity.Scope(), project
}

func testJobClaimAccess(workerID string, scope Scope, slug, action string) JobClaimAccess {
	return JobClaimAccess{WorkerID: workerID, Scopes: []JobClaimScope{{
		TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
		Slug: slug, Actions: []string{action},
	}}}
}

func assertJobOutboxEvent(t *testing.T, event OutboxEvent, job Job, eventType string) {
	t.Helper()
	if event.ID != jobLifecycleEventID(job.ID, eventType) || event.EventType != eventType ||
		event.AggregateType != "job" || event.AggregateID != job.ID ||
		event.TenantID != job.TenantID || event.WorkspaceID != job.WorkspaceID {
		t.Fatalf("unexpected job outbox envelope: %#v", event)
	}
	wants := map[string]string{
		"tenantId": job.TenantID, "workspaceId": job.WorkspaceID,
		"projectId": job.ProjectID, "jobId": job.ID, "status": job.Status,
	}
	for key, want := range wants {
		if got, ok := event.Payload[key].(string); !ok || got != want {
			t.Fatalf("payload %s=%#v, want %q", key, event.Payload[key], want)
		}
	}
	if got, ok := event.Payload["schemaVersion"].(float64); !ok || got != 1 {
		t.Fatalf("payload schemaVersion=%#v, want 1", event.Payload["schemaVersion"])
	}
	if len(event.Payload) != 6 {
		t.Fatalf("unexpected payload fields: %#v", event.Payload)
	}
}

func assertOutboxCount(t *testing.T, projectStore *ProjectStore, jobID, eventType string, want int) {
	t.Helper()
	var got int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM outbox_events WHERE aggregate_type = 'job' AND aggregate_id = ? AND event_type = ?`, jobID, eventType).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("outbox count=%d, want %d for %s", got, want, eventType)
	}
}

func assertTableCount(t *testing.T, projectStore *ProjectStore, table string, want int) {
	t.Helper()
	var got int
	query := "SELECT COUNT(*) FROM " + table // table names are fixed test constants.
	if err := projectStore.database.QueryRow(query).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("%s count=%d, want %d", table, got, want)
	}
}

func installOutboxFailureTrigger(t *testing.T, projectStore *ProjectStore, eventType string) {
	t.Helper()
	var eventLiteral string
	switch eventType {
	case jobEventCreated:
		eventLiteral = "'job.created'"
	case jobEventSucceeded:
		eventLiteral = "'job.succeeded'"
	case jobEventFailed:
		eventLiteral = "'job.failed'"
	case jobEventCancelled:
		eventLiteral = "'job.cancelled'"
	default:
		t.Fatalf("unsupported event type %q", eventType)
	}
	query := `CREATE TRIGGER reject_job_outbox BEFORE INSERT ON outbox_events
		WHEN NEW.event_type = ` + eventLiteral + ` BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`
	if _, err := projectStore.database.Exec(query); err != nil {
		t.Fatal(err)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
