package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Identity struct {
	UserID      string
	TenantID    string
	WorkspaceID string
	Email       string
	DisplayName string
	Role        string
}

func (identity Identity) Scope() Scope {
	return Scope{
		TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		UserID: identity.UserID, Role: identity.Role,
	}
}

func (store *ProjectStore) EnsureDevIdentity(tenantID, workspaceID, email, displayName, role string) (Identity, error) {
	if store.adapter == AdapterPostgreSQL {
		return Identity{}, errors.New("development identity provisioning is unavailable on PostgreSQL")
	}
	normalizedEmail := strings.ToLower(strings.TrimSpace(email))
	now := nowText()
	tx, err := store.database.Begin()
	if err != nil {
		return Identity{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO tenants(id, name, status, created_at, updated_at) VALUES(?, ?, 'active', ?, ?)
		ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`, tenantID, "Development tenant", tx.timestamp(now), tx.timestamp(now)); err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(`INSERT INTO workspaces(id, tenant_id, name, status, created_at, updated_at) VALUES(?, ?, ?, 'active', ?, ?)
		ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`, workspaceID, tenantID, "Development workspace", tx.timestamp(now), tx.timestamp(now)); err != nil {
		return Identity{}, err
	}
	var userID string
	err = tx.QueryRow(`SELECT id FROM users WHERE tenant_id = ? AND lower(email) = ?`, tenantID, normalizedEmail).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		userID = uuid.NewString()
		_, err = tx.Exec(`INSERT INTO users(id, tenant_id, email, display_name, status, created_at, updated_at)
			VALUES(?, ?, ?, ?, 'active', ?, ?)`, userID, tenantID, normalizedEmail, displayName, tx.timestamp(now), tx.timestamp(now))
	}
	if err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(`INSERT INTO memberships(tenant_id, workspace_id, user_id, role, status, created_at, updated_at)
		VALUES(?, ?, ?, ?, 'active', ?, ?)
		ON CONFLICT(tenant_id, workspace_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_at = excluded.updated_at`,
		tenantID, workspaceID, userID, role, tx.timestamp(now), tx.timestamp(now)); err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, err
	}
	return Identity{UserID: userID, TenantID: tenantID, WorkspaceID: workspaceID, Email: normalizedEmail, DisplayName: displayName, Role: role}, nil
}

func (store *ProjectStore) CreateSession(tokenHash string, identity Identity, ttl time.Duration) (time.Time, error) {
	tx, err := store.beginUserTransaction(context.Background(), identity.Scope())
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback() }()
	expiresAt, err := insertSession(context.Background(), tx, tokenHash, identity, ttl)
	if err != nil {
		return time.Time{}, err
	}
	if err := tx.Commit(); err != nil {
		return time.Time{}, err
	}
	return expiresAt, nil
}

// CreateSessionWithAudit makes the authenticated session and its success
// evidence one commit. A caller never receives a usable cookie when the audit
// chain could not be advanced.
func (store *ProjectStore) CreateSessionWithAudit(ctx context.Context, tokenHash string, identity Identity, ttl time.Duration, audit AuditEvent) (time.Time, error) {
	return auditedMutation(ctx, store, identity.Scope(), func(tx *databaseTx) (time.Time, *AuditEvent, error) {
		expiresAt, err := insertSession(ctx, tx, tokenHash, identity, ttl)
		if err != nil {
			return time.Time{}, nil, err
		}
		return expiresAt, &audit, nil
	})
}

func (store *ProjectStore) GetSession(ctx context.Context, tokenHash string) (Identity, bool, error) {
	if store.adapter == AdapterPostgreSQL {
		var identity Identity
		err := store.database.QueryRowContext(ctx, `SELECT user_id, tenant_id, workspace_id, email, display_name, role
			FROM public.resolve_session_identity_v1(?)`, tokenHash).Scan(
			&identity.UserID, &identity.TenantID, &identity.WorkspaceID,
			&identity.Email, &identity.DisplayName, &identity.Role,
		)
		if errors.Is(err, sql.ErrNoRows) {
			return Identity{}, false, nil
		}
		if err != nil {
			return Identity{}, false, fmt.Errorf("resolve session through secured database function: %w", err)
		}
		return identity, true, nil
	}
	nowExpression := authenticationDatabaseNowExpression(store.database.dialect)
	freshExpression := authenticationDatabaseFreshExpression(store.database.dialect, "s.expires_at")
	row := store.database.QueryRowContext(ctx, `SELECT s.user_id, s.tenant_id, s.workspace_id, u.email, u.display_name, m.role
		FROM sessions s
		JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id AND u.status = 'active'
		JOIN memberships m ON m.tenant_id = s.tenant_id AND m.workspace_id = s.workspace_id AND m.user_id = s.user_id AND m.status = 'active'
		JOIN tenants t ON t.id = s.tenant_id AND t.status = 'active'
		JOIN workspaces w ON w.id = s.workspace_id AND w.tenant_id = s.tenant_id AND w.status = 'active'
		WHERE s.token_hash = ? AND `+freshExpression, tokenHash)
	var identity Identity
	if err := row.Scan(&identity.UserID, &identity.TenantID, &identity.WorkspaceID, &identity.Email, &identity.DisplayName, &identity.Role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			_, _ = store.database.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ? AND NOT (`+authenticationDatabaseFreshExpression(store.database.dialect, "expires_at")+`)`, tokenHash)
			return Identity{}, false, nil
		}
		return Identity{}, false, err
	}
	result, err := store.database.ExecContext(ctx, `UPDATE sessions SET last_seen_at = `+nowExpression+` WHERE token_hash = ? AND `+authenticationDatabaseFreshExpression(store.database.dialect, "expires_at"), tokenHash)
	if err != nil {
		return Identity{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Identity{}, false, err
	}
	if affected != 1 {
		return Identity{}, false, nil
	}
	return identity, true, nil
}

func insertSession(ctx context.Context, tx *databaseTx, tokenHash string, identity Identity, ttl time.Duration) (time.Time, error) {
	ttlSeconds, err := normalizedAuthenticationTTLSeconds(ttl)
	if err != nil {
		return time.Time{}, err
	}
	nowExpression := authenticationDatabaseNowExpression(tx.dialect)
	var expiresAt timestampText
	err = tx.QueryRowContext(ctx, `INSERT INTO sessions(token_hash, tenant_id, workspace_id, user_id, expires_at, created_at, last_seen_at)
		VALUES(?, ?, ?, ?, `+authenticationDatabaseExpiryExpression(tx.dialect)+`, `+nowExpression+`, `+nowExpression+`)
		RETURNING expires_at`, tokenHash, identity.TenantID, identity.WorkspaceID, identity.UserID, ttlSeconds).Scan(&expiresAt)
	if err != nil {
		return time.Time{}, err
	}
	parsed, err := parseDatabaseTimestamp(expiresAt)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse session database expiry: %w", err)
	}
	return parsed.UTC(), nil
}

func (store *ProjectStore) DeleteSession(tokenHash string) error {
	if store.adapter == AdapterPostgreSQL {
		return errors.New("PostgreSQL session deletion requires an authenticated identity")
	}
	_, err := store.database.Exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteSessionWithAudit prevents logout from deleting the credential without
// committing the corresponding audit evidence (and vice versa).
func (store *ProjectStore) DeleteSessionWithAudit(ctx context.Context, tokenHash string, identity Identity, audit AuditEvent) (bool, error) {
	return auditedMutation(ctx, store, identity.Scope(), func(tx *databaseTx) (bool, *AuditEvent, error) {
		result, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ? AND tenant_id = ? AND workspace_id = ? AND user_id = ?`,
			tokenHash, identity.TenantID, identity.WorkspaceID, identity.UserID)
		if err != nil {
			return false, nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return false, nil, err
		}
		if affected == 0 {
			return false, nil, nil
		}
		return true, &audit, nil
	})
}
