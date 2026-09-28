package worker

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	testTokenA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testTokenB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func scopedCredential(id, token string) Credential {
	return Credential{ID: id, Token: token, Scopes: []Scope{{
		TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"audit"},
	}}}
}

func TestAuthenticatorBindsTokenToWorkerIdentity(t *testing.T) {
	authenticator, err := New([]Credential{scopedCredential("worker-a", testTokenA), scopedCredential("worker-b", testTokenB)})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		header []string
		wantID string
		ok     bool
	}{
		{name: "worker a", header: []string{"Bearer " + testTokenA}, wantID: "worker-a", ok: true},
		{name: "case insensitive scheme", header: []string{"bearer " + testTokenB}, wantID: "worker-b", ok: true},
		{name: "unknown token", header: []string{"Bearer " + strings.Repeat("c", 32)}},
		{name: "duplicate header", header: []string{"Bearer " + testTokenA, "Bearer " + testTokenB}},
		{name: "token whitespace", header: []string{"Bearer " + testTokenA + " "}},
		{name: "wrong scheme", header: []string{"Basic " + testTokenA}},
	} {
		t.Run(test.name, func(t *testing.T) {
			identity, ok := authenticator.AuthenticateAuthorization(test.header)
			if identity.WorkerID != test.wantID || ok != test.ok {
				t.Fatalf("AuthenticateAuthorization() = %+v, %v; want %q, %v", identity, ok, test.wantID, test.ok)
			}
		})
	}
	identity, ok := authenticator.AuthenticateAuthorization([]string{"Bearer " + testTokenA})
	if !ok {
		t.Fatal("expected valid identity")
	}
	identity.Scopes[0].Actions[0] = "forged"
	again, ok := authenticator.AuthenticateAuthorization([]string{"Bearer " + testTokenA})
	if !ok || again.Scopes[0].Actions[0] != "audit" {
		t.Fatalf("returned identity mutated authenticator policy: %+v", again)
	}
}

func TestIdentityAllowsOnlyCompleteExactCapability(t *testing.T) {
	identity := Identity{WorkerID: "worker-a", Scopes: []Scope{
		{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"audit", "outline"}},
		{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "research-radar", Actions: []string{"search"}},
	}}
	if !identity.Allows("tenant-a", "workspace-a", "paper-writing", "audit") ||
		!identity.Allows("tenant-a", "workspace-a", "research-radar", "search") {
		t.Fatal("exact capability was denied")
	}
	for _, candidate := range [][4]string{
		{"tenant-b", "workspace-a", "paper-writing", "audit"},
		{"tenant-a", "workspace-b", "paper-writing", "audit"},
		{"tenant-a", "workspace-a", "research-radar", "audit"},
		{"tenant-a", "workspace-a", "paper-writing", "search"},
	} {
		if identity.Allows(candidate[0], candidate[1], candidate[2], candidate[3]) {
			t.Fatalf("cross-boundary capability was allowed: %v", candidate)
		}
	}
}

func TestLoadFileRejectsUnsafeUnixPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows credential ACL validation is a deployment responsibility")
	}
	path := writeCredentialFile(t, credentialDocument(testTokenA))
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFile(path); err == nil || !strings.Contains(err.Error(), "group or others") {
		t.Fatalf("expected unsafe permission rejection, got %v", err)
	}
}

func TestCredentialsRejectAmbiguousOrWeakValues(t *testing.T) {
	withScopes := func(scopes ...Scope) Credential {
		return Credential{ID: "worker-a", Token: testTokenA, Scopes: scopes}
	}
	for _, test := range []struct {
		name        string
		credentials []Credential
	}{
		{name: "invalid id", credentials: []Credential{{ID: " worker-a", Token: testTokenA}}},
		{name: "weak token", credentials: []Credential{{ID: "worker-a", Token: "short"}}},
		{name: "token whitespace", credentials: []Credential{{ID: "worker-a", Token: testTokenA + " "}}},
		{name: "token internal space", credentials: []Credential{{ID: "worker-a", Token: testTokenA[:16] + " " + testTokenA[16:]}}},
		{name: "token non ascii", credentials: []Credential{{ID: "worker-a", Token: testTokenA + "密"}}},
		{name: "duplicate id", credentials: []Credential{scopedCredential("worker-a", testTokenA), scopedCredential("worker-a", testTokenB)}},
		{name: "duplicate token", credentials: []Credential{scopedCredential("worker-a", testTokenA), scopedCredential("worker-b", testTokenA)}},
		{name: "empty scopes", credentials: []Credential{{ID: "worker-a", Token: testTokenA}}},
		{name: "wildcard tenant", credentials: []Credential{withScopes(Scope{TenantID: "*", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"audit"}})}},
		{name: "wildcard workspace", credentials: []Credential{withScopes(Scope{TenantID: "tenant-a", WorkspaceID: "*", Slug: "paper-writing", Actions: []string{"audit"}})}},
		{name: "wildcard slug", credentials: []Credential{withScopes(Scope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "*", Actions: []string{"audit"}})}},
		{name: "wildcard action", credentials: []Credential{withScopes(Scope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"*"}})}},
		{name: "empty actions", credentials: []Credential{withScopes(Scope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing"})}},
		{name: "duplicate actions", credentials: []Credential{withScopes(Scope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"audit", "audit"}})}},
		{name: "duplicate scope", credentials: []Credential{withScopes(
			Scope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"audit"}},
			Scope{TenantID: "tenant-a", WorkspaceID: "workspace-a", Slug: "paper-writing", Actions: []string{"outline"}},
		)},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.credentials); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestLoadFileIsStrictAndBounded(t *testing.T) {
	valid := credentialDocument(testTokenA)
	path := writeCredentialFile(t, valid)
	credentials, err := LoadFile(path)
	if err != nil || len(credentials) != 1 || credentials[0].ID != "worker-a" {
		t.Fatalf("LoadFile(valid) = %#v, %v", credentials, err)
	}

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "unknown root field", body: `{"version":1,"workers":[],"extra":true}`},
		{name: "unknown worker field", body: `{"version":1,"workers":[{"id":"worker-a","token":"` + testTokenA + `","scopes":[{"tenantId":"tenant-a","workspaceId":"workspace-a","slug":"paper-writing","actions":["audit"]}],"role":"admin"}]}`},
		{name: "trailing JSON", body: valid + `{}`},
		{name: "unsupported version", body: strings.Replace(credentialDocument(testTokenA), `"version":1`, `"version":2`, 1)},
		{name: "empty workers", body: `{"version":1,"workers":[]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := LoadFile(writeCredentialFile(t, test.body)); err == nil {
				t.Fatal("expected strict file validation error")
			}
		})
	}

	oversized := writeCredentialFile(t, strings.Repeat("x", MaxCredentialFileBytes+1))
	if _, err := LoadFile(oversized); err == nil {
		t.Fatal("expected oversized file error")
	}
}

func credentialDocument(token string) string {
	return `{"version":1,"workers":[{"id":"worker-a","token":"` + token + `","scopes":[{"tenantId":"tenant-a","workspaceId":"workspace-a","slug":"paper-writing","actions":["audit"]}]}]}`
}

func writeCredentialFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "workers.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
