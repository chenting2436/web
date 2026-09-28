package api

import "skyviewlab/backend_go/internal/store"

// PublicJob is the browser-facing projection of a persisted job. Keep this
// type explicit: store.Job also carries tenant, actor, request input,
// idempotency and worker-coordination data that must not cross the session API
// boundary.
type PublicJob struct {
	ID         string         `json:"id"`
	ProjectID  string         `json:"projectId"`
	Slug       string         `json:"slug"`
	Action     string         `json:"action"`
	Status     string         `json:"status"`
	Result     map[string]any `json:"result"`
	Error      string         `json:"error,omitempty"`
	Attempt    int            `json:"attempt"`
	DurationMS float64        `json:"durationMs"`
	CreatedAt  string         `json:"createdAt"`
	StartedAt  string         `json:"startedAt,omitempty"`
	UpdatedAt  string         `json:"updatedAt"`
	FinishedAt string         `json:"finishedAt,omitempty"`
}

// PublicRun is the browser-facing execution evidence. In particular, request
// input is intentionally omitted; the result remains visible because current
// workbench pages render it.
type PublicRun struct {
	ID         string         `json:"id"`
	JobID      string         `json:"jobId"`
	ProjectID  string         `json:"projectId"`
	Slug       string         `json:"slug"`
	Action     string         `json:"action"`
	Status     string         `json:"status"`
	Result     map[string]any `json:"result"`
	Error      string         `json:"error,omitempty"`
	DurationMS float64        `json:"durationMs"`
	CreatedAt  string         `json:"createdAt"`
	UpdatedAt  string         `json:"updatedAt"`
}

type PublicJobRun struct {
	Job PublicJob `json:"job"`
	Run PublicRun `json:"run"`
}

// WorkerJob is the minimum routing projection disclosed during claim. Inputs,
// tenant context, creator identity and result fields remain server-side; the
// execute endpoint resolves them again under the one-time claim capability.
type WorkerJob struct {
	ID       string `json:"id"`
	WorkerID string `json:"workerId"`
}

// WorkerJobResult is the only terminal response projection needed by the
// polling worker. Customer input, result data, tenant context and identities
// never need to be echoed after the worker has submitted or executed them.
type WorkerJobResult struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func workerJobResult(job store.Job) WorkerJobResult {
	return WorkerJobResult{ID: job.ID, Status: job.Status}
}

type WorkerJobClaim struct {
	Job            WorkerJob `json:"job"`
	ClaimToken     string    `json:"claimToken"`
	ClaimEpoch     int64     `json:"claimEpoch"`
	LeaseExpiresAt string    `json:"leaseExpiresAt"`
	HeartbeatAt    string    `json:"heartbeatAt"`
}

func workerJobClaim(claim store.JobClaim) WorkerJobClaim {
	return WorkerJobClaim{
		Job: WorkerJob{ID: claim.Job.ID, WorkerID: claim.Job.WorkerID}, ClaimToken: claim.ClaimToken,
		ClaimEpoch: claim.ClaimEpoch, LeaseExpiresAt: claim.LeaseExpiresAt, HeartbeatAt: claim.HeartbeatAt,
	}
}

func publicJob(job store.Job) PublicJob {
	return PublicJob{
		ID: job.ID, ProjectID: job.ProjectID, Slug: job.Slug, Action: job.Action,
		Status: job.Status, Result: job.Result, Error: job.Error, Attempt: job.Attempt,
		DurationMS: job.DurationMS, CreatedAt: job.CreatedAt, StartedAt: job.StartedAt,
		UpdatedAt: job.UpdatedAt, FinishedAt: job.FinishedAt,
	}
}

func publicJobs(jobs []store.Job) []PublicJob {
	result := make([]PublicJob, len(jobs))
	for index, job := range jobs {
		result[index] = publicJob(job)
	}
	return result
}

func publicRun(run store.Run) PublicRun {
	return PublicRun{
		ID: run.ID, JobID: run.JobID, ProjectID: run.ProjectID, Slug: run.Slug,
		Action: run.Action, Status: run.Status, Result: run.Result, Error: run.Error,
		DurationMS: run.DurationMS, CreatedAt: run.CreatedAt, UpdatedAt: run.UpdatedAt,
	}
}

func publicRuns(runs []store.Run) []PublicRun {
	result := make([]PublicRun, len(runs))
	for index, run := range runs {
		result[index] = publicRun(run)
	}
	return result
}

func publicJobRun(jobRun store.JobRun) PublicJobRun {
	return PublicJobRun{Job: publicJob(jobRun.Job), Run: publicRun(jobRun.Run)}
}
