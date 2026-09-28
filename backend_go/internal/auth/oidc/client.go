package oidc

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	maxProviderResponse     = 1 << 20
	defaultMaxTokenLifetime = time.Hour
	maximumMaxTokenLifetime = 24 * time.Hour
	MaximumTransactionTTL   = 10 * time.Minute
)

var (
	ErrInvalidState        = errors.New("invalid or expired oidc state")
	ErrInvalidToken        = errors.New("invalid oidc id token")
	ErrProviderUnavailable = errors.New("oidc provider unavailable")
	ErrFlowCapacity        = errors.New("oidc login flow capacity reached")
)

var claimNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`)

// Config contains the relying-party settings required for Authorization Code
// flow with PKCE. AllowInsecureHTTP exists only for isolated development and
// tests; callers must reject it in production configuration.
type Config struct {
	IssuerURL         string
	ClientID          string
	ClientSecret      string
	RedirectURL       string
	Scopes            []string
	TenantClaim       string
	WorkspaceClaim    string
	AllowInsecureHTTP bool
	HTTPClient        *http.Client
	Clock             func() time.Time
	ClockSkew         time.Duration
	MaxTokenLifetime  time.Duration
	TransactionTTL    time.Duration
	MetadataCacheTTL  time.Duration
	JWKSCacheTTL      time.Duration
	TransactionStore  TransactionStore
}

type Principal struct {
	Issuer      string
	Subject     string
	Email       string
	DisplayName string
	TenantID    string
	WorkspaceID string
}

type Authorization struct {
	URL       string
	State     string
	ExpiresAt time.Time
	TTL       time.Duration
}

type providerMetadata struct {
	Issuer                           string   `json:"issuer"`
	AuthorizationEndpoint            string   `json:"authorization_endpoint"`
	TokenEndpoint                    string   `json:"token_endpoint"`
	JWKSURI                          string   `json:"jwks_uri"`
	CodeChallengeMethodsSupported    []string `json:"code_challenge_methods_supported"`
	IDTokenSigningAlgValuesSupported []string `json:"id_token_signing_alg_values_supported"`
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
	TokenType   string `json:"token_type"`
}

type Client struct {
	config       Config
	client       *http.Client
	transactions TransactionStore

	metadataMu      sync.Mutex
	metadataValue   providerMetadata
	metadataExpires time.Time

	keysMu      sync.Mutex
	keysValue   jwkSet
	keysExpires time.Time
}

func New(config Config) (*Client, error) {
	config.IssuerURL = strings.TrimSpace(config.IssuerURL)
	config.ClientID = strings.TrimSpace(config.ClientID)
	config.RedirectURL = strings.TrimSpace(config.RedirectURL)
	config.TenantClaim = strings.TrimSpace(config.TenantClaim)
	config.WorkspaceClaim = strings.TrimSpace(config.WorkspaceClaim)
	if config.TenantClaim == "" {
		config.TenantClaim = "tenant_id"
	}
	if config.WorkspaceClaim == "" {
		config.WorkspaceClaim = "workspace_id"
	}
	if len(config.Scopes) == 0 {
		config.Scopes = []string{"openid", "profile", "email"}
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	if config.ClockSkew <= 0 {
		config.ClockSkew = 60 * time.Second
	}
	if config.MaxTokenLifetime <= 0 {
		config.MaxTokenLifetime = defaultMaxTokenLifetime
	}
	if config.MaxTokenLifetime > maximumMaxTokenLifetime {
		return nil, fmt.Errorf("maximum ID token lifetime must not exceed %s", maximumMaxTokenLifetime)
	}
	if config.TransactionTTL <= 0 {
		config.TransactionTTL = 5 * time.Minute
	}
	if config.TransactionTTL > MaximumTransactionTTL {
		return nil, fmt.Errorf("OIDC transaction TTL must not exceed %s", MaximumTransactionTTL)
	}
	if config.MetadataCacheTTL <= 0 {
		config.MetadataCacheTTL = 10 * time.Minute
	}
	if config.JWKSCacheTTL <= 0 {
		config.JWKSCacheTTL = 5 * time.Minute
	}

	if err := validateIssuerURL(config.IssuerURL, config.AllowInsecureHTTP); err != nil {
		return nil, fmt.Errorf("issuer URL: %w", err)
	}
	if err := validateRedirectURL(config.RedirectURL, config.AllowInsecureHTTP); err != nil {
		return nil, fmt.Errorf("redirect URL: %w", err)
	}
	if config.ClientID == "" || len(config.ClientID) > 256 {
		return nil, errors.New("client ID is required and must not exceed 256 bytes")
	}
	if !claimNamePattern.MatchString(config.TenantClaim) || !claimNamePattern.MatchString(config.WorkspaceClaim) {
		return nil, errors.New("tenant and workspace claim names are invalid")
	}
	if !contains(config.Scopes, "openid") {
		return nil, errors.New("OIDC scopes must include openid")
	}
	if config.TransactionStore == nil {
		return nil, errors.New("OIDC transaction store is required")
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	} else {
		clone := *httpClient
		httpClient = &clone
		if httpClient.Timeout <= 0 {
			httpClient.Timeout = 10 * time.Second
		}
	}
	if httpClient.CheckRedirect == nil {
		httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}

	return &Client{config: config, client: httpClient, transactions: config.TransactionStore}, nil
}

func (client *Client) Ready(ctx context.Context) error {
	metadata, err := client.metadata(ctx)
	if err != nil {
		return err
	}
	_, err = client.keys(ctx, metadata, false)
	return err
}

func (client *Client) Begin(ctx context.Context) (Authorization, error) {
	metadata, err := client.metadata(ctx)
	if err != nil {
		return Authorization{}, err
	}
	state, err := randomValue()
	if err != nil {
		return Authorization{}, err
	}
	nonce, err := randomValue()
	if err != nil {
		return Authorization{}, err
	}
	verifier, err := randomValue()
	if err != nil {
		return Authorization{}, err
	}
	now := client.config.Clock().UTC()
	expiresAt, err := client.transactions.Create(ctx, state, Transaction{Nonce: nonce, CodeVerifier: verifier}, now, client.config.TransactionTTL)
	if err != nil {
		if errors.Is(err, ErrFlowCapacity) || errors.Is(err, ErrFlowRateLimited) {
			return Authorization{}, err
		}
		return Authorization{}, fmt.Errorf("%w: create login transaction", ErrTransactionStore)
	}

	challengeDigest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeDigest[:])
	authorizationURL, err := url.Parse(metadata.AuthorizationEndpoint)
	if err != nil {
		_ = client.AbortContext(ctx, state)
		return Authorization{}, fmt.Errorf("%w: invalid authorization endpoint", ErrProviderUnavailable)
	}
	query := authorizationURL.Query()
	query.Set("client_id", client.config.ClientID)
	query.Set("redirect_uri", client.config.RedirectURL)
	query.Set("response_type", "code")
	query.Set("scope", strings.Join(client.config.Scopes, " "))
	query.Set("state", state)
	query.Set("nonce", nonce)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	authorizationURL.RawQuery = query.Encode()
	return Authorization{URL: authorizationURL.String(), State: state, ExpiresAt: expiresAt, TTL: client.config.TransactionTTL}, nil
}

func (client *Client) Exchange(ctx context.Context, state, code string) (Principal, error) {
	state = strings.TrimSpace(state)
	code = strings.TrimSpace(code)
	if len(state) < 32 || len(state) > 256 || len(code) == 0 || len(code) > 4096 {
		return Principal{}, ErrInvalidState
	}
	transaction, err := client.transactions.Consume(ctx, state, client.config.Clock().UTC())
	if errors.Is(err, ErrTransactionNotFound) {
		return Principal{}, ErrInvalidState
	}
	if err != nil {
		return Principal{}, fmt.Errorf("%w: consume login transaction", ErrTransactionStore)
	}
	metadata, err := client.metadata(ctx)
	if err != nil {
		return Principal{}, err
	}
	tokens, err := client.exchangeCode(ctx, metadata, code, transaction.CodeVerifier)
	if err != nil {
		return Principal{}, err
	}
	return client.verifyIDToken(ctx, metadata, tokens.IDToken, tokens.AccessToken, transaction.Nonce)
}

// Abort consumes a pending state after an authorization-server error. It is
// intentionally one-way so a failed browser flow cannot be replayed.
func (client *Client) Abort(state string) {
	_ = client.AbortContext(context.Background(), state)
}

// AbortContext consumes a pending state without exchanging a code. Missing or
// already-consumed state is harmless; storage failures remain observable to
// callers that need to surface degraded login infrastructure.
func (client *Client) AbortContext(ctx context.Context, state string) error {
	_, err := client.transactions.Consume(ctx, strings.TrimSpace(state), client.config.Clock().UTC())
	if errors.Is(err, ErrTransactionNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: abort login transaction", ErrTransactionStore)
	}
	return nil
}

func (client *Client) exchangeCode(ctx context.Context, metadata providerMetadata, code, verifier string) (tokenResponse, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {client.config.RedirectURL},
		"client_id":     {client.config.ClientID},
		"code_verifier": {verifier},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, metadata.TokenEndpoint, bytes.NewBufferString(form.Encode()))
	if err != nil {
		return tokenResponse{}, fmt.Errorf("%w: build token request", ErrProviderUnavailable)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if client.config.ClientSecret != "" {
		request.SetBasicAuth(client.config.ClientID, client.config.ClientSecret)
	}
	var tokens tokenResponse
	if err := client.doJSON(request, &tokens); err != nil {
		return tokenResponse{}, err
	}
	if tokens.IDToken == "" {
		return tokenResponse{}, fmt.Errorf("%w: token response omitted id_token", ErrInvalidToken)
	}
	return tokens, nil
}

func (client *Client) metadata(ctx context.Context) (providerMetadata, error) {
	now := client.config.Clock().UTC()
	client.metadataMu.Lock()
	defer client.metadataMu.Unlock()
	if client.metadataValue.Issuer != "" && now.Before(client.metadataExpires) {
		return client.metadataValue, nil
	}
	discoveryURL := strings.TrimSuffix(client.config.IssuerURL, "/") + "/.well-known/openid-configuration"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	if err != nil {
		return providerMetadata{}, fmt.Errorf("%w: build discovery request", ErrProviderUnavailable)
	}
	request.Header.Set("Accept", "application/json")
	var metadata providerMetadata
	if err := client.doJSON(request, &metadata); err != nil {
		return providerMetadata{}, err
	}
	if metadata.Issuer != client.config.IssuerURL {
		return providerMetadata{}, fmt.Errorf("%w: discovery issuer mismatch", ErrProviderUnavailable)
	}
	for label, endpoint := range map[string]string{
		"authorization": metadata.AuthorizationEndpoint,
		"token":         metadata.TokenEndpoint,
		"jwks":          metadata.JWKSURI,
	} {
		if err := validateEndpointURL(endpoint, client.config.AllowInsecureHTTP); err != nil {
			return providerMetadata{}, fmt.Errorf("%w: invalid %s endpoint", ErrProviderUnavailable, label)
		}
	}
	if !contains(metadata.CodeChallengeMethodsSupported, "S256") {
		return providerMetadata{}, fmt.Errorf("%w: provider does not advertise PKCE S256", ErrProviderUnavailable)
	}
	if !contains(metadata.IDTokenSigningAlgValuesSupported, "RS256") {
		return providerMetadata{}, fmt.Errorf("%w: provider does not advertise RS256", ErrProviderUnavailable)
	}
	client.metadataValue = metadata
	client.metadataExpires = now.Add(client.config.MetadataCacheTTL)
	return metadata, nil
}

func (client *Client) keys(ctx context.Context, metadata providerMetadata, force bool) (jwkSet, error) {
	now := client.config.Clock().UTC()
	client.keysMu.Lock()
	defer client.keysMu.Unlock()
	if !force && len(client.keysValue.Keys) > 0 && now.Before(client.keysExpires) {
		return client.keysValue, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, metadata.JWKSURI, nil)
	if err != nil {
		return jwkSet{}, fmt.Errorf("%w: build jwks request", ErrProviderUnavailable)
	}
	request.Header.Set("Accept", "application/json")
	var keys jwkSet
	if err := client.doJSON(request, &keys); err != nil {
		return jwkSet{}, err
	}
	if len(keys.Keys) == 0 || len(keys.Keys) > 100 {
		return jwkSet{}, fmt.Errorf("%w: invalid jwks key count", ErrProviderUnavailable)
	}
	client.keysValue = keys
	client.keysExpires = now.Add(client.config.JWKSCacheTTL)
	return keys, nil
}

func (client *Client) doJSON(request *http.Request, destination any) error {
	response, err := client.client.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrProviderUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8<<10))
		return fmt.Errorf("%w: provider returned HTTP %d", ErrProviderUnavailable, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxProviderResponse+1))
	if err != nil {
		return fmt.Errorf("%w: read provider response", ErrProviderUnavailable)
	}
	if len(body) > maxProviderResponse {
		return fmt.Errorf("%w: oversized provider response", ErrProviderUnavailable)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("%w: invalid provider JSON", ErrProviderUnavailable)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: oversized or trailing provider response", ErrProviderUnavailable)
	}
	return nil
}

func randomValue() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func validateIssuerURL(raw string, allowHTTP bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("must be an absolute issuer URL without credentials, query, or fragment")
	}
	return validateScheme(parsed.Scheme, allowHTTP)
}

func validateRedirectURL(raw string, allowHTTP bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("must be an absolute callback URL without credentials, query, or fragment")
	}
	return validateScheme(parsed.Scheme, allowHTTP)
}

func validateEndpointURL(raw string, allowHTTP bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("must be an absolute endpoint URL without credentials or fragment")
	}
	return validateScheme(parsed.Scheme, allowHTTP)
}

func validateScheme(scheme string, allowHTTP bool) error {
	if scheme == "https" || allowHTTP && scheme == "http" {
		return nil
	}
	return errors.New("HTTPS is required")
}
