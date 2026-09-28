package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

const (
	AdapterSQLiteDevelopment = "sqlite-development"
	AdapterPostgreSQL        = "postgresql"
)

var ErrSchemaNotCurrent = errors.New("database schema is not current")

// StoreConfig selects one durable data adapter. SQLite is intentionally named
// as a development adapter so it cannot be mistaken for a production backend.
type StoreConfig struct {
	Adapter         string
	SQLitePath      string
	PostgresDSN     string
	ApplyMigrations bool
	// RequireExistingSchema prevents development SQLite from creating or
	// upgrading schema objects. It is used by one-shot operational readers and
	// importers that must not mutate a database merely by opening it. PostgreSQL
	// already has this behavior whenever ApplyMigrations is false.
	RequireExistingSchema bool
	RequireTLS            bool
	ConnectTimeout        time.Duration
	MaxOpenConns          int
	MaxIdleConns          int
}

type databaseDialect int

const (
	dialectSQLite databaseDialect = iota
	dialectPostgreSQL
)

type databaseHandle struct {
	raw     *sql.DB
	dialect databaseDialect
}

type databaseTx struct {
	raw     *sql.Tx
	dialect databaseDialect
}

func openDatabase(config StoreConfig) (*databaseHandle, string, error) {
	adapter, err := normalizeStoreConfig(&config)
	if err != nil {
		return nil, "", err
	}

	var raw *sql.DB
	switch adapter {
	case AdapterSQLiteDevelopment:
		path := config.SQLitePath
		if path == "" {
			path = ":memory:"
		}
		if path != ":memory:" {
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				return nil, "", fmt.Errorf("create sqlite directory: %w", err)
			}
		}
		raw, err = sql.Open("sqlite", path)
		if err != nil {
			return nil, "", fmt.Errorf("open sqlite development database: %w", err)
		}
		// SQLite is retained only for deterministic development and tests. A
		// single connection also preserves in-memory database semantics.
		raw.SetMaxOpenConns(1)
		raw.SetMaxIdleConns(1)
		return &databaseHandle{raw: raw, dialect: dialectSQLite}, adapter, nil

	case AdapterPostgreSQL:
		raw, err = sql.Open("pgx", config.PostgresDSN)
		if err != nil {
			return nil, "", fmt.Errorf("open PostgreSQL database: %w", err)
		}
		maxOpen := config.MaxOpenConns
		if maxOpen <= 0 {
			maxOpen = 20
		}
		maxIdle := config.MaxIdleConns
		if maxIdle < 0 {
			maxIdle = 0
		} else if maxIdle == 0 {
			maxIdle = min(5, maxOpen)
		}
		raw.SetMaxOpenConns(maxOpen)
		raw.SetMaxIdleConns(min(maxIdle, maxOpen))
		raw.SetConnMaxLifetime(30 * time.Minute)
		raw.SetConnMaxIdleTime(5 * time.Minute)

		timeout := config.ConnectTimeout
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := raw.PingContext(ctx); err != nil {
			_ = raw.Close()
			return nil, "", fmt.Errorf("connect PostgreSQL database: %w", err)
		}
		return &databaseHandle{raw: raw, dialect: dialectPostgreSQL}, adapter, nil
	default:
		return nil, "", fmt.Errorf("unsupported database adapter %q", adapter)
	}
}

func normalizeStoreConfig(config *StoreConfig) (string, error) {
	adapter := strings.ToLower(strings.TrimSpace(config.Adapter))
	switch adapter {
	case "sqlite", AdapterSQLiteDevelopment:
		if strings.TrimSpace(config.PostgresDSN) != "" {
			return "", errors.New("PostgresDSN must be empty for sqlite-development")
		}
		return AdapterSQLiteDevelopment, nil
	case "postgres", "postgresql":
		if strings.TrimSpace(config.SQLitePath) != "" {
			return "", errors.New("SQLitePath must be empty for PostgreSQL")
		}
		if err := validatePostgresDSN(config.PostgresDSN, config.RequireTLS); err != nil {
			return "", err
		}
		return AdapterPostgreSQL, nil
	case "":
		return "", errors.New("database adapter is required")
	default:
		return "", fmt.Errorf("unsupported database adapter %q", adapter)
	}
}

func validatePostgresDSN(raw string, requireTLS bool) error {
	if strings.TrimSpace(raw) == "" {
		return errors.New("PostgreSQL DSN is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return errors.New("PostgreSQL DSN must be a postgres:// or postgresql:// URL")
	}
	if parsed.Hostname() == "" || strings.Trim(parsed.EscapedPath(), "/") == "" {
		return errors.New("PostgreSQL DSN must include a host and database name")
	}
	if requireTLS && parsed.Query().Get("sslmode") != "verify-full" {
		return errors.New("production PostgreSQL requires sslmode=verify-full")
	}
	return nil
}

func (database *databaseHandle) Adapter() string {
	if database.dialect == dialectPostgreSQL {
		return AdapterPostgreSQL
	}
	return AdapterSQLiteDevelopment
}

func (database *databaseHandle) Close() error {
	return database.raw.Close()
}

func (database *databaseHandle) Ping() error {
	return database.raw.Ping()
}

func (database *databaseHandle) timestamp(value string) any {
	return timestampArgument(database.dialect, value)
}

func (database *databaseHandle) json(value []byte) any {
	return jsonArgument(database.dialect, value)
}

func (database *databaseHandle) Exec(query string, args ...any) (sql.Result, error) {
	return database.raw.Exec(rebind(query, database.dialect), args...)
}

func (database *databaseHandle) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return database.raw.ExecContext(ctx, rebind(query, database.dialect), args...)
}

func (database *databaseHandle) Query(query string, args ...any) (*sql.Rows, error) {
	return database.raw.Query(rebind(query, database.dialect), args...)
}

func (database *databaseHandle) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return database.raw.QueryContext(ctx, rebind(query, database.dialect), args...)
}

func (database *databaseHandle) QueryRow(query string, args ...any) *sql.Row {
	return database.raw.QueryRow(rebind(query, database.dialect), args...)
}

func (database *databaseHandle) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return database.raw.QueryRowContext(ctx, rebind(query, database.dialect), args...)
}

func (database *databaseHandle) Begin() (*databaseTx, error) {
	tx, err := database.raw.Begin()
	if err != nil {
		return nil, err
	}
	return &databaseTx{raw: tx, dialect: database.dialect}, nil
}

func (database *databaseHandle) BeginContext(ctx context.Context) (*databaseTx, error) {
	tx, err := database.raw.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	return &databaseTx{raw: tx, dialect: database.dialect}, nil
}

func (tx *databaseTx) Exec(query string, args ...any) (sql.Result, error) {
	return tx.raw.Exec(rebind(query, tx.dialect), args...)
}

func (tx *databaseTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return tx.raw.ExecContext(ctx, rebind(query, tx.dialect), args...)
}

func (tx *databaseTx) Query(query string, args ...any) (*sql.Rows, error) {
	return tx.raw.Query(rebind(query, tx.dialect), args...)
}

func (tx *databaseTx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return tx.raw.QueryContext(ctx, rebind(query, tx.dialect), args...)
}

func (tx *databaseTx) QueryRow(query string, args ...any) *sql.Row {
	return tx.raw.QueryRow(rebind(query, tx.dialect), args...)
}

func (tx *databaseTx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return tx.raw.QueryRowContext(ctx, rebind(query, tx.dialect), args...)
}

func (tx *databaseTx) Commit() error {
	return tx.raw.Commit()
}

func (tx *databaseTx) Rollback() error {
	return tx.raw.Rollback()
}

func (tx *databaseTx) timestamp(value string) any {
	return timestampArgument(tx.dialect, value)
}

func (tx *databaseTx) optionalTimestamp(value string) any {
	if tx.dialect == dialectPostgreSQL && value == "" {
		return nil
	}
	return timestampArgument(tx.dialect, value)
}

func (tx *databaseTx) json(value []byte) any {
	return jsonArgument(tx.dialect, value)
}

func jsonArgument(dialect databaseDialect, value []byte) any {
	if dialect == dialectPostgreSQL {
		return value
	}
	return string(value)
}

func timestampArgument(dialect databaseDialect, value string) any {
	if dialect != dialectPostgreSQL {
		return value
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		// All callers use this only for typed timestamp columns. Returning the
		// original value makes PostgreSQL reject an invalid timestamp rather
		// than silently coercing it in application code.
		return value
	}
	return parsed.UTC()
}

type timestampText string

func (value *timestampText) Scan(source any) error {
	switch typed := source.(type) {
	case time.Time:
		*value = timestampText(typed.UTC().Format(time.RFC3339Nano))
		return nil
	case string:
		*value = timestampText(typed)
		return nil
	case []byte:
		*value = timestampText(string(typed))
		return nil
	case nil:
		*value = ""
		return nil
	default:
		return fmt.Errorf("unsupported timestamp source %T", source)
	}
}

// rebind converts the static, parameterized SQL used by the store to pgx's
// positional syntax. It deliberately skips quoted strings, identifiers,
// comments, and dollar-quoted bodies so SQL text cannot change placeholder
// cardinality.
func rebind(query string, dialect databaseDialect) string {
	if dialect != dialectPostgreSQL || !strings.Contains(query, "?") {
		return query
	}
	var result strings.Builder
	result.Grow(len(query) + 8)
	parameter := 1
	for index := 0; index < len(query); {
		switch query[index] {
		case '\'':
			index = copyQuoted(&result, query, index, '\'')
		case '"':
			index = copyQuoted(&result, query, index, '"')
		case '-':
			if index+1 < len(query) && query[index+1] == '-' {
				end := strings.IndexByte(query[index+2:], '\n')
				if end < 0 {
					result.WriteString(query[index:])
					return result.String()
				}
				end += index + 3
				result.WriteString(query[index:end])
				index = end
				continue
			}
			result.WriteByte(query[index])
			index++
		case '/':
			if index+1 < len(query) && query[index+1] == '*' {
				end := strings.Index(query[index+2:], "*/")
				if end < 0 {
					result.WriteString(query[index:])
					return result.String()
				}
				end += index + 4
				result.WriteString(query[index:end])
				index = end
				continue
			}
			result.WriteByte(query[index])
			index++
		case '$':
			if delimiter, ok := dollarDelimiter(query[index:]); ok {
				bodyStart := index + len(delimiter)
				bodyEnd := strings.Index(query[bodyStart:], delimiter)
				if bodyEnd < 0 {
					result.WriteString(query[index:])
					return result.String()
				}
				end := bodyStart + bodyEnd + len(delimiter)
				result.WriteString(query[index:end])
				index = end
				continue
			}
			result.WriteByte(query[index])
			index++
		case '?':
			result.WriteByte('$')
			result.WriteString(strconv.Itoa(parameter))
			parameter++
			index++
		default:
			result.WriteByte(query[index])
			index++
		}
	}
	return result.String()
}

func copyQuoted(result *strings.Builder, query string, start int, quote byte) int {
	result.WriteByte(quote)
	for index := start + 1; index < len(query); index++ {
		result.WriteByte(query[index])
		if query[index] != quote {
			continue
		}
		if index+1 < len(query) && query[index+1] == quote {
			result.WriteByte(query[index+1])
			index++
			continue
		}
		return index + 1
	}
	return len(query)
}

func dollarDelimiter(query string) (string, bool) {
	if len(query) < 2 || query[0] != '$' {
		return "", false
	}
	end := strings.IndexByte(query[1:], '$')
	if end < 0 {
		return "", false
	}
	end++
	tag := query[1:end]
	for index, character := range tag {
		if !(character == '_' || character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || index > 0 && character >= '0' && character <= '9') {
			return "", false
		}
	}
	return query[:end+1], true
}
