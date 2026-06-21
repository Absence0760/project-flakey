# Audit logging controls — tamper-evidence + SIEM export

Operator + developer guide for the two SOC 2 / GovRAMP logging controls on top
of the existing audit log:

1. **Tamper-evidence** — a per-org hash chain over `audit_log`, verifiable on
   demand. Always on; nothing to configure.
2. **Export / SIEM streaming** — durable, gap-free delivery of audit events to a
   customer SIEM (HTTP) or an S3 bucket. Off by default behind an instance flag.

> ⚠️ GovRAMP-scoped logging control. Don't enable export in a regulated
> environment without CISO / Security Analyst sign-off.

## What's already there

`audit_log` (migration `008`) records every mutation (uploads, settings,
members, webhooks, API keys, SSO/SCIM, support sessions, …) with `org_id`,
`user_id`, `action`, `target_type`/`target_id`, a JSONB `detail`, and
`created_at`. It's RLS-isolated per org and pruned by the nightly retention
pass. `logAudit()` (`src/audit.ts`) is the single writer; `GET /audit` reads it
(admin+).

## 1. Tamper-evidence (hash chain)

Every audit row written from migration `064` onward carries `prev_hash` +
`entry_hash`:

```
entry_hash = SHA-256( prev_hash || canonical(id, org_id, user_id, action,
                                              target_type, target_id, detail,
                                              created_at) )
```

Each row binds the previous row's hash, so any later **edit**, **delete**, or
**reorder** of audit rows breaks the chain. Appends are serialized per org by a
transaction-scoped advisory lock (`audit-chain.ts` / `audit.ts`), so the chain
has a single well-defined head even under concurrent writes.

Rows written **before** migration 064 have NULL hashes and are treated as a
counted *legacy prefix* — we deliberately don't backfill (a full-table UPDATE
would lock a populated production `audit_log`). Tamper-evidence is forward-
looking from the first hashed row.

### Verify the chain

```
GET /audit/verify        # admin+; returns 200 with the result (even when broken)
```

```jsonc
{
  "ok": true,
  "totalRows": 12043,
  "legacyRows": 118,     // pre-feature rows, not part of the chain
  "hashedRows": 11925,
  "firstBrokenId": null, // the id of the first row that fails to verify, when ok=false
  "reason": null
}
```

`ok: false` with a `firstBrokenId` + `reason` ("the row was modified",
"row deleted, reordered, or inserted", "a hash was cleared") means the local
table was tampered with after the fact. Wire this into a periodic compliance
check. Note: `hashedRows: 0` on an active org is itself suspicious (it can mean
every hashed row was deleted) — treat it as a warning, not a clean result.

In-place verification proves the local table is internally consistent. **True**
tamper-evidence comes from combining it with export below: once `entry_hash` is
shipped off-box to a SIEM, a later local rewrite can re-chain the DB but can't
change the hashes already attested elsewhere.

## 2. Export / SIEM streaming

### Enable it (instance operator)

Set the kill-switch and restart:

```
FLAKEY_AUDIT_EXPORT_ENABLED=true
```

Off by default: the flusher no-ops and the `/audit/export` routes return 404
until this is set. When on, a flush runs every 60s (single-flight across
instances via an advisory lock).

### Configure a destination (org admin/owner)

Two ways, same routes underneath:

- **Admin UI** — **Settings → Audit export (SIEM)** (`/settings/audit-export`).
  Owner/admin can add/edit/enable/delete destinations and run a test delivery;
  viewers see it read-only; if the instance flag is off the page renders an
  explanatory disabled state instead of a broken form. The auth token is
  write-only (the page shows only whether one is set), mirroring the SSO page.
- **API / IaC** — the same routes directly (e.g. from Terraform). All routes are
  admin+ and 404 when the instance flag is off.

**HTTP (customer SIEM — Splunk HEC, Datadog, Sumo, a collector of your own):**

```bash
curl -X POST "$API/audit/export" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "destination": "http",
    "endpoint_url": "https://http-inputs.example.splunkcloud.com/services/collector/raw",
    "auth_header_name": "Authorization",
    "auth_token": "Splunk <hec-token>",
    "enabled": true
  }'
```

**S3 (archival / Athena / Glue):**

```bash
curl -X POST "$API/audit/export" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "destination": "s3",
    "s3_bucket": "acme-audit-archive",
    "s3_prefix": "flakey/audit",
    "enabled": true
  }'
```

S3 uses the instance's configured S3 client (`S3_REGION` / `S3_ENDPOINT` and the
standard AWS credential chain — the same config the artifact store uses).

Other routes: `GET /audit/export` (list — the token is **never** returned, only
`auth_token_set`), `PATCH /audit/export/:id` (toggle `enabled`, rotate
`auth_token`, edit fields), `DELETE /audit/export/:id`, and
`POST /audit/export/:id/test` (send one synthetic event without moving the
cursor; returns `{ ok, error? }` with a sanitized error).

### Delivery semantics

- **Format:** NDJSON — one JSON object per line, each carrying `id`,
  `created_at`, `action`, `user_id`, `target_type`/`target_id`, `detail`, and
  `prev_hash`/`entry_hash` so the receiver can independently verify the chain.
- **Durable + gap-free:** each destination keeps a cursor (`last_exported_id`).
  The flusher ships rows with `id > cursor` in id order and advances the cursor
  **only after a confirmed delivery**. A receiver outage just stalls the cursor;
  nothing is dropped, and delivery resumes on recovery. Gap-free because the
  per-org append lock makes an org's own ids commit in strictly increasing
  order.
- **At-least-once:** if delivery succeeds but the cursor write doesn't (crash in
  the gap), the batch is re-sent next tick. Receivers should dedup on `id` /
  `entry_hash`.
- **New destinations start from "now"** (the current max audit id) so a large
  existing `audit_log` isn't dumped in one go. Pass `"from_beginning": true` on
  create to stream the full history instead.
- **Failures** increment `consecutive_failures` and record a **sanitized**
  `last_error` (an HTTP status or network errno — never the upstream response
  body, the URL, or the auth token). Surfaced on `GET /audit/export`.

### Security notes

- The auth token is encrypted at rest via the `FLAKEY_ENCRYPTION_KEY` envelope
  (same path as integration secrets) and is never returned by any route.
- The HTTP endpoint is run through the same SSRF guard as webhooks
  (`validateWebhookUrl`) at config-write **and** delivery time — production
  blocks private/loopback/metadata targets unless
  `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.
- Export config mutations are themselves audited (`audit.export.*`).

### Known tradeoff

The flush tick holds a single advisory lock across all orgs, so a consistently
slow/timing-out destination can delay other orgs' delivery within a tick
(bounded per org). Acceptable at current scale; the durable fix if it bites is a
per-org lock or moving delivery onto a worker queue. See the
`flushAuditExports` comment and `docs/proposals/phase-16-audit-logging-controls.md`.

## Tests

- `src/tests/audit_chain.unit.test.ts` — canonical/hash contract.
- `src/tests/audit_chain.smoke.test.ts` — real content-edit / row-delete /
  cleared-hash tamper detection + legacy prefix.
- `src/tests/audit_export.unit.test.ts` — NDJSON format, error sanitization, S3 key.
- `src/tests/audit_export.smoke.test.ts` — delivery, cursor advance, 5xx
  hold-back, recovery, no-body-leak (in-process HTTP collector).
- `src/tests/audit_export_routes.smoke.test.ts` — token redaction, validation,
  kill-switch 404, verify shape.
