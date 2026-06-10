# Proposal: Audit logging controls — tamper-evidence + SIEM export

**Status:** Implemented (backend + API + tests). Tamper-evidence is always on;
export is built behind the `FLAKEY_AUDIT_EXPORT_ENABLED` instance flag — OFF by
default, **not yet enabled in any regulated environment** pending CISO /
Security Analyst sign-off (SOC 2 / GovRAMP logging control). **Not yet built:**
an admin UI for configuring export (today it's API-configured — see the tracked
roadmap sub-item). Operator + dev guide: [backend/docs/audit-logging.md](../../backend/docs/audit-logging.md).
**Area:** backend `audit_log` (+ hash columns), new `audit_export_config` table,
`src/audit.ts` / `src/audit-chain.ts` / `src/audit-export.ts`, the `/audit`
route, the scheduler in `index.ts`.
**Effort:** Medium. Migration is metadata-only; the hot path (`logAudit`) gains
a transaction + per-org advisory lock.

---

## Summary

We already have an audit log of every mutation, RLS-isolated per org and pruned
by retention. SOC 2 (CC7) and GovRAMP logging controls want two more things the
raw table doesn't give on its own:

1. **Integrity / tamper-evidence** — proof the log wasn't edited after the fact.
2. **Export / streaming** — getting audit events off the box into the
   customer's own SIEM (or durable archive), reliably and without gaps.

This delivers both, additively, without changing what gets audited or how
`audit_log` is read.

## 1. Tamper-evidence (hash chain)

Each audit row binds the previous row's hash:
`entry_hash = SHA-256(prev_hash || canonical(content))`. Editing, deleting, or
reordering any row breaks the chain, detected by `GET /audit/verify`.

Design decisions:

- **App-computed, not a DB trigger.** Keeps the crypto in TypeScript (unit-
  testable) and reuses `tenantTransaction` + RLS. Appends are serialized per org
  by a transaction-scoped advisory lock so the chain has one head under
  concurrency. (That same serialization is what makes the export cursor
  gap-free — see below.)
- **Insert-then-hash.** `logAudit` inserts, reads back the DB-authoritative row
  (id, stored jsonb `detail`, assigned `created_at`), hashes that, then writes
  `entry_hash` — so verify recomputes identical bytes across the jsonb round
  trip. `canonicalJson` (recursively sorted keys) makes the hash independent of
  key order.
- **No backfill.** Pre-feature rows keep NULL hashes and are a counted legacy
  prefix. A full-table UPDATE to backfill would take a heavy lock on a populated
  prod `audit_log`; tamper-evidence is forward-looking instead.
- **The off-box anchor is the real control.** In-place verify proves internal
  consistency, but an attacker with DB write could re-chain. Exporting
  `entry_hash` to a SIEM (below) is what makes tampering undeniable.

## 2. Export / SIEM streaming

A per-org destination (`audit_export_config`, RLS) — HTTP (customer SIEM) or S3
(archive) — fed by a 60s flusher.

Design decisions:

- **Durable buffer = `audit_log` itself.** No separate outbox. Each destination
  keeps a cursor (`last_exported_id`); the flusher ships `id > cursor` in id
  order and advances the cursor **only after a confirmed delivery**. A receiver
  outage stalls the cursor; nothing is lost.
- **Gap-free cursor.** `audit_log.id` is a global sequence, but a single org's
  appends are serialized by the hash-chain advisory lock, so that org's own ids
  commit in strictly increasing order — `id > cursor ORDER BY id` can never skip
  a row. (This is why the two features share the lock.)
- **At-least-once, not exactly-once.** A crash between deliver and cursor-write
  re-sends a batch; the chain hashes let the receiver dedup. Honest and simple.
- **Not fire-and-forget** (unlike notification webhooks): a dropped audit event
  is a compliance gap, so delivery is retried until it sticks.
- **Off by default.** `FLAKEY_AUDIT_EXPORT_ENABLED` gates both the flusher and
  the config routes (404 when off), mirroring the SSO kill-switch.

## Where the CISO review should focus

- **Egress of audit data** to a customer-controlled endpoint. Mitigations: the
  SSRF guard (re-checked at delivery), encrypted auth token, sanitized errors
  (no upstream body/URL/token in logs or `last_error`), admin+ only, config
  changes audited.
- **Availability tradeoff:** the flush tick holds one advisory lock across all
  orgs, so a slow destination can delay others within a tick (bounded per org).
  Durable fix if it bites: per-org lock or a worker queue. Surfaced in code +
  the operator guide.
- **Retention vs. export ordering:** retention prunes old `audit_log` rows. If a
  destination's cursor lags past the retention horizon, unexported rows could be
  pruned before delivery. At current retention (≥7d) and a 60s flush this is not
  reachable, but it's the interaction to watch; a future guard could refuse to
  prune rows below every destination's cursor.

## Out of scope (tracked follow-ups)

- **Admin UI** for configuring export (settings page) — today it's API/IaC
  configured. Tracked on the roadmap.
- **CloudWatch Logs** destination — the adapter interface is there; CloudWatch
  needs a new AWS SDK client + a local equivalent before it fits the local-first
  rule.
- **Retention/cursor interlock** — see above.
