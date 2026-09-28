package oidc

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

const DefaultTransactionCapacity = 4096

var (
	ErrTransactionNotFound = errors.New("oidc transaction not found")
	ErrTransactionStore    = errors.New("oidc transaction store unavailable")
	ErrFlowRateLimited     = errors.New("oidc login flow rate limited")
)

// Transaction contains the short-lived secrets required to finish an
// Authorization Code + PKCE flow. ExpiresAt is assigned by the store and is
// returned on creation/consumption. Durable implementations must encrypt Nonce
// and CodeVerifier before persistence and atomically remove a transaction when
// Consume succeeds.
type Transaction struct {
	Nonce        string
	CodeVerifier string
	ExpiresAt    time.Time
}

// TransactionStore is intentionally smaller than a general cache. Create must
// reject capacity exhaustion and return the store-authoritative expiry.
// Durable stores use their database clock; the now argument exists only so the
// development memory store remains deterministic. Consume must provide
// one-time semantics across all callers sharing the store.
type TransactionStore interface {
	Create(ctx context.Context, state string, transaction Transaction, now time.Time, ttl time.Duration) (time.Time, error)
	Consume(ctx context.Context, state string, now time.Time) (Transaction, error)
}

// MemoryTransactionStore is suitable only for isolated development and tests.
// Production callers must inject a shared durable implementation.
type MemoryTransactionStore struct {
	mu           sync.Mutex
	transactions map[string]Transaction
	capacity     int
}

func NewMemoryTransactionStore(capacity int) *MemoryTransactionStore {
	if capacity <= 0 {
		capacity = DefaultTransactionCapacity
	}
	return &MemoryTransactionStore{transactions: make(map[string]Transaction), capacity: capacity}
}

func (store *MemoryTransactionStore) Create(ctx context.Context, state string, transaction Transaction, now time.Time, ttl time.Duration) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	if err := validateTransactionSecrets(state, transaction); err != nil {
		return time.Time{}, err
	}
	if ttl <= 0 {
		return time.Time{}, ErrInvalidState
	}
	now = now.UTC()
	transaction.ExpiresAt = now.Add(ttl)
	store.mu.Lock()
	defer store.mu.Unlock()
	store.removeExpiredLocked(now)
	if len(store.transactions) >= store.capacity {
		return time.Time{}, ErrFlowCapacity
	}
	if _, exists := store.transactions[state]; exists {
		return time.Time{}, ErrFlowCapacity
	}
	store.transactions[state] = transaction
	return transaction.ExpiresAt, nil
}

func (store *MemoryTransactionStore) Consume(ctx context.Context, state string, now time.Time) (Transaction, error) {
	if err := ctx.Err(); err != nil {
		return Transaction{}, err
	}
	state = strings.TrimSpace(state)
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, exists := store.transactions[state]
	if exists {
		delete(store.transactions, state)
	}
	store.removeExpiredLocked(now)
	if !exists || !now.Before(transaction.ExpiresAt) {
		return Transaction{}, ErrTransactionNotFound
	}
	return transaction, nil
}

func (store *MemoryTransactionStore) removeExpiredLocked(now time.Time) {
	for state, transaction := range store.transactions {
		if !now.Before(transaction.ExpiresAt) {
			delete(store.transactions, state)
		}
	}
}

func validateTransactionSecrets(state string, transaction Transaction) error {
	state = strings.TrimSpace(state)
	if len(state) < 32 || len(state) > 256 {
		return ErrInvalidState
	}
	if len(transaction.Nonce) < 32 || len(transaction.Nonce) > 256 || len(transaction.CodeVerifier) < 43 || len(transaction.CodeVerifier) > 128 {
		return errors.New("invalid oidc transaction secrets")
	}
	return nil
}
