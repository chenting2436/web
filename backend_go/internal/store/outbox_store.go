package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const outboxTimeLayout = "2006-01-02T15:04:05.000000000Z07:00"

const (
	DefaultOutboxLease       = 30 * time.Second
	DefaultOutboxMaxAttempts = 10
	maximumOutboxLease       = 24 * time.Hour
)

var (
	ErrOutboxEventConflict = errors.New("outbox event ID reused with different content")
	ErrOutboxTransition    = errors.New("invalid outbox event transition or expired claim")
	outboxRelayEventType   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)
)

type OutboxEvent struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenantId"`
	WorkspaceID   string         `json:"workspaceId"`
	AggregateType string         `json:"aggregateType"`
	AggregateID   string         `json:"aggregateId"`
	EventType     string         `json:"eventType"`
	Payload       map[string]any `json:"payload"`
	Attempt       int            `json:"attempt"`
	MaxAttempts   int            `json:"maxAttempts"`
	AvailableAt   string         `json:"availableAt"`
	ClaimedAt     string         `json:"claimedAt,omitempty"`
	ClaimedBy     string         `json:"claimedBy,omitempty"`
	ProcessedAt   string         `json:"processedAt,omitempty"`
	DeadLetterAt  string         `json:"deadLetterAt,omitempty"`
	LastError     string         `json:"lastError,omitempty"`
	CreatedAt     string         `json:"createdAt"`
	UpdatedAt     string         `json:"updatedAt"`
}

// OutboxClaim is a relay-only capability. The raw token is never stored in the
// database or embedded in OutboxEvent/Payload.
type OutboxClaim struct {
	Event          OutboxEvent `json:"event"`
	ClaimToken     string      `json:"claimToken"`
	ClaimEpoch     int64       `json:"claimEpoch"`
	LeaseExpiresAt string      `json:"leaseExpiresAt"`
}

type OutboxLease struct {
	ClaimEpoch     int64  `json:"claimEpoch"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

// Outbox relay credentials are intentionally separate from compute Worker
// credentials. A compute token can enqueue its own job lifecycle event inside
// the job transaction, but it can never read, acknowledge, retry, or dead-letter
// integration messages.
type OutboxRelayScope struct {
	TenantID    string
	WorkspaceID string
	EventTypes  []string
}

type OutboxRelayAccess struct {
	RelayID string
	Scopes  []OutboxRelayScope
}

type postgresOutboxRelayScope struct {
	TenantID    string   `json:"tenantId"`
	WorkspaceID string   `json:"workspaceId"`
	EventTypes  []string `json:"eventTypes"`
}

func validateAndEncodeOutboxRelayAccess(access OutboxRelayAccess) (string, error) {
	if err := validateRLSValue("relay id", access.RelayID, 128, true); err != nil {
		return "", err
	}
	if len(access.Scopes) == 0 || len(access.Scopes) > 64 {
		return "", errors.New("outbox relay requires between 1 and 64 exact scopes")
	}
	encodedScopes := make([]postgresOutboxRelayScope, len(access.Scopes))
	seen := make(map[string]struct{}, len(access.Scopes))
	for index, scope := range access.Scopes {
		if err := validateScopeBoundary(scope.TenantID, scope.WorkspaceID); err != nil {
			return "", fmt.Errorf("outbox relay scope %d: %w", index, err)
		}
		boundary := scope.TenantID + "\x00" + scope.WorkspaceID
		if _, exists := seen[boundary]; exists {
			return "", fmt.Errorf("outbox relay scope %d duplicates tenant/workspace boundary", index)
		}
		seen[boundary] = struct{}{}
		if len(scope.EventTypes) == 0 || len(scope.EventTypes) > 256 {
			return "", fmt.Errorf("outbox relay scope %d requires a bounded event type allowlist", index)
		}
		eventTypes := make([]string, len(scope.EventTypes))
		seenTypes := make(map[string]struct{}, len(scope.EventTypes))
		for eventIndex, eventType := range scope.EventTypes {
			if eventType != strings.TrimSpace(eventType) || !outboxRelayEventType.MatchString(eventType) {
				return "", fmt.Errorf("outbox relay scope %d contains invalid event type", index)
			}
			if _, exists := seenTypes[eventType]; exists {
				return "", fmt.Errorf("outbox relay scope %d duplicates event type %q", index, eventType)
			}
			seenTypes[eventType] = struct{}{}
			eventTypes[eventIndex] = eventType
		}
		encodedScopes[index] = postgresOutboxRelayScope{
			TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, EventTypes: eventTypes,
		}
	}
	encoded, err := json.Marshal(encodedScopes)
	return string(encoded), err
}

// EnqueueOutbox creates a standalone transaction for callers that do not
// already own one. Business mutations should call enqueueTx with their existing
// databaseTx so the mutation and event commit or roll back together.
func (store *ProjectStore) EnqueueOutbox(event OutboxEvent) (OutboxEvent, bool, error) {
	tx, err := store.database.Begin()
	if err != nil {
		return OutboxEvent{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setSystemRLSContext(event.TenantID, event.WorkspaceID, "outbox-enqueue"); err != nil {
		return OutboxEvent{}, false, err
	}
	created, inserted, err := store.enqueueTx(tx, event)
	if err != nil {
		return OutboxEvent{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return OutboxEvent{}, false, err
	}
	return created, inserted, nil
}

func (store *ProjectStore) enqueueTx(tx *databaseTx, event OutboxEvent) (OutboxEvent, bool, error) {
	if tx == nil || tx.raw == nil {
		return OutboxEvent{}, false, errors.New("outbox enqueue requires an active transaction")
	}
	if err := validateOutboxEvent(event); err != nil {
		return OutboxEvent{}, false, err
	}
	if event.ID == "" {
		event.ID = uuid.NewString()
	}
	event.TenantID = strings.TrimSpace(event.TenantID)
	event.WorkspaceID = strings.TrimSpace(event.WorkspaceID)
	event.AggregateType = strings.TrimSpace(event.AggregateType)
	event.AggregateID = strings.TrimSpace(event.AggregateID)
	event.EventType = strings.TrimSpace(event.EventType)
	if err := tx.setOutboxEnqueueRLSContext(event); err != nil {
		return OutboxEvent{}, false, err
	}
	if event.Payload == nil {
		event.Payload = map[string]any{}
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return OutboxEvent{}, false, err
	}
	event.Attempt = 0
	event.MaxAttempts = DefaultOutboxMaxAttempts
	event.ClaimedAt, event.ClaimedBy, event.ProcessedAt, event.DeadLetterAt, event.LastError = "", "", "", "", ""
	nowExpression := databaseNowExpression(store.adapter)
	availableExpression := nowExpression
	arguments := []any{event.ID, event.TenantID, event.WorkspaceID, event.AggregateType, event.AggregateID,
		event.EventType, tx.json(payload), event.MaxAttempts}
	if strings.TrimSpace(event.AvailableAt) != "" {
		availableAt, err := normalizeOutboxTime(event.AvailableAt, time.Time{})
		if err != nil {
			return OutboxEvent{}, false, fmt.Errorf("invalid outbox available time: %w", err)
		}
		event.AvailableAt = availableAt
		availableExpression = "?"
		arguments = append(arguments, tx.timestamp(availableAt))
	}

	result, err := tx.Exec(`INSERT INTO outbox_events(id, tenant_id, workspace_id, aggregate_type, aggregate_id, event_type,
		payload_json, attempt, max_attempts, available_at, claimed_at, claimed_by, processed_at, dead_letter_at,
		last_error, created_at, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, `+availableExpression+`, NULL, '', NULL, NULL, '', `+nowExpression+`, `+nowExpression+`)
		ON CONFLICT(id) DO NOTHING`, arguments...)
	if err != nil {
		return OutboxEvent{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return OutboxEvent{}, false, err
	}
	if affected == 1 {
		created, err := getOutboxTx(tx, event.ID)
		return created, true, err
	}
	existing, err := getOutboxTx(tx, event.ID)
	if err != nil {
		return OutboxEvent{}, false, err
	}
	if !sameOutboxMessage(existing, event) {
		return OutboxEvent{}, false, ErrOutboxEventConflict
	}
	return existing, false, nil
}

func (store *ProjectStore) GetOutbox(scope Scope, id string) (OutboxEvent, bool, error) {
	tx, err := store.beginUserTransaction(context.Background(), scope)
	if err != nil {
		return OutboxEvent{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	event, err := scanOutbox(tx.QueryRow(outboxSelect+` WHERE tenant_id = ? AND workspace_id = ? AND id = ?`, scope.TenantID, scope.WorkspaceID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return OutboxEvent{}, false, nil
	}
	if err != nil {
		return OutboxEvent{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return OutboxEvent{}, false, err
	}
	return event, true, nil
}

// ClaimNextOutbox atomically claims either an available event or an event whose
// prior lease expired. Exhausted events are dead-lettered before searching for
// another event. All eligibility checks use database time.
func (store *ProjectStore) ClaimNextOutbox(workerID string, leaseDuration time.Duration) (OutboxClaim, bool, error) {
	return store.claimNextOutbox(nil, workerID, leaseDuration)
}

func (store *ProjectStore) ClaimNextOutboxForRelay(access OutboxRelayAccess, leaseDuration time.Duration) (OutboxClaim, bool, error) {
	return store.claimNextOutbox(&access, access.RelayID, leaseDuration)
}

func (store *ProjectStore) claimNextOutbox(access *OutboxRelayAccess, workerID string, leaseDuration time.Duration) (OutboxClaim, bool, error) {
	workerID = strings.TrimSpace(workerID)
	leaseSeconds, err := normalizedLeaseSeconds(workerID, leaseDuration, maximumOutboxLease)
	if err != nil {
		return OutboxClaim{}, false, err
	}
	for {
		tx, err := store.database.Begin()
		if err != nil {
			return OutboxClaim{}, false, err
		}
		if access != nil {
			if err := tx.setRelayRLSContext(*access); err != nil {
				_ = tx.Rollback()
				return OutboxClaim{}, false, err
			}
		} else if store.adapter == AdapterPostgreSQL {
			_ = tx.Rollback()
			return OutboxClaim{}, false, errors.New("PostgreSQL outbox claim requires exact relay access")
		}
		var id string
		var attempt, maxAttempts int
		err = tx.QueryRow(outboxClaimQuery(store.adapter)).Scan(&id, &attempt, &maxAttempts)
		if errors.Is(err, sql.ErrNoRows) {
			_ = tx.Rollback()
			return OutboxClaim{}, false, nil
		}
		if err != nil {
			_ = tx.Rollback()
			return OutboxClaim{}, false, err
		}
		if attempt >= maxAttempts {
			if err := store.deadLetterExhaustedOutboxTx(tx, id); err != nil {
				_ = tx.Rollback()
				return OutboxClaim{}, false, err
			}
			if err := tx.Commit(); err != nil {
				return OutboxClaim{}, false, err
			}
			continue
		}

		token, tokenHash, err := newClaimToken()
		if err != nil {
			_ = tx.Rollback()
			return OutboxClaim{}, false, err
		}
		nowExpression := databaseNowExpression(store.adapter)
		leaseExpression := databaseLeaseExpression(store.adapter)
		result, err := tx.Exec(`UPDATE outbox_events SET attempt = attempt + 1, claim_epoch = claim_epoch + 1,
			claimed_at = `+nowExpression+`, claimed_by = ?, claim_token_hash = ?, lease_expires_at = `+leaseExpression+`,
			last_error = '', updated_at = `+nowExpression+` WHERE id = ? AND processed_at IS NULL
			AND dead_letter_at IS NULL AND available_at <= `+nowExpression+` AND attempt < max_attempts
			AND (claimed_at IS NULL OR lease_expires_at <= `+nowExpression+`)`, workerID, tokenHash, leaseSeconds, id)
		if err != nil {
			_ = tx.Rollback()
			return OutboxClaim{}, false, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			_ = tx.Rollback()
			return OutboxClaim{}, false, err
		}
		if affected == 0 {
			_ = tx.Rollback()
			continue
		}
		claim, err := getOutboxClaimTx(tx, id, token)
		if err != nil {
			_ = tx.Rollback()
			return OutboxClaim{}, false, err
		}
		if err := tx.Commit(); err != nil {
			return OutboxClaim{}, false, err
		}
		return claim, true, nil
	}
}

func outboxClaimQuery(adapter string) string {
	nowExpression := databaseNowExpression(adapter)
	query := `SELECT id, attempt, max_attempts FROM outbox_events
		WHERE processed_at IS NULL AND dead_letter_at IS NULL AND available_at <= ` + nowExpression + `
		AND (claimed_at IS NULL OR lease_expires_at <= ` + nowExpression + `)
		ORDER BY available_at, created_at, id LIMIT 1`
	if adapter == AdapterPostgreSQL {
		query += ` FOR UPDATE SKIP LOCKED`
	}
	return query
}

func (store *ProjectStore) deadLetterExhaustedOutboxTx(tx *databaseTx, id string) error {
	nowExpression := databaseNowExpression(store.adapter)
	_, err := tx.Exec(`UPDATE outbox_events SET claimed_at = NULL, claimed_by = '', claim_token_hash = '',
		lease_expires_at = NULL, dead_letter_at = `+nowExpression+`,
		last_error = CASE WHEN last_error = '' THEN 'maximum outbox delivery attempts exhausted' ELSE last_error END,
		updated_at = `+nowExpression+` WHERE id = ? AND processed_at IS NULL AND dead_letter_at IS NULL
		AND attempt >= max_attempts AND (claimed_at IS NULL OR lease_expires_at <= `+nowExpression+`)`, id)
	return err
}

func (store *ProjectStore) AckOutbox(id, workerID, claimToken string) (OutboxEvent, bool, error) {
	return store.transitionOutbox(nil, id, workerID, claimToken, "", 0, true)
}

func (store *ProjectStore) AckOutboxForRelay(access OutboxRelayAccess, id, claimToken string) (OutboxEvent, bool, error) {
	return store.transitionOutbox(&access, id, access.RelayID, claimToken, "", 0, true)
}

// FailOutbox releases a live claim for retry, or dead-letters it immediately
// when the claim has consumed max_attempts. retryDelay is measured from the
// database clock, not from a caller-provided timestamp.
func (store *ProjectStore) FailOutbox(id, workerID, claimToken, lastError string, retryDelay time.Duration) (OutboxEvent, bool, error) {
	if retryDelay < 0 || retryDelay > 30*24*time.Hour {
		return OutboxEvent{}, false, errors.New("outbox retry delay is outside the allowed range")
	}
	return store.transitionOutbox(nil, id, workerID, claimToken, truncateOutboxError(lastError), retryDelay, false)
}

func (store *ProjectStore) FailOutboxForRelay(access OutboxRelayAccess, id, claimToken, lastError string, retryDelay time.Duration) (OutboxEvent, bool, error) {
	if retryDelay < 0 || retryDelay > 30*24*time.Hour {
		return OutboxEvent{}, false, errors.New("outbox retry delay is outside the allowed range")
	}
	return store.transitionOutbox(&access, id, access.RelayID, claimToken, truncateOutboxError(lastError), retryDelay, false)
}

func (store *ProjectStore) transitionOutbox(access *OutboxRelayAccess, id, workerID, claimToken, lastError string, retryDelay time.Duration, acknowledge bool) (OutboxEvent, bool, error) {
	id, workerID, claimToken = strings.TrimSpace(id), strings.TrimSpace(workerID), strings.TrimSpace(claimToken)
	if id == "" || workerID == "" || claimToken == "" {
		return OutboxEvent{}, false, ErrOutboxTransition
	}
	tx, err := store.database.Begin()
	if err != nil {
		return OutboxEvent{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if access != nil {
		if err := tx.setRelayRLSContext(*access); err != nil {
			return OutboxEvent{}, false, err
		}
	} else if store.adapter == AdapterPostgreSQL {
		return OutboxEvent{}, false, errors.New("PostgreSQL outbox transition requires exact relay access")
	}
	existing, err := getOutboxTx(tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return OutboxEvent{}, false, nil
	}
	if err != nil {
		return OutboxEvent{}, false, err
	}
	nowExpression := databaseNowExpression(store.adapter)
	tokenHash := claimTokenDigest(claimToken)
	var result sql.Result
	if acknowledge {
		result, err = tx.Exec(`UPDATE outbox_events SET processed_at = `+nowExpression+`, claimed_at = NULL,
			claimed_by = '', claim_token_hash = '', lease_expires_at = NULL, last_error = '', updated_at = `+nowExpression+`
			WHERE id = ? AND processed_at IS NULL AND dead_letter_at IS NULL AND claimed_by = ?
			AND claim_token_hash = ? AND lease_expires_at > `+nowExpression, id, workerID, tokenHash)
	} else if existing.Attempt >= existing.MaxAttempts {
		if lastError == "" {
			lastError = "maximum outbox delivery attempts exhausted"
		}
		result, err = tx.Exec(`UPDATE outbox_events SET dead_letter_at = `+nowExpression+`, claimed_at = NULL,
			claimed_by = '', claim_token_hash = '', lease_expires_at = NULL, last_error = ?, updated_at = `+nowExpression+`
			WHERE id = ? AND processed_at IS NULL AND dead_letter_at IS NULL AND claimed_by = ?
			AND claim_token_hash = ? AND lease_expires_at > `+nowExpression, lastError, id, workerID, tokenHash)
	} else {
		retrySeconds := int64(retryDelay / time.Second)
		if retryDelay%time.Second != 0 {
			retrySeconds++
		}
		result, err = tx.Exec(`UPDATE outbox_events SET available_at = `+databaseLeaseExpression(store.adapter)+`,
			claimed_at = NULL, claimed_by = '', claim_token_hash = '', lease_expires_at = NULL,
			last_error = ?, updated_at = `+nowExpression+` WHERE id = ? AND processed_at IS NULL
			AND dead_letter_at IS NULL AND claimed_by = ? AND claim_token_hash = ? AND lease_expires_at > `+nowExpression,
			retrySeconds, lastError, id, workerID, tokenHash)
	}
	if err != nil {
		return OutboxEvent{}, true, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return OutboxEvent{}, true, err
	}
	if affected == 0 {
		return existing, true, ErrOutboxTransition
	}
	updated, err := getOutboxTx(tx, id)
	if err != nil {
		return OutboxEvent{}, true, err
	}
	if err := tx.Commit(); err != nil {
		return OutboxEvent{}, true, err
	}
	return updated, true, nil
}

func (store *ProjectStore) HeartbeatOutbox(id, workerID, claimToken string, leaseDuration time.Duration) (OutboxLease, bool, error) {
	return store.heartbeatOutbox(nil, id, workerID, claimToken, leaseDuration)
}

func (store *ProjectStore) HeartbeatOutboxForRelay(access OutboxRelayAccess, id, claimToken string, leaseDuration time.Duration) (OutboxLease, bool, error) {
	return store.heartbeatOutbox(&access, id, access.RelayID, claimToken, leaseDuration)
}

func (store *ProjectStore) heartbeatOutbox(access *OutboxRelayAccess, id, workerID, claimToken string, leaseDuration time.Duration) (OutboxLease, bool, error) {
	workerID = strings.TrimSpace(workerID)
	leaseSeconds, err := normalizedLeaseSeconds(workerID, leaseDuration, maximumOutboxLease)
	if err != nil || strings.TrimSpace(id) == "" || strings.TrimSpace(claimToken) == "" {
		if err != nil {
			return OutboxLease{}, false, err
		}
		return OutboxLease{}, false, ErrOutboxTransition
	}
	tx, err := store.database.Begin()
	if err != nil {
		return OutboxLease{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if access != nil {
		if err := tx.setRelayRLSContext(*access); err != nil {
			return OutboxLease{}, false, err
		}
	} else if store.adapter == AdapterPostgreSQL {
		return OutboxLease{}, false, errors.New("PostgreSQL outbox heartbeat requires exact relay access")
	}
	nowExpression := databaseNowExpression(store.adapter)
	result, err := tx.Exec(`UPDATE outbox_events SET lease_expires_at = `+databaseLeaseExpression(store.adapter)+`,
		updated_at = `+nowExpression+` WHERE id = ? AND processed_at IS NULL AND dead_letter_at IS NULL
		AND claimed_by = ? AND claim_token_hash = ? AND lease_expires_at > `+nowExpression,
		leaseSeconds, id, workerID, claimTokenDigest(claimToken))
	if err != nil {
		return OutboxLease{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return OutboxLease{}, false, err
	}
	if affected == 0 {
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM outbox_events WHERE id = ?`, id).Scan(&exists); err != nil {
			return OutboxLease{}, false, err
		}
		return OutboxLease{}, exists > 0, ErrOutboxTransition
	}
	lease, err := getOutboxLeaseTx(tx, id)
	if err != nil {
		return OutboxLease{}, true, err
	}
	if err := tx.Commit(); err != nil {
		return OutboxLease{}, true, err
	}
	return lease, true, nil
}

const outboxSelect = `SELECT id, tenant_id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json,
	attempt, max_attempts, available_at, claimed_at, claimed_by, processed_at, dead_letter_at, last_error, created_at, updated_at FROM outbox_events`

func getOutboxTx(tx *databaseTx, id string) (OutboxEvent, error) {
	return scanOutbox(tx.QueryRow(outboxSelect+` WHERE id = ?`, id))
}

func getOutboxClaimTx(tx *databaseTx, id, token string) (OutboxClaim, error) {
	event, err := getOutboxTx(tx, id)
	if err != nil {
		return OutboxClaim{}, err
	}
	var claim OutboxClaim
	var leaseExpiresAt timestampText
	if err := tx.QueryRow(`SELECT claim_epoch, lease_expires_at FROM outbox_events WHERE id = ?`, id).
		Scan(&claim.ClaimEpoch, &leaseExpiresAt); err != nil {
		return OutboxClaim{}, err
	}
	claim.Event = event
	claim.ClaimToken = token
	claim.LeaseExpiresAt = string(leaseExpiresAt)
	return claim, nil
}

func getOutboxLeaseTx(tx *databaseTx, id string) (OutboxLease, error) {
	var lease OutboxLease
	var leaseExpiresAt timestampText
	if err := tx.QueryRow(`SELECT claim_epoch, lease_expires_at FROM outbox_events WHERE id = ?`, id).
		Scan(&lease.ClaimEpoch, &leaseExpiresAt); err != nil {
		return OutboxLease{}, err
	}
	lease.LeaseExpiresAt = string(leaseExpiresAt)
	return lease, nil
}

func scanOutbox(row rowScanner) (OutboxEvent, error) {
	var event OutboxEvent
	var payload string
	var availableAt, claimedAt, processedAt, deadLetterAt, createdAt, updatedAt timestampText
	if err := row.Scan(&event.ID, &event.TenantID, &event.WorkspaceID, &event.AggregateType, &event.AggregateID,
		&event.EventType, &payload, &event.Attempt, &event.MaxAttempts, &availableAt, &claimedAt, &event.ClaimedBy,
		&processedAt, &deadLetterAt, &event.LastError, &createdAt, &updatedAt); err != nil {
		return OutboxEvent{}, err
	}
	event.AvailableAt, event.ClaimedAt, event.ProcessedAt, event.DeadLetterAt =
		string(availableAt), string(claimedAt), string(processedAt), string(deadLetterAt)
	event.CreatedAt, event.UpdatedAt = string(createdAt), string(updatedAt)
	if err := json.Unmarshal([]byte(payload), &event.Payload); err != nil {
		return OutboxEvent{}, fmt.Errorf("decode outbox payload: %w", err)
	}
	return event, nil
}

func validateOutboxEvent(event OutboxEvent) error {
	values := map[string]string{
		"tenant ID": event.TenantID, "workspace ID": event.WorkspaceID,
		"aggregate type": event.AggregateType, "aggregate ID": event.AggregateID, "event type": event.EventType,
	}
	for name, value := range values {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("outbox %s is required", name)
		}
	}
	if len(event.ID) > 256 || len(event.AggregateType) > 128 || len(event.AggregateID) > 256 || len(event.EventType) > 256 {
		return errors.New("outbox identifier exceeds limit")
	}
	return nil
}

func normalizeOutboxTime(value string, fallback time.Time) (string, error) {
	if strings.TrimSpace(value) == "" {
		return fallback.UTC().Format(outboxTimeLayout), nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", err
	}
	return parsed.UTC().Format(outboxTimeLayout), nil
}

func sameOutboxMessage(left, right OutboxEvent) bool {
	leftPayload, leftErr := json.Marshal(left.Payload)
	rightPayload, rightErr := json.Marshal(right.Payload)
	return leftErr == nil && rightErr == nil && left.ID == right.ID && left.TenantID == right.TenantID &&
		left.WorkspaceID == right.WorkspaceID && left.AggregateType == right.AggregateType &&
		left.AggregateID == right.AggregateID && left.EventType == right.EventType && string(leftPayload) == string(rightPayload)
}

func truncateOutboxError(value string) string {
	characters := []rune(strings.TrimSpace(value))
	if len(characters) > 4096 {
		characters = characters[:4096]
	}
	return string(characters)
}
