package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	oidcauth "skyviewlab/backend_go/internal/auth/oidc"
)

const oidcTransactionCreateLock int64 = 73465961020260909

const (
	defaultOIDCAdmissionWindow = time.Minute
	defaultOIDCAdmissionLimit  = 240
)

var ErrOIDCTransactionIntegrity = errors.New("oidc transaction integrity check failed")

type OIDCTransactionStoreConfig struct {
	IssuerURL       string
	ClientID        string
	EncryptionKey   []byte
	Capacity        int
	AdmissionWindow time.Duration
	AdmissionLimit  int
}

// OIDCTransactionStore persists one-time login transactions in the same
// shared database as the control plane. State is represented only by a SHA-256
// digest; nonce and PKCE verifier are sealed with AES-256-GCM.
type OIDCTransactionStore struct {
	database        *databaseHandle
	aead            cipher.AEAD
	issuer          string
	clientID        string
	capacity        int
	admissionWindow time.Duration
	admissionLimit  int
}

func NewOIDCTransactionStore(projectStore *ProjectStore, config OIDCTransactionStoreConfig) (*OIDCTransactionStore, error) {
	if projectStore == nil || projectStore.database == nil {
		return nil, errors.New("OIDC transaction database is required")
	}
	config.IssuerURL = strings.TrimSpace(config.IssuerURL)
	config.ClientID = strings.TrimSpace(config.ClientID)
	if config.IssuerURL == "" || config.ClientID == "" {
		return nil, errors.New("OIDC transaction issuer and client ID are required")
	}
	if len(config.EncryptionKey) != 32 {
		return nil, errors.New("OIDC transaction encryption key must contain exactly 32 bytes")
	}
	if config.Capacity <= 0 {
		config.Capacity = oidcauth.DefaultTransactionCapacity
	}
	if config.Capacity > 1_000_000 {
		return nil, errors.New("OIDC transaction capacity exceeds the safety limit")
	}
	if config.AdmissionWindow == 0 {
		config.AdmissionWindow = defaultOIDCAdmissionWindow
	}
	if config.AdmissionWindow < time.Second || config.AdmissionWindow > time.Hour {
		return nil, errors.New("OIDC transaction admission window must be between one second and one hour")
	}
	if config.AdmissionLimit == 0 {
		config.AdmissionLimit = min(defaultOIDCAdmissionLimit, config.Capacity)
	}
	if config.AdmissionLimit < 1 || config.AdmissionLimit > config.Capacity {
		return nil, errors.New("OIDC transaction admission limit must be between one and capacity")
	}
	block, err := aes.NewCipher(append([]byte(nil), config.EncryptionKey...))
	if err != nil {
		return nil, fmt.Errorf("create OIDC transaction cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create OIDC transaction AEAD: %w", err)
	}
	return &OIDCTransactionStore{
		database:        projectStore.database,
		aead:            aead,
		issuer:          config.IssuerURL,
		clientID:        config.ClientID,
		capacity:        config.Capacity,
		admissionWindow: config.AdmissionWindow,
		admissionLimit:  config.AdmissionLimit,
	}, nil
}

func (store *OIDCTransactionStore) Create(ctx context.Context, state string, transaction oidcauth.Transaction, _ time.Time, ttl time.Duration) (time.Time, error) {
	state = strings.TrimSpace(state)
	if err := validateDurableOIDCTransaction(state, transaction); err != nil {
		return time.Time{}, err
	}
	if ttl > oidcauth.MaximumTransactionTTL {
		return time.Time{}, fmt.Errorf("OIDC transaction TTL must not exceed %s", oidcauth.MaximumTransactionTTL)
	}
	ttlSeconds, err := normalizedAuthenticationTTLSeconds(ttl)
	if err != nil {
		return time.Time{}, err
	}

	tx, err := store.database.BeginContext(ctx)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if tx.dialect == dialectPostgreSQL {
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(?)`, oidcTransactionCreateLock); err != nil {
			return time.Time{}, fmt.Errorf("lock OIDC transaction capacity: %w", err)
		}
	}
	nowExpression := authenticationDatabaseNowExpression(tx.dialect)
	if _, err := tx.ExecContext(ctx, `DELETE FROM oidc_login_transactions WHERE NOT (`+authenticationDatabaseFreshExpression(tx.dialect, "expires_at")+`)`); err != nil {
		return time.Time{}, fmt.Errorf("clean expired OIDC transactions: %w", err)
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM oidc_login_transactions WHERE LENGTH(sealed_payload) > 0`).Scan(&count); err != nil {
		return time.Time{}, fmt.Errorf("count OIDC transactions: %w", err)
	}
	if count >= store.capacity {
		return time.Time{}, oidcauth.ErrFlowCapacity
	}
	windowSeconds, err := normalizedAuthenticationTTLSeconds(store.admissionWindow)
	if err != nil {
		return time.Time{}, err
	}
	var recent int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM oidc_login_transactions WHERE LENGTH(sealed_payload) = 0`).Scan(&recent); err != nil {
		return time.Time{}, fmt.Errorf("count recent OIDC transaction admissions: %w", err)
	}
	if recent >= store.admissionLimit {
		return time.Time{}, oidcauth.ErrFlowRateLimited
	}
	var expiresAtValue timestampText
	if err := tx.QueryRowContext(ctx, `SELECT `+authenticationDatabaseExpiryExpression(tx.dialect), ttlSeconds).Scan(&expiresAtValue); err != nil {
		return time.Time{}, fmt.Errorf("read OIDC transaction database expiry: %w", err)
	}
	expiresAt, err := parseDatabaseTimestamp(expiresAtValue)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse OIDC transaction database expiry: %w", err)
	}
	sealed, err := store.seal(state, expiresAt, transaction)
	if err != nil {
		return time.Time{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO oidc_login_transactions(state_hash, sealed_payload, expires_at, created_at)
		VALUES(?, ?, ?, `+nowExpression+`) ON CONFLICT(state_hash) DO NOTHING`, stateDigest(state), sealed,
		tx.timestamp(expiresAt.Format(time.RFC3339Nano)))
	if err != nil {
		return time.Time{}, fmt.Errorf("create OIDC transaction: %w", err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return time.Time{}, fmt.Errorf("inspect OIDC transaction insert: %w", err)
	}
	if inserted != 1 {
		return time.Time{}, oidcauth.ErrFlowCapacity
	}
	// Admission evidence is deliberately separate from the consumable state
	// row. Callback success, provider error, or an attacker-triggered abort may
	// delete the state exactly once, but cannot reclaim the shared per-window
	// allowance. The random marker is never returned and an empty payload is a
	// schema-compatible discriminator from real encrypted transactions.
	admissionID, err := newOIDCAdmissionID()
	if err != nil {
		return time.Time{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO oidc_login_transactions(state_hash, sealed_payload, expires_at, created_at)
		VALUES(?, ?, `+authenticationDatabaseExpiryExpression(tx.dialect)+`, `+nowExpression+`)`, admissionID, []byte{}, windowSeconds); err != nil {
		return time.Time{}, fmt.Errorf("record OIDC transaction admission: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return time.Time{}, fmt.Errorf("commit OIDC transaction: %w", err)
	}
	return expiresAt, nil
}

func (store *OIDCTransactionStore) Consume(ctx context.Context, state string, _ time.Time) (oidcauth.Transaction, error) {
	state = strings.TrimSpace(state)
	if len(state) < 32 || len(state) > 256 {
		return oidcauth.Transaction{}, oidcauth.ErrTransactionNotFound
	}
	var sealed []byte
	var expiresAt timestampText
	var fresh bool
	err := store.database.QueryRowContext(ctx, `DELETE FROM oidc_login_transactions WHERE state_hash = ?
		RETURNING sealed_payload, expires_at, `+authenticationDatabaseFreshExpression(store.database.dialect, "expires_at"), stateDigest(state)).Scan(&sealed, &expiresAt, &fresh)
	if errors.Is(err, sql.ErrNoRows) {
		return oidcauth.Transaction{}, oidcauth.ErrTransactionNotFound
	}
	if err != nil {
		return oidcauth.Transaction{}, fmt.Errorf("consume OIDC transaction: %w", err)
	}
	parsedExpiry, err := parseDatabaseTimestamp(expiresAt)
	if err != nil {
		return oidcauth.Transaction{}, ErrOIDCTransactionIntegrity
	}
	if !fresh {
		return oidcauth.Transaction{}, oidcauth.ErrTransactionNotFound
	}
	transaction, err := store.open(state, parsedExpiry, sealed)
	if err != nil {
		return oidcauth.Transaction{}, err
	}
	transaction.ExpiresAt = parsedExpiry.UTC()
	return transaction, nil
}

type sealedOIDCTransaction struct {
	Nonce        string `json:"nonce"`
	CodeVerifier string `json:"codeVerifier"`
}

type oidcTransactionAAD struct {
	Context   string `json:"context"`
	IssuerURL string `json:"issuerUrl"`
	ClientID  string `json:"clientId"`
	State     string `json:"state"`
	ExpiresAt string `json:"expiresAt"`
}

func (store *OIDCTransactionStore) seal(state string, expiresAt time.Time, transaction oidcauth.Transaction) ([]byte, error) {
	plaintext, err := json.Marshal(sealedOIDCTransaction{Nonce: transaction.Nonce, CodeVerifier: transaction.CodeVerifier})
	if err != nil {
		return nil, fmt.Errorf("encode OIDC transaction: %w", err)
	}
	aad, err := store.additionalData(state, expiresAt)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, store.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("create OIDC transaction encryption nonce: %w", err)
	}
	return store.aead.Seal(nonce, nonce, plaintext, aad), nil
}

func (store *OIDCTransactionStore) open(state string, expiresAt time.Time, sealed []byte) (oidcauth.Transaction, error) {
	if len(sealed) < store.aead.NonceSize()+store.aead.Overhead() {
		return oidcauth.Transaction{}, ErrOIDCTransactionIntegrity
	}
	nonce := sealed[:store.aead.NonceSize()]
	ciphertext := sealed[store.aead.NonceSize():]
	aad, err := store.additionalData(state, expiresAt)
	if err != nil {
		return oidcauth.Transaction{}, err
	}
	plaintext, err := store.aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return oidcauth.Transaction{}, ErrOIDCTransactionIntegrity
	}
	var value sealedOIDCTransaction
	if err := json.Unmarshal(plaintext, &value); err != nil {
		return oidcauth.Transaction{}, ErrOIDCTransactionIntegrity
	}
	transaction := oidcauth.Transaction{Nonce: value.Nonce, CodeVerifier: value.CodeVerifier, ExpiresAt: expiresAt.UTC()}
	if err := validateDurableOIDCTransaction(state, transaction); err != nil {
		return oidcauth.Transaction{}, ErrOIDCTransactionIntegrity
	}
	return transaction, nil
}

func (store *OIDCTransactionStore) additionalData(state string, expiresAt time.Time) ([]byte, error) {
	return json.Marshal(oidcTransactionAAD{
		Context: "skyviewlab-oidc-transaction-v1", IssuerURL: store.issuer,
		ClientID: store.clientID, State: state, ExpiresAt: expiresAt.UTC().Format(time.RFC3339Nano),
	})
}

func validateDurableOIDCTransaction(state string, transaction oidcauth.Transaction) error {
	if len(state) < 32 || len(state) > 256 || len(transaction.Nonce) < 32 || len(transaction.Nonce) > 256 ||
		len(transaction.CodeVerifier) < 43 || len(transaction.CodeVerifier) > 128 {
		return errors.New("invalid OIDC transaction")
	}
	return nil
}

func stateDigest(state string) string {
	digest := sha256.Sum256([]byte(state))
	return hex.EncodeToString(digest[:])
}

func newOIDCAdmissionID() (string, error) {
	material := make([]byte, sha256.Size)
	if _, err := io.ReadFull(rand.Reader, material); err != nil {
		return "", fmt.Errorf("create OIDC admission marker: %w", err)
	}
	return hex.EncodeToString(material), nil
}
