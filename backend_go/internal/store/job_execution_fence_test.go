package store

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestJobExecutionFenceAllowsOneStartPerClaimEpoch(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "execution-fence")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "execution-fence")
	if err != nil {
		t.Fatal(err)
	}
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-fence", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim found=%t err=%v", found, err)
	}

	const callers = 24
	start := make(chan struct{})
	var successful atomic.Int32
	errorsSeen := make(chan error, callers)
	var wait sync.WaitGroup
	for index := range callers {
		wait.Add(1)
		go func(caller int) {
			defer wait.Done()
			<-start
			job, found, err := projectStore.BeginJobExecution(claim.Job.ID, "worker-fence", claim.ClaimToken)
			switch {
			case err == nil && found && job.ID == created.Job.ID:
				successful.Add(1)
			case found && errors.Is(err, ErrJobExecutionStarted):
				return
			default:
				errorsSeen <- fmt.Errorf("caller %d found=%t job=%s err=%v", caller, found, job.ID, err)
			}
		}(index)
	}
	close(start)
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Error(err)
	}
	if successful.Load() != 1 {
		t.Fatalf("execution starts=%d, want exactly one", successful.Load())
	}

	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, "worker-fence", "wrong-token"); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("wrong token found=%t err=%v", found, err)
	}
	expireJobLease(t, projectStore, claim.Job.ID)
	reclaimed, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-fence", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || found {
		t.Fatalf("started execution must be terminalized, not reclaimed found=%t claim=%+v err=%v", found, reclaimed, err)
	}
	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, "worker-fence", claim.ClaimToken); !found || !errors.Is(err, ErrJobClaimLost) {
		t.Fatalf("stale epoch started found=%t err=%v", found, err)
	}
	terminal, found, err := projectStore.GetJob(scope, created.Job.ID)
	if err != nil || !found || terminal.Status != "failed" || terminal.Error != JobExecutionLeaseLostError {
		t.Fatalf("lost execution lease terminal state found=%t job=%+v err=%v", found, terminal, err)
	}
	var runStatus, runError string
	if err := projectStore.database.QueryRow(`SELECT status, error_text FROM workbench_runs WHERE job_id = ?`, created.Job.ID).Scan(&runStatus, &runError); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || runError != JobExecutionLeaseLostError {
		t.Fatalf("run/job state diverged status=%q error=%q", runStatus, runError)
	}
	if event, found, err := projectStore.GetOutbox(scope, jobLifecycleEventID(created.Job.ID, jobEventFailed)); err != nil || !found || event.Payload["status"] != "failed" {
		t.Fatalf("missing safe failure event found=%t event=%+v err=%v", found, event, err)
	}
	assertOutboxCount(t, projectStore, created.Job.ID, jobEventFailed, 1)
}

func TestJobExecutionFenceIsClearedAtEveryTerminalTransition(t *testing.T) {
	projectStore, scope, project := newJobOutboxFixture(t, "execution-terminal")
	created, _, err := projectStore.CreateJob(scope, project.ID, project.Slug, "analyze", map[string]any{}, "execution-terminal")
	if err != nil {
		t.Fatal(err)
	}
	claim, found, err := projectStore.ClaimNextJobWithLease(testJobClaimAccess("worker-terminal", scope, project.Slug, "analyze"), time.Minute)
	if err != nil || !found {
		t.Fatalf("claim found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.BeginJobExecution(claim.Job.ID, "worker-terminal", claim.ClaimToken); err != nil || !found {
		t.Fatalf("begin found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.CompleteJobClaim(claim.Job.ID, "worker-terminal", claim.ClaimToken, "succeeded", map[string]any{}, "", 1); err != nil || !found {
		t.Fatalf("complete found=%t err=%v", found, err)
	}
	var marker any
	if err := projectStore.database.QueryRow(`SELECT execution_started_at FROM jobs WHERE id = ?`, created.Job.ID).Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != nil {
		t.Fatalf("terminal job retained execution fence: %v", marker)
	}
}
