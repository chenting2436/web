package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestLegacyWorkbenchImportDryRunApplyAndIdempotentRetry(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	legacy := []byte(`{"guest|python-lab":{"action":"run","fields":{"code":"print(12)"}}}`)
	manifest := legacyWorkbenchManifestJSON(t, legacy, LegacyWorkbenchImportMapping{
		LegacyUserKey: "guest", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID, AcknowledgeAnonymousSource: true,
	})

	dryRun, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, false)
	if err != nil {
		t.Fatal(err)
	}
	if dryRun.Mode != "dry-run" || dryRun.Total != 1 || dryRun.WouldImport != 1 || dryRun.Imported != 0 || dryRun.AlreadyPresent != 0 {
		t.Fatalf("unexpected dry-run report: %+v", dryRun)
	}
	if _, found, err := projectStore.GetWorkbenchState(target.Scope(), "python-lab"); err != nil || found {
		t.Fatalf("dry-run wrote destination state: found=%v err=%v", found, err)
	}
	if events, err := projectStore.ListAudit(target.Scope(), 10); err != nil || len(events) != 0 {
		t.Fatalf("dry-run wrote audit evidence: events=%+v err=%v", events, err)
	}

	applied, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, true)
	if err != nil {
		t.Fatal(err)
	}
	if applied.Mode != "apply" || applied.Total != 1 || applied.Imported != 1 || applied.AlreadyPresent != 0 || applied.Entries[0].Disposition != "imported" {
		t.Fatalf("unexpected apply report: %+v", applied)
	}
	state, found, err := projectStore.GetWorkbenchState(target.Scope(), "python-lab")
	if err != nil || !found || state.Revision != 1 || state.State["action"] != "run" {
		t.Fatalf("imported state mismatch: state=%+v found=%v err=%v", state, found, err)
	}
	events, err := projectStore.ListAudit(target.Scope(), 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("expected one import event: events=%+v err=%v", events, err)
	}
	event := events[0]
	if event.Action != "workbench.state.legacy_import" || event.ActorUserID != actor.UserID || event.ResourceID != target.UserID+"/python-lab" || event.AfterHash == "" {
		t.Fatalf("unexpected import evidence: %+v", event)
	}
	if event.Metadata["sourceSha256"] != byteSHA256(legacy) || event.Metadata["targetUserId"] != target.UserID {
		t.Fatalf("import evidence omitted provenance: %+v", event.Metadata)
	}
	if err := projectStore.VerifyAuditChain(target.Scope()); err != nil {
		t.Fatalf("verify imported audit chain: %v", err)
	}

	retried, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, true)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Imported != 0 || retried.AlreadyPresent != 1 || retried.Entries[0].Disposition != "already-present" {
		t.Fatalf("retry was not idempotent: %+v", retried)
	}
	events, err = projectStore.ListAudit(target.Scope(), 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("idempotent retry appended evidence: events=%+v err=%v", events, err)
	}
}

func TestLegacyWorkbenchImportConflictRollsBackWholeBatch(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	if _, err := projectStore.PutWorkbenchState(target.Scope(), "paper-writing", 0, map[string]any{"draft": "existing"}); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{
		"guest|data-lab":{"rows":[1,2]},
		"guest|paper-writing":{"draft":"legacy"}
	}`)
	manifest := legacyWorkbenchManifestJSON(t, legacy, LegacyWorkbenchImportMapping{
		LegacyUserKey: "guest", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID, AcknowledgeAnonymousSource: true,
	})

	report, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, true)
	if !errors.Is(err, ErrLegacyWorkbenchImportConflict) {
		t.Fatalf("expected conflict, report=%+v err=%v", report, err)
	}
	if _, found, err := projectStore.GetWorkbenchState(target.Scope(), "data-lab"); err != nil || found {
		t.Fatalf("conflicted batch partially imported data-lab: found=%v err=%v", found, err)
	}
	existing, found, err := projectStore.GetWorkbenchState(target.Scope(), "paper-writing")
	if err != nil || !found || existing.State["draft"] != "existing" {
		t.Fatalf("conflict overwrote destination: state=%+v found=%v err=%v", existing, found, err)
	}
	if events, err := projectStore.ListAudit(target.Scope(), 10); err != nil || len(events) != 0 {
		t.Fatalf("conflicted import wrote evidence: events=%+v err=%v", events, err)
	}
}

func TestLegacyWorkbenchImportRequiresExplicitGuestAcknowledgementAndExactMapping(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	legacy := []byte(`{"guest|python-lab":{"action":"run"}}`)

	missing := legacyWorkbenchManifestJSON(t, legacy)
	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, missing, false); !errors.Is(err, ErrLegacyWorkbenchImportMapping) || !strings.Contains(err.Error(), "no explicit mapping") {
		t.Fatalf("guest was accepted without an explicit mapping: %v", err)
	}

	unacknowledged := legacyWorkbenchManifestJSON(t, legacy, LegacyWorkbenchImportMapping{
		LegacyUserKey: "guest", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID,
	})
	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, unacknowledged, false); !errors.Is(err, ErrLegacyWorkbenchImportMapping) || !strings.Contains(err.Error(), "acknowledgeAnonymousSource") {
		t.Fatalf("guest was accepted without anonymous-source acknowledgement: %v", err)
	}

	wrongDigestManifest := LegacyWorkbenchImportManifest{
		Version: LegacyWorkbenchImportManifestVersion, SourceSHA256: strings.Repeat("0", 64),
		Mappings: []LegacyWorkbenchImportMapping{{
			LegacyUserKey: "guest", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
			UserID: target.UserID, ActorUserID: actor.UserID, AcknowledgeAnonymousSource: true,
		}},
	}
	wrongDigest, _ := json.Marshal(wrongDigestManifest)
	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, wrongDigest, false); !errors.Is(err, ErrLegacyWorkbenchImportMapping) || !strings.Contains(err.Error(), "sourceSha256") {
		t.Fatalf("mapping was not bound to the exact source file: %v", err)
	}
}

func TestLegacyWorkbenchImportRequiresExistingActiveTargetAndAdminActor(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	legacy := []byte(`{"alice|paper-writing":{"draft":true}}`)
	mapping := LegacyWorkbenchImportMapping{
		LegacyUserKey: "alice", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID,
	}

	if _, err := projectStore.database.Exec(`UPDATE memberships SET role = 'researcher' WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?`, actor.TenantID, actor.WorkspaceID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	manifest := legacyWorkbenchManifestJSON(t, legacy, mapping)
	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, false); !errors.Is(err, ErrLegacyWorkbenchImportMapping) || !strings.Contains(err.Error(), "admin") {
		t.Fatalf("non-admin actor accepted: %v", err)
	}

	if _, err := projectStore.database.Exec(`UPDATE memberships SET role = 'admin' WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?`, actor.TenantID, actor.WorkspaceID, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.database.Exec(`UPDATE memberships SET status = 'suspended' WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?`, target.TenantID, target.WorkspaceID, target.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, true); !errors.Is(err, ErrLegacyWorkbenchImportMapping) || !strings.Contains(err.Error(), "active") {
		t.Fatalf("inactive target accepted: %v", err)
	}
}

func TestLegacyWorkbenchImportRejectsCrossScopeOrMixedActorBatch(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	legacy := []byte(`{
		"alice|paper-writing":{"draft":true},
		"bob|data-lab":{"rows":[]}
	}`)
	base := LegacyWorkbenchImportMapping{
		LegacyUserKey: "alice", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID,
	}
	tests := []struct {
		name   string
		second LegacyWorkbenchImportMapping
	}{
		{name: "cross tenant", second: LegacyWorkbenchImportMapping{
			LegacyUserKey: "bob", TenantID: "tenant-other", WorkspaceID: target.WorkspaceID,
			UserID: "user-other", ActorUserID: actor.UserID,
		}},
		{name: "cross workspace", second: LegacyWorkbenchImportMapping{
			LegacyUserKey: "bob", TenantID: target.TenantID, WorkspaceID: "workspace-other",
			UserID: "user-other", ActorUserID: actor.UserID,
		}},
		{name: "mixed actor", second: LegacyWorkbenchImportMapping{
			LegacyUserKey: "bob", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
			UserID: "user-other", ActorUserID: "admin-other",
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := legacyWorkbenchManifestJSON(t, legacy, base, test.second)
			if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, false); !errors.Is(err, ErrLegacyWorkbenchImportMapping) || !strings.Contains(err.Error(), "one tenantId") {
				t.Fatalf("cross-boundary batch was not rejected before database access: %v", err)
			}
		})
	}
}

func TestLegacyWorkbenchImportRejectsInvalidAndAmbiguousInput(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	mapping := LegacyWorkbenchImportMapping{
		LegacyUserKey: "alice", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID,
	}
	tests := []struct {
		name   string
		legacy []byte
	}{
		{name: "unknown slug", legacy: []byte(`{"alice|not-a-workbench":{"ok":true}}`)},
		{name: "state is array", legacy: []byte(`{"alice|paper-writing":[1,2]}`)},
		{name: "duplicate root key", legacy: []byte(`{"alice|paper-writing":{},"alice|paper-writing":{}}`)},
		{name: "duplicate nested key", legacy: []byte(`{"alice|paper-writing":{"draft":1,"draft":2}}`)},
		{name: "oversize state", legacy: []byte(`{"alice|paper-writing":{"payload":"` + strings.Repeat("x", MaxWorkbenchStateBytes) + `"}}`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := legacyWorkbenchManifestJSON(t, test.legacy, mapping)
			if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), test.legacy, manifest, false); !errors.Is(err, ErrLegacyWorkbenchImportInvalid) {
				t.Fatalf("expected invalid input, got %v", err)
			}
		})
	}

	legacy := []byte(`{"alice|paper-writing":{"ok":true}}`)
	validManifest := legacyWorkbenchManifestJSON(t, legacy, mapping)
	var raw map[string]any
	if err := json.Unmarshal(validManifest, &raw); err != nil {
		t.Fatal(err)
	}
	raw["unexpected"] = true
	unknownManifest, _ := json.Marshal(raw)
	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, unknownManifest, false); !errors.Is(err, ErrLegacyWorkbenchImportMapping) {
		t.Fatalf("mapping with unknown field accepted: %v", err)
	}
}

func TestLegacyWorkbenchImportAuditFailureRollsBackState(t *testing.T) {
	projectStore, target, actor := legacyWorkbenchImportFixture(t)
	legacy := []byte(`{"alice|paper-writing":{"draft":"must roll back"}}`)
	manifest := legacyWorkbenchManifestJSON(t, legacy, LegacyWorkbenchImportMapping{
		LegacyUserKey: "alice", TenantID: target.TenantID, WorkspaceID: target.WorkspaceID,
		UserID: target.UserID, ActorUserID: actor.UserID,
	})
	forceAtomicAuditFailure(t, projectStore)

	if _, err := projectStore.ImportLegacyWorkbenchStates(context.Background(), legacy, manifest, true); !errors.Is(err, ErrAtomicAuditWrite) {
		t.Fatalf("expected atomic audit failure, got %v", err)
	}
	if _, found, err := projectStore.GetWorkbenchState(target.Scope(), "paper-writing"); err != nil || found {
		t.Fatalf("audit failure committed imported state: found=%v err=%v", found, err)
	}
	var events, heads int
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM audit_events`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := projectStore.database.QueryRow(`SELECT COUNT(*) FROM audit_heads`).Scan(&heads); err != nil {
		t.Fatal(err)
	}
	if events != 0 || heads != 0 {
		t.Fatalf("audit failure left partial chain: events=%d heads=%d", events, heads)
	}
}

func legacyWorkbenchImportFixture(t *testing.T) (*ProjectStore, Identity, Identity) {
	t.Helper()
	projectStore := openTestProjectStore(t, ":memory:")
	target, err := projectStore.EnsureDevIdentity("tenant-legacy-state", "workspace-legacy-state", "target@legacy.test", "Target", "researcher")
	if err != nil {
		t.Fatal(err)
	}
	actor, err := projectStore.EnsureDevIdentity(target.TenantID, target.WorkspaceID, "admin@legacy.test", "Import Administrator", "admin")
	if err != nil {
		t.Fatal(err)
	}
	return projectStore, target, actor
}

func legacyWorkbenchManifestJSON(t *testing.T, legacy []byte, mappings ...LegacyWorkbenchImportMapping) []byte {
	t.Helper()
	digest := sha256.Sum256(legacy)
	manifest := LegacyWorkbenchImportManifest{
		Version: LegacyWorkbenchImportManifestVersion, SourceSHA256: hex.EncodeToString(digest[:]),
		Mappings: append([]LegacyWorkbenchImportMapping{}, mappings...),
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
