package store

import (
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/postgres/*.sql
var postgresMigrationFS embed.FS

const postgresMigrationLock int64 = 73465961020260908

type postgresMigration struct {
	version  int
	name     string
	checksum string
	sql      string
}

func loadPostgresMigrations() ([]postgresMigration, error) {
	entries, err := fs.ReadDir(postgresMigrationFS, "migrations/postgres")
	if err != nil {
		return nil, err
	}
	items := make([]postgresMigration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		stem := strings.TrimSuffix(entry.Name(), ".sql")
		parts := strings.SplitN(stem, "_", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid PostgreSQL migration filename %q", entry.Name())
		}
		version, err := strconv.Atoi(parts[0])
		if err != nil || version < 1 {
			return nil, fmt.Errorf("invalid PostgreSQL migration version in %q", entry.Name())
		}
		contents, err := postgresMigrationFS.ReadFile("migrations/postgres/" + entry.Name())
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(contents)
		items = append(items, postgresMigration{
			version: version, name: parts[1], checksum: hex.EncodeToString(digest[:]), sql: string(contents),
		})
	}
	sort.Slice(items, func(left, right int) bool { return items[left].version < items[right].version })
	for index, item := range items {
		if index > 0 && item.version == items[index-1].version {
			return nil, fmt.Errorf("duplicate PostgreSQL migration version %d", item.version)
		}
	}
	if len(items) == 0 {
		return nil, errors.New("no PostgreSQL migrations are embedded")
	}
	return items, nil
}

func (store *ProjectStore) migratePostgreSQL() error {
	items, err := loadPostgresMigrations()
	if err != nil {
		return err
	}
	tx, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock(?)`, postgresMigrationLock); err != nil {
		return fmt.Errorf("acquire PostgreSQL migration lock: %w", err)
	}
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version BIGINT PRIMARY KEY,
		name TEXT NOT NULL,
		checksum TEXT NOT NULL,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create PostgreSQL migration ledger: %w", err)
	}
	for _, item := range items {
		var name, checksum string
		err := tx.QueryRow(`SELECT name, checksum FROM schema_migrations WHERE version = ?`, item.version).Scan(&name, &checksum)
		switch {
		case err == nil:
			if name != item.name || checksum != item.checksum {
				return fmt.Errorf("%w: PostgreSQL migration %d checksum/name mismatch", ErrSchemaNotCurrent, item.version)
			}
			continue
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		if item.name == "audit_chain_heads" {
			if _, err := preflightLegacyAuditChains(tx); err != nil {
				return fmt.Errorf("preflight PostgreSQL audit chain migration: %w", err)
			}
		}
		if item.name == "audit_chain_v3" {
			if err := preflightAuditV3Chains(tx); err != nil {
				return fmt.Errorf("preflight PostgreSQL audit-v3 migration: %w", err)
			}
		}
		if _, err := tx.Exec(item.sql); err != nil {
			return fmt.Errorf("apply PostgreSQL migration %d (%s): %w", item.version, item.name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version, name, checksum) VALUES(?, ?, ?)`, item.version, item.name, item.checksum); err != nil {
			return fmt.Errorf("record PostgreSQL migration %d: %w", item.version, err)
		}
	}
	var unsupported int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version > ?`, items[len(items)-1].version).Scan(&unsupported); err != nil {
		return err
	}
	if unsupported > 0 {
		return fmt.Errorf("%w: database contains newer PostgreSQL migrations", ErrSchemaNotCurrent)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit PostgreSQL migrations: %w", err)
	}
	return nil
}

func (store *ProjectStore) validatePostgreSQLSchema() error {
	items, err := loadPostgresMigrations()
	if err != nil {
		return err
	}
	for _, item := range items {
		var name, checksum string
		if err := store.database.QueryRow(`SELECT name, checksum FROM schema_migrations WHERE version = ?`, item.version).Scan(&name, &checksum); err != nil {
			return fmt.Errorf("%w: PostgreSQL migration %d is missing or ledger is unavailable", ErrSchemaNotCurrent, item.version)
		}
		if name != item.name || checksum != item.checksum {
			return fmt.Errorf("%w: PostgreSQL migration %d checksum/name mismatch", ErrSchemaNotCurrent, item.version)
		}
	}
	var unsupported int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version > ?`, items[len(items)-1].version).Scan(&unsupported); err != nil {
		return fmt.Errorf("%w: cannot validate future PostgreSQL migrations", ErrSchemaNotCurrent)
	}
	if unsupported > 0 {
		return fmt.Errorf("%w: database contains newer PostgreSQL migrations", ErrSchemaNotCurrent)
	}
	return nil
}
