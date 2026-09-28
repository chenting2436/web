package oidc

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMemoryTransactionStoreCapacityExpiryAndAtomicConsume(t *testing.T) {
	store := NewMemoryTransactionStore(1)
	now := time.Date(2026, 9, 8, 8, 0, 0, 0, time.UTC)
	transaction := Transaction{
		Nonce: strings.Repeat("n", 43), CodeVerifier: strings.Repeat("v", 43),
	}
	state := strings.Repeat("s", 43)
	if _, err := store.Create(t.Context(), state, transaction, now, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(t.Context(), strings.Repeat("x", 43), transaction, now, time.Minute); !errors.Is(err, ErrFlowCapacity) {
		t.Fatalf("capacity must fail closed, got %v", err)
	}

	var successes atomic.Int32
	var wait sync.WaitGroup
	start := make(chan struct{})
	for range 32 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := store.Consume(t.Context(), state, now)
			if err == nil {
				successes.Add(1)
				return
			}
			if !errors.Is(err, ErrTransactionNotFound) {
				t.Errorf("unexpected consume error: %v", err)
			}
		}()
	}
	close(start)
	wait.Wait()
	if successes.Load() != 1 {
		t.Fatalf("expected one successful consume, got %d", successes.Load())
	}

	expiredState := strings.Repeat("e", 43)
	if _, err := store.Create(t.Context(), expiredState, transaction, now, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Consume(t.Context(), expiredState, now.Add(time.Minute)); !errors.Is(err, ErrTransactionNotFound) {
		t.Fatalf("expired transaction must be consumed as missing, got %v", err)
	}
}
