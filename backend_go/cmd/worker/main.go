package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	workerauth "skyviewlab/backend_go/internal/auth/worker"
	"skyviewlab/backend_go/internal/store"
)

type apiEnvelope[T any] struct {
	Data T `json:"data"`
}

type worker struct {
	baseURL  string
	token    string
	workerID string
	client   *http.Client
}

func main() {
	token := os.Getenv("WORKER_TOKEN")
	workerID := os.Getenv("WORKER_ID")
	if workerID == "" {
		log.Fatal("WORKER_ID must match the server-side identity bound to WORKER_TOKEN")
	}
	if err := workerauth.ValidateCredentialSecret(workerID, token); err != nil {
		log.Fatalf("invalid worker credentials: %v", err)
	}
	devMode, err := boolEnv("DEV_MODE", false)
	if err != nil {
		log.Fatal(err)
	}
	baseURL, client, err := controlPlaneTransport(env("GO_CONTROL_PLANE_URL", "http://127.0.0.1:8080"), devMode)
	if err != nil {
		log.Fatalf("invalid control plane transport: %v", err)
	}
	runner := worker{baseURL: baseURL, token: token, workerID: workerID, client: client}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runner.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("worker stopped: %v", err)
	}
}

func (worker worker) run(ctx context.Context) error {
	backoff := 500 * time.Millisecond
	for {
		claim, found, err := worker.claim(ctx)
		if err != nil {
			log.Printf("claim failed: %v", err)
			if err := waitContext(ctx, backoff); err != nil {
				return err
			}
			backoff = min(backoff*2, 15*time.Second)
			continue
		}
		if !found {
			backoff = min(backoff*2, 5*time.Second)
			if err := waitContext(ctx, backoff); err != nil {
				return err
			}
			continue
		}
		backoff = 500 * time.Millisecond
		if err := worker.execute(ctx, claim); err != nil {
			log.Printf("job %s execution request failed: %v", claim.Job.ID, err)
		}
	}
}

func (worker worker) claim(ctx context.Context) (store.JobClaim, bool, error) {
	response, err := worker.post(ctx, "/api/v1/internal/jobs/claim", map[string]string{}, "")
	if err != nil {
		return store.JobClaim{}, false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return store.JobClaim{}, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return store.JobClaim{}, false, responseError(response)
	}
	var envelope apiEnvelope[store.JobClaim]
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope); err != nil {
		return store.JobClaim{}, false, err
	}
	if envelope.Data.Job.WorkerID != worker.workerID || envelope.Data.ClaimToken == "" {
		return store.JobClaim{}, false, fmt.Errorf("control plane returned an invalid job claim")
	}
	return envelope.Data, envelope.Data.Job.ID != "", nil
}

func (worker worker) execute(ctx context.Context, claim store.JobClaim) error {
	response, err := worker.post(ctx, "/api/v1/internal/jobs/"+claim.Job.ID+"/execute", map[string]string{}, claim.ClaimToken)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return responseError(response)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	return nil
}

func (worker worker) post(ctx context.Context, path string, payload any, claimToken string) (*http.Response, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, worker.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+worker.token)
	request.Header.Set("Content-Type", "application/json")
	if claimToken != "" {
		request.Header.Set("X-Skyview-Job-Claim", claimToken)
	}
	return worker.client.Do(request)
}

func responseError(response *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<10))
	return fmt.Errorf("control plane returned %s: %s", response.Status, strings.TrimSpace(string(body)))
}

func waitContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return parsed, nil
}

func controlPlaneTransport(rawURL string, devMode bool) (string, *http.Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", nil, errors.New("GO_CONTROL_PLANE_URL must be an absolute HTTP(S) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", nil, errors.New("GO_CONTROL_PLANE_URL must contain only scheme and authority")
	}
	if !devMode && parsed.Scheme != "https" {
		return "", nil, errors.New("production worker requires an HTTPS control plane")
	}
	parsed.Path = ""
	client := &http.Client{
		Timeout:   10 * time.Minute,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return strings.TrimRight(parsed.String(), "/"), client, nil
}
