package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"skyviewlab/backend_go/internal/store"
)

var openAPIMethods = map[string]struct{}{
	"get": {}, "post": {}, "put": {}, "patch": {}, "delete": {},
}

type contractOperation struct {
	path   string
	method string
	body   map[string]any
}

func TestOpenAPIContractMatchesRegisteredV1Routes(t *testing.T) {
	spec := loadOpenAPIContract(t)
	documented := documentedOperations(t, spec)
	registered := registeredV1Operations(t)
	if len(documented) != 38 {
		t.Fatalf("expected 38 documented operations after removing the untrusted external completion route, got %d", len(documented))
	}

	if diff := operationSetDiff(registered, documented); len(diff) > 0 {
		t.Fatalf("registered /api/v1 operations missing from OpenAPI contract: %s", strings.Join(diff, ", "))
	}
	if diff := operationSetDiff(documented, registered); len(diff) > 0 {
		t.Fatalf("OpenAPI operations not registered by server.go: %s", strings.Join(diff, ", "))
	}

	aliases := requireMap(t, spec, "x-compatibility-aliases")
	if _, explicitlyIgnored := aliases["/api"]; !explicitlyIgnored {
		t.Fatal("the temporary /api compatibility surface must be explicitly documented as excluded")
	}
}

func TestOpenAPIOperationsHaveUniqueIDsResponsesAndSecurity(t *testing.T) {
	spec := loadOpenAPIContract(t)
	operations := documentedOperations(t, spec)
	seenOperationIDs := map[string]string{}

	for key, operation := range operations {
		operationID, ok := operation.body["operationId"].(string)
		if !ok || strings.TrimSpace(operationID) == "" {
			t.Errorf("%s has no operationId", key)
		} else if previous, duplicate := seenOperationIDs[operationID]; duplicate {
			t.Errorf("operationId %q is duplicated by %s and %s", operationID, previous, key)
		} else {
			seenOperationIDs[operationID] = key
		}
		responses := requireMap(t, operation.body, "responses")
		if len(responses) == 0 {
			t.Errorf("%s has no responses", key)
		}
		assertOperationResponseEnvelopes(t, spec, key, responses)
		assertOperationSecurity(t, key, operation)
		if operation.method == "POST" || operation.method == "PUT" || operation.method == "PATCH" || operation.method == "DELETE" {
			if _, documented := responses["403"]; !documented {
				t.Errorf("%s must document exact-Origin rejection as HTTP 403", key)
			}
		}
		if usesSecurityScheme(operation.body["security"], "sessionCookie") {
			for _, status := range []string{"401", "500"} {
				if _, documented := responses[status]; !documented {
					t.Errorf("%s must document session authentication/persistence failure as HTTP %s", key, status)
				}
			}
		}
	}

	assertFrozenEndpoint(t, operations, "POST /api/v1/projects/{id}/runs")
	assertFrozenEndpoint(t, operations, "POST /api/v1/tools/{slug}/run")
	assertFrozenEndpoint(t, operations, "POST /api/v1/analysis/text")
}

func TestOpenAPIAuthPersistenceFailuresHaveStable500Examples(t *testing.T) {
	spec := loadOpenAPIContract(t)
	operations := documentedOperations(t, spec)
	checks := []struct {
		operation string
		response  string
		codes     []string
	}{
		{"POST /api/v1/auth/login", "AuthLoginError500", []string{"IDENTITY_BOOTSTRAP_FAILED", "SESSION_CREATE_FAILED", "AUDIT_WRITE_FAILED"}},
		{"GET /api/v1/auth/oidc/callback", "OIDCCallbackError500", []string{"OIDC_IDENTITY_MAPPING_FAILED", "SESSION_CREATE_FAILED", "AUDIT_WRITE_FAILED"}},
	}
	componentResponses := requireMap(t, requireMap(t, spec, "components"), "responses")
	for _, check := range checks {
		responses := requireMap(t, operations[check.operation].body, "responses")
		response500 := requireMap(t, responses, "500")
		if response500["$ref"] != "#/components/responses/"+check.response {
			t.Errorf("%s must document its dedicated 500 response", check.operation)
			continue
		}
		component := requireMap(t, componentResponses, check.response)
		media := requireMap(t, requireMap(t, component, "content"), "application/json")
		examples := requireMap(t, media, "examples")
		seen := make(map[string]bool)
		for _, rawExample := range examples {
			example := requireMap(t, requireMap(t, rawExample.(map[string]any), "value"), "error")
			code, _ := example["code"].(string)
			seen[code] = true
		}
		for _, code := range check.codes {
			if !seen[code] {
				t.Errorf("%s 500 examples are missing stable code %s", check.operation, code)
			}
		}
	}
}

func TestOpenAPIOIDCStartDocumentsRateLimitContract(t *testing.T) {
	spec := loadOpenAPIContract(t)
	operation := documentedOperations(t, spec)["GET /api/v1/auth/oidc/start"].body
	response429 := requireMap(t, requireMap(t, operation, "responses"), "429")
	if response429["$ref"] != "#/components/responses/OIDCRateLimitError429" {
		t.Fatal("OIDC start must document its dedicated 429 response")
	}
	component := requireMap(t, requireMap(t, requireMap(t, spec, "components"), "responses"), "OIDCRateLimitError429")
	retryAfter := requireMap(t, requireMap(t, component, "headers"), "Retry-After")
	if retryAfter["required"] != true {
		t.Fatal("OIDC start 429 must require Retry-After")
	}
	media := requireMap(t, requireMap(t, component, "content"), "application/json")
	example := requireMap(t, media, "example")
	errorValue := requireMap(t, example, "error")
	if errorValue["code"] != "OIDC_RATE_LIMITED" {
		t.Fatal("OIDC start 429 stable error code drifted")
	}
}

func TestOpenAPISharedBoundariesAreExplicit(t *testing.T) {
	spec := loadOpenAPIContract(t)
	components := requireMap(t, spec, "components")
	schemes := requireMap(t, components, "securitySchemes")
	for _, name := range []string{"sessionCookie", "oidcStateCookie", "workerBearer"} {
		if _, exists := schemes[name]; !exists {
			t.Errorf("missing security scheme %s", name)
		}
	}
	workerBearer := requireMap(t, schemes, "workerBearer")
	workerDescription, _ := workerBearer["description"].(string)
	for _, required := range []string{"tenantId", "workspaceId", "single-slug", "action-allowlist", "wildcards"} {
		if !strings.Contains(workerDescription, required) {
			t.Errorf("worker bearer scope contract is missing %q", required)
		}
	}

	parameters := requireMap(t, components, "parameters")
	origin := requireMap(t, parameters, "Origin")
	if origin["in"] != "header" || origin["name"] != "Origin" || origin["required"] != true {
		t.Fatal("Origin must remain a required reusable header parameter for cookie-authenticated writes")
	}
	idempotency := requireMap(t, parameters, "IdempotencyKey")
	idempotencySchema := requireMap(t, idempotency, "schema")
	if idempotency["name"] != "Idempotency-Key" || idempotency["x-single-value"] != true || number(t, idempotencySchema["minLength"]) != 1 || number(t, idempotencySchema["maxLength"]) != 128 || idempotencySchema["pattern"] == nil {
		t.Fatal("Idempotency-Key header must remain a single bounded safe-ASCII value")
	}
	jobClaimToken := requireMap(t, parameters, "JobClaimToken")
	jobClaimTokenSchema := requireMap(t, jobClaimToken, "schema")
	if jobClaimToken["name"] != "X-Skyview-Job-Claim" || jobClaimToken["in"] != "header" || jobClaimToken["required"] != true || jobClaimToken["x-single-value"] != true || jobClaimToken["x-sensitive"] != true {
		t.Fatal("X-Skyview-Job-Claim must remain a required, single-value, sensitive reusable header")
	}
	if number(t, jobClaimTokenSchema["minLength"]) != jobClaimTokenEncodedLength || number(t, jobClaimTokenSchema["maxLength"]) != jobClaimTokenEncodedLength || jobClaimTokenSchema["pattern"] != "^[A-Za-z0-9_-]{43}$" {
		t.Fatal("X-Skyview-Job-Claim must match the exact canonical token issued by the server")
	}

	operations := documentedOperations(t, spec)
	createJob := operations["POST /api/v1/projects/{id}/jobs"].body
	if !hasParameterReference(createJob, "#/components/parameters/IdempotencyKey") {
		t.Fatal("job creation must document the Idempotency-Key header")
	}
	jobRequest := resolveRequestSchema(t, spec, createJob)
	properties := requireMap(t, jobRequest, "properties")
	if _, exists := properties["idempotencyKey"]; !exists {
		t.Fatal("job creation must also document the body idempotencyKey alternative")
	}

	sizeLimits := requireMap(t, spec, "x-size-limits")
	if number(t, sizeLimits["jsonRequestBytes"]) != maxJSONBody {
		t.Fatalf("documented JSON request limit drifted from maxJSONBody=%d", maxJSONBody)
	}
	if number(t, sizeLimits["jobInputEncodedBytes"]) != 1<<20 {
		t.Fatal("documented job input limit must match the 1 MiB handler limit")
	}
	if number(t, sizeLimits["workbenchStateEncodedBytes"]) != store.MaxWorkbenchStateBytes {
		t.Fatal("documented workbench state limit must match the durable store limit")
	}
	if number(t, sizeLimits["pythonUpstreamResponseBytes"]) != maxPythonResponse {
		t.Fatalf("documented Python response limit drifted from maxPythonResponse=%d", maxPythonResponse)
	}

	schemas := requireMap(t, components, "schemas")
	assertRequiredFields(t, requireMap(t, schemas, "DataEnvelope"), "data", "requestId")
	assertRequiredFields(t, requireMap(t, schemas, "ErrorEnvelope"), "error", "message", "requestId")
	assertRequiredFields(t, requireMap(t, schemas, "AuditEvent"), "sequence", "chainVersion")
	assertRequiredFields(t, requireMap(t, schemas, "WorkbenchState"), "state", "revision")
	assertRequiredFields(t, requireMap(t, schemas, "WorkbenchStateWriteRequest"), "state", "revision")
	assertPublicJobSchemasExcludePrivateFields(t, schemas)
	assertPublicJobOperationsUsePublicResponses(t, spec, operations)
	assertJobLeaseOperations(t, spec, operations)
	assertAuditIntegrityGate(t, operations)
	assertEnum(t, requireMap(t, schemas, "WorkbenchStatus"), "prototype", "planned", "security-blocked")
	jobStatus := requireMap(t, schemas, "JobStatus")
	assertEnum(t, jobStatus, "queued", "running", "succeeded", "failed", "canceled")
	assertCanceledStatusMatchesImplementation(t, jobStatus)
	assertEnum(t, requireMap(t, schemas, "CollaborationKind"), "discussions", "assignments", "submissions")
	auditEvent := requireMap(t, schemas, "AuditEvent")
	auditEventProperties := requireMap(t, auditEvent, "properties")
	assertEnum(t, requireMap(t, auditEventProperties, "chainVersion"), "1", "2", "3")
	workerRequest := requireMap(t, schemas, "WorkerRequest")
	workerProperties := requireMap(t, workerRequest, "properties")
	workerID := requireMap(t, workerProperties, "workerId")
	if workerID["deprecated"] != true || requiredField(workerRequest, "workerId") || workerID["pattern"] != `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$` {
		t.Fatal("WorkerRequest.workerId must remain an optional deprecated compatibility assertion")
	}
}

func assertAuditIntegrityGate(t *testing.T, operations map[string]contractOperation) {
	t.Helper()
	operation, exists := operations["GET /api/v1/audit/events"]
	if !exists {
		t.Fatal("verified audit listing operation is missing")
	}
	description, _ := operation.body["description"].(string)
	for _, required := range []string{"consistent snapshot", "every digest", "AUDIT_CHAIN_INVALID", "no event list"} {
		if !strings.Contains(description, required) {
			t.Errorf("audit listing integrity contract is missing %q", required)
		}
	}
	responses := requireMap(t, operation.body, "responses")
	integrityFailure := requireMap(t, responses, "503")
	if integrityFailure["$ref"] != "#/components/responses/AuditIntegrityError503" {
		t.Fatalf("audit integrity failure must use its explicit 503 response, got %v", integrityFailure["$ref"])
	}
}

func assertPublicJobSchemasExcludePrivateFields(t *testing.T, schemas map[string]any) {
	t.Helper()
	publicJob := requireMap(t, schemas, "PublicJob")
	publicJobProperties := requireMap(t, publicJob, "properties")
	for _, field := range []string{"tenantId", "workspaceId", "createdByUserId", "input", "idempotencyKey", "workerId", "claimToken", "claimEpoch", "leaseExpiresAt", "heartbeatAt"} {
		if _, exposed := publicJobProperties[field]; exposed {
			t.Errorf("PublicJob must not expose private field %s", field)
		}
	}
	assertRequiredFields(t, publicJob, "id", "projectId", "slug", "action", "status", "result", "attempt", "durationMs", "createdAt", "updatedAt")

	publicRun := requireMap(t, schemas, "PublicRun")
	publicRunProperties := requireMap(t, publicRun, "properties")
	if _, exposed := publicRunProperties["input"]; exposed {
		t.Error("PublicRun must not expose request input")
	}
	assertRequiredFields(t, publicRun, "id", "jobId", "projectId", "slug", "action", "status", "result", "durationMs", "createdAt", "updatedAt")

	jobClaim := requireMap(t, schemas, "JobClaim")
	jobClaimProperties := requireMap(t, jobClaim, "properties")
	for _, field := range []string{"job", "claimToken", "claimEpoch", "leaseExpiresAt", "heartbeatAt"} {
		if _, documented := jobClaimProperties[field]; !documented {
			t.Errorf("JobClaim must document internal field %s", field)
		}
	}
	workerJob := requireMap(t, schemas, "WorkerJob")
	workerJobProperties := requireMap(t, workerJob, "properties")
	assertRequiredFields(t, workerJob, "id", "workerId")
	if len(workerJobProperties) != 2 {
		t.Fatalf("WorkerJob claim projection must expose only id and workerId, got %v", workerJobProperties)
	}
	jobProjection := requireMap(t, jobClaimProperties, "job")
	if jobProjection["$ref"] != "#/components/schemas/WorkerJob" {
		t.Fatalf("JobClaim must use the minimal WorkerJob projection, got %v", jobProjection["$ref"])
	}
	workerResult := requireMap(t, schemas, "WorkerJobResult")
	workerResultProperties := requireMap(t, workerResult, "properties")
	assertRequiredFields(t, workerResult, "id", "status")
	workerResultStatus := requireMap(t, workerResultProperties, "status")
	if workerResultStatus["$ref"] != "#/components/schemas/TerminalJobStatus" {
		t.Fatal("WorkerJobResult.status must be restricted to terminal job states")
	}
	if len(workerResultProperties) != 2 {
		t.Fatalf("WorkerJobResult must expose only id and status, got %v", workerResultProperties)
	}
	jobLease := requireMap(t, schemas, "JobLease")
	assertRequiredFields(t, jobLease, "claimEpoch", "leaseExpiresAt", "heartbeatAt")
	if _, echoed := requireMap(t, jobLease, "properties")["claimToken"]; echoed {
		t.Error("JobLease must not echo the cleartext claim capability")
	}
}

func assertPublicJobOperationsUsePublicResponses(t *testing.T, spec map[string]any, operations map[string]contractOperation) {
	t.Helper()
	expected := map[string]map[string]string{
		"GET /api/v1/projects/{id}/runs":            {"200": "#/components/responses/PublicRunList"},
		"GET /api/v1/projects/{id}/jobs":            {"200": "#/components/responses/PublicJobList"},
		"POST /api/v1/projects/{id}/jobs":           {"200": "#/components/responses/PublicJobRun", "201": "#/components/responses/PublicJobRun"},
		"GET /api/v1/jobs/{id}":                     {"200": "#/components/responses/PublicJob"},
		"POST /api/v1/jobs/{id}/cancel":             {"200": "#/components/responses/PublicJob"},
		"POST /api/v1/internal/jobs/claim":          {"200": "#/components/responses/JobClaim"},
		"POST /api/v1/internal/jobs/{id}/execute":   {"200": "#/components/responses/WorkerJobResult"},
		"POST /api/v1/internal/jobs/{id}/heartbeat": {"200": "#/components/responses/JobLease"},
	}
	for operationKey, statuses := range expected {
		operation, exists := operations[operationKey]
		if !exists {
			t.Errorf("missing operation %s", operationKey)
			continue
		}
		responses := requireMap(t, operation.body, "responses")
		for status, wanted := range statuses {
			response := requireMap(t, responses, status)
			if response["$ref"] != wanted {
				t.Errorf("%s response %s uses %v, want %s", operationKey, status, response["$ref"], wanted)
			}
		}
	}

	// Resolve every named response once here so a public operation cannot point
	// at a response whose envelope silently wraps a private store object.
	for _, responseName := range []string{"PublicJob", "PublicJobList", "PublicJobRun", "PublicRunList", "WorkerJobResult", "JobClaim", "JobLease"} {
		components := requireMap(t, spec, "components")
		responses := requireMap(t, components, "responses")
		_ = requireMap(t, responses, responseName)
	}
}

func assertJobLeaseOperations(t *testing.T, spec map[string]any, operations map[string]contractOperation) {
	t.Helper()
	for _, key := range []string{
		"POST /api/v1/internal/jobs/{id}/execute",
		"POST /api/v1/internal/jobs/{id}/heartbeat",
	} {
		operation, exists := operations[key]
		if !exists {
			t.Errorf("missing lease-protected operation %s", key)
			continue
		}
		if !hasParameterReference(operation.body, "#/components/parameters/JobClaimToken") {
			t.Errorf("%s must require X-Skyview-Job-Claim", key)
		}
		if operation.body["x-sensitive-request-headers"] == nil {
			t.Errorf("%s must mark the claim header as sensitive", key)
		}
		description, _ := operation.body["description"].(string)
		if !strings.Contains(description, "scope is indistinguishable from an absent job and returns 404") {
			t.Errorf("%s must document fail-closed scope revalidation and 404 non-disclosure", key)
		}
		responses := requireMap(t, operation.body, "responses")
		for _, status := range []string{"400", "401", "409"} {
			if _, exists := responses[status]; !exists {
				t.Errorf("%s must document %s for invalid or lost claim credentials", key, status)
			}
		}
		requestBody := requireMap(t, operation.body, "requestBody")
		if requestBody["required"] != true {
			t.Errorf("%s must require a bounded JSON WorkerRequest body", key)
		}
		content := requireMap(t, requestBody, "content")
		media := requireMap(t, content, "application/json")
		schemaReference := requireMap(t, media, "schema")
		if schemaReference["$ref"] != "#/components/schemas/WorkerRequest" {
			t.Errorf("%s must use the shared WorkerRequest schema", key)
		}
		requestSchema := resolveRequestSchema(t, spec, operation.body)
		if additional, exists := requestSchema["additionalProperties"]; !exists || additional != false {
			t.Errorf("%s WorkerRequest must reject unknown fields", key)
		}
	}
	if _, exists := operations["POST /api/v1/internal/jobs/{id}/complete"]; exists {
		t.Error("external Worker completion route must remain absent; only server-owned execute may finalize results")
	}
	execute := operations["POST /api/v1/internal/jobs/{id}/execute"]
	errorCodes := requireMap(t, execute.body, "x-error-codes")
	conflicts, ok := errorCodes["409"].([]any)
	hasExecutionFenceCode := false
	for _, value := range conflicts {
		if value == "JOB_EXECUTION_ALREADY_STARTED" {
			hasExecutionFenceCode = true
		}
	}
	if !ok || !hasExecutionFenceCode {
		t.Fatal("execute contract must document the execution-fence conflict code")
	}
	unavailableCodes, ok := errorCodes["503"].([]any)
	hasTerminalPersistenceCode := false
	for _, value := range unavailableCodes {
		if value == "JOB_TERMINAL_PERSISTENCE_UNAVAILABLE" {
			hasTerminalPersistenceCode = true
		}
	}
	if !ok || !hasTerminalPersistenceCode {
		t.Fatal("execute contract must distinguish terminal persistence failure from a business conflict")
	}

	components := requireMap(t, spec, "components")
	responses := requireMap(t, components, "responses")
	for _, responseName := range []string{"WorkerJobResult", "JobClaim", "JobLease"} {
		response := requireMap(t, responses, responseName)
		headers := requireMap(t, response, "headers")
		cacheControl := requireMap(t, headers, "Cache-Control")
		schema := requireMap(t, cacheControl, "schema")
		if cacheControl["required"] != true || schema["const"] != "no-store" {
			t.Errorf("%s response must require Cache-Control: no-store", responseName)
		}
	}
}

func TestOpenAPILocalReferencesResolve(t *testing.T) {
	spec := loadOpenAPIContract(t)
	walkContractValue(t, spec, "$", func(path string, object map[string]any) {
		ref, exists := object["$ref"].(string)
		if !exists {
			return
		}
		if !strings.HasPrefix(ref, "#/") {
			t.Errorf("%s uses unsupported non-local reference %q", path, ref)
			return
		}
		var current any = spec
		for _, encodedSegment := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			segment := strings.ReplaceAll(strings.ReplaceAll(encodedSegment, "~1", "/"), "~0", "~")
			object, ok := current.(map[string]any)
			if !ok {
				t.Errorf("%s reference %q traverses a non-object at %q", path, ref, segment)
				return
			}
			current, ok = object[segment]
			if !ok {
				t.Errorf("%s reference %q does not resolve", path, ref)
				return
			}
		}
	})
}

func loadOpenAPIContract(t *testing.T) map[string]any {
	t.Helper()
	path := filepath.Join("..", "..", "api", "openapi.yaml")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	// JSON is a strict subset of YAML. Keeping this source in JSON syntax lets
	// the contract remain OpenAPI/YAML-tool compatible without adding a parser
	// dependency to the production module.
	var spec map[string]any
	if err := json.Unmarshal(content, &spec); err != nil {
		t.Fatalf("parse OpenAPI contract: %v", err)
	}
	if spec["openapi"] != "3.1.0" {
		t.Fatalf("expected OpenAPI 3.1.0, got %v", spec["openapi"])
	}
	return spec
}

func documentedOperations(t *testing.T, spec map[string]any) map[string]contractOperation {
	t.Helper()
	paths := requireMap(t, spec, "paths")
	result := make(map[string]contractOperation)
	for path, rawPathItem := range paths {
		pathItem, ok := rawPathItem.(map[string]any)
		if !ok {
			t.Fatalf("path item %s is not an object", path)
		}
		for method, rawOperation := range pathItem {
			if _, isMethod := openAPIMethods[method]; !isMethod {
				continue
			}
			operation, ok := rawOperation.(map[string]any)
			if !ok {
				t.Fatalf("operation %s %s is not an object", method, path)
			}
			key := strings.ToUpper(method) + " " + path
			result[key] = contractOperation{path: path, method: strings.ToUpper(method), body: operation}
		}
	}
	return result
}

func registeredV1Operations(t *testing.T) map[string]contractOperation {
	t.Helper()
	content, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatalf("read server.go: %v", err)
	}
	source := string(content)
	methodNames := map[string]string{
		"MethodGet": "GET", "MethodPost": "POST", "MethodPut": "PUT",
		"MethodPatch": "PATCH", "MethodDelete": "DELETE",
	}
	result := make(map[string]contractOperation)
	helperPattern := regexp.MustCompile(`handle\(http\.(Method[A-Za-z]+),\s*"([^"]+)"`)
	for _, match := range helperPattern.FindAllStringSubmatch(source, -1) {
		method, known := methodNames[match[1]]
		if !known {
			t.Fatalf("unrecognized route method constant %s", match[1])
		}
		path := "/api/v1" + match[2]
		result[method+" "+path] = contractOperation{path: path, method: method}
	}
	internalPattern := regexp.MustCompile(`service\.mux\.HandleFunc\("([A-Z]+) (/api/v1/internal/[^"]+)"`)
	for _, match := range internalPattern.FindAllStringSubmatch(source, -1) {
		result[match[1]+" "+match[2]] = contractOperation{path: match[2], method: match[1]}
	}
	if len(result) == 0 {
		t.Fatal("no registered /api/v1 operations detected in server.go")
	}
	return result
}

func assertOperationSecurity(t *testing.T, key string, operation contractOperation) {
	t.Helper()
	security, exists := operation.body["security"]
	if !exists {
		t.Errorf("%s must declare security explicitly", key)
		return
	}
	unsafe := operation.method == "POST" || operation.method == "PUT" || operation.method == "PATCH" || operation.method == "DELETE"
	if key == "POST /api/v1/auth/login" {
		if !emptySecurity(security) || operation.body["x-development-only"] != true {
			t.Error("development login must be explicitly public and marked development-only")
		}
		return
	}
	publicOperations := map[string]bool{
		"GET /api/v1/health":          true,
		"GET /api/v1/live":            true,
		"GET /api/v1/ready":           true,
		"GET /api/v1/auth/oidc/start": true,
		"GET /api/v1/tools/catalog":   true,
	}
	if publicOperations[key] {
		if !emptySecurity(security) {
			t.Errorf("public operation %s must explicitly use empty security", key)
		}
		return
	}
	if key == "GET /api/v1/auth/oidc/callback" {
		if !usesSecurityScheme(security, "oidcStateCookie") {
			t.Error("OIDC callback must document its one-time correlation cookie")
		}
		return
	}
	if strings.HasPrefix(operation.path, "/api/v1/internal/") {
		if !usesSecurityScheme(security, "workerBearer") {
			t.Errorf("%s must use workerBearer", key)
		}
		if operation.body["x-origin-required-for-cookie"] != false {
			t.Errorf("%s must explicitly document that cookie Origin enforcement does not apply", key)
		}
		if operation.body["x-worker-identity-source"] != "bearer-credential" {
			t.Errorf("%s must declare the server-controlled worker identity source", key)
		}
		return
	}
	if unsafe {
		if !usesSecurityScheme(security, "sessionCookie") {
			t.Errorf("production write %s must use sessionCookie", key)
		}
		if operation.body["x-origin-required-for-cookie"] != true || !hasParameterReference(operation.body, "#/components/parameters/Origin") {
			t.Errorf("cookie-authenticated write %s must document required Origin", key)
		}
	} else if !usesSecurityScheme(security, "sessionCookie") {
		t.Errorf("authenticated read %s must use sessionCookie", key)
	}
}

func requiredField(schema map[string]any, wanted string) bool {
	raw, ok := schema["required"].([]any)
	if !ok {
		return false
	}
	for _, value := range raw {
		if value == wanted {
			return true
		}
	}
	return false
}

func assertOperationResponseEnvelopes(t *testing.T, spec map[string]any, key string, responses map[string]any) {
	t.Helper()
	for status, rawResponse := range responses {
		response := resolveResponse(t, spec, rawResponse)
		content, hasContent := response["content"].(map[string]any)
		if status == "204" || status == "302" || status == "303" {
			continue
		}
		if !hasContent {
			t.Errorf("%s response %s must document its JSON envelope", key, status)
			continue
		}
		media, ok := content["application/json"].(map[string]any)
		if !ok {
			t.Errorf("%s response %s must use application/json", key, status)
			continue
		}
		schema := requireMap(t, media, "schema")
		ref, _ := schema["$ref"].(string)
		readinessData := status == "503" && (key == "GET /api/v1/ready" || key == "GET /api/v1/health")
		isError := !readinessData && (strings.HasPrefix(status, "4") || strings.HasPrefix(status, "5"))
		if isError && ref != "#/components/schemas/ErrorEnvelope" {
			t.Errorf("%s response %s must use ErrorEnvelope, got %q", key, status, ref)
		}
		if !isError && (ref == "" || !strings.HasSuffix(ref, "Envelope")) {
			t.Errorf("%s response %s must use a typed data envelope, got %q", key, status, ref)
		}
	}
}

func resolveResponse(t *testing.T, spec map[string]any, raw any) map[string]any {
	t.Helper()
	response, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("response is not an object: %T", raw)
	}
	ref, isRef := response["$ref"].(string)
	if !isRef {
		return response
	}
	const prefix = "#/components/responses/"
	if !strings.HasPrefix(ref, prefix) {
		t.Fatalf("unsupported response reference %q", ref)
	}
	components := requireMap(t, spec, "components")
	responses := requireMap(t, components, "responses")
	return requireMap(t, responses, strings.TrimPrefix(ref, prefix))
}

func resolveRequestSchema(t *testing.T, spec map[string]any, operation map[string]any) map[string]any {
	t.Helper()
	requestBody := requireMap(t, operation, "requestBody")
	content := requireMap(t, requestBody, "content")
	media := requireMap(t, content, "application/json")
	schema := requireMap(t, media, "schema")
	ref, _ := schema["$ref"].(string)
	const prefix = "#/components/schemas/"
	if !strings.HasPrefix(ref, prefix) {
		t.Fatalf("unsupported request schema reference %q", ref)
	}
	components := requireMap(t, spec, "components")
	schemas := requireMap(t, components, "schemas")
	return requireMap(t, schemas, strings.TrimPrefix(ref, prefix))
}

func assertFrozenEndpoint(t *testing.T, operations map[string]contractOperation, key string) {
	t.Helper()
	operation, exists := operations[key]
	if !exists {
		t.Fatalf("frozen endpoint %s is missing", key)
	}
	if operation.body["x-execution-policy"] != "always-rejected" {
		t.Errorf("%s must remain visibly marked always-rejected", key)
	}
}

func hasParameterReference(operation map[string]any, wanted string) bool {
	parameters, ok := operation["parameters"].([]any)
	if !ok {
		return false
	}
	for _, raw := range parameters {
		parameter, ok := raw.(map[string]any)
		if ok && parameter["$ref"] == wanted {
			return true
		}
	}
	return false
}

func usesSecurityScheme(raw any, wanted string) bool {
	security, ok := raw.([]any)
	if !ok {
		return false
	}
	for _, item := range security {
		requirement, ok := item.(map[string]any)
		if ok {
			if _, exists := requirement[wanted]; exists {
				return true
			}
		}
	}
	return false
}

func emptySecurity(raw any) bool {
	security, ok := raw.([]any)
	return ok && len(security) == 0
}

func operationSetDiff(left, right map[string]contractOperation) []string {
	result := make([]string, 0)
	for key := range left {
		if _, exists := right[key]; !exists {
			result = append(result, key)
		}
	}
	sort.Strings(result)
	return result
}

func requireMap(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, exists := parent[key]
	if !exists {
		t.Fatalf("missing object %s", key)
	}
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s is %T, expected object", key, value)
	}
	return result
}

func number(t *testing.T, value any) int {
	t.Helper()
	number, ok := value.(float64)
	if !ok {
		t.Fatalf("expected JSON number, got %T", value)
	}
	return int(number)
}

func assertRequiredFields(t *testing.T, schema map[string]any, expected ...string) {
	t.Helper()
	raw, ok := schema["required"].([]any)
	if !ok {
		t.Fatal("schema has no required field list")
	}
	actual := make(map[string]bool, len(raw))
	for _, value := range raw {
		if field, ok := value.(string); ok {
			actual[field] = true
		}
	}
	for _, field := range expected {
		if !actual[field] {
			t.Errorf("required field %s is missing", field)
		}
	}
}

func assertEnum(t *testing.T, schema map[string]any, expected ...string) {
	t.Helper()
	raw, ok := schema["enum"].([]any)
	if !ok {
		t.Fatal("schema has no enum")
	}
	actual := make([]string, 0, len(raw))
	for _, value := range raw {
		actual = append(actual, fmt.Sprint(value))
	}
	sort.Strings(actual)
	wanted := append([]string(nil), expected...)
	sort.Strings(wanted)
	if strings.Join(actual, "\x00") != strings.Join(wanted, "\x00") {
		t.Errorf("enum mismatch: got %v want %v", actual, wanted)
	}
}

func assertCanceledStatusMatchesImplementation(t *testing.T, jobStatus map[string]any) {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("..", "store", "job_store.go"))
	if err != nil {
		t.Fatalf("read job_store.go: %v", err)
	}
	match := regexp.MustCompile(`UPDATE jobs SET status = '([^']+)'`).FindStringSubmatch(string(content))
	if len(match) != 2 {
		t.Fatal("could not derive the persisted cancellation status from job_store.go")
	}
	values, ok := jobStatus["enum"].([]any)
	if !ok {
		t.Fatal("JobStatus has no enum")
	}
	for _, value := range values {
		if value == match[1] {
			return
		}
	}
	t.Errorf("JobStatus enum does not contain implementation cancellation value %q", match[1])
}

func walkContractValue(t *testing.T, value any, path string, visit func(string, map[string]any)) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		visit(path, typed)
		for key, child := range typed {
			walkContractValue(t, child, path+"/"+key, visit)
		}
	case []any:
		for index, child := range typed {
			walkContractValue(t, child, fmt.Sprintf("%s/%d", path, index), visit)
		}
	}
}
