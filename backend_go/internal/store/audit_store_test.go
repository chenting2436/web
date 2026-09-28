package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

type testPostgresSQLStateError string

func (err testPostgresSQLStateError) Error() string    { return "postgres SQLSTATE " + string(err) }
func (err testPostgresSQLStateError) SQLState() string { return string(err) }

func TestAuditSerializationRetryContract(t *testing.T) {
	serialization := fmt.Errorf("wrapped: %w", testPostgresSQLStateError("40001"))
	if !isPostgreSQLSerializationFailure(serialization) {
		t.Fatal("wrapped SQLSTATE 40001 must be retryable")
	}
	atomicFailure := fmt.Errorf("%w: %w", ErrAtomicAuditWrite, serialization)
	if !isPostgreSQLSerializationFailure(atomicFailure) || !errors.Is(atomicFailure, ErrAtomicAuditWrite) {
		t.Fatal("atomic audit wrapping must preserve both the retry state and public sentinel")
	}
	if isPostgreSQLSerializationFailure(testPostgresSQLStateError("23505")) || isPostgreSQLSerializationFailure(errors.New("40001")) {
		t.Fatal("only a typed PostgreSQL serialization failure may be retried")
	}
	for attempt := 0; attempt < auditSerializationMaxAttempts; attempt++ {
		base := 5 * time.Millisecond * time.Duration(1<<attempt)
		delay := auditSerializationRetryDelay("audit-read-id", attempt)
		if delay < base || delay > 2*base {
			t.Fatalf("attempt %d delay %s is outside [%s,%s]", attempt, delay, base, 2*base)
		}
		if delay != auditSerializationRetryDelay("audit-read-id", attempt) {
			t.Fatal("retry jitter must be stable for one audit event and attempt")
		}
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitForAuditSerializationRetry(cancelled, time.Second); !errors.Is(err, context.Canceled) {
		t.Fatalf("retry wait must honor cancellation, got %v", err)
	}
}

func TestAuditV3PostgreSQLGoldenVector(t *testing.T) {
	event := AuditEvent{
		ID: "evt-黄金", TenantID: "tenant-a", WorkspaceID: "workspace-1", ActorUserID: "user:α",
		Action: "paper\nreview", ResourceType: "报告", ResourceID: "resource:42", Outcome: "success",
		RequestID: "req-1", SourceIP: "2001:db8::1", UserAgent: "SkyView/3\n测试",
		BeforeHash: "", AfterHash: "after:hash", PreviousEventHash: strings.Repeat("a", 64),
		Sequence: 42, ChainVersion: 3, CreatedAt: "2026-09-08T12:34:56.123456Z",
	}
	metadata := `{"line":"一\n二","n":1}`
	const expected = "f15b56a60e43cf350e996fab1ab830dd506d4e7d5e0cd0a96847a45e79f2d3d5"
	if got := auditHashV3(event, metadata); got != expected {
		t.Fatalf("audit v3 Go/PostgreSQL golden hash = %s, want %s", got, expected)
	}
}

func TestAuditV3FramesPreventV2CrossFieldNewlineCollision(t *testing.T) {
	left := testAuditEvent("field-boundary", "2026-09-08T00:00:00Z")
	left.Sequence, left.ChainVersion = 1, 2
	left.Action, left.ResourceType = "x\ny", "z"
	right := left
	right.Action, right.ResourceType = "x", "y\nz"
	if leftHash, rightHash := auditHashV2(left, `{}`), auditHashV2(right, `{}`); leftHash != rightHash {
		t.Fatalf("test fixture no longer demonstrates the v2 boundary collision: %s != %s", leftHash, rightHash)
	}
	left.ChainVersion, right.ChainVersion = 3, 3
	if leftHash, rightHash := auditHashV3(left, `{}`), auditHashV3(right, `{}`); leftHash == rightHash {
		t.Fatalf("v3 named length frames did not bind field boundaries: %s", leftHash)
	}
}

func TestAuditVerifierAcceptsOnlyMonotonicV1V2V3History(t *testing.T) {
	legacy := testAuditEvent("history-v1", "2026-01-01T00:00:00Z")
	legacy.ChainVersion = 1
	legacy.EventHash = auditHashV1(legacy, `{}`)
	v2 := testAuditEvent("history-v2", "2026-01-02T00:00:00Z")
	v2.ChainVersion, v2.Sequence, v2.PreviousEventHash = 2, 2, legacy.EventHash
	v2.EventHash = auditHashV2(v2, `{}`)
	v3 := testAuditEvent("history-v3", "2026-01-03T00:00:00Z")
	v3.ChainVersion, v3.Sequence, v3.PreviousEventHash = 3, 3, v2.EventHash
	v3.EventHash = auditHashV3(v3, `{}`)
	records := []storedAuditEvent{
		{event: legacy, metadataJSON: `{}`},
		{event: v2, metadataJSON: `{}`},
		{event: v3, metadataJSON: `{}`},
	}
	terminal, err := validateStoredAuditEvents(records, true)
	if err != nil || terminal != v3.EventHash {
		t.Fatalf("verify monotonic v1/v2/v3 history: terminal=%q err=%v", terminal, err)
	}

	backward := testAuditEvent("history-backward-v2", "2026-01-04T00:00:00Z")
	backward.ChainVersion, backward.Sequence, backward.PreviousEventHash = 2, 4, v3.EventHash
	backward.EventHash = auditHashV2(backward, `{}`)
	records = append(records, storedAuditEvent{event: backward, metadataJSON: `{}`})
	if _, err := validateStoredAuditEvents(records, true); err == nil || !strings.Contains(err.Error(), "moves chain version backward") {
		t.Fatalf("backward v3-to-v2 history must fail closed, got %v", err)
	}
}

func TestAuditChainUsesSequenceInsteadOfCreatedAt(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })

	first, err := projectStore.AppendAudit(testAuditEvent("first", "2030-01-01T00:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := projectStore.AppendAudit(testAuditEvent("second", "2020-01-01T00:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Sequence != 1 || second.Sequence != 2 || second.PreviousEventHash != first.EventHash {
		t.Fatalf("unexpected chain order: first=%+v second=%+v", first, second)
	}
	if first.ChainVersion != auditChainVersion || second.ChainVersion != auditChainVersion {
		t.Fatalf("new events must use chain version %d", auditChainVersion)
	}
	events, err := projectStore.ListAudit(Scope{TenantID: "tenant-audit", WorkspaceID: "workspace-audit"}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].ID != second.ID || events[1].ID != first.ID {
		t.Fatalf("audit listing did not follow sequence: %+v", events)
	}
	if err := projectStore.VerifyAuditChain(Scope{TenantID: "tenant-audit", WorkspaceID: "workspace-audit"}); err != nil {
		t.Fatalf("verify audit chain: %v", err)
	}
}

func TestSQLiteAuditV3MigrationPreservesAndContinuesV2History(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit-v2-upgrade.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	database := &databaseHandle{raw: raw, dialect: dialectSQLite}
	if _, err := database.Exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
		CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`); err != nil {
		_ = raw.Close()
		t.Fatal(err)
	}
	items := sqliteMigrations()
	for _, item := range items[:len(items)-1] {
		tx, err := database.Begin()
		if err != nil {
			_ = raw.Close()
			t.Fatal(err)
		}
		if err := item.apply(tx); err != nil {
			_ = tx.Rollback()
			_ = raw.Close()
			t.Fatalf("apply pre-v3 migration %d: %v", item.version, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)`,
			item.version, item.name, "2026-09-08T00:00:00Z"); err != nil {
			_ = tx.Rollback()
			_ = raw.Close()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			_ = raw.Close()
			t.Fatal(err)
		}
	}

	v2 := testAuditEvent("preserved-v2", "2026-09-08T01:02:03.123456Z")
	v2.ChainVersion, v2.Sequence = 2, 1
	v2.EventHash = auditHashV2(v2, `{}`)
	if _, err := database.Exec(`INSERT INTO audit_heads(tenant_id, workspace_id, head_event_hash, last_sequence, chain_version, updated_at)
		VALUES(?, ?, '', 0, 2, ?)`, v2.TenantID, v2.WorkspaceID, v2.CreatedAt); err != nil {
		_ = raw.Close()
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO audit_events(id, tenant_id, workspace_id, actor_user_id, action, resource_type,
		resource_id, outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
		previous_event_hash, event_hash, sequence_number, chain_version, created_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '', ?, 1, 2, ?)`,
		v2.ID, v2.TenantID, v2.WorkspaceID, v2.ActorUserID, v2.Action, v2.ResourceType, v2.ResourceID,
		v2.Outcome, v2.RequestID, v2.SourceIP, v2.UserAgent, v2.BeforeHash, v2.AfterHash, v2.EventHash, v2.CreatedAt); err != nil {
		_ = raw.Close()
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE audit_heads SET head_event_hash = ?, last_sequence = 1 WHERE tenant_id = ? AND workspace_id = ?`,
		v2.EventHash, v2.TenantID, v2.WorkspaceID); err != nil {
		_ = raw.Close()
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	projectStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatalf("upgrade v2 audit database: %v", err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	v3, err := projectStore.AppendAudit(testAuditEvent("continued-v3", "2026-09-08T01:02:04.123456Z"))
	if err != nil {
		t.Fatal(err)
	}
	if v3.ChainVersion != 3 || v3.Sequence != 2 || v3.PreviousEventHash != v2.EventHash {
		t.Fatalf("v3 append did not continue preserved v2 history: %+v", v3)
	}
	if err := projectStore.VerifyAuditChain(eventScope(v3)); err != nil {
		t.Fatalf("verify preserved v2 plus v3 history: %v", err)
	}
}

func TestAppendAuditTxParticipatesInCallerRollback(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	tx, err := projectStore.database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	appended, err := projectStore.appendAuditTx(tx, testAuditEvent("atomic-rollback", ""))
	if err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if appended.Sequence != 1 || appended.EventHash == "" {
		_ = tx.Rollback()
		t.Fatalf("unexpected transactional audit result: %+v", appended)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"audit_events", "audit_heads"} {
		var count int
		if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s escaped caller rollback: %d", table, count)
		}
	}
}

func TestConcurrentAuditAppendsHaveOneHeadAndUniqueSequence(t *testing.T) {
	projectStore, err := NewProjectStore(filepath.Join(t.TempDir(), "concurrent-audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })

	const writers = 40
	errorsByWriter := make(chan error, writers)
	var group sync.WaitGroup
	for index := 0; index < writers; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			event := testAuditEvent(fmt.Sprintf("concurrent-%02d", index), "")
			_, err := projectStore.AppendAudit(event)
			errorsByWriter <- err
		}(index)
	}
	group.Wait()
	close(errorsByWriter)
	for err := range errorsByWriter {
		if err != nil {
			t.Fatalf("concurrent append: %v", err)
		}
	}

	scope := Scope{TenantID: "tenant-audit", WorkspaceID: "workspace-audit"}
	events, err := projectStore.ListAudit(scope, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != writers {
		t.Fatalf("expected %d events, got %d", writers, len(events))
	}
	for index, event := range events {
		expected := int64(writers - index)
		if event.Sequence != expected {
			t.Fatalf("event %d has sequence %d, expected %d", index, event.Sequence, expected)
		}
	}
	if err := projectStore.VerifyAuditChain(scope); err != nil {
		t.Fatalf("verify concurrent audit chain: %v", err)
	}
	var heads, lastSequence int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*), MAX(last_sequence) FROM audit_heads
		WHERE tenant_id = ? AND workspace_id = ?`, scope.TenantID, scope.WorkspaceID).Scan(&heads, &lastSequence); err != nil {
		t.Fatal(err)
	}
	if heads != 1 || lastSequence != writers {
		t.Fatalf("unexpected durable head: heads=%d last_sequence=%d", heads, lastSequence)
	}
}

func TestAuditChainMigrationRejectsLegacyFork(t *testing.T) {
	path := filepath.Join(t.TempDir(), "forked-audit.db")
	projectStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := projectStore.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`DROP TRIGGER audit_events_chain_guard; DROP TABLE audit_heads;
		DELETE FROM schema_migrations WHERE version IN (7, 11);`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	root := testAuditEvent("legacy-root", "2026-01-01T00:00:00Z")
	root.ChainVersion = 1
	root.EventHash = auditHashV1(root, `{}`)
	left := testAuditEvent("legacy-left", "2026-01-02T00:00:00Z")
	left.ChainVersion, left.PreviousEventHash = 1, root.EventHash
	left.EventHash = auditHashV1(left, `{}`)
	right := testAuditEvent("legacy-right", "2026-01-03T00:00:00Z")
	right.ChainVersion, right.PreviousEventHash = 1, root.EventHash
	right.EventHash = auditHashV1(right, `{}`)
	for _, event := range []AuditEvent{root, left, right} {
		if _, err := database.Exec(`INSERT INTO audit_events(id, tenant_id, workspace_id, actor_user_id, action, resource_type,
			resource_id, outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
			previous_event_hash, event_hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
			event.ID, event.TenantID, event.WorkspaceID, event.ActorUserID, event.Action, event.ResourceType, event.ResourceID,
			event.Outcome, event.RequestID, event.SourceIP, event.UserAgent, event.BeforeHash, event.AfterHash,
			event.PreviousEventHash, event.EventHash, event.CreatedAt); err != nil {
			_ = database.Close()
			t.Fatal(err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := NewProjectStore(path); err == nil || !strings.Contains(err.Error(), "invalid legacy audit chain") {
		t.Fatalf("expected fail-closed fork rejection, got %v", err)
	}
}

func TestAuditChainMigrationPreflightRejectsTamperedLegacyHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tampered-legacy-audit.db")
	projectStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := projectStore.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`DROP TRIGGER audit_events_chain_guard; DROP TABLE audit_heads;
		DELETE FROM schema_migrations WHERE version IN (7, 11);`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	event := testAuditEvent("tampered-legacy", "2026-02-01T00:00:00Z")
	if _, err := database.Exec(`INSERT INTO audit_events(id, tenant_id, workspace_id, actor_user_id, action, resource_type,
		resource_id, outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
		previous_event_hash, event_hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '', ?, ?)`,
		event.ID, event.TenantID, event.WorkspaceID, event.ActorUserID, event.Action, event.ResourceType, event.ResourceID,
		event.Outcome, event.RequestID, event.SourceIP, event.UserAgent, event.BeforeHash, event.AfterHash,
		strings.Repeat("0", 64), event.CreatedAt); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := NewProjectStore(path); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("expected fail-closed legacy hash rejection, got %v", err)
	}
}

func TestAuditChainMigrationSeedsVerifiedLegacyHead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "valid-legacy-audit.db")
	projectStore, err := NewProjectStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := projectStore.Close(); err != nil {
		t.Fatal(err)
	}

	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`DROP TRIGGER audit_events_chain_guard; DROP TABLE audit_heads;
		DELETE FROM schema_migrations WHERE version IN (7, 11);`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	legacy := testAuditEvent("valid-legacy", "2026-03-01T00:00:00Z")
	legacy.ChainVersion = 1
	legacy.EventHash = auditHashV1(legacy, `{}`)
	if _, err := database.Exec(`INSERT INTO audit_events(id, tenant_id, workspace_id, actor_user_id, action, resource_type,
		resource_id, outcome, request_id, source_ip, user_agent, before_hash, after_hash, metadata_json,
		previous_event_hash, event_hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '', ?, ?)`,
		legacy.ID, legacy.TenantID, legacy.WorkspaceID, legacy.ActorUserID, legacy.Action, legacy.ResourceType, legacy.ResourceID,
		legacy.Outcome, legacy.RequestID, legacy.SourceIP, legacy.UserAgent, legacy.BeforeHash, legacy.AfterHash,
		legacy.EventHash, legacy.CreatedAt); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	projectStore, err = NewProjectStore(path)
	if err != nil {
		t.Fatalf("migrate valid legacy chain: %v", err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	newEvent, err := projectStore.AppendAudit(testAuditEvent("after-migration", "2025-01-01T00:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	if newEvent.Sequence != 2 || newEvent.PreviousEventHash != legacy.EventHash {
		t.Fatalf("new event did not continue legacy chain: %+v", newEvent)
	}
	if err := projectStore.VerifyAuditChain(Scope{TenantID: legacy.TenantID, WorkspaceID: legacy.WorkspaceID}); err != nil {
		t.Fatalf("verify mixed legacy/v3 chain: %v", err)
	}
}

func TestPostgreSQLLegacyHashRecoversPgxTruncatedNanoseconds(t *testing.T) {
	original := testAuditEvent("legacy-pg-microseconds", "2026-03-01T12:34:56.123456789Z")
	original.ChainVersion = 1
	original.EventHash = auditHashV1(original, `{}`)
	stored := original
	stored.CreatedAt = "2026-03-01T12:34:56.123456Z"
	record := storedAuditEvent{
		event: stored, metadataJSON: `{}`, legacyTimestampMicrosecondLoss: true,
	}
	terminal, err := validateStoredAuditEvents([]storedAuditEvent{record}, true)
	if err != nil || terminal != original.EventHash {
		t.Fatalf("recover valid pgx-truncated v1 timestamp: terminal=%q err=%v", terminal, err)
	}

	record.legacyTimestampMicrosecondLoss = false
	if _, err := validateStoredAuditEvents([]storedAuditEvent{record}, true); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("non-PostgreSQL legacy timestamp must not use recovery: %v", err)
	}
}

func TestPostgreSQLLegacyHashRecoveryRemainsFailClosed(t *testing.T) {
	original := testAuditEvent("legacy-pg-tampered", "2026-03-01T12:34:56.987654999Z")
	original.ChainVersion = 1
	original.EventHash = auditHashV1(original, `{"source":"original"}`)
	stored := original
	stored.CreatedAt = "2026-03-01T12:34:56.987654Z"
	record := storedAuditEvent{
		event: stored, metadataJSON: `{"source":"tampered"}`, legacyTimestampMicrosecondLoss: true,
	}
	if _, err := validateStoredAuditEvents([]storedAuditEvent{record}, true); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("timestamp recovery must not accept tampered metadata: %v", err)
	}
	stored.CreatedAt = "2026-03-01T12:34:56.987655Z"
	record.event = stored
	record.metadataJSON = `{"source":"original"}`
	if _, err := validateStoredAuditEvents([]storedAuditEvent{record}, true); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("timestamp recovery must not cross a stored microsecond boundary: %v", err)
	}
}

func TestOnlineLegacyHashRecoveryHasExplicitLimit(t *testing.T) {
	if err := validateOnlineLegacyAuditRecoverySize(maxOnlineLegacyAuditPrecisionRecoveryEvents); err != nil {
		t.Fatalf("boundary event count must be accepted: %v", err)
	}
	if err := validateOnlineLegacyAuditRecoverySize(maxOnlineLegacyAuditPrecisionRecoveryEvents + 1); err == nil || !strings.Contains(err.Error(), "offline snapshot") {
		t.Fatalf("oversized legacy chain must require offline validation: %v", err)
	}
	if err := validateOnlineLegacyAuditRecoverySize(-1); err == nil {
		t.Fatal("negative legacy event count must fail closed")
	}
}

func BenchmarkPostgreSQLLegacyTimestampHashRecoveryWorstCase(benchmark *testing.B) {
	original := testAuditEvent("legacy-pg-benchmark", "2026-03-01T12:34:56.123456999Z")
	original.ChainVersion = 1
	original.EventHash = auditHashV1(original, `{}`)
	stored := original
	stored.CreatedAt = "2026-03-01T12:34:56.123456Z"
	record := storedAuditEvent{event: stored, metadataJSON: `{}`, legacyTimestampMicrosecondLoss: true}
	benchmark.ResetTimer()
	for iteration := 0; iteration < benchmark.N; iteration++ {
		matched, err := storedAuditHashMatches(record, `{}`)
		if err != nil || !matched {
			benchmark.Fatalf("hash recovery failed: matched=%v err=%v", matched, err)
		}
	}
}

func TestAuditHashVerificationDetectsStoredPayloadMutation(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	event, err := projectStore.AppendAudit(testAuditEvent("verify", ""))
	if err != nil {
		t.Fatal(err)
	}
	scope := Scope{TenantID: event.TenantID, WorkspaceID: event.WorkspaceID}
	if err := projectStore.VerifyAuditChain(scope); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`DROP TRIGGER audit_events_no_update`); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`UPDATE audit_events SET metadata_json = '{"tampered":true}' WHERE id = ?`, event.ID); err != nil {
		t.Fatal(err)
	}
	if err := projectStore.VerifyAuditChain(scope); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
		t.Fatalf("expected hash mismatch, got %v", err)
	}
}

func TestListVerifiedAuditReturnsOnlyAfterFullChainValidation(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })

	first, err := projectStore.AppendAudit(testAuditEvent("verified-first", ""))
	if err != nil {
		t.Fatal(err)
	}
	second, err := projectStore.AppendAudit(testAuditEvent("verified-second", ""))
	if err != nil {
		t.Fatal(err)
	}
	events, err := projectStore.ListVerifiedAudit(context.Background(), Scope{TenantID: first.TenantID, WorkspaceID: first.WorkspaceID}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ID != second.ID {
		t.Fatalf("unexpected verified audit page: %+v", events)
	}
}

func TestListVerifiedAuditWithAuditCommitsReadEvidenceBeforeReturning(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	initial, err := projectStore.AppendAudit(testAuditEvent("before-sensitive-read", ""))
	if err != nil {
		t.Fatal(err)
	}
	scope := eventScope(initial)
	scope.UserID = initial.ActorUserID
	readEvent := testAuditEvent("sensitive-read", "")
	readEvent.Action = "audit.events.read"
	readEvent.ResourceType = "audit_log"
	readEvent.ResourceID = scope.WorkspaceID

	events, err := projectStore.ListVerifiedAuditWithAudit(context.Background(), scope, 100, readEvent)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Action != "audit.events.read" || events[0].Sequence != 2 {
		t.Fatalf("read evidence was not committed before listing: %+v", events)
	}
	if err := projectStore.VerifyAuditChain(scope); err != nil {
		t.Fatalf("read evidence did not preserve the verified chain: %v", err)
	}
}

func TestListVerifiedAuditWithAuditReturnsNoEventsWhenEvidenceAppendFails(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	initial, err := projectStore.AppendAudit(testAuditEvent("before-read-failure", ""))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`CREATE TRIGGER force_audit_read_failure BEFORE INSERT ON audit_events
		BEGIN SELECT RAISE(ABORT, 'forced_audit_read_failure'); END`); err != nil {
		t.Fatal(err)
	}
	scope := eventScope(initial)
	scope.UserID = initial.ActorUserID
	readEvent := testAuditEvent("failed-sensitive-read", "")
	readEvent.Action = "audit.events.read"
	readEvent.ResourceType = "audit_log"
	readEvent.ResourceID = scope.WorkspaceID

	events, err := projectStore.ListVerifiedAuditWithAudit(context.Background(), scope, 100, readEvent)
	if !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit failure, got events=%+v err=%v", events, err)
	}
	if events != nil {
		t.Fatalf("failed read-evidence append must return no events, got %+v", events)
	}
	var count int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM audit_events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("failed read evidence escaped rollback: %d audit events", count)
	}
}

func TestListVerifiedAuditFailsClosedWithoutReturningTamperedEvents(t *testing.T) {
	tests := []struct {
		name   string
		tamper func(*testing.T, *ProjectStore, AuditEvent)
	}{
		{
			name: "event payload",
			tamper: func(t *testing.T, projectStore *ProjectStore, event AuditEvent) {
				t.Helper()
				if _, err := projectStore.database.Exec(`DROP TRIGGER audit_events_no_update`); err != nil {
					t.Fatal(err)
				}
				if _, err := projectStore.database.Exec(`UPDATE audit_events SET metadata_json = '{"tampered":true}' WHERE id = ?`, event.ID); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "durable head",
			tamper: func(t *testing.T, projectStore *ProjectStore, event AuditEvent) {
				t.Helper()
				if _, err := projectStore.database.Exec(`UPDATE audit_heads SET last_sequence = 99
					WHERE tenant_id = ? AND workspace_id = ?`, event.TenantID, event.WorkspaceID); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			projectStore, err := NewProjectStore(":memory:")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = projectStore.Close() })
			event, err := projectStore.AppendAudit(testAuditEvent("fail-closed-"+strings.ReplaceAll(test.name, " ", "-"), ""))
			if err != nil {
				t.Fatal(err)
			}
			test.tamper(t, projectStore, event)

			events, err := projectStore.ListVerifiedAudit(context.Background(), eventScope(event), 100)
			if !errors.Is(err, ErrAuditChainInvalid) {
				t.Fatalf("expected ErrAuditChainInvalid, got events=%+v err=%v", events, err)
			}
			if events != nil {
				t.Fatalf("tampered audit read must return no events, got %+v", events)
			}
		})
	}
}

func eventScope(event AuditEvent) Scope {
	return Scope{TenantID: event.TenantID, WorkspaceID: event.WorkspaceID}
}

func testAuditEvent(id, createdAt string) AuditEvent {
	return AuditEvent{
		ID: id, TenantID: "tenant-audit", WorkspaceID: "workspace-audit", ActorUserID: "user-audit",
		Action: "project.update", ResourceType: "project", ResourceID: "project-audit", Outcome: "success",
		RequestID: "request-" + id, SourceIP: "127.0.0.1", UserAgent: "audit-test", Metadata: map[string]any{},
		CreatedAt: createdAt,
	}
}
