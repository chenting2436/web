package api

import (
	"math"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	defaultOIDCStartSourceRate  = 0.2
	defaultOIDCStartSourceBurst = 5
	defaultOIDCStartGlobalRate  = 5.0
	defaultOIDCStartGlobalBurst = 20
	maxOIDCStartSourceBuckets   = 4096
)

type oidcRateBucket struct {
	tokens   float64
	updated  time.Time
	lastSeen time.Time
}

type oidcStartRateLimiter struct {
	mu          sync.Mutex
	clock       func() time.Time
	sourceLimit bool
	sourceRate  float64
	sourceBurst float64
	globalRate  float64
	globalBurst float64
	global      oidcRateBucket
	sources     map[string]oidcRateBucket
}

func newOIDCStartRateLimiter() *oidcStartRateLimiter {
	return newOIDCStartRateLimiterWithClock(time.Now, defaultOIDCStartSourceRate, defaultOIDCStartSourceBurst, defaultOIDCStartGlobalRate, defaultOIDCStartGlobalBurst)
}

// Production traffic arrives through a TLS gateway, while this application
// deliberately does not trust Forwarded/X-Forwarded-For. Applying a source
// bucket to RemoteAddr would collapse every user behind one proxy into a tiny
// shared bucket. Production therefore keeps process-global and database-global
// admission here and requires the gateway to enforce client-source limits.
func newOIDCStartGlobalRateLimiter() *oidcStartRateLimiter {
	limiter := newOIDCStartRateLimiterWithClock(time.Now, defaultOIDCStartSourceRate, defaultOIDCStartSourceBurst, defaultOIDCStartGlobalRate, defaultOIDCStartGlobalBurst)
	limiter.sourceLimit = false
	return limiter
}

func newOIDCStartRateLimiterWithClock(clock func() time.Time, sourceRate float64, sourceBurst int, globalRate float64, globalBurst int) *oidcStartRateLimiter {
	return &oidcStartRateLimiter{
		clock: clock, sourceRate: sourceRate, sourceBurst: float64(sourceBurst),
		globalRate: globalRate, globalBurst: float64(globalBurst),
		sourceLimit: true, sources: make(map[string]oidcRateBucket),
	}
}

func (limiter *oidcStartRateLimiter) Allow(source string) (bool, time.Duration) {
	if limiter == nil {
		return false, time.Second
	}
	now := limiter.clock().UTC()
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	limiter.global = refillOIDCRateBucket(limiter.global, now, limiter.globalRate, limiter.globalBurst)
	globalWait := oidcBucketWait(limiter.global, limiter.globalRate)
	if !limiter.sourceLimit {
		if globalWait > 0 {
			return false, globalWait
		}
		limiter.global.tokens--
		return true, 0
	}
	source = limiter.boundedSourceKey(strings.TrimSpace(source), now)
	sourceBucket := refillOIDCRateBucket(limiter.sources[source], now, limiter.sourceRate, limiter.sourceBurst)
	limiter.sources[source] = sourceBucket

	sourceWait := oidcBucketWait(sourceBucket, limiter.sourceRate)
	if globalWait > 0 || sourceWait > 0 {
		if sourceWait > globalWait {
			globalWait = sourceWait
		}
		return false, globalWait
	}
	limiter.global.tokens--
	sourceBucket.tokens--
	limiter.sources[source] = sourceBucket
	return true, 0
}

func (limiter *oidcStartRateLimiter) boundedSourceKey(source string, now time.Time) string {
	if source == "" {
		source = "unknown"
	}
	if _, exists := limiter.sources[source]; exists || len(limiter.sources) < maxOIDCStartSourceBuckets-1 {
		return source
	}
	for key, bucket := range limiter.sources {
		if now.Sub(bucket.lastSeen) > 30*time.Minute {
			delete(limiter.sources, key)
		}
	}
	if len(limiter.sources) < maxOIDCStartSourceBuckets-1 {
		return source
	}
	return "overflow"
}

func refillOIDCRateBucket(bucket oidcRateBucket, now time.Time, rate, burst float64) oidcRateBucket {
	if bucket.updated.IsZero() {
		return oidcRateBucket{tokens: burst, updated: now, lastSeen: now}
	}
	if now.After(bucket.updated) {
		bucket.tokens = math.Min(burst, bucket.tokens+now.Sub(bucket.updated).Seconds()*rate)
		bucket.updated = now
	}
	bucket.lastSeen = now
	return bucket
}

func oidcBucketWait(bucket oidcRateBucket, rate float64) time.Duration {
	if bucket.tokens >= 1 {
		return 0
	}
	if rate <= 0 {
		return time.Minute
	}
	return time.Duration(math.Ceil((1-bucket.tokens)/rate*float64(time.Second))) * time.Nanosecond
}

func oidcSourcePrefix(remoteAddr string) string {
	remoteAddr = strings.TrimSpace(remoteAddr)
	var address netip.Addr
	if parsed, err := netip.ParseAddrPort(remoteAddr); err == nil {
		address = parsed.Addr()
	} else {
		host, _, splitErr := net.SplitHostPort(remoteAddr)
		if splitErr == nil {
			address, _ = netip.ParseAddr(host)
		} else {
			address, _ = netip.ParseAddr(remoteAddr)
		}
	}
	if !address.IsValid() {
		return "unknown"
	}
	address = address.Unmap()
	bits := 64
	if address.Is4() {
		bits = 24
	}
	return netip.PrefixFrom(address, bits).Masked().String()
}
