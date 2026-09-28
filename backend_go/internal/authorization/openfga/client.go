package openfga

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"skyviewlab/backend_go/internal/authorization"
)

const maxResponseBody = 64 << 10

var openFGAID = regexp.MustCompile(`^[ABCDEFGHJKMNPQRSTVWXYZ0-9]{26}$`)
var sha256Hex = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

var requiredModelRelations = map[string][]string{
	"tenant":     {"admin"},
	"workspace":  {"tenant", "admin", "member", "editor", "viewer", "can_edit", "can_view"},
	"project":    {"workspace", "admin", "owner", "reviewer", "can_edit", "can_view"},
	"job":        {"project", "submitter", "can_cancel", "can_view"},
	"course":     {"workspace", "teacher", "student", "can_grade", "can_view"},
	"assignment": {"course", "can_grade", "can_view"},
	"submission": {"assignment", "student", "draft_editor", "can_edit", "can_grade", "can_view"},
}

type Config struct {
	APIURL               string
	StoreID              string
	AuthorizationModelID string
	APIToken             string
	ExpectedModelSHA256  string
	Timeout              time.Duration
	AllowInsecureHTTP    bool
}

type Client struct {
	baseURL              *url.URL
	storeID              string
	authorizationModelID string
	apiToken             string
	expectedModelSHA256  string
	timeout              time.Duration
	httpClient           *http.Client
}

func New(config Config, httpClient *http.Client) (*Client, error) {
	baseURL, err := validateConfig(config)
	if err != nil {
		return nil, err
	}
	if config.Timeout <= 0 {
		config.Timeout = 2 * time.Second
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	} else {
		clone := *httpClient
		httpClient = &clone
	}
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		baseURL: baseURL, storeID: config.StoreID, authorizationModelID: config.AuthorizationModelID,
		apiToken: strings.TrimSpace(config.APIToken), expectedModelSHA256: strings.ToLower(strings.TrimSpace(config.ExpectedModelSHA256)),
		timeout: config.Timeout, httpClient: httpClient,
	}, nil
}

func (client *Client) Check(ctx context.Context, check authorization.Check) (bool, error) {
	mapped, err := authorization.Map(check)
	if err != nil {
		return false, err
	}
	payload := struct {
		TupleKey struct {
			User     string `json:"user"`
			Relation string `json:"relation"`
			Object   string `json:"object"`
		} `json:"tuple_key"`
		ContextualTuples struct {
			TupleKeys []authorization.TupleKey `json:"tuple_keys"`
		} `json:"contextual_tuples"`
		Context              map[string]any `json:"context"`
		AuthorizationModelID string         `json:"authorization_model_id"`
		Consistency          string         `json:"consistency"`
	}{
		Context: mapped.Context, AuthorizationModelID: client.authorizationModelID, Consistency: "HIGHER_CONSISTENCY",
	}
	payload.TupleKey.User = mapped.User
	payload.TupleKey.Relation = mapped.Relation
	payload.TupleKey.Object = mapped.Object
	payload.ContextualTuples.TupleKeys = mapped.ContextualTuples
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false, fmt.Errorf("encode OpenFGA check: %w", err)
	}

	var result struct {
		Allowed *bool `json:"allowed"`
	}
	if err := client.request(ctx, http.MethodPost, client.checkPath(), encoded, check.RequestID, &result); err != nil {
		return false, err
	}
	if result.Allowed == nil {
		return false, errors.New("OpenFGA check response is missing allowed")
	}
	return *result.Allowed, nil
}

func (client *Client) Ready(ctx context.Context) error {
	var response struct {
		AuthorizationModel json.RawMessage `json:"authorization_model"`
	}
	if err := client.request(ctx, http.MethodGet, client.modelPath(), nil, "", &response); err != nil {
		return err
	}
	if len(response.AuthorizationModel) == 0 {
		return errors.New("OpenFGA readiness response is missing authorization_model")
	}
	var model struct {
		ID              string `json:"id"`
		TypeDefinitions []struct {
			Type      string                     `json:"type"`
			Relations map[string]json.RawMessage `json:"relations"`
		} `json:"type_definitions"`
	}
	if err := json.Unmarshal(response.AuthorizationModel, &model); err != nil {
		return fmt.Errorf("decode OpenFGA authorization model: %w", err)
	}
	if model.ID != client.authorizationModelID {
		return errors.New("OpenFGA returned a different authorization model id")
	}
	definitions := make(map[string]map[string]json.RawMessage, len(model.TypeDefinitions))
	for _, definition := range model.TypeDefinitions {
		definitions[definition.Type] = definition.Relations
	}
	for resourceType, relations := range requiredModelRelations {
		available, ok := definitions[resourceType]
		if !ok {
			return fmt.Errorf("OpenFGA model is missing type %q", resourceType)
		}
		for _, relation := range relations {
			if _, ok := available[relation]; !ok {
				return fmt.Errorf("OpenFGA model type %q is missing relation %q", resourceType, relation)
			}
		}
	}
	if client.expectedModelSHA256 != "" {
		var canonicalValue any
		if err := json.Unmarshal(response.AuthorizationModel, &canonicalValue); err != nil {
			return fmt.Errorf("normalize OpenFGA authorization model: %w", err)
		}
		canonical, err := json.Marshal(canonicalValue)
		if err != nil {
			return fmt.Errorf("normalize OpenFGA authorization model: %w", err)
		}
		digest := sha256.Sum256(canonical)
		if fmt.Sprintf("%x", digest) != client.expectedModelSHA256 {
			return errors.New("OpenFGA authorization model hash does not match the pinned configuration")
		}
	}
	return nil
}

func (client *Client) Mode() string { return "openfga" }

func (client *Client) request(ctx context.Context, method, path string, body []byte, requestID string, destination any) error {
	requestContext, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, method, client.endpoint(path), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create OpenFGA request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if client.apiToken != "" {
		request.Header.Set("Authorization", "Bearer "+client.apiToken)
	}
	if requestID != "" {
		request.Header.Set("X-Request-ID", requestID)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("OpenFGA request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBody))
		return fmt.Errorf("OpenFGA returned HTTP %d", response.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody+1))
	if err != nil {
		return fmt.Errorf("read OpenFGA response: %w", err)
	}
	if len(responseBody) > maxResponseBody {
		return errors.New("OpenFGA response exceeds the 64 KiB limit")
	}
	if err := json.Unmarshal(responseBody, destination); err != nil {
		return fmt.Errorf("decode OpenFGA response: %w", err)
	}
	return nil
}

func validateConfig(config Config) (*url.URL, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.APIURL))
	if err != nil || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("OpenFGA API URL is invalid")
	}
	if baseURL.Scheme != "https" && !(config.AllowInsecureHTTP && baseURL.Scheme == "http") {
		return nil, errors.New("OpenFGA API URL must use HTTPS")
	}
	if !openFGAID.MatchString(config.StoreID) {
		return nil, errors.New("OpenFGA store id must be a 26-character ULID")
	}
	if !openFGAID.MatchString(config.AuthorizationModelID) {
		return nil, errors.New("OpenFGA authorization model id must be a 26-character ULID")
	}
	if config.ExpectedModelSHA256 != "" && !sha256Hex.MatchString(strings.TrimSpace(config.ExpectedModelSHA256)) {
		return nil, errors.New("OpenFGA expected model SHA-256 must contain 64 hexadecimal characters")
	}
	return baseURL, nil
}

func (client *Client) endpoint(path string) string {
	copy := *client.baseURL
	copy.Path = strings.TrimRight(copy.Path, "/") + path
	return copy.String()
}

func (client *Client) checkPath() string {
	return "/stores/" + client.storeID + "/check"
}

func (client *Client) modelPath() string {
	return "/stores/" + client.storeID + "/authorization-models/" + client.authorizationModelID
}
