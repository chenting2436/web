package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

var (
	ErrOIDCIdentityNotProvisioned = errors.New("oidc identity is not provisioned")
	ErrOIDCIdentityConflict       = errors.New("oidc identity conflicts with an existing binding")
)

// ResolveOIDCIdentity binds a verified issuer/subject pair to an existing,
// active local user. First login is permitted only when the verified email
// exactly matches a pre-provisioned user with an active membership in the
// requested tenant/workspace. The local membership remains authoritative for
// the role; token role claims are intentionally not accepted here.
func (store *ProjectStore) ResolveOIDCIdentity(issuer, subject, tenantID, workspaceID, verifiedEmail string) (Identity, error) {
	return store.resolveOIDCIdentity(context.Background(), issuer, subject, tenantID, workspaceID, verifiedEmail, nil)
}

// ResolveOIDCIdentityWithAudit records a first-time external identity binding
// in the same transaction that creates it. Returning users only refresh
// last_seen_at and do not create duplicate binding evidence.
func (store *ProjectStore) ResolveOIDCIdentityWithAudit(ctx context.Context, issuer, subject, tenantID, workspaceID, verifiedEmail string, audit func(Identity) AuditEvent) (Identity, error) {
	if audit == nil {
		return Identity{}, errors.New("oidc binding audit factory is required")
	}
	return store.resolveOIDCIdentity(ctx, issuer, subject, tenantID, workspaceID, verifiedEmail, audit)
}

func (store *ProjectStore) resolveOIDCIdentity(ctx context.Context, issuer, subject, tenantID, workspaceID, verifiedEmail string, audit func(Identity) AuditEvent) (Identity, error) {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	tenantID = strings.TrimSpace(tenantID)
	workspaceID = strings.TrimSpace(workspaceID)
	verifiedEmail = strings.ToLower(strings.TrimSpace(verifiedEmail))
	if issuer == "" || len(issuer) > 2048 || subject == "" || len(subject) > 255 || tenantID == "" || workspaceID == "" || verifiedEmail == "" || len(verifiedEmail) > 320 {
		return Identity{}, ErrOIDCIdentityNotProvisioned
	}
	digest := sha256.Sum256([]byte(issuer))
	issuerHash := hex.EncodeToString(digest[:])

	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return Identity{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.setOIDCRLSContext(tenantID, workspaceID); err != nil {
		return Identity{}, err
	}

	var boundUserID, storedIssuer string
	err = tx.QueryRow(`SELECT user_id, issuer FROM oidc_identities
		WHERE issuer_hash = ? AND subject = ? AND tenant_id = ?`, issuerHash, subject, tenantID).Scan(&boundUserID, &storedIssuer)
	switch {
	case err == nil:
		if storedIssuer != issuer {
			return Identity{}, ErrOIDCIdentityConflict
		}
		identity, err := activeIdentityTx(tx, tenantID, workspaceID, boundUserID, "")
		if err != nil {
			return Identity{}, err
		}
		if identity.UserID == "" {
			return Identity{}, ErrOIDCIdentityNotProvisioned
		}
		if err := tx.setUserRLSContext(identity.Scope()); err != nil {
			return Identity{}, err
		}
		if _, err := tx.Exec(`UPDATE oidc_identities SET last_seen_at = `+authenticationDatabaseMonotonicTimestampExpression(tx.dialect, "last_seen_at")+`
			WHERE issuer_hash = ? AND subject = ? AND tenant_id = ?`, issuerHash, subject, tenantID); err != nil {
			return Identity{}, err
		}
		if err := tx.Commit(); err != nil {
			return Identity{}, err
		}
		return identity, nil
	case !errors.Is(err, sql.ErrNoRows):
		return Identity{}, err
	}

	identity, err := activeIdentityTx(tx, tenantID, workspaceID, "", verifiedEmail)
	if err != nil {
		return Identity{}, err
	}
	if identity.UserID == "" {
		return Identity{}, ErrOIDCIdentityNotProvisioned
	}

	var existingSubject, existingIssuer string
	err = tx.QueryRow(`SELECT subject, issuer FROM oidc_identities
		WHERE tenant_id = ? AND user_id = ? AND issuer_hash = ?`, tenantID, identity.UserID, issuerHash).Scan(&existingSubject, &existingIssuer)
	switch {
	case err == nil:
		if existingIssuer != issuer || existingSubject != subject {
			return Identity{}, ErrOIDCIdentityConflict
		}
	case !errors.Is(err, sql.ErrNoRows):
		return Identity{}, err
	}

	// The verified OIDC claims are only a bootstrap boundary. Once the local
	// pre-provisioned identity is resolved, switch the same transaction to its
	// full user context before creating the durable binding and audit evidence.
	if err := tx.setUserRLSContext(identity.Scope()); err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(`INSERT INTO oidc_identities(issuer_hash, issuer, subject, tenant_id, user_id, created_at, last_seen_at)
		VALUES(?, ?, ?, ?, ?, `+authenticationDatabaseNowExpression(tx.dialect)+`, `+authenticationDatabaseNowExpression(tx.dialect)+`)`,
		issuerHash, issuer, subject, tenantID, identity.UserID); err != nil {
		return Identity{}, fmt.Errorf("bind oidc identity: %w", err)
	}
	if audit != nil {
		event := audit(identity)
		if err := validateBusinessAudit(identity.Scope(), event); err != nil {
			return Identity{}, err
		}
		if _, err := store.appendAuditTxContext(ctx, tx, event); err != nil {
			return Identity{}, fmt.Errorf("%w: %v", ErrAtomicAuditWrite, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, err
	}
	return identity, nil
}

func activeIdentityTx(tx *databaseTx, tenantID, workspaceID, userID, verifiedEmail string) (Identity, error) {
	query := `SELECT u.id, u.tenant_id, m.workspace_id, u.email, u.display_name, m.role
		FROM users u
		JOIN memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.status = 'active'
		JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active'
		JOIN workspaces w ON w.id = m.workspace_id AND w.tenant_id = m.tenant_id AND w.status = 'active'
		WHERE u.tenant_id = ? AND m.workspace_id = ? AND u.status = 'active'`
	args := []any{tenantID, workspaceID}
	if userID != "" {
		query += ` AND u.id = ?`
		args = append(args, userID)
		var identity Identity
		err := tx.QueryRow(query, args...).Scan(
			&identity.UserID, &identity.TenantID, &identity.WorkspaceID,
			&identity.Email, &identity.DisplayName, &identity.Role,
		)
		if errors.Is(err, sql.ErrNoRows) {
			return Identity{}, nil
		}
		return identity, err
	}

	query += ` AND lower(u.email) = ? ORDER BY u.id LIMIT 2`
	args = append(args, verifiedEmail)
	rows, err := tx.Query(query, args...)
	if err != nil {
		return Identity{}, err
	}
	defer rows.Close()
	var identity Identity
	matches := 0
	for rows.Next() {
		matches++
		if matches > 1 {
			return Identity{}, ErrOIDCIdentityConflict
		}
		if err := rows.Scan(
			&identity.UserID, &identity.TenantID, &identity.WorkspaceID,
			&identity.Email, &identity.DisplayName, &identity.Role,
		); err != nil {
			return Identity{}, err
		}
	}
	if err := rows.Err(); err != nil {
		return Identity{}, err
	}
	return identity, nil
}
