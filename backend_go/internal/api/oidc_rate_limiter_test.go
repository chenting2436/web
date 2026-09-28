package api

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOIDCStartRateLimiterEnforcesSourceAndGlobalBurstsConcurrently(t *testing.T) {
	fixedNow := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return fixedNow }

	perSource := newOIDCStartRateLimiterWithClock(clock, 1, 5, 100, 100)
	if allowed := concurrentOIDCAllows(perSource, 64, func(int) string { return "203.0.113.0/24" }); allowed != 5 {
		t.Fatalf("source-prefix burst admitted %d requests, want 5", allowed)
	}
	global := newOIDCStartRateLimiterWithClock(clock, 100, 100, 1, 20)
	if allowed := concurrentOIDCAllows(global, 128, func(index int) string { return fmt.Sprintf("2001:db8:%x::/64", index) }); allowed != 20 {
		t.Fatalf("global burst admitted %d requests, want 20", allowed)
	}
}

func TestOIDCStartRateLimiterReturnsRetryAndUsesNetworkPrefixes(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	limiter := newOIDCStartRateLimiterWithClock(func() time.Time { return now }, 0.2, 1, 100, 100)
	if allowed, _ := limiter.Allow("203.0.113.0/24"); !allowed {
		t.Fatal("initial source request must be allowed")
	}
	if allowed, retry := limiter.Allow("203.0.113.0/24"); allowed || retry != 5*time.Second {
		t.Fatalf("limited request returned allowed=%v retry=%s, want false/5s", allowed, retry)
	}
	now = now.Add(5 * time.Second)
	if allowed, _ := limiter.Allow("203.0.113.0/24"); !allowed {
		t.Fatal("source token was not replenished after Retry-After")
	}
	if first, second := oidcSourcePrefix("203.0.113.4:1234"), oidcSourcePrefix("203.0.113.250:4321"); first != "203.0.113.0/24" || first != second {
		t.Fatalf("IPv4 source prefix bucketing drifted: %q %q", first, second)
	}
	if first, second := oidcSourcePrefix("[2001:db8:abcd:12::1]:1234"), oidcSourcePrefix("[2001:db8:abcd:12::ffff]:4321"); first != "2001:db8:abcd:12::/64" || first != second {
		t.Fatalf("IPv6 source prefix bucketing drifted: %q %q", first, second)
	}
}

func TestOIDCProductionGlobalLimiterDoesNotCollapseUsersBehindProxy(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	limiter := newOIDCStartRateLimiterWithClock(func() time.Time { return now }, 0.2, 1, 5, 4)
	limiter.sourceLimit = false
	for index := 0; index < 4; index++ {
		if allowed, _ := limiter.Allow("10.0.0.10/32"); !allowed {
			t.Fatalf("proxy-shared RemoteAddr was source-limited at global request %d", index+1)
		}
	}
	if allowed, retry := limiter.Allow("10.0.0.10/32"); allowed || retry <= 0 {
		t.Fatalf("global process budget was not enforced allowed=%v retry=%s", allowed, retry)
	}
	if len(limiter.sources) != 0 {
		t.Fatalf("production global limiter unexpectedly allocated source buckets: %d", len(limiter.sources))
	}
}

func TestOIDCStartRateLimiterBoundsUntrustedSourceCardinality(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	limiter := newOIDCStartRateLimiterWithClock(func() time.Time { return now }, 100, 1, 100_000, maxOIDCStartSourceBuckets+100)
	for index := 0; index < maxOIDCStartSourceBuckets+100; index++ {
		_, _ = limiter.Allow(fmt.Sprintf("source-%d", index))
	}
	if len(limiter.sources) > maxOIDCStartSourceBuckets {
		t.Fatalf("untrusted source keys grew limiter state to %d entries", len(limiter.sources))
	}
}

func TestOIDCStartIgnoresForwardedHeadersAndLimitsConcurrentAbuse(t *testing.T) {
	provider := newAPIFakeOIDCProvider(t)
	config := testConfig()
	config.OIDCIssuerURL = provider.server.URL
	config.OIDCClientID = provider.clientID
	config.OIDCClientSecret = provider.clientSecret
	config.OIDCRedirectURL = provider.redirectURL
	config.OIDCWebReturnURL = "http://localhost:4182/auth/complete"
	config.OIDCAllowInsecureHTTP = true
	config.OIDCTransactionKey = bytes.Repeat([]byte{0x5c}, 32)
	handler := newTestHandler(t, config)

	var redirects atomic.Int32
	var limited atomic.Int32
	var failures atomic.Int32
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := range 64 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/start", nil)
			request.RemoteAddr = "203.0.113.44:" + strconv.Itoa(10000+index)
			request.Header.Set("Forwarded", fmt.Sprintf("for=198.51.%d.%d", index/250, index%250+1))
			request.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.%d.%d", index/250, index%250+1))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			switch response.Code {
			case http.StatusFound:
				redirects.Add(1)
			case http.StatusTooManyRequests:
				if response.Header().Get("Retry-After") == "" || !strings.Contains(response.Body.String(), `"code":"OIDC_RATE_LIMITED"`) {
					failures.Add(1)
				}
				limited.Add(1)
			default:
				failures.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	if failures.Load() != 0 || redirects.Load() != defaultOIDCStartSourceBurst || limited.Load() != 64-defaultOIDCStartSourceBurst {
		t.Fatalf("unexpected concurrent admission: redirects=%d limited=%d failures=%d", redirects.Load(), limited.Load(), failures.Load())
	}
}

func concurrentOIDCAllows(limiter *oidcStartRateLimiter, attempts int, source func(int) string) int32 {
	var allowed atomic.Int32
	var wait sync.WaitGroup
	start := make(chan struct{})
	for index := range attempts {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			if ok, _ := limiter.Allow(source(index)); ok {
				allowed.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	return allowed.Load()
}
