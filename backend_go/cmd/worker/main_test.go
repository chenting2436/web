package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestControlPlaneTransportRequiresHTTPSOutsideDevelopment(t *testing.T) {
	if _, _, err := controlPlaneTransport("http://control.example.test", false); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("production HTTP must fail closed, got %v", err)
	}
	baseURL, client, err := controlPlaneTransport("http://127.0.0.1:8080/", true)
	if err != nil || baseURL != "http://127.0.0.1:8080" || client == nil {
		t.Fatalf("development URL rejected: base=%q err=%v", baseURL, err)
	}
	for _, invalid := range []string{
		"control.example.test", "ftp://control.example.test", "https://user:pass@control.example.test",
		"https://control.example.test/base", "https://control.example.test?secret=value", "https://control.example.test/#fragment",
	} {
		if _, _, err := controlPlaneTransport(invalid, false); err == nil {
			t.Errorf("invalid control plane URL accepted: %s", invalid)
		}
	}
}

func TestWorkerNeverFollowsCredentialBearingRedirect(t *testing.T) {
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		destinationCalls.Add(1)
		if request.Header.Get("Authorization") != "" || request.Header.Get("X-Skyview-Job-Claim") != "" {
			t.Error("worker credential reached redirect destination")
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer destination.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") == "" || request.Header.Get("X-Skyview-Job-Claim") == "" {
			t.Error("origin did not receive expected worker credentials")
		}
		http.Redirect(response, request, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	baseURL, client, err := controlPlaneTransport(origin.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	runner := worker{baseURL: baseURL, token: strings.Repeat("a", 32), workerID: "worker-test", client: client}
	response, err := runner.post(context.Background(), "/execute", map[string]any{}, strings.Repeat("A", 43))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusTemporaryRedirect || destinationCalls.Load() != 0 {
		t.Fatalf("redirect followed: status=%d destinationCalls=%d", response.StatusCode, destinationCalls.Load())
	}
}
