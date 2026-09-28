package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"skyviewlab/backend_go/internal/authorization"
)

type testAuthorizer struct {
	checks   []authorization.Check
	decision func(authorization.Check) (bool, error)
	readyErr error
}

func (authorizer *testAuthorizer) Check(_ context.Context, check authorization.Check) (bool, error) {
	authorizer.checks = append(authorizer.checks, check)
	if authorizer.decision != nil {
		return authorizer.decision(check)
	}
	return true, nil
}

func (authorizer *testAuthorizer) Ready(context.Context) error { return authorizer.readyErr }

func (authorizer *testAuthorizer) Mode() string { return "test-openfga" }

func configWithAuthorizer(authorizer authorization.Authorizer) Config {
	config := testConfig()
	config.DevAuthorizationFallback = false
	config.Authorizer = authorizer
	return config
}

func TestProjectRoutesFailClosedOnPolicyDenyAndAuthorizerError(t *testing.T) {
	authorizer := &testAuthorizer{}
	handler := newTestHandler(t, configWithAuthorizer(authorizer))
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	projectID := createProject(t, handler, admin, "paper-writing")

	authorizer.decision = func(check authorization.Check) (bool, error) {
		if check.Resource.Type == authorization.ResourceProject && check.Relation == authorization.RelationView {
			return false, nil
		}
		return true, nil
	}
	denied := perform(handler, http.MethodGet, "/api/v1/projects/"+projectID, "", admin)
	if denied.Code != http.StatusForbidden || errorCode(t, denied) != "PROJECT_ACCESS_DENIED" {
		t.Fatalf("project read must honor policy deny: %d %s", denied.Code, denied.Body.String())
	}

	authorizer.decision = func(check authorization.Check) (bool, error) {
		if check.Resource.Type == authorization.ResourceProject && check.Relation == authorization.RelationEdit {
			return false, nil
		}
		return true, nil
	}
	update := perform(handler, http.MethodPut, "/api/v1/projects/"+projectID, `{"title":"unauthorized","state":{"stage":"changed"}}`, admin)
	if update.Code != http.StatusForbidden || errorCode(t, update) != "PROJECT_ACCESS_DENIED" {
		t.Fatalf("project write must honor policy deny: %d %s", update.Code, update.Body.String())
	}

	authorizer.decision = func(check authorization.Check) (bool, error) {
		if check.Resource.Type == authorization.ResourceProject {
			return false, errors.New("OpenFGA unavailable")
		}
		return true, nil
	}
	unavailable := perform(handler, http.MethodGet, "/api/v1/projects/"+projectID, "", admin)
	if unavailable.Code != http.StatusServiceUnavailable || errorCode(t, unavailable) != "AUTHORIZATION_UNAVAILABLE" {
		t.Fatalf("authorizer failure must fail closed: %d %s", unavailable.Code, unavailable.Body.String())
	}
}

func TestJobReadAndCancelRequireResourceChecks(t *testing.T) {
	authorizer := &testAuthorizer{}
	handler := newTestHandler(t, configWithAuthorizer(authorizer))
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs", `{"slug":"paper-writing","action":"audit","input":{}}`, admin)
	if created.Code != http.StatusCreated {
		t.Fatalf("create job failed: %d %s", created.Code, created.Body.String())
	}
	job := decodeData[struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}](t, created)

	authorizer.decision = func(check authorization.Check) (bool, error) {
		return !(check.Resource.Type == authorization.ResourceJob && check.Relation == authorization.RelationView), nil
	}
	read := perform(handler, http.MethodGet, "/api/v1/jobs/"+job.Job.ID, "", admin)
	if read.Code != http.StatusForbidden || errorCode(t, read) != "JOB_ACCESS_DENIED" {
		t.Fatalf("job read must be denied: %d %s", read.Code, read.Body.String())
	}
	authorizer.decision = func(check authorization.Check) (bool, error) {
		return !(check.Resource.Type == authorization.ResourceJob && check.Relation == authorization.RelationCancel), nil
	}
	cancel := perform(handler, http.MethodPost, "/api/v1/jobs/"+job.Job.ID+"/cancel", "", admin)
	if cancel.Code != http.StatusForbidden || errorCode(t, cancel) != "JOB_CANCEL_DENIED" {
		t.Fatalf("job cancel must be denied before mutation: %d %s", cancel.Code, cancel.Body.String())
	}
}

func TestSubmissionReadEditAndGradeRequireResourceChecks(t *testing.T) {
	authorizer := &testAuthorizer{}
	handler := newTestHandler(t, configWithAuthorizer(authorizer))
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	assignmentResponse := perform(handler, http.MethodPost, "/api/v1/collaboration/assignments", `{"data":{"title":"授权测试作业","description":"验证逐提交授权"}}`, admin)
	assignment := decodeData[struct {
		ID string `json:"id"`
	}](t, assignmentResponse)
	student := login(t, handler, "student@skyviewlab.local", "student-password-123")
	submissionResponse := perform(handler, http.MethodPost, "/api/v1/collaboration/submissions", `{"data":{"assignmentId":"`+assignment.ID+`","content":"original"}}`, student)
	if submissionResponse.Code != http.StatusCreated {
		t.Fatalf("create submission failed: %d %s", submissionResponse.Code, submissionResponse.Body.String())
	}
	submission := decodeData[struct {
		ID string `json:"id"`
	}](t, submissionResponse)

	authorizer.decision = func(check authorization.Check) (bool, error) {
		return !(check.Resource.Type == authorization.ResourceSubmission && check.Relation == authorization.RelationView), nil
	}
	read := perform(handler, http.MethodGet, "/api/v1/collaboration/submissions/"+submission.ID, "", student)
	if read.Code != http.StatusForbidden || errorCode(t, read) != "SUBMISSION_ACCESS_DENIED" {
		t.Fatalf("submission read must be denied: %d %s", read.Code, read.Body.String())
	}

	authorizer.decision = func(check authorization.Check) (bool, error) {
		return !(check.Resource.Type == authorization.ResourceSubmission && check.Relation == authorization.RelationEdit), nil
	}
	edit := perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, `{"revision":1,"data":{"content":"changed"}}`, student)
	if edit.Code != http.StatusForbidden || errorCode(t, edit) != "SUBMISSION_UPDATE_DENIED" {
		t.Fatalf("submission edit must be denied: %d %s", edit.Code, edit.Body.String())
	}

	authorizer.decision = func(check authorization.Check) (bool, error) {
		return !(check.Resource.Type == authorization.ResourceSubmission && check.Relation == authorization.RelationGrade), nil
	}
	grade := perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, `{"revision":1,"data":{"score":90,"feedback":"review"}}`, admin)
	if grade.Code != http.StatusForbidden || errorCode(t, grade) != "SUBMISSION_UPDATE_DENIED" {
		t.Fatalf("submission grade must be denied: %d %s", grade.Code, grade.Body.String())
	}
}

func TestDevelopmentFallbackDeniesStudentHorizontalProjectAndJobAccess(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	projectID := createProject(t, handler, admin, "paper-writing")
	created := perform(handler, http.MethodPost, "/api/v1/projects/"+projectID+"/jobs", `{"slug":"paper-writing","action":"audit","input":{}}`, admin)
	if created.Code != http.StatusCreated {
		t.Fatalf("create job failed: %d %s", created.Code, created.Body.String())
	}
	job := decodeData[struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}](t, created)
	student := login(t, handler, "student@skyviewlab.local", "student-password-123")

	project := perform(handler, http.MethodGet, "/api/v1/projects/"+projectID, "", student)
	if project.Code != http.StatusForbidden || errorCode(t, project) != "PROJECT_ACCESS_DENIED" {
		t.Fatalf("student must not read another user's project: %d %s", project.Code, project.Body.String())
	}
	jobRead := perform(handler, http.MethodGet, "/api/v1/jobs/"+job.Job.ID, "", student)
	if jobRead.Code != http.StatusForbidden || errorCode(t, jobRead) != "JOB_ACCESS_DENIED" {
		t.Fatalf("student must not read another submitter's job: %d %s", jobRead.Code, jobRead.Body.String())
	}
}

func TestDevelopmentFallbackKeepsSubmittedRecordImmutable(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	admin := login(t, handler, "demo@skyviewlab.local", "test-password-123")
	assignmentResponse := perform(handler, http.MethodPost, "/api/v1/collaboration/assignments", `{"data":{"title":"不可覆盖测试","description":"正式提交必须创建新版本"}}`, admin)
	assignment := decodeData[struct {
		ID string `json:"id"`
	}](t, assignmentResponse)
	student := login(t, handler, "student@skyviewlab.local", "student-password-123")
	submissionResponse := perform(handler, http.MethodPost, "/api/v1/collaboration/submissions", `{"data":{"assignmentId":"`+assignment.ID+`","content":"version one"}}`, student)
	submission := decodeData[struct {
		ID string `json:"id"`
	}](t, submissionResponse)
	overwrite := perform(handler, http.MethodPut, "/api/v1/collaboration/submissions/"+submission.ID, `{"revision":1,"data":{"content":"overwrite"}}`, student)
	if overwrite.Code != http.StatusForbidden || errorCode(t, overwrite) != "SUBMISSION_UPDATE_DENIED" {
		t.Fatalf("formal submission must not be overwritten: %d %s", overwrite.Code, overwrite.Body.String())
	}
}

func TestAuthorizationConfigurationAndReadinessGates(t *testing.T) {
	config := testConfig()
	config.DevAuthorizationFallback = false
	if err := validateAuthorizationConfig(config); err == nil || !strings.Contains(err.Error(), "OpenFGA") {
		t.Fatalf("development requires explicit fallback or OpenFGA: %v", err)
	}
	production := Config{
		OpenFGAAPIURL: "https://openfga.example.test", OpenFGAStoreID: "01H0H015178Y2V4CX10C2KGHF4",
		OpenFGAAuthorizationModelID: "01H0H015178Y2V4CX10C2KGHF5",
	}
	if err := validateAuthorizationConfig(production); err == nil || !strings.Contains(err.Error(), "preshared") {
		t.Fatalf("production must require the OpenFGA preshared token: %v", err)
	}
	production.OpenFGAAPIToken = "0123456789abcdef0123456789abcdef"
	if err := validateAuthorizationConfig(production); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("production must pin the model hash: %v", err)
	}
	if err := validateAuthorizationConfig(Config{DevAuthorizationFallback: true}); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("production must forbid local fallback: %v", err)
	}

	authorizer := &testAuthorizer{readyErr: errors.New("offline")}
	handler := newTestHandler(t, configWithAuthorizer(authorizer))
	ready := perform(handler, http.MethodGet, "/api/v1/ready", "", nil)
	if ready.Code != http.StatusServiceUnavailable || !strings.Contains(ready.Body.String(), `"authorization":{"mode":"test-openfga","ok":false,"productionReady":false}`) {
		t.Fatalf("readiness must report authorization failure without claiming E2E: %d %s", ready.Code, ready.Body.String())
	}
}
