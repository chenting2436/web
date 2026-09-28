package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

const (
	LegacyWorkbenchImportManifestVersion = 1
	MaxLegacyWorkbenchImportEntries      = 10_000
	MaxLegacyWorkbenchStateFileBytes     = 16 << 20
	MaxLegacyWorkbenchMappingFileBytes   = 1 << 20
)

var (
	ErrLegacyWorkbenchImportInvalid  = errors.New("invalid legacy workbench-state import input")
	ErrLegacyWorkbenchImportMapping  = errors.New("legacy workbench-state mapping is invalid")
	ErrLegacyWorkbenchImportConflict = errors.New("legacy workbench-state destination conflicts with existing state")
)

// LegacyWorkbenchImportManifest deliberately maps an old, untrusted logical
// user key to identities that have already been provisioned in the durable
// tenant model. The importer never guesses an identity from an email, a user
// name, or the special legacy key "guest".
type LegacyWorkbenchImportManifest struct {
	Version      int                            `json:"version"`
	SourceSHA256 string                         `json:"sourceSha256"`
	Mappings     []LegacyWorkbenchImportMapping `json:"mappings"`
}

type LegacyWorkbenchImportMapping struct {
	LegacyUserKey              string `json:"legacyUserKey"`
	TenantID                   string `json:"tenantId"`
	WorkspaceID                string `json:"workspaceId"`
	UserID                     string `json:"userId"`
	ActorUserID                string `json:"actorUserId"`
	AcknowledgeAnonymousSource bool   `json:"acknowledgeAnonymousSource,omitempty"`
}

type LegacyWorkbenchImportEntry struct {
	LegacyKey   string `json:"legacyKey"`
	TenantID    string `json:"tenantId"`
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	Slug        string `json:"slug"`
	Disposition string `json:"disposition"`
}

type LegacyWorkbenchImportReport struct {
	Mode           string                       `json:"mode"`
	SourceSHA256   string                       `json:"sourceSha256"`
	ManifestSHA256 string                       `json:"manifestSha256"`
	Total          int                          `json:"total"`
	WouldImport    int                          `json:"wouldImport"`
	Imported       int                          `json:"imported"`
	AlreadyPresent int                          `json:"alreadyPresent"`
	Entries        []LegacyWorkbenchImportEntry `json:"entries"`
}

type parsedLegacyWorkbenchState struct {
	legacyKey     string
	legacyUserKey string
	slug          string
	state         map[string]any
	encoded       []byte
	mapping       LegacyWorkbenchImportMapping
	targetRole    string
	disposition   string
}

// ImportLegacyWorkbenchStates performs a complete validation pass in one
// database transaction. Dry-run is the default at the command boundary and
// never writes state or audit data. Apply inserts only missing destinations;
// an existing byte-equivalent normalized JSON object is an idempotent no-op,
// while any different destination state aborts the whole transaction.
func (store *ProjectStore) ImportLegacyWorkbenchStates(ctx context.Context, legacyJSON, manifestJSON []byte, apply bool) (LegacyWorkbenchImportReport, error) {
	report := LegacyWorkbenchImportReport{Mode: "dry-run", Entries: []LegacyWorkbenchImportEntry{}}
	if apply {
		report.Mode = "apply"
	}
	if store == nil || store.database == nil || ctx == nil {
		return report, fmt.Errorf("%w: store and context are required", ErrLegacyWorkbenchImportInvalid)
	}
	if len(legacyJSON) == 0 || len(legacyJSON) > MaxLegacyWorkbenchStateFileBytes {
		return report, fmt.Errorf("%w: legacy state file must contain 1 to %d bytes", ErrLegacyWorkbenchImportInvalid, MaxLegacyWorkbenchStateFileBytes)
	}
	if len(manifestJSON) == 0 || len(manifestJSON) > MaxLegacyWorkbenchMappingFileBytes {
		return report, fmt.Errorf("%w: mapping file must contain 1 to %d bytes", ErrLegacyWorkbenchImportInvalid, MaxLegacyWorkbenchMappingFileBytes)
	}

	report.SourceSHA256 = byteSHA256(legacyJSON)
	report.ManifestSHA256 = byteSHA256(manifestJSON)
	records, err := parseLegacyWorkbenchStateJSON(legacyJSON)
	if err != nil {
		return report, err
	}
	_, mappings, err := parseLegacyWorkbenchManifest(manifestJSON, report.SourceSHA256, records)
	if err != nil {
		return report, err
	}
	actorScope, hasBatchScope, err := legacyWorkbenchImportBatchScope(mappings)
	if err != nil {
		return report, err
	}

	// Serializable gives the validation and the writes one coherent view. This
	// matters when a separate provisioning process changes a membership while
	// an import is running. We intentionally do not use SELECT FOR SHARE on
	// identity tables because the least-privilege runtime role has SELECT (not
	// UPDATE) permission on them.
	rawTx, err := store.database.raw.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: !apply})
	if err != nil {
		return report, fmt.Errorf("begin legacy workbench-state import: %w", err)
	}
	tx := &databaseTx{raw: rawTx, dialect: store.database.dialect}
	defer func() { _ = tx.Rollback() }()
	// The manifest boundary is structurally validated before it becomes trusted
	// transaction-local context. Identity validation runs as the one active
	// administrator. Draft reads/writes later switch to the exact target user,
	// then switch back to the administrator only for audit evidence. There is no
	// system or bypass mode.
	if hasBatchScope {
		if err := tx.setUserRLSContext(actorScope); err != nil {
			return report, fmt.Errorf("%w: set importer administrator scope: %v", ErrLegacyWorkbenchImportMapping, err)
		}
	}

	targetRoles := make(map[string]string, len(mappings))
	for legacyUserKey, mapping := range mappings {
		role, err := validateLegacyWorkbenchMappingTx(ctx, tx, mapping)
		if err != nil {
			return report, fmt.Errorf("%w: mapping for %q: %v", ErrLegacyWorkbenchImportMapping, legacyUserKey, err)
		}
		targetRoles[legacyUserKey] = role
	}

	planned := make([]parsedLegacyWorkbenchState, 0, len(records))
	destinations := make(map[string]string, len(records))
	for _, record := range records {
		mapping := mappings[record.legacyUserKey]
		record.mapping = mapping
		record.targetRole = targetRoles[record.legacyUserKey]
		destinationKey := strings.Join([]string{mapping.TenantID, mapping.WorkspaceID, mapping.UserID, record.slug}, "\x00")
		if previousLegacyKey, exists := destinations[destinationKey]; exists {
			return report, fmt.Errorf("%w: %q and %q map to the same destination", ErrLegacyWorkbenchImportMapping, previousLegacyKey, record.legacyKey)
		}
		destinations[destinationKey] = record.legacyKey

		targetScope := Scope{
			TenantID: mapping.TenantID, WorkspaceID: mapping.WorkspaceID, UserID: mapping.UserID, Role: record.targetRole,
		}
		if err := tx.setUserRLSContext(targetScope); err != nil {
			return report, fmt.Errorf("%w: set exact target scope for %q: %v", ErrLegacyWorkbenchImportMapping, record.legacyKey, err)
		}
		existing, found, err := getLegacyWorkbenchImportStateTx(ctx, tx, targetScope, record.slug, apply)
		if err != nil {
			return report, err
		}
		if found {
			existingEncoded, _, normalizeErr := normalizeWorkbenchState(existing.State)
			if normalizeErr != nil {
				return report, fmt.Errorf("%w: destination %q contains invalid stored state: %v", ErrLegacyWorkbenchImportConflict, record.legacyKey, normalizeErr)
			}
			if !bytes.Equal(existingEncoded, record.encoded) {
				report.Entries = append(report.Entries, legacyImportReportEntry(record, "conflict"))
				return report, fmt.Errorf("%w: destination for %q already contains different state", ErrLegacyWorkbenchImportConflict, record.legacyKey)
			}
			record.disposition = "already-present"
		} else {
			record.disposition = "would-import"
		}
		planned = append(planned, record)
	}

	if !apply {
		for _, record := range planned {
			report.Entries = append(report.Entries, legacyImportReportEntry(record, record.disposition))
			if record.disposition == "already-present" {
				report.AlreadyPresent++
			} else {
				report.WouldImport++
			}
		}
		report.Total = len(planned)
		if err := tx.Commit(); err != nil {
			return report, fmt.Errorf("finish legacy workbench-state dry-run: %w", err)
		}
		return report, nil
	}

	imported, alreadyPresent := 0, 0
	for index := range planned {
		record := &planned[index]
		if record.disposition == "already-present" {
			alreadyPresent++
			continue
		}
		scope := Scope{TenantID: record.mapping.TenantID, WorkspaceID: record.mapping.WorkspaceID, UserID: record.mapping.UserID, Role: record.targetRole}
		if err := tx.setUserRLSContext(scope); err != nil {
			return report, fmt.Errorf("%w: set exact target scope for %q: %v", ErrLegacyWorkbenchImportMapping, record.legacyKey, err)
		}
		saved, err := putWorkbenchStateTx(ctx, tx, scope, record.slug, 0, record.encoded, record.state)
		if errors.Is(err, ErrWorkbenchStateConflict) {
			// A concurrent importer may have won the unique insert after our
			// validation pass. It is safe only when it installed exactly the same
			// normalized value; otherwise fail closed and roll back this batch.
			existing, found, lookupErr := getLegacyWorkbenchImportStateTx(ctx, tx, scope, record.slug, true)
			if lookupErr != nil {
				return report, lookupErr
			}
			if found {
				existingEncoded, _, normalizeErr := normalizeWorkbenchState(existing.State)
				if normalizeErr == nil && bytes.Equal(existingEncoded, record.encoded) {
					record.disposition = "already-present"
					alreadyPresent++
					continue
				}
			}
			return report, fmt.Errorf("%w: destination for %q changed during apply", ErrLegacyWorkbenchImportConflict, record.legacyKey)
		}
		if err != nil {
			return report, err
		}
		event := AuditEvent{
			TenantID: record.mapping.TenantID, WorkspaceID: record.mapping.WorkspaceID,
			ActorUserID: record.mapping.ActorUserID,
			Action:      "workbench.state.legacy_import", ResourceType: "workbench_state",
			ResourceID: record.mapping.UserID + "/" + record.slug, Outcome: "success",
			RequestID: "legacy-workbench-import-" + report.ManifestSHA256[:24],
			UserAgent: "skyviewlab-legacy-workbench-importer/1",
			AfterHash: byteSHA256(record.encoded),
			Metadata: map[string]any{
				"legacyUserKey": record.legacyUserKey, "slug": record.slug,
				"sourceSha256": report.SourceSHA256, "manifestSha256": report.ManifestSHA256,
				"targetUserId": record.mapping.UserID, "revision": saved.Revision,
			},
		}
		if err := tx.setUserRLSContext(actorScope); err != nil {
			return report, fmt.Errorf("%w: restore importer administrator scope for %q: %v", ErrLegacyWorkbenchImportMapping, record.legacyKey, err)
		}
		if _, err := store.appendAuditTxContext(ctx, tx, event); err != nil {
			return report, fmt.Errorf("%w: append evidence for %q: %w", ErrAtomicAuditWrite, record.legacyKey, err)
		}
		record.disposition = "imported"
		imported++
	}
	if err := tx.Commit(); err != nil {
		return report, fmt.Errorf("commit legacy workbench-state import: %w", err)
	}
	for _, record := range planned {
		report.Entries = append(report.Entries, legacyImportReportEntry(record, record.disposition))
	}
	report.Total = len(planned)
	report.Imported = imported
	report.AlreadyPresent = alreadyPresent
	return report, nil
}

func parseLegacyWorkbenchStateJSON(raw []byte) ([]parsedLegacyWorkbenchState, error) {
	if err := rejectDuplicateJSONObjectKeys(raw); err != nil {
		return nil, fmt.Errorf("%w: legacy state JSON: %v", ErrLegacyWorkbenchImportInvalid, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var values map[string]json.RawMessage
	if err := decoder.Decode(&values); err != nil {
		return nil, fmt.Errorf("%w: decode legacy state JSON: %v", ErrLegacyWorkbenchImportInvalid, err)
	}
	if values == nil {
		return nil, fmt.Errorf("%w: legacy state root must be a JSON object", ErrLegacyWorkbenchImportInvalid)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, fmt.Errorf("%w: legacy state JSON: %v", ErrLegacyWorkbenchImportInvalid, err)
	}
	if len(values) > MaxLegacyWorkbenchImportEntries {
		return nil, fmt.Errorf("%w: legacy state contains more than %d entries", ErrLegacyWorkbenchImportInvalid, MaxLegacyWorkbenchImportEntries)
	}

	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	catalog := NewMemoryStore()
	records := make([]parsedLegacyWorkbenchState, 0, len(keys))
	for _, legacyKey := range keys {
		separator := strings.LastIndexByte(legacyKey, '|')
		if separator <= 0 || separator == len(legacyKey)-1 {
			return nil, fmt.Errorf("%w: key %q must be <legacyUserKey>|<slug>", ErrLegacyWorkbenchImportInvalid, legacyKey)
		}
		legacyUserKey, slug := legacyKey[:separator], legacyKey[separator+1:]
		if err := validateWorkbenchStateKey("legacy user key", legacyUserKey, false); err != nil {
			return nil, fmt.Errorf("%w: key %q: %v", ErrLegacyWorkbenchImportInvalid, legacyKey, err)
		}
		if err := validateWorkbenchStateKey("slug", slug, true); err != nil {
			return nil, fmt.Errorf("%w: key %q: %v", ErrLegacyWorkbenchImportInvalid, legacyKey, err)
		}
		if _, known := catalog.Get(slug); !known {
			return nil, fmt.Errorf("%w: key %q references an unknown workbench slug", ErrLegacyWorkbenchImportInvalid, legacyKey)
		}
		state, err := decodeWorkbenchState(values[legacyKey])
		if err != nil {
			return nil, fmt.Errorf("%w: state for %q: %v", ErrLegacyWorkbenchImportInvalid, legacyKey, err)
		}
		encoded, normalized, err := normalizeWorkbenchState(state)
		if err != nil {
			return nil, fmt.Errorf("%w: state for %q: %v", ErrLegacyWorkbenchImportInvalid, legacyKey, err)
		}
		records = append(records, parsedLegacyWorkbenchState{
			legacyKey: legacyKey, legacyUserKey: legacyUserKey, slug: slug, state: normalized, encoded: encoded,
		})
	}
	return records, nil
}

func parseLegacyWorkbenchManifest(raw []byte, sourceSHA256 string, records []parsedLegacyWorkbenchState) (LegacyWorkbenchImportManifest, map[string]LegacyWorkbenchImportMapping, error) {
	var manifest LegacyWorkbenchImportManifest
	if err := rejectDuplicateJSONObjectKeys(raw); err != nil {
		return manifest, nil, fmt.Errorf("%w: mapping JSON: %v", ErrLegacyWorkbenchImportMapping, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return manifest, nil, fmt.Errorf("%w: decode mapping JSON: %v", ErrLegacyWorkbenchImportMapping, err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return manifest, nil, fmt.Errorf("%w: mapping JSON: %v", ErrLegacyWorkbenchImportMapping, err)
	}
	if manifest.Version != LegacyWorkbenchImportManifestVersion {
		return manifest, nil, fmt.Errorf("%w: mapping version must be %d", ErrLegacyWorkbenchImportMapping, LegacyWorkbenchImportManifestVersion)
	}
	if manifest.Mappings == nil || len(manifest.Mappings) > MaxLegacyWorkbenchImportEntries {
		return manifest, nil, fmt.Errorf("%w: mappings must be an array with at most %d entries", ErrLegacyWorkbenchImportMapping, MaxLegacyWorkbenchImportEntries)
	}
	if !isLowerHexSHA256(manifest.SourceSHA256) || manifest.SourceSHA256 != sourceSHA256 {
		return manifest, nil, fmt.Errorf("%w: sourceSha256 does not match the exact legacy state file", ErrLegacyWorkbenchImportMapping)
	}

	mappings := make(map[string]LegacyWorkbenchImportMapping, len(manifest.Mappings))
	for index, mapping := range manifest.Mappings {
		if err := validateWorkbenchStateKey("legacy user key", mapping.LegacyUserKey, false); err != nil {
			return manifest, nil, fmt.Errorf("%w: mappings[%d]: %v", ErrLegacyWorkbenchImportMapping, index, err)
		}
		if _, exists := mappings[mapping.LegacyUserKey]; exists {
			return manifest, nil, fmt.Errorf("%w: duplicate mapping for %q", ErrLegacyWorkbenchImportMapping, mapping.LegacyUserKey)
		}
		if err := validateWorkbenchStateScope(Scope{TenantID: mapping.TenantID, WorkspaceID: mapping.WorkspaceID, UserID: mapping.UserID}, "mapping"); err != nil {
			return manifest, nil, fmt.Errorf("%w: mappings[%d]: %v", ErrLegacyWorkbenchImportMapping, index, err)
		}
		if err := validateWorkbenchStateKey("actor user ID", mapping.ActorUserID, false); err != nil {
			return manifest, nil, fmt.Errorf("%w: mappings[%d]: %v", ErrLegacyWorkbenchImportMapping, index, err)
		}
		if strings.EqualFold(mapping.LegacyUserKey, "guest") && !mapping.AcknowledgeAnonymousSource {
			return manifest, nil, fmt.Errorf("%w: mapping legacy user %q requires acknowledgeAnonymousSource=true", ErrLegacyWorkbenchImportMapping, mapping.LegacyUserKey)
		}
		mappings[mapping.LegacyUserKey] = mapping
	}

	required := make(map[string]bool)
	for _, record := range records {
		required[record.legacyUserKey] = true
		if _, exists := mappings[record.legacyUserKey]; !exists {
			return manifest, nil, fmt.Errorf("%w: no explicit mapping for legacy user %q", ErrLegacyWorkbenchImportMapping, record.legacyUserKey)
		}
	}
	for legacyUserKey := range mappings {
		if !required[legacyUserKey] {
			return manifest, nil, fmt.Errorf("%w: mapping for legacy user %q is unused", ErrLegacyWorkbenchImportMapping, legacyUserKey)
		}
	}
	return manifest, mappings, nil
}

// legacyWorkbenchImportBatchScope rejects cross-boundary manifests. Besides
// making an apply all-or-nothing, this lets PostgreSQL use the ordinary user
// RLS context of one verified administrator. Cross-tenant/workspace work must
// be reviewed and executed as separate manifests.
func legacyWorkbenchImportBatchScope(mappings map[string]LegacyWorkbenchImportMapping) (Scope, bool, error) {
	var result Scope
	first := true
	for _, mapping := range mappings {
		candidate := Scope{
			TenantID: mapping.TenantID, WorkspaceID: mapping.WorkspaceID,
			UserID: mapping.ActorUserID, Role: "admin",
		}
		if first {
			result = candidate
			first = false
			continue
		}
		if candidate.TenantID != result.TenantID || candidate.WorkspaceID != result.WorkspaceID || candidate.UserID != result.UserID {
			return Scope{}, false, fmt.Errorf("%w: one manifest must use exactly one tenantId, workspaceId, and actorUserId; split cross-scope imports into separate batches", ErrLegacyWorkbenchImportMapping)
		}
	}
	return result, !first, nil
}

func validateLegacyWorkbenchMappingTx(ctx context.Context, tx *databaseTx, mapping LegacyWorkbenchImportMapping) (string, error) {
	query := `SELECT target_membership.role, actor_membership.role
		FROM memberships target_membership
		JOIN tenants tenant ON tenant.id = target_membership.tenant_id AND tenant.status = 'active'
		JOIN workspaces workspace ON workspace.tenant_id = target_membership.tenant_id
			AND workspace.id = target_membership.workspace_id AND workspace.status = 'active'
		JOIN users target_user ON target_user.tenant_id = target_membership.tenant_id
			AND target_user.id = target_membership.user_id AND target_user.status = 'active'
		JOIN memberships actor_membership ON actor_membership.tenant_id = target_membership.tenant_id
			AND actor_membership.workspace_id = target_membership.workspace_id
			AND actor_membership.user_id = ? AND actor_membership.status = 'active'
		JOIN users actor_user ON actor_user.tenant_id = actor_membership.tenant_id
			AND actor_user.id = actor_membership.user_id AND actor_user.status = 'active'
		WHERE target_membership.tenant_id = ? AND target_membership.workspace_id = ?
			AND target_membership.user_id = ? AND target_membership.status = 'active'`
	var targetRole, actorRole string
	err := tx.QueryRowContext(ctx, query, mapping.ActorUserID, mapping.TenantID, mapping.WorkspaceID, mapping.UserID).Scan(&targetRole, &actorRole)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("target and actor must already have active users and active memberships in an active tenant/workspace")
	}
	if err != nil {
		return "", err
	}
	if actorRole != "admin" {
		return "", errors.New("actorUserId must have the active admin role in the destination workspace")
	}
	return targetRole, nil
}

func getLegacyWorkbenchImportStateTx(ctx context.Context, tx *databaseTx, scope Scope, slug string, lock bool) (WorkbenchState, bool, error) {
	query := `SELECT state_json, revision, updated_at FROM workbench_states
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND slug = ?`
	if lock && tx.dialect == dialectPostgreSQL {
		query += ` FOR UPDATE`
	}
	record, err := scanWorkbenchState(tx.QueryRowContext(ctx, query, scope.TenantID, scope.WorkspaceID, scope.UserID, slug))
	if errors.Is(err, sql.ErrNoRows) {
		return WorkbenchState{}, false, nil
	}
	return record, err == nil, err
}

func legacyImportReportEntry(record parsedLegacyWorkbenchState, disposition string) LegacyWorkbenchImportEntry {
	return LegacyWorkbenchImportEntry{
		LegacyKey: record.legacyKey, TenantID: record.mapping.TenantID, WorkspaceID: record.mapping.WorkspaceID,
		UserID: record.mapping.UserID, Slug: record.slug, Disposition: disposition,
	}
}

func rejectDuplicateJSONObjectKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := walkUniqueJSONValue(decoder); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func walkUniqueJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := walkUniqueJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			if err != nil {
				return err
			}
			return errors.New("JSON object is not closed")
		}
	case '[':
		for decoder.More() {
			if err := walkUniqueJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			if err != nil {
				return err
			}
			return errors.New("JSON array is not closed")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
	return nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("contains trailing JSON data")
		}
		return err
	}
	return nil
}

func byteSHA256(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func isLowerHexSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}
