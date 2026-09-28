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
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const auditChainVersion = 3

const auditSerializationMaxAttempts = 4

// ErrAuditChainInvalid means the persisted event graph, digests, sequence, or
// durable head did not agree. Callers must fail closed and must not return any
// events from a read that produced this error.
var ErrAuditChainInvalid = errors.New("audit chain integrity validation failed")

type AuditEvent struct {
	ID                string         `json:"id"`
	TenantID          string         `json:"tenantId"`
	WorkspaceID       string         `json:"workspaceId"`
	ActorUserID       string         `json:"actorUserId"`
	Action            string         `json:"action"`
	ResourceType      string         `json:"resourceType"`
	ResourceID        string         `json:"resourceId"`
	Outcome           string         `json:"outcome"`
	RequestID         string         `json:"requestId"`
	SourceIP          string         `json:"sourceIp"`
	UserAgent         string         `json:"userAgent"`
	BeforeHash        string         `json:"beforeHash"`
	AfterHash         string         `json:"afterHash"`
	Metadata          map[string]any `json:"metadata"`
	PreviousEventHash string         `json:"previousEventHash"`
	EventHash         string         `json:"eventHash"`
	Sequence          int64          `json:"sequence"`
	ChainVersion      int            `json:"chainVersion"`
	CreatedAt         string         `json:"createdAt"`
}

type storedAuditEvent struct {
	event                          AuditEvent
	metadataJSON                   string
	hashMetadataText               string
	legacyTimestampMicrosecondLoss bool
}

// AppendAudit serializes writers on one durable head row per tenant/workspace.
// The predecessor and sequence are always derived from that locked row; values
// supplied by a caller are deliberately ignored.
func (store *ProjectStore) AppendAudit(event AuditEvent) (AuditEvent, error) {
	return store.AppendAuditContext(context.Background(), event)
}

func (store *ProjectStore) AppendAuditContext(ctx context.Context, event AuditEvent) (AuditEvent, error) {
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return AuditEvent{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if strings.HasPrefix(event.ActorUserID, "worker:") {
		return AuditEvent{}, errors.New("standalone worker audit append requires exact worker scope")
	}
	if err := tx.setUserRLSContext(Scope{
		TenantID: event.TenantID, WorkspaceID: event.WorkspaceID,
		UserID: event.ActorUserID, Role: "audit",
	}); err != nil {
		return AuditEvent{}, err
	}
	appended, err := store.appendAuditTxContext(ctx, tx, event)
	if err != nil {
		return AuditEvent{}, err
	}
	if err := tx.Commit(); err != nil {
		return AuditEvent{}, err
	}
	return appended, nil
}

// appendAuditTx is the common atomic audit primitive for standalone appends
// and business mutations that already own a database transaction. Callers are
// responsible for committing or rolling back tx.
func (store *ProjectStore) appendAuditTx(tx *databaseTx, event AuditEvent) (AuditEvent, error) {
	return store.appendAuditTxContext(context.Background(), tx, event)
}

func (store *ProjectStore) appendAuditTxContext(ctx context.Context, tx *databaseTx, event AuditEvent) (AuditEvent, error) {
	if tx == nil {
		return AuditEvent{}, errors.New("audit transaction is required")
	}
	if event.ID == "" {
		event.ID = uuid.NewString()
	}
	if event.Metadata == nil {
		event.Metadata = map[string]any{}
	}
	metadata, err := json.Marshal(event.Metadata)
	if err != nil {
		return AuditEvent{}, err
	}
	if tx.dialect == dialectPostgreSQL {
		return store.appendAuditPostgreSQLTx(ctx, tx, event, string(metadata))
	}
	return store.appendAuditSQLiteTx(ctx, tx, event, metadata)
}

func (store *ProjectStore) appendAuditPostgreSQLTx(ctx context.Context, tx *databaseTx, event AuditEvent, metadata string) (AuditEvent, error) {
	event.ChainVersion = auditChainVersion

	var storedCreatedAt timestampText
	err := tx.QueryRowContext(ctx, `SELECT appended_sequence, appended_previous_event_hash, appended_event_hash, appended_created_at
		FROM public.append_audit_event_v3(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		event.ID, event.TenantID, event.WorkspaceID, event.ActorUserID, event.Action, event.ResourceType, event.ResourceID,
		event.Outcome, event.RequestID, event.SourceIP, event.UserAgent, event.BeforeHash, event.AfterHash, metadata).
		Scan(&event.Sequence, &event.PreviousEventHash, &event.EventHash, &storedCreatedAt)
	if err != nil {
		return AuditEvent{}, fmt.Errorf("append audit event through secured database function: %w", err)
	}
	event.CreatedAt = string(storedCreatedAt)
	if expectedHash := auditHash(event, metadata); event.EventHash != expectedHash {
		return AuditEvent{}, errors.New("secured audit append returned a mismatched event hash")
	}
	return event, nil
}

func (store *ProjectStore) appendAuditSQLiteTx(ctx context.Context, tx *databaseTx, event AuditEvent, metadata []byte) (AuditEvent, error) {
	if _, err := tx.ExecContext(ctx, `INSERT INTO audit_heads(tenant_id, workspace_id, head_event_hash, last_sequence, chain_version, updated_at)
		VALUES(?, ?, '', 0, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(tenant_id, workspace_id) DO NOTHING`, event.TenantID, event.WorkspaceID, auditChainVersion); err != nil {
		return AuditEvent{}, fmt.Errorf("create audit chain head: %w", err)
	}
	headQuery := `SELECT head_event_hash, last_sequence FROM audit_heads WHERE tenant_id = ? AND workspace_id = ?`
	if store.adapter == AdapterPostgreSQL {
		headQuery += ` FOR UPDATE`
	}
	var previousHash string
	var lastSequence int64
	if err := tx.QueryRowContext(ctx, headQuery, event.TenantID, event.WorkspaceID).Scan(&previousHash, &lastSequence); err != nil {
		return AuditEvent{}, fmt.Errorf("lock audit chain head: %w", err)
	}
	event.PreviousEventHash = previousHash
	event.Sequence = lastSequence + 1
	event.ChainVersion = auditChainVersion
	var err error
	event.CreatedAt, err = canonicalAuditTimestamp(tx, dialectSQLite, event.CreatedAt)
	if err != nil {
		return AuditEvent{}, err
	}
	event.EventHash = auditHash(event, string(metadata))

	_, err = tx.ExecContext(ctx, `INSERT INTO audit_events(id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
		outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json, previous_event_hash, event_hash,
		sequence_number, chain_version, created_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, event.ID, event.TenantID, event.WorkspaceID,
		event.ActorUserID, event.Action, event.ResourceType, event.ResourceID, event.Outcome, event.RequestID, event.SourceIP,
		event.UserAgent, event.BeforeHash, event.AfterHash, tx.json(metadata), event.PreviousEventHash, event.EventHash,
		event.Sequence, event.ChainVersion, tx.timestamp(event.CreatedAt))
	if err != nil {
		return AuditEvent{}, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE audit_heads SET head_event_hash = ?, last_sequence = ?, chain_version = ?, updated_at = CURRENT_TIMESTAMP
		WHERE tenant_id = ? AND workspace_id = ? AND head_event_hash = ? AND last_sequence = ?`, event.EventHash, event.Sequence,
		auditChainVersion, event.TenantID, event.WorkspaceID, previousHash, lastSequence)
	if err != nil {
		return AuditEvent{}, fmt.Errorf("advance audit chain head: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return AuditEvent{}, err
	}
	if affected != 1 {
		return AuditEvent{}, errors.New("audit chain head changed while appending")
	}
	return event, nil
}

type auditTimestampQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

func canonicalAuditTimestamp(database auditTimestampQuerier, dialect databaseDialect, requested string) (string, error) {
	if requested == "" {
		var value timestampText
		query := `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
		if dialect == dialectPostgreSQL {
			query = `SELECT CURRENT_TIMESTAMP`
		}
		if err := database.QueryRow(query).Scan(&value); err != nil {
			return "", fmt.Errorf("read database audit timestamp: %w", err)
		}
		requested = string(value)
	}
	parsed, err := time.Parse(time.RFC3339Nano, requested)
	if err != nil {
		return "", fmt.Errorf("invalid audit timestamp: %w", err)
	}
	// PostgreSQL stores timestamps at microsecond precision. Hashing this exact
	// canonical representation prevents a write/read round trip from changing
	// the bytes covered by the digest.
	return parsed.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano), nil
}

func (store *ProjectStore) ListAudit(scope Scope, limit int) ([]AuditEvent, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	events, err := listAuditEventsContext(context.Background(), tx, scope, limit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return events, nil
}

// ListVerifiedAudit reads, validates, and lists an audit chain from one
// consistent database snapshot. This prevents a concurrent append from being
// visible in only the events query or only the durable-head query.
func (store *ProjectStore) ListVerifiedAudit(ctx context.Context, scope Scope, limit int) ([]AuditEvent, error) {
	tx, err := store.beginAuditSnapshot(ctx, true)
	if err != nil {
		return nil, fmt.Errorf("begin audit read snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setUserRLSContext(scope); err != nil {
		return nil, err
	}

	if err := verifyAuditChainSnapshotContext(ctx, tx, scope); err != nil {
		return nil, err
	}
	events, err := listAuditEventsContext(ctx, tx, scope, limit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit audit read snapshot: %w", err)
	}
	return events, nil
}

// ListVerifiedAuditWithAudit performs the sensitive-read audit in the same
// transaction as verification. The existing chain is validated first; only
// then is the read evidence appended and included in the returned, bounded
// page. A validation, append, or commit failure returns no events.
func (store *ProjectStore) ListVerifiedAuditWithAudit(ctx context.Context, scope Scope, limit int, readEvent AuditEvent) ([]AuditEvent, error) {
	if err := validateAuditReadEvidence(scope, readEvent); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 500 {
		limit = 100
	}
	if readEvent.ID == "" {
		readEvent.ID = uuid.NewString()
	}
	attempts := 1
	if store.adapter == AdapterPostgreSQL {
		attempts = auditSerializationMaxAttempts
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		events, err := store.listVerifiedAuditWithAuditAttempt(ctx, scope, limit, readEvent)
		if err == nil {
			return events, nil
		}
		lastErr = err
		if !isPostgreSQLSerializationFailure(err) || attempt+1 == attempts {
			return nil, err
		}
		if err := waitForAuditSerializationRetry(ctx, auditSerializationRetryDelay(readEvent.ID, attempt)); err != nil {
			return nil, err
		}
	}
	return nil, lastErr
}

// listVerifiedAuditWithAuditAttempt owns exactly one transaction/snapshot.
// PostgreSQL invalidates a REPEATABLE READ transaction with SQLSTATE 40001 if
// another writer advances the head after this snapshot verified it. Retrying
// must therefore begin a fresh transaction instead of reusing the aborted one.
func (store *ProjectStore) listVerifiedAuditWithAuditAttempt(ctx context.Context, scope Scope, limit int, readEvent AuditEvent) ([]AuditEvent, error) {
	tx, err := store.beginAuditSnapshot(ctx, false)
	if err != nil {
		return nil, fmt.Errorf("begin audited audit-read snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setUserRLSContext(scope); err != nil {
		return nil, err
	}

	if err := verifyAuditChainSnapshotContext(ctx, tx, scope); err != nil {
		return nil, err
	}
	events, err := listAuditEventsContext(ctx, tx, scope, limit)
	if err != nil {
		return nil, err
	}
	// The historical page was obtained from the already-verified repeatable-read
	// snapshot. appendAuditTxContext independently recomputes and checks the new
	// event hash returned by PostgreSQL, so a second O(N) graph walk while
	// holding the scope-head lock adds contention without adding evidence.
	appended, err := store.appendAuditTxContext(ctx, tx, readEvent)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrAtomicAuditWrite, err)
	}
	events = append([]AuditEvent{appended}, events...)
	if len(events) > limit && limit > 0 {
		events = events[:limit]
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit audited audit-read snapshot: %w", err)
	}
	return events, nil
}

type postgresSQLStateError interface {
	SQLState() string
}

func isPostgreSQLSerializationFailure(err error) bool {
	var sqlState postgresSQLStateError
	return errors.As(err, &sqlState) && sqlState.SQLState() == "40001"
}

func auditSerializationRetryDelay(eventID string, attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt > auditSerializationMaxAttempts-1 {
		attempt = auditSerializationMaxAttempts - 1
	}
	base := 5 * time.Millisecond * time.Duration(1<<attempt)
	digest := sha256.Sum256([]byte(eventID + ":" + strconv.Itoa(attempt)))
	jitterValue := uint16(digest[0])<<8 | uint16(digest[1])
	jitter := time.Duration(jitterValue) * base / time.Duration(^uint16(0))
	return base + jitter
}

func waitForAuditSerializationRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func validateAuditReadEvidence(scope Scope, event AuditEvent) error {
	if event.TenantID != scope.TenantID || event.WorkspaceID != scope.WorkspaceID || event.ActorUserID != scope.UserID {
		return errors.New("audit read evidence scope does not match authenticated scope")
	}
	if event.Action != "audit.events.read" || event.ResourceType != "audit_log" || event.ResourceID == "" || event.Outcome != "success" {
		return errors.New("audit read evidence must describe a successful scoped audit-log read")
	}
	return nil
}

func (store *ProjectStore) beginAuditSnapshot(ctx context.Context, readOnly bool) (*databaseTx, error) {
	options := &sql.TxOptions{ReadOnly: readOnly}
	if store.database.dialect == dialectPostgreSQL {
		options.Isolation = sql.LevelRepeatableRead
	}
	raw, err := store.database.raw.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &databaseTx{raw: raw, dialect: store.database.dialect}, nil
}

func listAuditEvents(database auditRows, scope Scope, limit int) ([]AuditEvent, error) {
	return listAuditEventsContext(context.Background(), database, scope, limit)
}

func listAuditEventsContext(ctx context.Context, database auditRows, scope Scope, limit int) ([]AuditEvent, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	rows, err := queryAuditRows(ctx, database, `SELECT id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
		outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json, previous_event_hash, event_hash,
		COALESCE(sequence_number, 0), COALESCE(chain_version, 1), created_at
		FROM audit_events WHERE tenant_id = ? AND workspace_id = ?
		ORDER BY CASE WHEN sequence_number IS NULL THEN 1 ELSE 0 END, sequence_number DESC, created_at DESC, id DESC LIMIT ?`,
		scope.TenantID, scope.WorkspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []AuditEvent{}
	for rows.Next() {
		record, err := scanStoredAuditEvent(rows, false)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(record.metadataJSON), &record.event.Metadata); err != nil {
			return nil, err
		}
		events = append(events, record.event)
	}
	return events, rows.Err()
}

// VerifyAuditChain recomputes every digest, walks the predecessor graph, checks
// v2/v3 sequence continuity and monotonic protocol upgrades, and compares the
// terminal event with the durable head.
func (store *ProjectStore) VerifyAuditChain(scope Scope) error {
	tx, err := store.beginAuditSnapshot(context.Background(), true)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setUserRLSContext(scope); err != nil {
		return err
	}
	if err := verifyAuditChainSnapshotContext(context.Background(), tx, scope); err != nil {
		return err
	}
	return tx.Commit()
}

type auditSnapshot interface {
	auditRows
	QueryRow(query string, args ...any) *sql.Row
}

type auditRowsContext interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

type auditRowContext interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func queryAuditRows(ctx context.Context, database auditRows, query string, args ...any) (*sql.Rows, error) {
	if contextual, ok := database.(auditRowsContext); ok {
		return contextual.QueryContext(ctx, query, args...)
	}
	return database.Query(query, args...)
}

func queryAuditRow(ctx context.Context, database auditSnapshot, query string, args ...any) *sql.Row {
	if contextual, ok := database.(auditRowContext); ok {
		return contextual.QueryRowContext(ctx, query, args...)
	}
	return database.QueryRow(query, args...)
}

func verifyAuditChainSnapshot(database auditSnapshot, scope Scope) error {
	return verifyAuditChainSnapshotContext(context.Background(), database, scope)
}

func verifyAuditChainSnapshotContext(ctx context.Context, database auditSnapshot, scope Scope) error {
	records, err := loadStoredAuditEventsContext(ctx, database, scope)
	if err != nil {
		return err
	}
	terminalHash, err := validateStoredAuditEventsContext(ctx, records, true)
	if err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		return fmt.Errorf("%w: %v", ErrAuditChainInvalid, err)
	}
	var headHash string
	var lastSequence int64
	var chainVersion int
	err = queryAuditRow(ctx, database, `SELECT head_event_hash, last_sequence, chain_version FROM audit_heads
		WHERE tenant_id = ? AND workspace_id = ?`, scope.TenantID, scope.WorkspaceID).Scan(&headHash, &lastSequence, &chainVersion)
	if errors.Is(err, sql.ErrNoRows) && len(records) == 0 {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: durable head is missing for %d events", ErrAuditChainInvalid, len(records))
	}
	if err != nil {
		return fmt.Errorf("read audit chain head: %w", err)
	}
	if headHash != terminalHash || lastSequence != int64(len(records)) || chainVersion != auditChainVersion {
		return fmt.Errorf("%w: durable head mismatch: stored sequence %d, events %d", ErrAuditChainInvalid, lastSequence, len(records))
	}
	return nil
}

type auditRows interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func loadStoredAuditEvents(database auditRows, scope Scope) ([]storedAuditEvent, error) {
	return loadStoredAuditEventsContext(context.Background(), database, scope)
}

func loadStoredAuditEventsContext(ctx context.Context, database auditRows, scope Scope) ([]storedAuditEvent, error) {
	postgres := auditRowsUsePostgreSQL(database)
	hashProjection := ""
	if postgres {
		hashProjection = `, COALESCE(hash_metadata_text, '')`
	}
	rows, err := queryAuditRows(ctx, database, `SELECT id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
		outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json, previous_event_hash, event_hash,
		COALESCE(sequence_number, 0), COALESCE(chain_version, 1), created_at
		`+hashProjection+` FROM audit_events WHERE tenant_id = ? AND workspace_id = ?`, scope.TenantID, scope.WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]storedAuditEvent, 0)
	for rows.Next() {
		record, err := scanStoredAuditEvent(rows, postgres)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func loadLegacyStoredAuditEvents(database auditRows, scope Scope) ([]storedAuditEvent, error) {
	rows, err := database.Query(`SELECT id, tenant_id, workspace_id, actor_user_id, action, resource_type, resource_id,
		outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json, previous_event_hash, event_hash,
		created_at FROM audit_events WHERE tenant_id = ? AND workspace_id = ?`, scope.TenantID, scope.WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := make([]storedAuditEvent, 0)
	for rows.Next() {
		var record storedAuditEvent
		var createdAt timestampText
		if err := rows.Scan(&record.event.ID, &record.event.TenantID, &record.event.WorkspaceID, &record.event.ActorUserID,
			&record.event.Action, &record.event.ResourceType, &record.event.ResourceID, &record.event.Outcome, &record.event.RequestID,
			&record.event.SourceIP, &record.event.UserAgent, &record.event.BeforeHash, &record.event.AfterHash, &record.metadataJSON,
			&record.event.PreviousEventHash, &record.event.EventHash, &createdAt); err != nil {
			return nil, err
		}
		record.event.ChainVersion = 1
		record.event.CreatedAt = string(createdAt)
		record.legacyTimestampMicrosecondLoss = auditRowsUsePostgreSQL(database)
		records = append(records, record)
	}
	return records, rows.Err()
}

func scanStoredAuditEvent(row rowScanner, includeHashMetadata bool) (storedAuditEvent, error) {
	var record storedAuditEvent
	var createdAt timestampText
	destinations := []any{&record.event.ID, &record.event.TenantID, &record.event.WorkspaceID, &record.event.ActorUserID,
		&record.event.Action, &record.event.ResourceType, &record.event.ResourceID, &record.event.Outcome, &record.event.RequestID,
		&record.event.SourceIP, &record.event.UserAgent, &record.event.BeforeHash, &record.event.AfterHash, &record.metadataJSON,
		&record.event.PreviousEventHash, &record.event.EventHash, &record.event.Sequence, &record.event.ChainVersion, &createdAt}
	if includeHashMetadata {
		destinations = append(destinations, &record.hashMetadataText)
		record.legacyTimestampMicrosecondLoss = true
	}
	if err := row.Scan(destinations...); err != nil {
		return storedAuditEvent{}, err
	}
	record.event.CreatedAt = string(createdAt)
	return record, nil
}

func validateStoredAuditEvents(records []storedAuditEvent, verifyHashes bool) (string, error) {
	return validateStoredAuditEventsContext(context.Background(), records, verifyHashes)
}

func validateStoredAuditEventsContext(ctx context.Context, records []storedAuditEvent, verifyHashes bool) (string, error) {
	if len(records) == 0 {
		return "", nil
	}
	byHash := make(map[string]storedAuditEvent, len(records))
	children := make(map[string][]string, len(records))
	roots := make([]string, 0, 1)
	for _, record := range records {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		event := record.event
		if event.EventHash == "" {
			return "", errors.New("audit event has an empty hash")
		}
		if _, exists := byHash[event.EventHash]; exists {
			return "", fmt.Errorf("duplicate audit event hash %s", event.EventHash)
		}
		if event.ChainVersion == 1 {
			if event.Sequence != 0 {
				return "", fmt.Errorf("legacy audit event %s has a sequence", event.ID)
			}
		} else if event.ChainVersion < 2 || event.ChainVersion > auditChainVersion || event.Sequence < 1 {
			return "", fmt.Errorf("audit event %s has an unsupported chain version or sequence", event.ID)
		}
		if verifyHashes {
			metadata, err := canonicalAuditMetadata(record.metadataJSON)
			if err != nil {
				return "", fmt.Errorf("canonicalize audit metadata for %s: %w", event.ID, err)
			}
			if record.hashMetadataText != "" {
				hashMetadata, err := canonicalAuditMetadata(record.hashMetadataText)
				if err != nil {
					return "", fmt.Errorf("canonicalize stored audit hash metadata for %s: %w", event.ID, err)
				}
				if hashMetadata != metadata {
					return "", fmt.Errorf("audit event %s hash metadata differs from stored metadata", event.ID)
				}
				metadata = record.hashMetadataText
			}
			matches, err := storedAuditHashMatchesContext(ctx, record, metadata)
			if err != nil {
				return "", fmt.Errorf("verify audit event %s hash: %w", event.ID, err)
			}
			if !matches {
				return "", fmt.Errorf("audit event %s hash mismatch", event.ID)
			}
		}
		byHash[event.EventHash] = record
		if event.PreviousEventHash == "" {
			roots = append(roots, event.EventHash)
		} else {
			children[event.PreviousEventHash] = append(children[event.PreviousEventHash], event.EventHash)
		}
	}
	if len(roots) != 1 {
		return "", fmt.Errorf("audit chain has %d roots", len(roots))
	}
	for previous, next := range children {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if _, exists := byHash[previous]; !exists {
			return "", fmt.Errorf("audit chain predecessor %s is missing", previous)
		}
		if len(next) != 1 {
			return "", fmt.Errorf("audit chain forks after %s", previous)
		}
	}

	visited := make(map[string]bool, len(records))
	current := roots[0]
	lastChainVersion := 1
	for position := 1; current != ""; position++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if visited[current] {
			return "", fmt.Errorf("audit chain contains a cycle at %s", current)
		}
		visited[current] = true
		event := byHash[current].event
		if event.ChainVersion >= 2 {
			if event.Sequence != int64(position) {
				return "", fmt.Errorf("audit event %s has sequence %d, expected %d", event.ID, event.Sequence, position)
			}
		}
		if event.ChainVersion < lastChainVersion {
			return "", fmt.Errorf("audit event %s moves chain version backward from v%d to v%d", event.ID, lastChainVersion, event.ChainVersion)
		}
		lastChainVersion = event.ChainVersion
		next := children[current]
		if len(next) == 0 {
			break
		}
		current = next[0]
	}
	if len(visited) != len(records) {
		return "", fmt.Errorf("audit chain reaches %d of %d events", len(visited), len(records))
	}
	return current, nil
}

func auditRowsUsePostgreSQL(database auditRows) bool {
	switch value := database.(type) {
	case *databaseHandle:
		return value != nil && value.dialect == dialectPostgreSQL
	case *databaseTx:
		return value != nil && value.dialect == dialectPostgreSQL
	default:
		return false
	}
}

// storedAuditHashMatches recovers the historical nanoseconds that pgx v5
// intentionally truncated while encoding TIMESTAMPTZ. Every one of the 1,000
// possible RFC3339Nano values mapping to the stored microsecond is tested, and
// exactly one must match the persisted v1 digest. Topology validation still
// runs independently, so this compatibility path does not skip chain checks.
func storedAuditHashMatches(record storedAuditEvent, metadata string) (bool, error) {
	return storedAuditHashMatchesContext(context.Background(), record, metadata)
}

func storedAuditHashMatchesContext(ctx context.Context, record storedAuditEvent, metadata string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if auditHash(record.event, metadata) == record.event.EventHash {
		return true, nil
	}
	if record.event.ChainVersion != 1 || !record.legacyTimestampMicrosecondLoss {
		return false, nil
	}
	storedTimestamp, err := time.Parse(time.RFC3339Nano, record.event.CreatedAt)
	if err != nil {
		return false, err
	}
	storedTimestamp = storedTimestamp.UTC()
	if !storedTimestamp.Equal(storedTimestamp.Truncate(time.Microsecond)) {
		return false, errors.New("stored PostgreSQL legacy timestamp is not microsecond-aligned")
	}
	matches := 0
	for nanosecondRemainder := 1; nanosecondRemainder < int(time.Microsecond); nanosecondRemainder++ {
		if nanosecondRemainder%64 == 0 {
			if err := ctx.Err(); err != nil {
				return false, err
			}
		}
		candidate := record.event
		candidate.CreatedAt = storedTimestamp.Add(time.Duration(nanosecondRemainder)).Format(time.RFC3339Nano)
		if auditHashV1(candidate, metadata) == record.event.EventHash {
			matches++
		}
	}
	if matches > 1 {
		return false, errors.New("legacy timestamp hash recovery is ambiguous")
	}
	return matches == 1, nil
}

func canonicalAuditMetadata(raw string) (string, error) {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return "", errors.New("audit metadata contains multiple JSON values")
		}
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func auditHash(event AuditEvent, metadata string) string {
	if event.ChainVersion <= 1 {
		return auditHashV1(event, metadata)
	}
	if event.ChainVersion == 2 {
		return auditHashV2(event, metadata)
	}
	if event.ChainVersion == 3 {
		return auditHashV3(event, metadata)
	}
	return ""
}

func auditHashV2(event AuditEvent, metadata string) string {
	canonical := "skyviewlab.audit.v2\n" + strconv.Itoa(event.ChainVersion) + "\n" + strconv.FormatInt(event.Sequence, 10) + "\n" +
		event.ID + "\n" + event.TenantID + "\n" + event.WorkspaceID + "\n" + event.ActorUserID + "\n" + event.Action + "\n" +
		event.ResourceType + "\n" + event.ResourceID + "\n" + event.Outcome + "\n" + event.RequestID + "\n" + event.SourceIP + "\n" +
		event.UserAgent + "\n" + event.BeforeHash + "\n" + event.AfterHash + "\n" + metadata + "\n" + event.PreviousEventHash + "\n" + event.CreatedAt
	return sha256Hex(canonical)
}

func auditHashV3(event AuditEvent, metadata string) string {
	return sha256Hex(auditCanonicalV3(event, metadata))
}

func auditCanonicalV3(event AuditEvent, metadata string) string {
	fields := [...]struct {
		name  string
		value string
	}{
		{name: "format", value: "skyviewlab.audit.v3"},
		{name: "chain_version", value: strconv.Itoa(event.ChainVersion)},
		{name: "sequence_number", value: strconv.FormatInt(event.Sequence, 10)},
		{name: "id", value: event.ID},
		{name: "tenant_id", value: event.TenantID},
		{name: "workspace_id", value: event.WorkspaceID},
		{name: "actor_user_id", value: event.ActorUserID},
		{name: "action", value: event.Action},
		{name: "resource_type", value: event.ResourceType},
		{name: "resource_id", value: event.ResourceID},
		{name: "outcome", value: event.Outcome},
		{name: "request_id", value: event.RequestID},
		{name: "source_ip", value: event.SourceIP},
		{name: "user_agent", value: event.UserAgent},
		{name: "before_hash", value: event.BeforeHash},
		{name: "after_hash", value: event.AfterHash},
		{name: "metadata_json", value: metadata},
		{name: "previous_event_hash", value: event.PreviousEventHash},
		{name: "created_at", value: event.CreatedAt},
	}
	var canonical strings.Builder
	for _, field := range fields {
		writeAuditV3Frame(&canonical, field.name, field.value)
	}
	return canonical.String()
}

// writeAuditV3Frame encodes both the field name and value using their UTF-8
// byte lengths. Frames need no delimiter: a verifier reads decimal digits up
// to ':', then consumes exactly that many bytes. This binds field boundaries
// even when values contain newlines, colons, Unicode, or decimal text.
func writeAuditV3Frame(destination *strings.Builder, name, value string) {
	destination.WriteString(strconv.Itoa(len([]byte(name))))
	destination.WriteByte(':')
	destination.WriteString(name)
	destination.WriteString(strconv.Itoa(len([]byte(value))))
	destination.WriteByte(':')
	destination.WriteString(value)
}

func auditHashV1(event AuditEvent, metadata string) string {
	canonical := event.ID + "\n" + event.TenantID + "\n" + event.WorkspaceID + "\n" + event.ActorUserID + "\n" + event.Action + "\n" +
		event.ResourceType + "\n" + event.ResourceID + "\n" + event.Outcome + "\n" + event.RequestID + "\n" + event.SourceIP + "\n" +
		event.UserAgent + "\n" + event.BeforeHash + "\n" + event.AfterHash + "\n" + metadata + "\n" + event.PreviousEventHash + "\n" + event.CreatedAt
	return sha256Hex(canonical)
}

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
