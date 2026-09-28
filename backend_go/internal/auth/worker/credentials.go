package worker

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"
)

const (
	// SourceFile marks credentials loaded from the production secret file contract.
	SourceFile = "file"
	// SourceDevelopmentInline marks the explicit WORKER_ID + WORKER_TOKEN
	// development adapter. It is never accepted in production mode.
	SourceDevelopmentInline = "development-inline"

	MaxCredentialFileBytes = 64 << 10
	MaxCredentials         = 256
	MaxScopesPerWorker     = 64
	MaxValuesPerAllowlist  = 256
	MinTokenBytes          = 32
	MaxTokenBytes          = 4096
)

var workerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$`)
var capabilityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// Scope is an exact, deny-by-default worker dispatch boundary. One scope binds
// one slug to its own action allowlist, avoiding cross-product authorization
// when a worker serves multiple tools in the same workspace.
type Scope struct {
	TenantID    string   `json:"tenantId"`
	WorkspaceID string   `json:"workspaceId"`
	Slug        string   `json:"slug"`
	Actions     []string `json:"actions"`
}

// Identity is the immutable authorization result associated with a bearer
// token. AuthenticateAuthorization returns a deep copy so callers cannot
// mutate the authenticator's policy table.
type Identity struct {
	WorkerID string  `json:"workerId"`
	Scopes   []Scope `json:"scopes"`
}

// Allows checks one complete job capability. A matching tenant/workspace is
// insufficient unless the same scope also matches the exact slug and action.
func (identity Identity) Allows(tenantID, workspaceID, slug, action string) bool {
	for _, scope := range identity.Scopes {
		if scope.TenantID != tenantID || scope.WorkspaceID != workspaceID || scope.Slug != slug {
			continue
		}
		for _, allowedAction := range scope.Actions {
			if allowedAction == action {
				return true
			}
		}
	}
	return false
}

// Credential is an input-only worker credential. API servers turn this value
// into an Authenticator and then discard the plaintext slice.
type Credential struct {
	ID     string  `json:"id"`
	Token  string  `json:"token"`
	Scopes []Scope `json:"scopes"`
}

type credentialFile struct {
	Version int          `json:"version"`
	Workers []Credential `json:"workers"`
}

// Authenticator binds an opaque bearer token to exactly one server-controlled
// worker identity. Only SHA-256 token digests are retained after construction.
type Authenticator struct {
	workersByTokenHash map[[sha256.Size]byte]Identity
}

// New validates every credential and constructs the digest-only lookup table.
// An empty set is allowed so development readiness can fail closed without
// preventing liveness; production configuration rejects it before startup.
func New(credentials []Credential) (*Authenticator, error) {
	if len(credentials) > MaxCredentials {
		return nil, fmt.Errorf("worker credentials exceed maximum of %d", MaxCredentials)
	}
	authenticator := &Authenticator{workersByTokenHash: make(map[[sha256.Size]byte]Identity, len(credentials))}
	workerIDs := make(map[string]struct{}, len(credentials))
	for index, credential := range credentials {
		if err := ValidateCredentialSecret(credential.ID, credential.Token); err != nil {
			return nil, fmt.Errorf("worker credential %d: %w", index, err)
		}
		identity, err := validateIdentity(credential.ID, credential.Scopes)
		if err != nil {
			return nil, fmt.Errorf("worker credential %d: %w", index, err)
		}
		if _, exists := workerIDs[credential.ID]; exists {
			return nil, fmt.Errorf("duplicate worker id %q", credential.ID)
		}
		workerIDs[credential.ID] = struct{}{}
		tokenHash := sha256.Sum256([]byte(credential.Token))
		if _, exists := authenticator.workersByTokenHash[tokenHash]; exists {
			return nil, errors.New("duplicate worker token")
		}
		authenticator.workersByTokenHash[tokenHash] = identity
	}
	return authenticator, nil
}

// ValidateCredentialSecret validates the two values a standalone worker owns
// without pretending that the worker is allowed to choose its server-side
// scopes. The API server must still construct an Authenticator from scoped
// credentials.
func ValidateCredentialSecret(workerID, token string) error {
	if workerID != strings.TrimSpace(workerID) || !workerIDPattern.MatchString(workerID) {
		return errors.New("invalid worker id")
	}
	if !validToken(token) {
		return fmt.Errorf("token must contain %d to %d printable ASCII bytes without spaces", MinTokenBytes, MaxTokenBytes)
	}
	return nil
}

func validateIdentity(workerID string, scopes []Scope) (Identity, error) {
	if len(scopes) == 0 {
		return Identity{}, errors.New("at least one exact scope is required")
	}
	if len(scopes) > MaxScopesPerWorker {
		return Identity{}, fmt.Errorf("scopes exceed maximum of %d", MaxScopesPerWorker)
	}
	identity := Identity{WorkerID: workerID, Scopes: make([]Scope, len(scopes))}
	seenScopes := make(map[string]struct{}, len(scopes))
	for index, scope := range scopes {
		if scope.TenantID != strings.TrimSpace(scope.TenantID) || !workerIDPattern.MatchString(scope.TenantID) {
			return Identity{}, fmt.Errorf("scope %d has an invalid tenantId", index)
		}
		if scope.WorkspaceID != strings.TrimSpace(scope.WorkspaceID) || !workerIDPattern.MatchString(scope.WorkspaceID) {
			return Identity{}, fmt.Errorf("scope %d has an invalid workspaceId", index)
		}
		if scope.Slug != strings.TrimSpace(scope.Slug) || !capabilityPattern.MatchString(scope.Slug) {
			return Identity{}, fmt.Errorf("scope %d has an invalid slug", index)
		}
		key := scope.TenantID + "\x00" + scope.WorkspaceID + "\x00" + scope.Slug
		if _, exists := seenScopes[key]; exists {
			return Identity{}, fmt.Errorf("scope %d duplicates tenant/workspace/slug boundary", index)
		}
		seenScopes[key] = struct{}{}
		actions, err := validateAllowlist("actions", index, scope.Actions)
		if err != nil {
			return Identity{}, err
		}
		identity.Scopes[index] = Scope{TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Slug: scope.Slug, Actions: actions}
	}
	return identity, nil
}

func validateAllowlist(name string, scopeIndex int, values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, fmt.Errorf("scope %d %s allowlist must not be empty", scopeIndex, name)
	}
	if len(values) > MaxValuesPerAllowlist {
		return nil, fmt.Errorf("scope %d %s allowlist exceeds maximum of %d", scopeIndex, name, MaxValuesPerAllowlist)
	}
	result := make([]string, len(values))
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		// '*' is intentionally not part of capabilityPattern. Production worker
		// credentials therefore cannot silently become global dispatch keys.
		if value != strings.TrimSpace(value) || !capabilityPattern.MatchString(value) {
			return nil, fmt.Errorf("scope %d %s entry %d is invalid", scopeIndex, name, index)
		}
		if _, exists := seen[value]; exists {
			return nil, fmt.Errorf("scope %d %s contains duplicate %q", scopeIndex, name, value)
		}
		seen[value] = struct{}{}
		result[index] = value
	}
	return result, nil
}

func validToken(token string) bool {
	if token != strings.TrimSpace(token) || len(token) < MinTokenBytes || len(token) > MaxTokenBytes {
		return false
	}
	for index := 0; index < len(token); index++ {
		if token[index] < 0x21 || token[index] > 0x7e {
			return false
		}
	}
	return true
}

func (authenticator *Authenticator) Ready() bool {
	return authenticator != nil && len(authenticator.workersByTokenHash) > 0
}

func (authenticator *Authenticator) Count() int {
	if authenticator == nil {
		return 0
	}
	return len(authenticator.workersByTokenHash)
}

// AuthenticateAuthorization accepts exactly one RFC 6750-style Bearer header.
// It returns only the identity bound to that token; request bodies never
// participate in worker authentication.
func (authenticator *Authenticator) AuthenticateAuthorization(values []string) (Identity, bool) {
	if !authenticator.Ready() || len(values) != 1 {
		return Identity{}, false
	}
	header := values[0]
	separator := strings.IndexByte(header, ' ')
	if separator <= 0 || !strings.EqualFold(header[:separator], "Bearer") {
		return Identity{}, false
	}
	token := header[separator+1:]
	if token == "" || token != strings.TrimSpace(token) || strings.ContainsAny(token, "\t\r\n ") || len(token) > MaxTokenBytes {
		return Identity{}, false
	}
	identity, found := authenticator.workersByTokenHash[sha256.Sum256([]byte(token))]
	if !found {
		return Identity{}, false
	}
	return cloneIdentity(identity), true
}

func cloneIdentity(identity Identity) Identity {
	clone := Identity{WorkerID: identity.WorkerID, Scopes: make([]Scope, len(identity.Scopes))}
	for index, scope := range identity.Scopes {
		clone.Scopes[index] = Scope{
			TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
			Slug: scope.Slug, Actions: append([]string(nil), scope.Actions...),
		}
	}
	return clone
}

// LoadFile reads the bounded, strict worker credential file used by production.
// On Unix-like systems it rejects group/world permissions because this file
// contains reusable bearer secrets. Windows ACL validation remains a deployment
// responsibility.
func LoadFile(path string) ([]Credential, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("WORKER_CREDENTIALS_FILE is empty")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open worker credentials file: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat worker credentials file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("worker credentials file must be a regular file")
	}
	if info.Size() > MaxCredentialFileBytes {
		return nil, fmt.Errorf("worker credentials file exceeds %d bytes", MaxCredentialFileBytes)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("worker credentials file must not be readable or writable by group or others")
	}
	body, err := io.ReadAll(io.LimitReader(file, MaxCredentialFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read worker credentials file: %w", err)
	}
	if len(body) > MaxCredentialFileBytes {
		return nil, fmt.Errorf("worker credentials file exceeds %d bytes", MaxCredentialFileBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var document credentialFile
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("decode worker credentials file: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return nil, err
	}
	if document.Version != 1 {
		return nil, fmt.Errorf("unsupported worker credentials file version %d", document.Version)
	}
	if len(document.Workers) == 0 {
		return nil, errors.New("worker credentials file must contain at least one worker")
	}
	if _, err := New(document.Workers); err != nil {
		return nil, err
	}
	return document.Workers, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("worker credentials file contains trailing JSON")
		}
		return fmt.Errorf("decode trailing worker credentials data: %w", err)
	}
	return nil
}
