import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import pool, { tenantQuery } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { validateWebhookUrl, webhookSafeFetch } from "./routes/webhooks.js";
import { s3ClientConfig } from "./storage.js";

/**
 * Audit-log export / SIEM streaming (SOC 2 / GovRAMP logging control).
 *
 * Ships audit_log rows to a per-org destination (a customer SIEM over HTTP, or
 * an S3 bucket) with durable, gap-free, at-least-once delivery — NOT the
 * fire-and-forget model the notification webhooks use. The audit_log table is
 * the durable buffer; each destination keeps a cursor (last_exported_id) and
 * the flusher ships everything past it in id order, advancing the cursor only
 * after a confirmed delivery. So a receiver outage just stalls the cursor;
 * nothing is dropped, and on recovery delivery resumes from where it left off.
 *
 * GAP-FREE cursor: audit_log.id is a global BIGSERIAL, but appends for a single
 * org are serialized by the per-org advisory lock in audit.ts (the hash chain).
 * That serialization means an org's own ids are committed in strictly
 * increasing order — no same-org row ever commits with an id below one already
 * past the cursor — so `id > cursor ORDER BY id` can never skip a row. (Other
 * orgs' ids interleave in the global sequence, but we filter by org_id.)
 *
 * Each exported record carries prev_hash + entry_hash, so the receiver can
 * independently verify the chain and detect any later local tampering — this is
 * what makes the off-box copy true tamper-evidence rather than just a backup.
 *
 * Instance kill-switch: FLAKEY_AUDIT_EXPORT_ENABLED. Off by default — the
 * flusher no-ops and the config routes 404 (see routes/audit.ts) until an
 * operator deliberately turns it on. It is a GovRAMP-scoped control; don't
 * enable in a regulated environment without CISO sign-off.
 */

// Single-flight lock for the flush tick (multi-instance safe). Distinct from
// scheduled-reports' key (0x666c616b79).
const AUDIT_EXPORT_LOCK_KEY = 0x666c616b7a; // "flakz"

const BATCH_SIZE = 500;
const MAX_BATCHES_PER_TICK = 20; // bound a single config's share of a tick
const HTTP_TIMEOUT_MS = 10_000;

export function isAuditExportEnabled(): boolean {
  return process.env.FLAKEY_AUDIT_EXPORT_ENABLED === "true";
}

export interface AuditExportConfigRow {
  id: number;
  org_id: number;
  destination: "http" | "s3";
  enabled: boolean;
  endpoint_url: string | null;
  auth_header_name: string | null;
  auth_token_encrypted: string | null;
  s3_bucket: string | null;
  s3_prefix: string | null;
  last_exported_id: string; // bigint
}

interface AuditRow {
  id: string;
  org_id: number;
  user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  created_at: Date;
  prev_hash: string | null;
  entry_hash: string | null;
}

/**
 * Serialize a batch as NDJSON (one JSON object per line). Exported (pure) so
 * the wire format is unit-testable. Includes the chain hashes so the receiver
 * can verify integrity.
 */
export function formatBatchNdjson(rows: AuditRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        id: String(r.id),
        org_id: r.org_id,
        action: r.action,
        user_id: r.user_id,
        target_type: r.target_type,
        target_id: r.target_id,
        detail: r.detail ?? null,
        created_at: new Date(r.created_at).toISOString(),
        prev_hash: r.prev_hash,
        entry_hash: r.entry_hash,
      })
    )
    .join("\n");
}

/**
 * Reduce a delivery error to a short, safe token for storage in last_error /
 * return to the client. NEVER includes the raw upstream response body, the
 * target URL, or the auth token — echoing those is the PII/secret-in-logs class
 * of bug the repo's audit explicitly guards against. Low-cardinality codes
 * (HTTP status, network errno) only.
 */
export function sanitizeDeliveryError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || /timed out|timeout/i.test(err.message)) {
      return "request timed out";
    }
    if (/^HTTP \d{3}$/.test(err.message)) return err.message; // our own controlled message
    const code =
      (err as { code?: unknown }).code ??
      (err as { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === "string") return `connection error (${code})`;
    return "delivery failed";
  }
  return "delivery failed";
}

export function s3KeyFor(prefix: string | null, orgId: number, firstId: string, lastId: string): string {
  const clean = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  const base = clean ? `${clean}/` : "";
  return `${base}audit/org-${orgId}/${firstId}-${lastId}.ndjson`;
}

async function deliverHttp(config: AuditExportConfigRow, body: string): Promise<void> {
  // Fast string-level rejection (scheme + literal private host). The
  // AUTHORITATIVE SSRF gate is webhookSafeFetch's connect-time pin, which
  // validates the RESOLVED IP — a public hostname can still resolve to a
  // private/metadata address, which this string check alone would miss.
  const check = validateWebhookUrl(config.endpoint_url);
  if (!check.ok) throw new Error(`HTTP 000`); // sanitized; never echo the URL/reason

  const headers: Record<string, string> = { "Content-Type": "application/x-ndjson" };
  if (config.auth_header_name) {
    const token = decryptSecret(config.auth_token_encrypted);
    if (token) headers[config.auth_header_name] = token;
  }

  const res = await webhookSafeFetch(config.endpoint_url as string, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    // Never auto-follow a redirect: a public endpoint could 3xx to a private /
    // metadata address AFTER the gate, replaying the auth token there. With
    // "manual", undici does NOT follow the redirect and returns the real 3xx
    // status (res.ok === false), so the non-ok check below rejects it as a
    // failed delivery. (Don't confuse with browser fetch, which yields an
    // opaqueredirect/status 0 here.)
    redirect: "manual",
  });
  if (!res.ok) {
    // Throw a controlled message — do NOT read res.body (it can contain
    // account-identifying or sensitive collector responses). `|| "000"` is a
    // defensive fallback for a falsy status (not expected from undici).
    throw new Error(`HTTP ${res.status || "000"}`);
  }
}

// NodeHttpHandler options that actually bound a PutObject. CRITICAL:
// requestTimeout alone is WARN-only in @smithy/node-http-handler — it does NOT
// abort the request unless throwOnRequestTimeout is also true. Without it a
// connected-but-unresponsive S3 endpoint hangs PutObject forever while
// flushAuditExports holds the single-flight lock across ALL orgs. So:
//   - throwOnRequestTimeout: true   → requestTimeout actually rejects
//   - requestTimeout                → hard end-to-end deadline
//   - socketTimeout                 → backstop for an idle/half-open socket
//   - connectionTimeout             → bounds the pre-connect blackhole
// sanitizeDeliveryError maps the resulting TimeoutError to "request timed out".
// Exported so the throw-on-timeout config is regression-tested.
export function s3RequestHandlerOptions() {
  return {
    requestTimeout: HTTP_TIMEOUT_MS,
    socketTimeout: HTTP_TIMEOUT_MS,
    connectionTimeout: 5000,
    throwOnRequestTimeout: true,
  };
}

let _s3: S3Client | null = null;
function s3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      ...s3ClientConfig(),
      requestHandler: new NodeHttpHandler(s3RequestHandlerOptions()),
      maxAttempts: 2,
    });
  }
  return _s3;
}

async function deliverS3(
  config: AuditExportConfigRow,
  body: string,
  firstId: string,
  lastId: string
): Promise<void> {
  if (!config.s3_bucket) throw new Error("s3 destination missing bucket");
  await s3Client().send(
    new PutObjectCommand({
      Bucket: config.s3_bucket,
      Key: s3KeyFor(config.s3_prefix, config.org_id, firstId, lastId),
      Body: body,
      ContentType: "application/x-ndjson",
    })
  );
}

async function deliverBatch(config: AuditExportConfigRow, rows: AuditRow[]): Promise<void> {
  const body = formatBatchNdjson(rows);
  if (config.destination === "http") {
    await deliverHttp(config, body);
  } else {
    await deliverS3(config, body, String(rows[0].id), String(rows[rows.length - 1].id));
  }
}

async function readBatch(orgId: number, afterId: string): Promise<AuditRow[]> {
  const { rows } = await tenantQuery(
    orgId,
    `SELECT id, org_id, user_id, action, target_type, target_id, detail,
            created_at, prev_hash, entry_hash
     FROM audit_log
     WHERE org_id = $1 AND id > $2
     ORDER BY id ASC
     LIMIT $3`,
    [orgId, afterId, BATCH_SIZE]
  );
  return rows as AuditRow[];
}

/**
 * Flush one destination: ship pending rows in batches, advancing the cursor
 * after each confirmed delivery. Stops at the first failure (cursor stays put;
 * retried next tick) or when caught up / the per-tick batch budget is spent.
 * Exported for the smoke test. Never throws — records failures in the row.
 */
export async function flushConfig(orgId: number, config: AuditExportConfigRow): Promise<void> {
  let cursor = config.last_exported_id;
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    let rows: AuditRow[];
    try {
      rows = await readBatch(orgId, cursor);
    } catch (err) {
      console.error(`Audit export: read failed for config=${config.id} org=${orgId}:`, err);
      return;
    }
    if (rows.length === 0) return; // caught up

    try {
      await deliverBatch({ ...config, last_exported_id: cursor }, rows);
    } catch (err) {
      const reason = sanitizeDeliveryError(err);
      await tenantQuery(
        orgId,
        `UPDATE audit_export_config
         SET consecutive_failures = consecutive_failures + 1,
             last_error = $2, updated_at = NOW()
         WHERE id = $1`,
        [config.id, reason]
      ).catch((e) => console.error(`Audit export: failure-record write failed for config=${config.id}:`, e));
      return; // leave cursor; retry next tick (at-least-once)
    }

    cursor = String(rows[rows.length - 1].id);
    try {
      await tenantQuery(
        orgId,
        `UPDATE audit_export_config
         SET last_exported_id = $2, last_success_at = NOW(),
             consecutive_failures = 0, last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
        [config.id, cursor]
      );
    } catch (err) {
      // Delivered but couldn't persist the cursor — next tick re-sends this
      // batch (at-least-once; the receiver dedups on id/entry_hash). Surface it.
      console.error(`Audit export: cursor advance failed for config=${config.id} org=${orgId}:`, err);
      return;
    }

    if (rows.length < BATCH_SIZE) return; // drained
  }
}

/**
 * Scheduler entry — flush every enabled destination across all orgs. Guarded by
 * a single-flight advisory lock so overlapping ticks / multiple instances don't
 * double-ship. No-ops when the instance kill-switch is off.
 *
 * Known tradeoff (matches scheduled-reports.ts): the lock is held for the whole
 * tick, so a consistently slow/timing-out destination can delay other orgs'
 * delivery within a tick. Both delivery paths are time-bounded so this is
 * bounded, not unbounded: HTTP via AbortSignal.timeout(HTTP_TIMEOUT_MS), S3 via
 * the bounded requestHandler below (requestTimeout + maxAttempts) — worst case
 * per org ≈ timeout × MAX_BATCHES_PER_TICK. Acceptable at current scale; the
 * durable fix if it bites is a per-org lock (pg_try_advisory_xact_lock(CLASS,
 * orgId)) or moving delivery off the lock onto a worker queue. Surfaced for the
 * CISO availability review.
 */
export async function flushAuditExports(): Promise<void> {
  if (!isAuditExportEnabled()) return;

  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    const got = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [AUDIT_EXPORT_LOCK_KEY]
    );
    if (!got.rows[0]?.locked) {
      await lockClient.query("ROLLBACK");
      return;
    }

    // audit_export_config is RLS-scoped, so (like scheduled-reports) we can't
    // SELECT across orgs in one shot — enumerate orgs, then read each org's
    // enabled configs inside its tenant context.
    const orgs = await pool.query<{ id: number }>("SELECT id FROM organizations");
    for (const { id: orgId } of orgs.rows) {
      let configs: AuditExportConfigRow[];
      try {
        const r = await tenantQuery(
          orgId,
          `SELECT id, org_id, destination, enabled, endpoint_url, auth_header_name,
                  auth_token_encrypted, s3_bucket, s3_prefix, last_exported_id
           FROM audit_export_config
           WHERE org_id = $1 AND enabled = true`,
          [orgId]
        );
        configs = r.rows as AuditExportConfigRow[];
      } catch (err) {
        console.error(`Audit export: config read failed for org=${orgId}:`, err);
        continue;
      }
      for (const config of configs) {
        await flushConfig(orgId, config);
      }
    }

    await lockClient.query("COMMIT");
  } catch (err) {
    console.error("flushAuditExports error:", err);
    try {
      await lockClient.query("ROLLBACK");
    } catch {
      /* ignore */
    }
  } finally {
    lockClient.release();
  }
}

/**
 * Deliver a single synthetic event to a destination, WITHOUT touching the
 * cursor — backs the "test connection" route. Returns a sanitized result.
 */
export async function testDelivery(config: AuditExportConfigRow): Promise<{ ok: boolean; error?: string }> {
  const probe: AuditRow = {
    id: "0",
    org_id: config.org_id,
    user_id: null,
    action: "audit.export.test",
    target_type: null,
    target_id: null,
    detail: { note: "Flakey audit-export connectivity test" },
    created_at: new Date(),
    prev_hash: null,
    entry_hash: null,
  };
  try {
    await deliverBatch(config, [probe]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitizeDeliveryError(err) };
  }
}
