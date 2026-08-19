---
description: Audit a server-streaming WebSocket / pub-sub hub (live spectator, presence, real-time feed) — auth, fail-closed defaults, resource bounds, cache TTL, log-leak surface
---

WebSocket hubs concentrate four risks that don't show up in REST audits:

1. **Long-lived connections × unbounded subscriber count** — a public-room URL is anon-reachable; one bad actor opens 10 000 WS connections and forces O(n) per-publish work.
2. **In-process state never expires** — once a room is hot, its caches (auth metadata, privacy zones, last-known position) live until process restart unless a GC is wired.
3. **Browser WebSocket API can't set headers** on the upgrade — the standard "Authorization: Bearer" channel doesn't exist; tokens land in `?token=…` and webserver access logs become secret-bearing.
4. **Fail-open dev defaults that ship to prod** — "permissive mode for local dev" silently runs in production unless a hard sentinel forces fail-closed.

## What to check

### 1. Auth on every operation

- **Push (recorder / publisher)**: owner-only, even on public rooms. A spectator MUST NOT be able to push fake positions for another user's session.
- **Subscribe / snapshot**: anon ok for `is_public = true` rooms; owner-only otherwise. A flip to private mid-session must stop serving anon spectators within a cache-TTL window (see §5 below).
- **JWT verification**: HS256-only via `jwt.WithValidMethods` (Go) or equivalent. `alg:none`, RS256-key-confusion, and tampered signatures all rejected. Expiry validated on every parse.
- **Permissive-mode sentinel**: when the JWT-secret env var is empty, the authorizer falls through to permissive (any caller is "the owner"). This is fine in local dev and **catastrophic in prod**. Gate on `<APP>_REQUIRE_AUTH=1` so production refuses to start when the secret is missing:

  ```go
  if os.Getenv("REQUIRE_AUTH") == "1" {
      if jwtSecret == "" {
          logger.Error("REQUIRE_AUTH=1 but JWT_SECRET unset — refusing to start")
          os.Exit(1)
      }
      if len(allowedOrigins) == 0 {
          logger.Error("REQUIRE_AUTH=1 but ALLOWED_ORIGINS unset — refusing to start")
          os.Exit(1)
      }
  }
  ```

- **Bearer scheme case-insensitivity** per RFC 7235 §2.1. Use `strings.EqualFold(prefix, "Bearer ")`, not `HasPrefix(h, "Bearer ")` — clients in the wild send `bearer`, `BEARER`, etc.
- **GET-only querystring fallback** for browser WS upgrades. The push path (POST, mobile / server-to-server) keeps requiring the header — only the subscribe + snapshot paths read `?token=` from the URL:

  ```go
  if r.Method == http.MethodGet {
      if q := r.URL.Query().Get("token"); q != "" {
          return strings.TrimSpace(q)
      }
  }
  ```

- **JWT redaction in Sentry / log breadcrumbs**: any helper that strips signed-URL tokens must also strip `?token=…` from `/v1/live/.+/(subscribe|snapshot)` URLs. Otherwise a `console.log` of the subscribe URL leaks the JWT.

### 2. Privacy-sensitive payload clipping

If pings carry coordinates / health data:

- **Server-side clip on every publish** (not just client-side — a curl skips your client). Fail-closed on fetch error: drop the ping rather than risk publishing through a broken zone-fetcher.
- **Cache invalidation contract**: a mid-session privacy-zone edit must take effect within `CacheRefreshTTL` (60s is a reasonable default). Cache "loaded forever" on first push is the M6 antipattern.
- **Historical pings**: spectators receive last-known on subscribe. If pings persisted before zones were added, they must be re-clipped on read, OR the trigger must filter at insert time.
- **Parity with the Postgres-side path**: if there's a fallback transport (Supabase Realtime, Postgres LISTEN/NOTIFY, etc.), both paths must clip the same way. The trigger version + the Go version both need pgtap / Go tests pinning the contract.

### 3. Resource bounds

- **Per-room subscriber cap** (typical: 500). Required for any anon-reachable public-room URL — without it, one bad actor opens N connections + forces every Publish's O(n) snapshot copy:

  ```go
  if len(r.subs) >= MaxSubsPerRoom {
      h.metrics.subscribeRejectCap.Add(1)
      return nil, nil, ErrSubscriberCapReached
  }
  ```

  Server maps the error to a `StatusTryAgainLater` (1013) WS close so clients back off.

- **Per-publisher push rate-limit**: token-bucket per `(user_id, room_id)` or, when each room is 1:1 user:room, per-room is fine. Typical: `rate=12 / 60s` so a recorder catching up after a network stutter doesn't hit the cap, but a 100Hz spam recorder does.

- **Body cap on `/push`**: `MaxBytesReader` at 4 KiB. Defends against payload-shape abuse from blowing past the policy with crafted JSON inside the limit. Pair with `DisallowUnknownFields` for defence-in-depth.

- **WS read limit + close-on-inbound**: the protocol is server-streaming-only. `c.SetReadLimit(1024)` BEFORE `CloseRead`. Without it, the WS library's default (typically 32 KiB) lets a subscriber pump frames at line rate.

- **Wire-format validation**: every numeric field rejects NaN / Inf (`math.IsNaN` / `math.IsInf`) and out-of-range values. A `lat: NaN` or `bpm: 1e308` should never reach the publish path.

### 4. Lifecycle + GC

- **Idle-room GC**: rooms with `subs=0 && lastPingAt > maxIdle` get reaped. In-process maps need an explicit background sweeper; without it, RSS grows monotonically across sessions. The Redis-backed variant gets this for free via per-key TTL on Publish.

  ```go
  func (h *Hub) StartGC(ctx context.Context, interval, maxIdle time.Duration) {
      go func() {
          t := time.NewTicker(interval)
          defer t.Stop()
          for {
              select {
              case <-ctx.Done(): return
              case <-t.C: h.RunGC(maxIdle)
              }
          }
      }()
  }
  ```

  Typical: `interval=5min`, `maxIdle=24h` (matching the Redis TTL).

- **Subscriber lock dance** (in-process variant): the close-channel-while-publish-iterates race needs explicit handling. Per-subscriber `sync.Mutex` around `ch <- p` and `close(ch)` keeps `-race` clean.

- **WS connection cleanup on disconnect**: relying solely on `CloseRead` is fragile — pair with a 25 s ping cycle and a 10 s pong timeout. Stuck-client detection within ~30 s.

### 5. Cache TTL

For metadata cached per room (run owner, is_public, privacy zones, etc.):

- **TTL ~60 s** so a mid-session toggle (privacy flip, zone add) takes effect without waiting for room GC.
- Cache fetch failure: fail-closed (deny, or use stale value with a logged warning — depending on the privacy posture).
- A `cachedAt time.Time` companion to every cache field; readers compare against `time.Since`. Don't try to invalidate from the caller — too many call sites.

### 6. Observability

Minimum counter set (atomic, no external lib needed):

- `publishCount` — every publish.
- `publishDropZone` — pings dropped for privacy or validation reasons.
- `subscribeRejectCap` — M3 attack signature.
- `authFailCount` — spike = stolen JWT or wrong-key replay.
- `roomGCDropped` — leak indicator.

Expose via `Hub.Metrics() HubMetrics` returning a snapshot. The operator wires it to Prometheus / CloudWatch.

### 7. Documentation + ops

- The fail-closed sentinel (`<APP>_REQUIRE_AUTH=1`) is set in the deploy config (e.g. fly.toml `[env]`, terraform.tfvars).
- Edge / proxy access logs that include the request URL are flagged as **secret-bearing** until the log shipper redacts the `token` query param. Add a documented operator task to configure that redaction (the JWT in `?token=` is the same access as a session cookie).
- If two transports coexist (Realtime + custom hub), document the cutover plan in an ADR — flag-day vs per-deploy env flip, parity-required gates, and the deprecation criterion for removing the old path.

## Report

- **Critical** — anon push accepted, JWT signed by wrong key accepted, permissive-mode shipped to prod, unbounded memory growth (no GC, no idle TTL).
- **High** — per-room subscriber cap missing, push rate-limit missing, privacy-zone bypass on a transport, mid-session privacy flip not honoured for hours, JWT in access logs unredacted.
- **Medium** — observability gap (no per-room metrics), default-client timeout missing on the fetcher fallback, comment drift on the lock-dance / GC invariants.
- **Low** — bearer scheme case-sensitive, edge-case header / CORS list.

For each finding: file:line + concrete change + the regulatory or operational anchor.

Read-only. NO code changes. Findings only.
