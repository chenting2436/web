package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSessionCreationRollsBackWhenAuditAppendFails(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	forceAtomicAuditFailure(t, projectStore)
	tokenHash := "session-create-token-hash"
	event := atomicTestAudit(identity.Scope(), "auth.login", "session", "session-create")

	_, err := projectStore.CreateSessionWithAudit(context.Background(), tokenHash, identity, time.Hour, event)
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit failure, got %v", err)
	}
	var count int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, tokenHash).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("session escaped rollback after audit failure")
	}
}

func TestSessionDeletionRollsBackWhenAuditAppendFails(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	tokenHash := "session-delete-token-hash"
	if _, err := projectStore.CreateSession(tokenHash, identity, time.Hour); err != nil {
		t.Fatal(err)
	}
	forceAtomicAuditFailure(t, projectStore)
	event := atomicTestAudit(identity.Scope(), "auth.logout", "session", "session-delete")

	_, err := projectStore.DeleteSessionWithAudit(context.Background(), tokenHash, identity, event)
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit failure, got %v", err)
	}
	var count int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, tokenHash).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("session deletion escaped rollback after audit failure")
	}
}

func TestSessionAndAuditCommitTogether(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	tokenHash := "session-success-token-hash"
	event := atomicTestAudit(identity.Scope(), "auth.login", "session", "session-success")

	if _, err := projectStore.CreateSessionWithAudit(context.Background(), tokenHash, identity, time.Hour, event); err != nil {
		t.Fatal(err)
	}
	if _, found, err := projectStore.GetSession(context.Background(), tokenHash); err != nil || !found {
		t.Fatalf("session not committed: found=%v err=%v", found, err)
	}
	if err := projectStore.VerifyAuditChain(identity.Scope()); err != nil {
		t.Fatalf("audit chain not committed: %v", err)
	}
}

func TestSessionExpiryUsesDatabaseClock(t *testing.T) {
	projectStore, identity := atomicAuditFixture(t)
	before := time.Now().UTC()
	expiresAt, err := projectStore.CreateSession("session-database-clock", identity, 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().UTC()
	if expiresAt.Before(before.Add(119*time.Second)) || expiresAt.After(after.Add(121*time.Second)) {
		t.Fatalf("session expiry was not based on database time: before=%s expiry=%s after=%s", before, expiresAt, after)
	}

	if _, err := projectStore.database.Exec(`UPDATE sessions
		SET expires_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', CURRENT_TIMESTAMP, '-1 second')
		WHERE token_hash = ?`, "session-database-clock"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := projectStore.GetSession(context.Background(), "session-database-clock"); err != nil || found {
		t.Fatalf("database-expired session must fail closed: found=%v err=%v", found, err)
	}
	var remaining int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, "session-database-clock").Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatal("expired session was not removed using database time")
	}
}
