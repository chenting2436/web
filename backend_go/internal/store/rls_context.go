package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	rlsActorUser   = "user"
	rlsActorOIDC   = "oidc"
	rlsActorWorker = "worker"
	rlsActorRelay  = "relay"
	rlsActorSystem = "system"
)

// rlsContext is deliberately internal to the durable store. HTTP headers and
// request payloads never reach PostgreSQL session state directly: callers must
// first resolve a server-authenticated Scope or JobClaimAccess.
type rlsContext struct {
	ActorKind   string
	TenantID    string
	WorkspaceID string
	UserID      string
	Role        string
	WorkerID    string
	WorkerScope string
	RelayID     string
	RelayScope  string
}

type postgresWorkerCapability struct {
	TenantID    string   `json:"tenantId"`
	WorkspaceID string   `json:"workspaceId"`
	Slug        string   `json:"slug"`
	Actions     []string `json:"actions"`
}

// setRLSContext writes every application GUC on every PostgreSQL transaction.
// pg_catalog.set_config(..., true) is the parameter-safe form of SET LOCAL:
// all values disappear at COMMIT/ROLLBACK and therefore cannot leak through
// database/sql's pooled physical connections.
func (tx *databaseTx) setRLSContext(context rlsContext) error {
	if tx == nil {
		return errors.New("database transaction is required for RLS context")
	}
	if tx.dialect != dialectPostgreSQL {
		return nil
	}
	if err := validateRLSValue("actor kind", context.ActorKind, 16, true); err != nil {
		return err
	}
	for name, value := range map[string]string{
		"tenant id": context.TenantID, "workspace id": context.WorkspaceID,
		"user id": context.UserID, "role": context.Role, "worker id": context.WorkerID,
		"relay id": context.RelayID,
	} {
		if err := validateRLSValue(name, value, 256, false); err != nil {
			return err
		}
	}
	if context.WorkerScope == "" {
		context.WorkerScope = "[]"
	}
	if context.RelayScope == "" {
		context.RelayScope = "[]"
	}
	if len(context.WorkerScope) > 1<<20 || !json.Valid([]byte(context.WorkerScope)) ||
		len(context.RelayScope) > 1<<20 || !json.Valid([]byte(context.RelayScope)) {
		return errors.New("RLS capability document is invalid")
	}
	_, err := tx.Exec(`SELECT
		pg_catalog.set_config('lock_timeout', '5s', true),
		pg_catalog.set_config('statement_timeout', '30s', true),
		pg_catalog.set_config('skyview.actor_kind', ?, true),
		pg_catalog.set_config('skyview.tenant_id', ?, true),
		pg_catalog.set_config('skyview.workspace_id', ?, true),
		pg_catalog.set_config('skyview.user_id', ?, true),
		pg_catalog.set_config('skyview.role', ?, true),
		pg_catalog.set_config('skyview.worker_id', ?, true),
		pg_catalog.set_config('skyview.worker_scopes', ?, true),
		pg_catalog.set_config('skyview.relay_id', ?, true),
		pg_catalog.set_config('skyview.relay_scopes', ?, true),
		pg_catalog.set_config('skyview.operation', '', true),
		pg_catalog.set_config('skyview.outbox_event_id', '', true)`,
		context.ActorKind, context.TenantID, context.WorkspaceID, context.UserID,
		context.Role, context.WorkerID, context.WorkerScope, context.RelayID, context.RelayScope)
	if err != nil {
		return fmt.Errorf("set transaction-local PostgreSQL RLS context: %w", err)
	}
	return nil
}

// setOutboxEnqueueRLSContext opens only the exact event row being inserted.
// PostgreSQL applies SELECT policies to INSERT ... ON CONFLICT, so this narrow
// context is required for idempotency without giving compute workers or system
// producers general outbox read access. The values remain transaction-local.
func (tx *databaseTx) setOutboxEnqueueRLSContext(event OutboxEvent) error {
	if tx == nil {
		return errors.New("database transaction is required for outbox RLS context")
	}
	if tx.dialect != dialectPostgreSQL {
		return nil
	}
	if err := validateScopeBoundary(event.TenantID, event.WorkspaceID); err != nil {
		return err
	}
	if err := validateRLSValue("outbox event id", event.ID, 256, true); err != nil {
		return err
	}
	_, err := tx.Exec(`SELECT
		pg_catalog.set_config('skyview.operation', 'outbox_enqueue', true),
		pg_catalog.set_config('skyview.outbox_event_id', ?, true)`, event.ID)
	if err != nil {
		return fmt.Errorf("set transaction-local PostgreSQL outbox enqueue context: %w", err)
	}
	return nil
}

func (tx *databaseTx) setUserRLSContext(scope Scope) error {
	if tx != nil && tx.dialect != dialectPostgreSQL {
		return nil
	}
	if err := validateAuthenticatedScope(scope); err != nil {
		return err
	}
	return tx.setRLSContext(rlsContext{
		ActorKind: rlsActorUser, TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
		UserID: scope.UserID, Role: scope.Role,
	})
}

func (tx *databaseTx) setOIDCRLSContext(tenantID, workspaceID string) error {
	if tx != nil && tx.dialect != dialectPostgreSQL {
		return nil
	}
	if err := validateScopeBoundary(tenantID, workspaceID); err != nil {
		return err
	}
	return tx.setRLSContext(rlsContext{ActorKind: rlsActorOIDC, TenantID: tenantID, WorkspaceID: workspaceID})
}

func (tx *databaseTx) setWorkerRLSContext(access JobClaimAccess) error {
	if tx != nil && tx.dialect != dialectPostgreSQL {
		return nil
	}
	if _, _, err := jobClaimScopePredicate(access.Scopes); err != nil {
		return err
	}
	if err := validateRLSValue("worker id", access.WorkerID, 128, true); err != nil {
		return err
	}
	capabilities := make([]postgresWorkerCapability, len(access.Scopes))
	for index, scope := range access.Scopes {
		capabilities[index] = postgresWorkerCapability{
			TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID,
			Slug: scope.Slug, Actions: append([]string(nil), scope.Actions...),
		}
	}
	encoded, err := json.Marshal(capabilities)
	if err != nil {
		return err
	}
	return tx.setRLSContext(rlsContext{ActorKind: rlsActorWorker, WorkerID: access.WorkerID, WorkerScope: string(encoded)})
}

func (tx *databaseTx) setSystemRLSContext(tenantID, workspaceID, systemID string) error {
	if tx != nil && tx.dialect != dialectPostgreSQL {
		return nil
	}
	if err := validateScopeBoundary(tenantID, workspaceID); err != nil {
		return err
	}
	if err := validateRLSValue("system id", systemID, 128, true); err != nil {
		return err
	}
	return tx.setRLSContext(rlsContext{
		ActorKind: rlsActorSystem, TenantID: tenantID, WorkspaceID: workspaceID,
		UserID: "system:" + systemID, Role: "service",
	})
}

func (tx *databaseTx) setRelayRLSContext(access OutboxRelayAccess) error {
	if tx != nil && tx.dialect != dialectPostgreSQL {
		return nil
	}
	encoded, err := validateAndEncodeOutboxRelayAccess(access)
	if err != nil {
		return err
	}
	return tx.setRLSContext(rlsContext{ActorKind: rlsActorRelay, RelayID: access.RelayID, RelayScope: encoded})
}

func (store *ProjectStore) beginUserTransaction(ctx context.Context, scope Scope) (*databaseTx, error) {
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.setUserRLSContext(scope); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (store *ProjectStore) beginWorkerTransaction(ctx context.Context, access JobClaimAccess) (*databaseTx, error) {
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.setWorkerRLSContext(access); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (store *ProjectStore) beginRelayTransaction(ctx context.Context, access OutboxRelayAccess) (*databaseTx, error) {
	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.setRelayRLSContext(access); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func validateAuthenticatedScope(scope Scope) error {
	if err := validateScopeBoundary(scope.TenantID, scope.WorkspaceID); err != nil {
		return err
	}
	if err := validateRLSValue("user id", scope.UserID, 256, true); err != nil {
		return err
	}
	return validateRLSValue("role", scope.Role, 64, true)
}

func validateScopeBoundary(tenantID, workspaceID string) error {
	if err := validateRLSValue("tenant id", tenantID, 128, true); err != nil {
		return err
	}
	return validateRLSValue("workspace id", workspaceID, 128, true)
}

func validateRLSValue(name, value string, maximum int, required bool) error {
	if required && value == "" {
		return fmt.Errorf("%s is required for PostgreSQL RLS context", name)
	}
	if value != strings.TrimSpace(value) || len(value) > maximum || strings.ContainsRune(value, '\x00') {
		return fmt.Errorf("%s is invalid for PostgreSQL RLS context", name)
	}
	return nil
}
