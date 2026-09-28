package oidc

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeProvider struct {
	t                 *testing.T
	server            *httptest.Server
	key               *rsa.PrivateKey
	signingKey        *rsa.PrivateKey
	now               time.Time
	clientID          string
	clientSecret      string
	expectedNonce     string
	expectedChallenge string
	mutateClaims      func(map[string]any)
	mutateHeader      func(map[string]any)
	metadataIssuer    string
	metadataPadding   int
	tokenRequests     int
	mu                sync.Mutex
}

func newFakeProvider(t *testing.T) *fakeProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	provider := &fakeProvider{
		t: t, key: key, signingKey: key, now: time.Unix(1_788_796_800, 0).UTC(),
		clientID: "skyviewlab-web", clientSecret: "client-secret-value",
	}
	provider.server = httptest.NewTLSServer(http.HandlerFunc(provider.serveHTTP))
	t.Cleanup(provider.server.Close)
	return provider
}

func (provider *fakeProvider) client(t *testing.T) *Client {
	t.Helper()
	client, err := New(Config{
		IssuerURL: provider.server.URL, ClientID: provider.clientID,
		ClientSecret: provider.clientSecret,
		RedirectURL:  provider.server.URL + "/callback",
		HTTPClient:   provider.server.Client(), Clock: func() time.Time { return provider.now },
		TransactionStore: NewMemoryTransactionStore(DefaultTransactionCapacity),
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func (provider *fakeProvider) begin(t *testing.T, client *Client) Authorization {
	t.Helper()
	authorization, err := client.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(authorization.URL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	provider.expectedNonce = query.Get("nonce")
	provider.expectedChallenge = query.Get("code_challenge")
	if parsed.Path != "/authorize" || query.Get("client_id") != provider.clientID || query.Get("redirect_uri") != provider.server.URL+"/callback" || query.Get("response_type") != "code" || query.Get("scope") != "openid profile email" {
		t.Fatalf("invalid authorization request: %s", authorization.URL)
	}
	if query.Get("state") != authorization.State || len(provider.expectedNonce) < 43 || query.Get("code_challenge_method") != "S256" || len(provider.expectedChallenge) != 43 {
		t.Fatalf("missing state, nonce, or PKCE S256: %s", authorization.URL)
	}
	return authorization
}

func (provider *fakeProvider) serveHTTP(response http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/.well-known/openid-configuration":
		issuer := provider.server.URL
		if provider.metadataIssuer != "" {
			issuer = provider.metadataIssuer
		}
		writeTestJSON(response, map[string]any{
			"issuer": issuer, "authorization_endpoint": provider.server.URL + "/authorize",
			"token_endpoint": provider.server.URL + "/token", "jwks_uri": provider.server.URL + "/jwks",
			"code_challenge_methods_supported":      []string{"S256"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
		if provider.metadataPadding > 0 {
			_, _ = response.Write([]byte(strings.Repeat(" ", provider.metadataPadding)))
		}
	case "/jwks":
		writeTestJSON(response, map[string]any{"keys": []any{rsaJWK("key-1", &provider.key.PublicKey)}})
	case "/token":
		provider.serveToken(response, request)
	default:
		http.NotFound(response, request)
	}
}

func (provider *fakeProvider) serveToken(response http.ResponseWriter, request *http.Request) {
	provider.mu.Lock()
	provider.tokenRequests++
	provider.mu.Unlock()
	if request.Method != http.MethodPost {
		http.Error(response, "method", http.StatusMethodNotAllowed)
		return
	}
	account, password, ok := request.BasicAuth()
	if !ok || account != provider.clientID || password != provider.clientSecret {
		http.Error(response, "client authentication", http.StatusUnauthorized)
		return
	}
	if err := request.ParseForm(); err != nil {
		http.Error(response, "form", http.StatusBadRequest)
		return
	}
	verifier := request.Form.Get("code_verifier")
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	if request.Form.Get("grant_type") != "authorization_code" || request.Form.Get("code") == "" || request.Form.Get("client_id") != provider.clientID || request.Form.Get("redirect_uri") != provider.server.URL+"/callback" || challenge != provider.expectedChallenge {
		http.Error(response, "invalid grant or PKCE verifier", http.StatusBadRequest)
		return
	}
	accessToken := "signed-access-token"
	accessDigest := sha256.Sum256([]byte(accessToken))
	claims := map[string]any{
		"iss": provider.server.URL, "sub": "keycloak-subject-42", "aud": provider.clientID,
		"nonce": provider.expectedNonce, "exp": provider.now.Add(5 * time.Minute).Unix(), "iat": provider.now.Unix(),
		"email": "alice@example.test", "email_verified": true, "name": "Alice",
		"tenant_id": "tenant-a", "workspace_id": "workspace-a",
		"at_hash": base64.RawURLEncoding.EncodeToString(accessDigest[:len(accessDigest)/2]),
	}
	if provider.mutateClaims != nil {
		provider.mutateClaims(claims)
	}
	header := map[string]any{"alg": "RS256", "kid": "key-1", "typ": "JWT"}
	if provider.mutateHeader != nil {
		provider.mutateHeader(header)
	}
	idToken := signJWT(provider.t, provider.signingKey, header, claims)
	writeTestJSON(response, map[string]any{"access_token": accessToken, "token_type": "Bearer", "id_token": idToken})
}

func TestAuthorizationCodePKCEAndVerifiedIDToken(t *testing.T) {
	provider := newFakeProvider(t)
	client := provider.client(t)
	if err := client.Ready(t.Context()); err != nil {
		t.Fatalf("provider readiness failed: %v", err)
	}
	authorization := provider.begin(t, client)
	principal, err := client.Exchange(t.Context(), authorization.State, "authorization-code")
	if err != nil {
		t.Fatal(err)
	}
	if principal.Issuer != provider.server.URL || principal.Subject != "keycloak-subject-42" || principal.Email != "alice@example.test" || principal.DisplayName != "Alice" || principal.TenantID != "tenant-a" || principal.WorkspaceID != "workspace-a" {
		t.Fatalf("unexpected principal: %+v", principal)
	}
	if provider.tokenRequests != 1 {
		t.Fatalf("expected one token exchange, got %d", provider.tokenRequests)
	}
}

func TestStateIsOneTimeAndExpires(t *testing.T) {
	provider := newFakeProvider(t)
	client := provider.client(t)
	authorization := provider.begin(t, client)
	if _, err := client.Exchange(t.Context(), authorization.State, "authorization-code"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Exchange(t.Context(), authorization.State, "authorization-code"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("replayed state must fail, got %v", err)
	}
	if provider.tokenRequests != 1 {
		t.Fatalf("replay reached token endpoint: %d requests", provider.tokenRequests)
	}

	second := provider.begin(t, client)
	provider.now = provider.now.Add(6 * time.Minute)
	if _, err := client.Exchange(t.Context(), second.State, "authorization-code"); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("expired state must fail, got %v", err)
	}
}

func TestIDTokenValidationFailsClosed(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeProvider)
	}{
		{"nonce", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["nonce"] = "wrong" }
		}},
		{"issuer", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["iss"] = "https://attacker.invalid" }
		}},
		{"audience", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["aud"] = "other-client" }
		}},
		{"multiple audiences", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) {
				claims["aud"] = []string{provider.clientID, "other-api"}
				claims["azp"] = provider.clientID
			}
		}},
		{"authorized party", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["azp"] = "other-client" }
		}},
		{"expired", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) {
				claims["iat"] = provider.now.Add(-10 * time.Minute).Unix()
				claims["exp"] = provider.now.Add(-2 * time.Minute).Unix()
			}
		}},
		{"future issued at", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) {
				claims["iat"] = provider.now.Add(2 * time.Minute).Unix()
				claims["exp"] = provider.now.Add(5 * time.Minute).Unix()
			}
		}},
		{"excessive token lifetime", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) {
				claims["iat"] = provider.now.Add(-2 * time.Hour).Unix()
				claims["exp"] = provider.now.Add(5 * time.Minute).Unix()
			}
		}},
		{"future not before", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["nbf"] = provider.now.Add(2 * time.Minute).Unix() }
		}},
		{"unverified email", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["email_verified"] = false }
		}},
		{"missing tenant", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { delete(claims, "tenant_id") }
		}},
		{"malformed workspace", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["workspace_id"] = "../ workspace" }
		}},
		{"access token hash", func(provider *fakeProvider) {
			provider.mutateClaims = func(claims map[string]any) { claims["at_hash"] = "wrong" }
		}},
		{"untrusted signature", func(provider *fakeProvider) {
			otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			provider.signingKey = otherKey
		}},
		{"unsigned algorithm", func(provider *fakeProvider) {
			provider.mutateHeader = func(header map[string]any) { header["alg"] = "none" }
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			provider := newFakeProvider(t)
			test.mutate(provider)
			client := provider.client(t)
			authorization := provider.begin(t, client)
			if _, err := client.Exchange(t.Context(), authorization.State, "authorization-code"); !errors.Is(err, ErrInvalidToken) {
				t.Fatalf("token must fail closed, got %v", err)
			}
		})
	}
}

func TestDiscoveryAndConfigurationFailClosed(t *testing.T) {
	if _, err := New(Config{IssuerURL: "http://idp.example.test", ClientID: "client", RedirectURL: "https://app.example.test/callback"}); err == nil {
		t.Fatal("insecure issuer must be rejected")
	}
	provider := newFakeProvider(t)
	if _, err := New(Config{
		IssuerURL: provider.server.URL, ClientID: provider.clientID,
		RedirectURL: provider.server.URL + "/callback", HTTPClient: provider.server.Client(),
		MaxTokenLifetime: 25 * time.Hour,
	}); err == nil {
		t.Fatal("configured maximum token lifetime must be capped")
	}
	if _, err := New(Config{
		IssuerURL: provider.server.URL, ClientID: provider.clientID,
		RedirectURL: provider.server.URL + "/callback", HTTPClient: provider.server.Client(),
	}); err == nil || !strings.Contains(err.Error(), "transaction store is required") {
		t.Fatalf("a transaction store must be explicit, got %v", err)
	}
	provider.metadataIssuer = "https://different-issuer.invalid"
	if err := provider.client(t).Ready(t.Context()); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("discovery issuer mismatch must fail readiness, got %v", err)
	}
	oversized := newFakeProvider(t)
	oversized.metadataPadding = maxProviderResponse + 1
	if err := oversized.client(t).Ready(t.Context()); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("oversized discovery response must fail readiness, got %v", err)
	}
}

func rsaJWK(keyID string, key *rsa.PublicKey) map[string]any {
	exponent := big.NewInt(int64(key.E)).Bytes()
	return map[string]any{
		"kty": "RSA", "use": "sig", "key_ops": []string{"verify"}, "alg": "RS256", "kid": keyID,
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(exponent),
	}
}

func signJWT(t *testing.T, key *rsa.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	headerJSON, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signed := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signed))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signed + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func writeTestJSON(response http.ResponseWriter, value any) {
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(value); err != nil {
		panic(fmt.Sprintf("encode test response: %v", err))
	}
}

func formValue(rawURL, key string) string {
	parsed, _ := url.Parse(rawURL)
	return strings.TrimSpace(parsed.Query().Get(key))
}
