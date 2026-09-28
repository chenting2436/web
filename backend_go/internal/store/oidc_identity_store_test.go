package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestOIDCIdentityRequiresProvisioningAndUsesLocalMembershipRole(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	provisioned, err := projectStore.EnsureDevIdentity("tenant-a", "workspace-a", "Alice@Example.Test", "Local Alice", "student")
	if err != nil {
		t.Fatal(err)
	}
	if provisioned.Email != "alice@example.test" {
		t.Fatalf("local email was not canonicalized: %q", provisioned.Email)
	}
	if _, err := projectStore.database.Exec(`INSERT INTO users(id, tenant_id, email, display_name, status, created_at, updated_at)
		VALUES(?, ?, ?, ?, 'active', ?, ?)`, "case-collision", "tenant-a", "ALICE@example.test", "Collision", nowText(), nowText()); err == nil {
		t.Fatal("tenant email uniqueness must be case-insensitive")
	}

	identity, err := projectStore.ResolveOIDCIdentity(
		"https://identity.example.test/realms/skyviewlab", "subject-42",
		"tenant-a", "workspace-a", "ALICE@EXAMPLE.TEST",
	)
	if err != nil {
		t.Fatal(err)
	}
	if identity.UserID != provisioned.UserID || identity.Role != "student" || identity.DisplayName != "Local Alice" {
		t.Fatalf("local identity and role must remain authoritative: %+v", identity)
	}

	// Once issuer+subject is bound, a later email claim cannot silently move the
	// external identity to a different local account.
	rebound, err := projectStore.ResolveOIDCIdentity(
		"https://identity.example.test/realms/skyviewlab", "subject-42",
		"tenant-a", "workspace-a", "changed@example.test",
	)
	if err != nil || rebound.UserID != provisioned.UserID {
		t.Fatalf("stable subject binding failed: identity=%+v err=%v", rebound, err)
	}

	if _, err := projectStore.ResolveOIDCIdentity(
		"https://identity.example.test/realms/skyviewlab", "unknown-subject",
		"tenant-a", "workspace-a", "missing@example.test",
	); !errors.Is(err, ErrOIDCIdentityNotProvisioned) {
		t.Fatalf("unprovisioned user must fail closed, got %v", err)
	}
	if _, err := projectStore.ResolveOIDCIdentity(
		"https://identity.example.test/realms/skyviewlab", "subject-42",
		"tenant-a", "other-workspace", "alice@example.test",
	); !errors.Is(err, ErrOIDCIdentityNotProvisioned) {
		t.Fatalf("inactive or missing workspace membership must fail closed, got %v", err)
	}
	if _, err := projectStore.database.Exec(`UPDATE memberships SET status = 'suspended'
		WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?`, "tenant-a", "workspace-a", provisioned.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.ResolveOIDCIdentity(
		"https://identity.example.test/realms/skyviewlab", "subject-42",
		"tenant-a", "workspace-a", "alice@example.test",
	); !errors.Is(err, ErrOIDCIdentityNotProvisioned) {
		t.Fatalf("suspended local membership must fail closed, got %v", err)
	}
}

func TestOIDCIdentityTimestampsUseDatabaseClockAndNeverMoveBackward(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	if _, err := projectStore.EnsureDevIdentity("tenant-a", "workspace-a", "alice@example.test", "Alice", "viewer"); err != nil {
		t.Fatal(err)
	}
	issuer := "https://identity.example.test/realms/skyviewlab"
	before := time.Now().UTC().Add(-time.Second)
	if _, err := projectStore.ResolveOIDCIdentity(issuer, "database-clock-subject", "tenant-a", "workspace-a", "alice@example.test"); err != nil {
		t.Fatal(err)
	}
	after := time.Now().UTC().Add(time.Second)
	var createdAtValue, lastSeenAtValue timestampText
	if err := projectStore.database.QueryRow(`SELECT created_at, last_seen_at FROM oidc_identities WHERE subject = ?`, "database-clock-subject").
		Scan(&createdAtValue, &lastSeenAtValue); err != nil {
		t.Fatal(err)
	}
	createdAt, err := parseDatabaseTimestamp(createdAtValue)
	if err != nil {
		t.Fatal(err)
	}
	lastSeenAt, err := parseDatabaseTimestamp(lastSeenAtValue)
	if err != nil {
		t.Fatal(err)
	}
	if createdAt.Before(before) || createdAt.After(after) || lastSeenAt.Before(createdAt) || lastSeenAt.After(after) {
		t.Fatalf("identity timestamps are not database-clock ordered: created=%s lastSeen=%s", createdAt, lastSeenAt)
	}

	future := "2099-01-01T00:00:00.000000000Z"
	if _, err := projectStore.database.Exec(`UPDATE oidc_identities SET last_seen_at = ? WHERE subject = ?`, future, "database-clock-subject"); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.ResolveOIDCIdentity(issuer, "database-clock-subject", "tenant-a", "workspace-a", "alice@example.test"); err != nil {
		t.Fatal(err)
	}
	var refreshed timestampText
	if err := projectStore.database.QueryRow(`SELECT last_seen_at FROM oidc_identities WHERE subject = ?`, "database-clock-subject").Scan(&refreshed); err != nil {
		t.Fatal(err)
	}
	if string(refreshed) != future {
		t.Fatalf("last_seen_at moved backward from an existing later value: %s", refreshed)
	}
}

func TestOIDCFirstBindingAndAuditAreAtomic(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	forceAtomicAuditFailure(t, projectStore)
	issuer := "https://identity.example.test/realms/skyviewlab"
	subject := "atomic-subject"

	_, err := projectStore.ResolveOIDCIdentityWithAudit(context.Background(), issuer, subject,
		identity.TenantID, identity.WorkspaceID, identity.Email, func(bound Identity) AuditEvent {
			return atomicTestAudit(bound.Scope(), "auth.oidc.bind", "external_identity", bound.UserID)
		})
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit failure, got %v", err)
	}
	var bindings int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM oidc_identities WHERE tenant_id = ? AND subject = ?`, identity.TenantID, subject).Scan(&bindings); err != nil {
		t.Fatal(err)
	}
	if bindings != 0 {
		t.Fatal("oidc binding escaped rollback after audit failure")
	}
}

func TestOIDCIdentityRejectsSecondSubjectForSameIssuerAndUser(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	if _, err := projectStore.EnsureDevIdentity("tenant-a", "workspace-a", "alice@example.test", "Alice", "viewer"); err != nil {
		t.Fatal(err)
	}
	issuer := "https://identity.example.test/realms/skyviewlab"
	if _, err := projectStore.ResolveOIDCIdentity(issuer, "subject-1", "tenant-a", "workspace-a", "alice@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.ResolveOIDCIdentity(issuer, "subject-2", "tenant-a", "workspace-a", "alice@example.test"); !errors.Is(err, ErrOIDCIdentityConflict) {
		t.Fatalf("second subject must not take over the local account, got %v", err)
	}
}

func TestOIDCIdentityFailsClosedOnAmbiguousCanonicalEmail(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	if _, err := projectStore.EnsureDevIdentity("tenant-a", "workspace-a", "alice@example.test", "Alice", "student"); err != nil {
		t.Fatal(err)
	}
	// Simulate a legacy or tampered schema to ensure the lookup itself still
	// refuses ambiguity instead of trusting QueryRow ordering.
	if _, err := projectStore.database.Exec(`DROP INDEX idx_users_tenant_email_canonical`); err != nil {
		t.Fatal(err)
	}
	now := nowText()
	if _, err := projectStore.database.Exec(`INSERT INTO users(id, tenant_id, email, display_name, status, created_at, updated_at)
		VALUES(?, ?, ?, ?, 'active', ?, ?)`, "case-duplicate", "tenant-a", "ALICE@example.test", "Duplicate", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`INSERT INTO memberships(tenant_id, workspace_id, user_id, role, status, created_at, updated_at)
		VALUES(?, ?, ?, ?, 'active', ?, ?)`, "tenant-a", "workspace-a", "case-duplicate", "viewer", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.ResolveOIDCIdentity(
		"https://identity.example.test/realms/skyviewlab", "ambiguous-subject",
		"tenant-a", "workspace-a", "alice@example.test",
	); !errors.Is(err, ErrOIDCIdentityConflict) {
		t.Fatalf("ambiguous canonical email must fail closed, got %v", err)
	}
}
