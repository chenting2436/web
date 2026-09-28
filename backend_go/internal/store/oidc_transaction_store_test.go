package store

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	oidcauth "skyviewlab/backend_go/internal/auth/oidc"
)

func TestOIDCTransactionStoreEncryptsAndAtomicallyConsumes(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	transactionStore := newTestOIDCTransactionStore(t, projectStore, 16, "client-a")
	replicaStore := newTestOIDCTransactionStore(t, projectStore, 16, "client-a")
	now := time.Date(1999, 9, 8, 9, 0, 0, 123456000, time.UTC)
	state := strings.Repeat("s", 43)
	transaction := oidcauth.Transaction{
		Nonce: strings.Repeat("nonce", 10), CodeVerifier: strings.Repeat("verifier", 8),
	}
	expiresAt, err := transactionStore.Create(t.Context(), state, transaction, now, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	transaction.ExpiresAt = expiresAt

	var persistedHash string
	var sealed []byte
	if err := projectStore.database.QueryRow(`SELECT state_hash, sealed_payload FROM oidc_login_transactions WHERE LENGTH(sealed_payload) > 0`).Scan(&persistedHash, &sealed); err != nil {
		t.Fatal(err)
	}
	if persistedHash != stateDigest(state) || persistedHash == state {
		t.Fatalf("state was not reduced to its digest: %q", persistedHash)
	}
	if bytes.Contains(sealed, []byte(transaction.Nonce)) || bytes.Contains(sealed, []byte(transaction.CodeVerifier)) {
		t.Fatal("nonce or PKCE verifier leaked into persisted payload")
	}

	var successes atomic.Int32
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := range 32 {
		wait.Add(1)
		go func(replica *OIDCTransactionStore) {
			defer wait.Done()
			<-start
			value, err := replica.Consume(t.Context(), state, time.Date(2099, 9, 8, 9, 0, 0, 0, time.UTC))
			if err == nil {
				if value.Nonce != transaction.Nonce || value.CodeVerifier != transaction.CodeVerifier || !value.ExpiresAt.Equal(transaction.ExpiresAt) {
					t.Errorf("unexpected consumed transaction: %+v", value)
				}
				successes.Add(1)
				return
			}
			if !errors.Is(err, oidcauth.ErrTransactionNotFound) {
				t.Errorf("unexpected consume error: %v", err)
			}
		}([]*OIDCTransactionStore{transactionStore, replicaStore}[index%2])
	}
	close(start)
	wait.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected exactly one successful consume, got %d", successes.Load())
	}
}

func TestOIDCTransactionStoreSharesAdmissionWindowAcrossConcurrentReplicas(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	config := OIDCTransactionStoreConfig{
		IssuerURL: "https://identity.example.test/realms/skyviewlab", ClientID: "client-a",
		EncryptionKey: bytes.Repeat([]byte{0x7a}, 32), Capacity: 64,
		AdmissionWindow: time.Minute, AdmissionLimit: 8,
	}
	first, err := NewOIDCTransactionStore(projectStore, config)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewOIDCTransactionStore(projectStore, config)
	if err != nil {
		t.Fatal(err)
	}
	transaction := oidcauth.Transaction{Nonce: strings.Repeat("n", 43), CodeVerifier: strings.Repeat("v", 43)}
	stores := []*OIDCTransactionStore{first, second}

	var admitted atomic.Int32
	var limited atomic.Int32
	var failures atomic.Int32
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := range 32 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			state := fmt.Sprintf("%043d", index)
			_, err := stores[index%len(stores)].Create(t.Context(), state, transaction, time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC), 5*time.Minute)
			switch {
			case err == nil:
				admitted.Add(1)
			case errors.Is(err, oidcauth.ErrFlowRateLimited):
				limited.Add(1)
			default:
				failures.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	if admitted.Load() != 8 || limited.Load() != 24 || failures.Load() != 0 {
		t.Fatalf("shared admission drifted: admitted=%d limited=%d failures=%d", admitted.Load(), limited.Load(), failures.Load())
	}
	var persisted int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM oidc_login_transactions WHERE LENGTH(sealed_payload) > 0`).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if persisted != 8 {
		t.Fatalf("shared admission persisted %d transactions, want 8", persisted)
	}
	var admissions int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM oidc_login_transactions WHERE LENGTH(sealed_payload) = 0`).Scan(&admissions); err != nil {
		t.Fatal(err)
	}
	if admissions != 8 {
		t.Fatalf("shared admission persisted %d non-consumable markers, want 8", admissions)
	}
}

func TestOIDCTransactionAbortCannotReclaimSharedAdmission(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	transactionStore, err := NewOIDCTransactionStore(projectStore, OIDCTransactionStoreConfig{
		IssuerURL: "https://identity.example.test/realms/skyviewlab", ClientID: "client-a",
		EncryptionKey: bytes.Repeat([]byte{0x7a}, 32), Capacity: 16,
		AdmissionWindow: time.Minute, AdmissionLimit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	transaction := oidcauth.Transaction{Nonce: strings.Repeat("n", 43), CodeVerifier: strings.Repeat("v", 43)}
	firstState, secondState := strings.Repeat("a", 43), strings.Repeat("b", 43)
	if _, err := transactionStore.Create(t.Context(), firstState, transaction, time.Time{}, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := transactionStore.Consume(t.Context(), firstState, time.Time{}); err != nil {
		t.Fatalf("simulate provider abort consuming state: %v", err)
	}
	if _, err := transactionStore.Create(t.Context(), secondState, transaction, time.Time{}, 5*time.Minute); !errors.Is(err, oidcauth.ErrFlowRateLimited) {
		t.Fatalf("abort reclaimed shared admission allowance: %v", err)
	}
	var states, admissions int
	if err := projectStore.database.QueryRow(`SELECT
		SUM(CASE WHEN LENGTH(sealed_payload) > 0 THEN 1 ELSE 0 END),
		SUM(CASE WHEN LENGTH(sealed_payload) = 0 THEN 1 ELSE 0 END)
		FROM oidc_login_transactions`).Scan(&states, &admissions); err != nil {
		t.Fatal(err)
	}
	if states != 0 || admissions != 1 {
		t.Fatalf("unexpected post-abort rows states=%d admissions=%d", states, admissions)
	}
}

func TestOIDCTransactionStoreCapacityCleanupAndAAD(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	now := time.Date(1999, 9, 8, 10, 0, 0, 0, time.UTC)
	transactionStore := newTestOIDCTransactionStore(t, projectStore, 1, "client-a")
	transaction := oidcauth.Transaction{
		Nonce: strings.Repeat("n", 43), CodeVerifier: strings.Repeat("v", 43),
	}
	firstState, secondState := strings.Repeat("a", 43), strings.Repeat("b", 43)
	if _, err := transactionStore.Create(t.Context(), firstState, transaction, now, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := transactionStore.Create(t.Context(), secondState, transaction, now, time.Minute); !errors.Is(err, oidcauth.ErrFlowCapacity) {
		t.Fatalf("expected capacity error, got %v", err)
	}
	if _, err := projectStore.database.Exec(`UPDATE oidc_login_transactions
		SET expires_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', CURRENT_TIMESTAMP, '-1 second')
		WHERE state_hash = ? OR LENGTH(sealed_payload) = 0`, stateDigest(firstState)); err != nil {
		t.Fatal(err)
	}
	if _, err := transactionStore.Create(t.Context(), secondState, transaction, now.Add(100*365*24*time.Hour), 3*time.Minute); err != nil {
		t.Fatalf("expired row must be cleaned before capacity check: %v", err)
	}

	otherClientStore := newTestOIDCTransactionStore(t, projectStore, 1, "client-b")
	if _, err := otherClientStore.Consume(t.Context(), secondState, now.Add(200*365*24*time.Hour)); !errors.Is(err, ErrOIDCTransactionIntegrity) {
		t.Fatalf("AAD must bind the client ID, got %v", err)
	}
}

func TestOIDCTransactionStoreUsesDatabaseClockDespiteApplicationClockSkew(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	transactionStore := newTestOIDCTransactionStore(t, projectStore, 8, "client-a")
	transaction := oidcauth.Transaction{Nonce: strings.Repeat("n", 43), CodeVerifier: strings.Repeat("v", 43)}

	before := time.Now().UTC()
	state := strings.Repeat("c", 43)
	expiresAt, err := transactionStore.Create(t.Context(), state, transaction, time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC), 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().UTC()
	if expiresAt.Before(before.Add(119*time.Second)) || expiresAt.After(after.Add(121*time.Second)) {
		t.Fatalf("expiry was not based on the database clock: before=%s expiry=%s after=%s", before, expiresAt, after)
	}
	if _, err := transactionStore.Consume(t.Context(), state, time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("fast application clock must not expire a database-fresh transaction: %v", err)
	}

	expiredState := strings.Repeat("d", 43)
	if _, err := transactionStore.Create(t.Context(), expiredState, transaction, time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC), time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`UPDATE oidc_login_transactions
		SET expires_at = STRFTIME('%Y-%m-%dT%H:%M:%f000000Z', CURRENT_TIMESTAMP, '-1 second')
		WHERE state_hash = ?`, stateDigest(expiredState)); err != nil {
		t.Fatal(err)
	}
	if _, err := transactionStore.Consume(t.Context(), expiredState, time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)); !errors.Is(err, oidcauth.ErrTransactionNotFound) {
		t.Fatalf("slow application clock must not revive a database-expired transaction: %v", err)
	}
	var remaining int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM oidc_login_transactions WHERE state_hash = ?`, stateDigest(expiredState)).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatal("expired transaction was not atomically consumed")
	}
}

func TestOIDCTransactionStoreRejectsInvalidEncryptionKey(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	_, err = NewOIDCTransactionStore(projectStore, OIDCTransactionStoreConfig{
		IssuerURL: "https://identity.example.test/realms/skyviewlab", ClientID: "client-a", EncryptionKey: make([]byte, 31),
	})
	if err == nil || !strings.Contains(err.Error(), "exactly 32 bytes") {
		t.Fatalf("invalid key length must be rejected, got %v", err)
	}
}

func TestOIDCTransactionStoreRejectsTTLThatCanExhaustSharedCapacity(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	transactionStore := newTestOIDCTransactionStore(t, projectStore, 16, "client-a")
	transaction := oidcauth.Transaction{Nonce: strings.Repeat("n", 43), CodeVerifier: strings.Repeat("v", 43)}
	_, err = transactionStore.Create(t.Context(), strings.Repeat("t", 43), transaction, time.Now(), oidcauth.MaximumTransactionTTL+time.Second)
	if err == nil || !strings.Contains(err.Error(), "must not exceed") {
		t.Fatalf("oversized OIDC transaction TTL must fail closed, got %v", err)
	}
}

func newTestOIDCTransactionStore(t *testing.T, projectStore *ProjectStore, capacity int, clientID string) *OIDCTransactionStore {
	t.Helper()
	value, err := NewOIDCTransactionStore(projectStore, OIDCTransactionStoreConfig{
		IssuerURL: "https://identity.example.test/realms/skyviewlab", ClientID: clientID,
		EncryptionKey: bytes.Repeat([]byte{0x7a}, 32), Capacity: capacity,
	})
	if err != nil {
		t.Fatal(err)
	}
	return value
}
