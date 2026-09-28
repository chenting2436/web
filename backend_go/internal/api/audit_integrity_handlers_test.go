package api

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuditEventsEndpointReturnsOnlyCommittedVerifiedRead(t *testing.T) {
	handler := newTestHandler(t, testConfig())
	admin := login(t, handler, testConfig().DemoAccount, testConfig().DemoPassword)

	response := perform(handler, http.MethodGet, "/api/v1/audit/events?limit=100", "", admin)
	if response.Code != http.StatusOK {
		t.Fatalf("verified audit read failed: %d %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"action":"audit.events.read"`) {
		t.Fatalf("successful sensitive read was not atomically audited: %s", response.Body.String())
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("audit response must not be cached, got %q", cacheControl)
	}
}

func TestAuditEventsEndpointFailsClosedWhenChainIsTampered(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "audit-integrity.db")
	config := testConfig()
	config.DatabaseFile = databasePath
	handler := newTestHandler(t, config)
	admin := login(t, handler, config.DemoAccount, config.DemoPassword)

	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`DROP TRIGGER audit_events_no_update`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE audit_events SET metadata_json = '{"tampered":true}'
		WHERE id = (SELECT id FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1)`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	response := perform(handler, http.MethodGet, "/api/v1/audit/events?limit=100", "", admin)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected fail-closed 503, got %d %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"code":"AUDIT_CHAIN_INVALID"`) {
		t.Fatalf("missing explicit audit integrity error: %s", body)
	}
	for _, leaked := range []string{`"data":`, `"tenantId":`, `"action":`} {
		if strings.Contains(body, leaked) {
			t.Fatalf("tampered audit response leaked a misleading event list (%s): %s", leaked, body)
		}
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("audit integrity failure must not be cached, got %q", cacheControl)
	}
}
