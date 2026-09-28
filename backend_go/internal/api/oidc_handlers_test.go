package api

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type apiFakeOIDCProvider struct {
	t                 *testing.T
	server            *httptest.Server
	key               *rsa.PrivateKey
	clientID          string
	clientSecret      string
	redirectURL       string
	email             string
	expectedNonce     string
	expectedChallenge string
	tokenRequests     int
}

func newAPIFakeOIDCProvider(t *testing.T) *apiFakeOIDCProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	provider := &apiFakeOIDCProvider{t: t, key: key, clientID: "skyviewlab-bff", clientSecret: "oidc-client-secret", email: "student@skyviewlab.local"}
	provider.server = httptest.NewServer(http.HandlerFunc(provider.serveHTTP))
	t.Cleanup(provider.server.Close)
	provider.redirectURL = "http://app.example.test/api/v1/auth/oidc/callback"
	return provider
}

func (provider *apiFakeOIDCProvider) serveHTTP(response http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/.well-known/openid-configuration":
		writeOIDCTestJSON(response, map[string]any{
			"issuer": provider.server.URL, "authorization_endpoint": provider.server.URL + "/authorize",
			"token_endpoint": provider.server.URL + "/token", "jwks_uri": provider.server.URL + "/jwks",
			"code_challenge_methods_supported":      []string{"S256"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	case "/jwks":
		writeOIDCTestJSON(response, map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "use": "sig", "key_ops": []string{"verify"}, "alg": "RS256", "kid": "api-key",
			"n": base64.RawURLEncoding.EncodeToString(provider.key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(provider.key.E)).Bytes()),
		}}})
	case "/token":
		provider.tokenRequests++
		account, password, ok := request.BasicAuth()
		if !ok || account != provider.clientID || password != provider.clientSecret || request.ParseForm() != nil {
			http.Error(response, "invalid client", http.StatusUnauthorized)
			return
		}
		verifierDigest := sha256.Sum256([]byte(request.Form.Get("code_verifier")))
		if request.Form.Get("code") == "" || request.Form.Get("redirect_uri") != provider.redirectURL || base64.RawURLEncoding.EncodeToString(verifierDigest[:]) != provider.expectedChallenge {
			http.Error(response, "invalid code or verifier", http.StatusBadRequest)
			return
		}
		now := time.Now().UTC()
		claims := map[string]any{
			"iss": provider.server.URL, "sub": "student-subject", "aud": provider.clientID,
			"nonce": provider.expectedNonce, "iat": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(),
			"email": provider.email, "email_verified": true, "name": "Untrusted Token Name",
			"tenant_id": "tenant-a", "workspace_id": "workspace-a",
			"realm_access": map[string]any{"roles": []string{"platform-admin"}},
		}
		writeOIDCTestJSON(response, map[string]any{"access_token": "access-token", "token_type": "Bearer", "id_token": signAPIJWT(provider.t, provider.key, claims)})
	default:
		http.NotFound(response, request)
	}
}

func TestOIDCCallbackIssuesSessionFromVerifiedIdentityAndLocalRole(t *testing.T) {
	provider := newAPIFakeOIDCProvider(t)
	config := testConfig()
	config.OIDCIssuerURL = provider.server.URL
	config.OIDCClientID = provider.clientID
	config.OIDCClientSecret = provider.clientSecret
	config.OIDCRedirectURL = provider.redirectURL
	config.OIDCWebReturnURL = "http://localhost:4182/auth/complete"
	config.OIDCAllowInsecureHTTP = true
	config.OIDCTransactionKey = bytes.Repeat([]byte{0x5c}, 32)
	handler := newTestHandler(t, config)

	// Provision the local membership. The signed token deliberately asserts an
	// administrator realm role, but the resulting session must remain student.
	_ = login(t, handler, config.StudentAccount, config.StudentPassword)
	start := perform(handler, http.MethodGet, "/api/v1/auth/oidc/start?return_to=https://attacker.invalid", "", nil)
	if start.Code != http.StatusFound {
		t.Fatalf("OIDC start failed: %d %s", start.Code, start.Body.String())
	}
	authorizationURL, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	provider.expectedNonce = authorizationURL.Query().Get("nonce")
	provider.expectedChallenge = authorizationURL.Query().Get("code_challenge")
	state := authorizationURL.Query().Get("state")
	stateCookie := findResponseCookie(t, start, oidcStateCookie)
	callback := perform(handler, http.MethodGet, "/api/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=valid-code&return_to=https://attacker.invalid", "", stateCookie)
	if callback.Code != http.StatusSeeOther || callback.Header().Get("Location") != config.OIDCWebReturnURL {
		t.Fatalf("OIDC callback must use fixed return URL: %d %s %s", callback.Code, callback.Header().Get("Location"), callback.Body.String())
	}
	authenticatedCookie := findResponseCookie(t, callback, sessionCookie)
	me := perform(handler, http.MethodGet, "/api/v1/auth/me", "", authenticatedCookie)
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"role":"student"`) || !strings.Contains(me.Body.String(), `"displayName":"虚拟学生"`) {
		t.Fatalf("OIDC session did not use local membership: %d %s", me.Code, me.Body.String())
	}
	replay := perform(handler, http.MethodGet, "/api/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=replayed", "", stateCookie)
	if replay.Code != http.StatusUnauthorized || errorCode(t, replay) != "OIDC_TOKEN_INVALID" || provider.tokenRequests != 1 {
		t.Fatalf("OIDC state replay was not blocked: %d %s requests=%d", replay.Code, replay.Body.String(), provider.tokenRequests)
	}
}

func TestOIDCCallbackRequiresBrowserCorrelationCookie(t *testing.T) {
	provider := newAPIFakeOIDCProvider(t)
	config := testConfig()
	config.OIDCIssuerURL, config.OIDCClientID, config.OIDCClientSecret = provider.server.URL, provider.clientID, provider.clientSecret
	config.OIDCRedirectURL, config.OIDCWebReturnURL, config.OIDCAllowInsecureHTTP = provider.redirectURL, "http://localhost:4182/auth/complete", true
	handler := newTestHandler(t, config)
	start := perform(handler, http.MethodGet, "/api/v1/auth/oidc/start", "", nil)
	parsed, _ := url.Parse(start.Header().Get("Location"))
	state := parsed.Query().Get("state")
	callback := perform(handler, http.MethodGet, "/api/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=stolen", "", nil)
	if callback.Code != http.StatusUnauthorized || errorCode(t, callback) != "OIDC_STATE_INVALID" || provider.tokenRequests != 0 {
		t.Fatalf("callback without correlation cookie must fail before exchange: %d %s", callback.Code, callback.Body.String())
	}
}

func TestProductionConfigurationRequiresOIDCAndConfidentialClient(t *testing.T) {
	base := Config{AllowedOrigins: []string{"https://app.example.test"}, DatabaseAdapter: "postgresql", DatabaseDSN: "postgres://service@db.example.test/skyview?sslmode=verify-full", CookieSecure: true}
	if _, err := NewHandlerChecked(base); err == nil || !strings.Contains(err.Error(), "production requires OIDC") {
		t.Fatalf("production must require OIDC before opening the database, got %v", err)
	}
	base.OIDCIssuerURL = "https://identity.example.test/realms/skyviewlab"
	base.OIDCClientID = "skyviewlab-bff"
	base.OIDCRedirectURL = "https://app.example.test/api/v1/auth/oidc/callback"
	base.OIDCWebReturnURL = "https://app.example.test/auth/complete"
	if _, err := NewHandlerChecked(base); err == nil || !strings.Contains(err.Error(), "confidential client secret") {
		t.Fatalf("production must require confidential client authentication, got %v", err)
	}
	base.OIDCClientSecret = "production-confidential-client-secret"
	base.OIDCTenantClaim = "tenant_id"
	base.OIDCWorkspaceClaim = "workspace_id"
	if _, err := NewHandlerChecked(base); err == nil || !strings.Contains(err.Error(), "transaction encryption key") {
		t.Fatalf("production must require a shared OIDC transaction encryption key, got %v", err)
	}
}

func TestOIDCTransactionKeyMustBeExactly32Bytes(t *testing.T) {
	provider := newAPIFakeOIDCProvider(t)
	config := testConfig()
	config.OIDCIssuerURL, config.OIDCClientID, config.OIDCClientSecret = provider.server.URL, provider.clientID, provider.clientSecret
	config.OIDCRedirectURL, config.OIDCWebReturnURL, config.OIDCAllowInsecureHTTP = provider.redirectURL, "http://localhost:4182/auth/complete", true
	config.OIDCTransactionKey = bytes.Repeat([]byte{0x11}, 31)
	if _, err := NewHandlerChecked(config); err == nil || !strings.Contains(err.Error(), "exactly 32 bytes") {
		t.Fatalf("invalid development transaction key must fail before opening the database, got %v", err)
	}
}

func findResponseCookie(t *testing.T, response *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == name && cookie.Value != "" {
			return cookie
		}
	}
	t.Fatalf("response cookie %s not found", name)
	return nil
}

func signAPIJWT(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	headerJSON, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": "api-key", "typ": "JWT"})
	claimsJSON, _ := json.Marshal(claims)
	signed := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signed))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signed + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func writeOIDCTestJSON(response http.ResponseWriter, value any) {
	response.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(response).Encode(value)
}
