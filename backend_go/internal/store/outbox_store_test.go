package store

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestOutboxRelayAccessRequiresExactBoundedScopes(t *testing.T) {
	valid := OutboxRelayAccess{RelayID: "relay-primary", Scopes: []OutboxRelayScope{{
		TenantID: "tenant-a", WorkspaceID: "workspace-a", EventTypes: []string{"job.succeeded", "job.failed"},
	}}}
	encoded, err := validateAndEncodeOutboxRelayAccess(valid)
	if err != nil || !strings.Contains(encoded, `"tenantId":"tenant-a"`) || !strings.Contains(encoded, `"eventTypes":["job.succeeded","job.failed"]`) {
		t.Fatalf("valid relay scope did not encode exactly: %q err=%v", encoded, err)
	}
	tests := []OutboxRelayAccess{
		{},
		{RelayID: "relay", Scopes: []OutboxRelayScope{{TenantID: "tenant", WorkspaceID: "workspace"}}},
		{RelayID: "relay", Scopes: []OutboxRelayScope{{TenantID: "tenant", WorkspaceID: "workspace", EventTypes: []string{"*"}}}},
		{RelayID: "relay", Scopes: []OutboxRelayScope{{TenantID: "tenant", WorkspaceID: "workspace", EventTypes: []string{"job.failed", "job.failed"}}}},
		{RelayID: "relay", Scopes: []OutboxRelayScope{
			{TenantID: "tenant", WorkspaceID: "workspace", EventTypes: []string{"job.failed"}},
			{TenantID: "tenant", WorkspaceID: "workspace", EventTypes: []string{"job.succeeded"}},
		}},
	}
	for index, access := range tests {
		if _, err := validateAndEncodeOutboxRelayAccess(access); err == nil {
			t.Fatalf("unsafe relay access case %d was accepted: %+v", index, access)
		}
	}
}

func TestOutboxIdempotencyClaimFailRetryAndAck(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-outbox", "workspace-outbox", "owner@outbox.test", "Owner", "admin")
	if err != nil {
		t.Fatal(err)
	}
	message := OutboxEvent{
		ID: "event-stable-1", TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		AggregateType: "project", AggregateID: "project-1", EventType: "project.created",
		Payload: map[string]any{"projectId": "project-1", "revision": 1},
	}
	created, inserted, err := projectStore.EnqueueOutbox(message)
	if err != nil || !inserted || created.Attempt != 0 || created.ClaimedAt != "" || created.ProcessedAt != "" {
		t.Fatalf("unexpected enqueue inserted=%t event=%#v err=%v", inserted, created, err)
	}
	replayed, inserted, err := projectStore.EnqueueOutbox(message)
	if err != nil || inserted || replayed.ID != created.ID {
		t.Fatalf("idempotent replay failed inserted=%t event=%#v err=%v", inserted, replayed, err)
	}
	conflict := message
	conflict.Payload = map[string]any{"projectId": "different"}
	if _, _, err := projectStore.EnqueueOutbox(conflict); !errors.Is(err, ErrOutboxEventConflict) {
		t.Fatalf("expected idempotency conflict, got %v", err)
	}
	if _, found, err := projectStore.GetOutbox(Scope{TenantID: identity.TenantID, WorkspaceID: "another-workspace"}, created.ID); err != nil || found {
		t.Fatalf("outbox scope leaked across workspaces found=%t err=%v", found, err)
	}

	claimed, found, err := projectStore.ClaimNextOutbox("relay-1", time.Minute)
	if err != nil || !found || claimed.Event.Attempt != 1 || claimed.Event.ClaimedBy != "relay-1" ||
		claimed.Event.ClaimedAt == "" || claimed.ClaimToken == "" || claimed.ClaimEpoch != 1 {
		t.Fatalf("first claim failed found=%t event=%#v err=%v", found, claimed, err)
	}
	if _, found, err := projectStore.AckOutbox(claimed.Event.ID, "relay-2", claimed.ClaimToken); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("wrong worker acknowledgement must fail found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.AckOutbox(claimed.Event.ID, "relay-1", "wrong-token"); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("wrong token acknowledgement must fail found=%t err=%v", found, err)
	}
	lease, found, err := projectStore.HeartbeatOutbox(claimed.Event.ID, "relay-1", claimed.ClaimToken, time.Minute)
	if err != nil || !found || lease.ClaimEpoch != claimed.ClaimEpoch || lease.LeaseExpiresAt == "" {
		t.Fatalf("heartbeat failed found=%t lease=%#v err=%v", found, lease, err)
	}
	failed, found, err := projectStore.FailOutbox(claimed.Event.ID, "relay-1", claimed.ClaimToken, "temporary downstream failure", 0)
	if err != nil || !found || failed.ClaimedAt != "" || failed.ClaimedBy != "" || failed.LastError == "" || failed.Attempt != 1 {
		t.Fatalf("failed delivery was not scheduled for retry: found=%t event=%#v err=%v", found, failed, err)
	}
	retried, found, err := projectStore.ClaimNextOutbox("relay-2", time.Minute)
	if err != nil || !found || retried.Event.Attempt != 2 || retried.Event.ClaimedBy != "relay-2" ||
		retried.Event.LastError != "" || retried.ClaimEpoch != 2 || retried.ClaimToken == claimed.ClaimToken {
		t.Fatalf("retry claim failed found=%t event=%#v err=%v", found, retried, err)
	}
	if _, found, err := projectStore.AckOutbox(retried.Event.ID, "relay-1", claimed.ClaimToken); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("ABA acknowledgement with stale token must fail found=%t err=%v", found, err)
	}
	processed, found, err := projectStore.AckOutbox(retried.Event.ID, "relay-2", retried.ClaimToken)
	if err != nil || !found || processed.ProcessedAt == "" || processed.Attempt != 2 {
		t.Fatalf("acknowledgement failed found=%t event=%#v err=%v", found, processed, err)
	}
	if _, found, err := projectStore.ClaimNextOutbox("relay-3", time.Minute); err != nil || found {
		t.Fatalf("processed event was reclaimed: found=%t err=%v", found, err)
	}
	if _, found, err := projectStore.FailOutbox(processed.ID, "relay-2", retried.ClaimToken, "late failure", time.Hour); !found || !errors.Is(err, ErrOutboxTransition) {
		t.Fatalf("processed event transition must fail found=%t err=%v", found, err)
	}
}

func TestEnqueueTxRollsBackWithOwningBusinessTransaction(t *testing.T) {
	projectStore, err := NewProjectStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = projectStore.Close() })
	identity, err := projectStore.EnsureDevIdentity("tenant-outbox-tx", "workspace-outbox-tx", "owner@tx.test", "Owner", "admin")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := projectStore.database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	event, inserted, err := projectStore.enqueueTx(tx, OutboxEvent{
		ID: "event-rollback", TenantID: identity.TenantID, WorkspaceID: identity.WorkspaceID,
		AggregateType: "project", AggregateID: "project-rollback", EventType: "project.updated", Payload: map[string]any{"version": 2},
	})
	if err != nil || !inserted {
		t.Fatalf("transactional enqueue failed inserted=%t err=%v", inserted, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, found, err := projectStore.GetOutbox(identity.Scope(), event.ID); err != nil || found {
		t.Fatalf("rolled back event escaped transaction found=%t err=%v", found, err)
	}
}

func TestPostgreSQLOutboxMigrationUsesProductionTypesAndClaimPrimitive(t *testing.T) {
	items, err := loadPostgresMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var outbox postgresMigration
	for _, item := range items {
		if item.version == 4 && item.name == "transactional_outbox" {
			outbox = item
			break
		}
	}
	if outbox.version == 0 {
		t.Fatal("missing PostgreSQL 004 transactional outbox migration")
	}
	for _, required := range []string{"payload_json JSONB", "available_at TIMESTAMPTZ", "claimed_at TIMESTAMPTZ", "processed_at TIMESTAMPTZ", "FOREIGN KEY (tenant_id, workspace_id)"} {
		if !containsSQL(outbox.sql, required) {
			t.Fatalf("outbox migration missing %q", required)
		}
	}
	if query := outboxClaimQuery(AdapterPostgreSQL); !containsSQL(query, "FOR UPDATE SKIP LOCKED") {
		t.Fatalf("PostgreSQL claim must use SKIP LOCKED: %s", query)
	}
	if query := outboxClaimQuery(AdapterSQLiteDevelopment); containsSQL(query, "FOR UPDATE SKIP LOCKED") {
		t.Fatalf("SQLite claim must remain single-node compatible: %s", query)
	}
	var leases postgresMigration
	for _, item := range items {
		if item.version == 8 && item.name == "job_outbox_leases" {
			leases = item
		}
	}
	if leases.version == 0 {
		t.Fatal("missing PostgreSQL 008 job/outbox lease migration")
	}
	for _, required := range []string{"claim_token_hash", "claim_epoch", "lease_expires_at TIMESTAMPTZ", "dead_letter_at TIMESTAMPTZ", "CURRENT_TIMESTAMP"} {
		if !containsSQL(leases.sql, required) {
			t.Fatalf("lease migration missing %q", required)
		}
	}
}

func containsSQL(value, fragment string) bool {
	return strings.Contains(value, fragment)
}
