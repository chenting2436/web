package openfga

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"skyviewlab/backend_go/internal/authorization"
)

const (
	testStoreID = "01H0H015178Y2V4CX10C2KGHF4"
	testModelID = "01H0H015178Y2V4CX10C2KGHF5"
)

func testCheck() authorization.Check {
	return authorization.Check{
		Principal: authorization.Principal{UserID: "user-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", Role: "student"},
		Relation:  authorization.RelationView,
		Resource: authorization.Resource{
			Type: authorization.ResourceProject, ID: "project-1", TenantID: "tenant-1", WorkspaceID: "workspace-1", OwnerUserID: "user-1",
		},
		RequestID: "request-1",
	}
}

func TestCheckCallsOpenFGAHTTPAPIWithServerContext(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/stores/"+testStoreID+"/check" {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer secret-token" || request.Header.Get("X-Request-ID") != "request-1" {
			t.Fatal("missing service authentication or request correlation header")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		tuple := body["tuple_key"].(map[string]any)
		if tuple["user"] != "user:user-1" || tuple["relation"] != "can_view" || tuple["object"] != "project:project-1" {
			t.Fatalf("unexpected tuple: %#v", tuple)
		}
		if body["authorization_model_id"] != testModelID || body["consistency"] != "HIGHER_CONSISTENCY" {
			t.Fatalf("model pin or consistency missing: %#v", body)
		}
		contextValue := body["context"].(map[string]any)
		if contextValue["tenant_id"] != "tenant-1" || contextValue["workspace_id"] != "workspace-1" {
			t.Fatalf("server context missing: %#v", contextValue)
		}
		_, _ = response.Write([]byte(`{"allowed":true}`))
	}))
	defer server.Close()
	client, err := New(Config{
		APIURL: server.URL, StoreID: testStoreID, AuthorizationModelID: testModelID,
		APIToken: "secret-token", AllowInsecureHTTP: true,
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := client.Check(context.Background(), testCheck())
	if err != nil || !allowed {
		t.Fatalf("expected allow, got allowed=%v err=%v", allowed, err)
	}
}

func TestCheckFailsClosedOnDenyProtocolErrorAndTimeout(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		wantErr bool
	}{
		{name: "deny", handler: func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte(`{"allowed":false}`))
		}},
		{name: "upstream error", wantErr: true, handler: func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusServiceUnavailable)
		}},
		{name: "missing decision", wantErr: true, handler: func(response http.ResponseWriter, _ *http.Request) { _, _ = response.Write([]byte(`{}`)) }},
		{name: "trailing JSON", wantErr: true, handler: func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte(`{"allowed":true}{}`))
		}},
		{name: "oversized response", wantErr: true, handler: func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write([]byte(`{"allowed":true}` + strings.Repeat(" ", maxResponseBody)))
		}},
		{name: "timeout", wantErr: true, handler: func(response http.ResponseWriter, _ *http.Request) {
			time.Sleep(100 * time.Millisecond)
			response.WriteHeader(http.StatusGatewayTimeout)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(test.handler)
			defer server.Close()
			client, err := New(Config{
				APIURL: server.URL, StoreID: testStoreID, AuthorizationModelID: testModelID,
				AllowInsecureHTTP: true, Timeout: 20 * time.Millisecond,
			}, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			allowed, checkErr := client.Check(context.Background(), testCheck())
			if allowed || test.wantErr != (checkErr != nil) {
				t.Fatalf("fail-closed mismatch: allowed=%v err=%v", allowed, checkErr)
			}
		})
	}
}

func TestReadyChecksPinnedAuthorizationModel(t *testing.T) {
	model := testAuthorizationModel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/stores/"+testStoreID+"/authorization-models/"+testModelID {
			t.Fatalf("unexpected readiness path %s", request.URL.Path)
		}
		_ = json.NewEncoder(response).Encode(map[string]any{"authorization_model": model})
	}))
	defer server.Close()
	client, err := New(Config{APIURL: server.URL, StoreID: testStoreID, AuthorizationModelID: testModelID, AllowInsecureHTTP: true}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestReadyRejectsModelContractMismatch(t *testing.T) {
	model := testAuthorizationModel()
	definitions := model["type_definitions"].([]map[string]any)
	for _, definition := range definitions {
		if definition["type"] == "job" {
			delete(definition["relations"].(map[string]any), "can_cancel")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{"authorization_model": model})
	}))
	defer server.Close()
	client, err := New(Config{APIURL: server.URL, StoreID: testStoreID, AuthorizationModelID: testModelID, AllowInsecureHTTP: true}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "can_cancel") {
		t.Fatalf("expected model contract failure, got %v", err)
	}
}

func TestReadyRejectsPinnedModelHashMismatch(t *testing.T) {
	model := testAuthorizationModel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{"authorization_model": model})
	}))
	defer server.Close()
	client, err := New(Config{
		APIURL: server.URL, StoreID: testStoreID, AuthorizationModelID: testModelID,
		ExpectedModelSHA256: strings.Repeat("0", 64), AllowInsecureHTTP: true,
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "hash") {
		t.Fatalf("expected pinned model hash failure, got %v", err)
	}
}

func TestCodeRelationsMatchInfrastructureModel(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "openfga", "authorization-model.fga")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	for resourceType, relations := range requiredModelRelations {
		if !strings.Contains(text, "type "+resourceType) {
			t.Fatalf("infrastructure model missing type %q", resourceType)
		}
		for _, relation := range relations {
			if !strings.Contains(text, "define "+relation+":") {
				t.Fatalf("infrastructure model missing relation %q required by %q", relation, resourceType)
			}
		}
	}
	projectStart := strings.Index(text, "type project")
	if projectStart < 0 {
		t.Fatal("cannot isolate project model contract")
	}
	projectEnd := strings.Index(text[projectStart:], "type artifact")
	if projectEnd < 0 {
		t.Fatal("cannot isolate project model contract")
	}
	projectBlock := text[projectStart : projectStart+projectEnd]
	if strings.Contains(projectBlock, "viewer from workspace") || !strings.Contains(projectBlock, "define viewer: [user] or editor") {
		t.Fatal("project viewer must not inherit broad workspace membership")
	}
	jobStart := strings.Index(text, "type job")
	if jobStart < 0 {
		t.Fatal("cannot isolate job model contract")
	}
	jobEnd := strings.Index(text[jobStart:], "type course")
	if jobEnd < 0 || !strings.Contains(text[jobStart:jobStart+jobEnd], "define can_cancel: submitter or admin from project") {
		t.Fatal("job cancellation must match the store's submitter-or-tenant-admin boundary")
	}
}

func TestConfigRequiresTLSAndRealOpenFGAIDs(t *testing.T) {
	_, err := New(Config{APIURL: "http://openfga:8080", StoreID: "store", AuthorizationModelID: "model"}, nil)
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("expected TLS gate, got %v", err)
	}
	_, err = New(Config{APIURL: "https://openfga.example", StoreID: "store", AuthorizationModelID: testModelID}, nil)
	if err == nil || !strings.Contains(err.Error(), "store id") {
		t.Fatalf("expected store id gate, got %v", err)
	}
}

func TestRedirectDoesNotForwardOpenFGACredentialsOrBody(t *testing.T) {
	var targetRequests atomic.Int32
	var targetAuthorization atomic.Bool
	var targetBody atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		targetRequests.Add(1)
		if request.Header.Get("Authorization") != "" || request.Header.Get("X-Request-ID") != "" {
			targetAuthorization.Store(true)
		}
		body, _ := io.ReadAll(request.Body)
		if len(body) > 0 {
			targetBody.Store(true)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	source := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", target.URL+"/stolen")
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	permissiveClient := source.Client()
	permissiveClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return nil }
	client, err := New(Config{
		APIURL: source.URL, StoreID: testStoreID, AuthorizationModelID: testModelID,
		APIToken: "openfga-sensitive-token", AllowInsecureHTTP: true,
	}, permissiveClient)
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := client.Check(context.Background(), testCheck())
	if err == nil || allowed || !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("redirect must fail closed at the original response, allowed=%v err=%v", allowed, err)
	}
	if targetRequests.Load() != 0 || targetAuthorization.Load() || targetBody.Load() {
		t.Fatalf("redirect target received request=%d credentials=%v body=%v", targetRequests.Load(), targetAuthorization.Load(), targetBody.Load())
	}
}

func testAuthorizationModel() map[string]any {
	definitions := make([]map[string]any, 0, len(requiredModelRelations)+1)
	definitions = append(definitions, map[string]any{"type": "user", "relations": map[string]any{}})
	for resourceType, relationNames := range requiredModelRelations {
		relations := make(map[string]any, len(relationNames))
		for _, relation := range relationNames {
			relations[relation] = map[string]any{}
		}
		definitions = append(definitions, map[string]any{"type": resourceType, "relations": relations})
	}
	return map[string]any{"id": testModelID, "schema_version": "1.1", "type_definitions": definitions}
}
