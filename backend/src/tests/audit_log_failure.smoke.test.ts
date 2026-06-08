/**
 * logAudit failure semantics.
 *
 * audit_log is a SOC 2 / GovRAMP forensic control, but logging it is a
 * best-effort side-effect: a write failure must NOT abort the operation being
 * audited. So logAudit swallows. The risk that swallowing creates is a silent
 * compliance gap — a missing row with no signal. This pins both halves of the
 * contract:
 *
 *   1. logAudit never throws, even when the underlying INSERT fails.
 *   2. The failure is logged with enough context (org, action, target) to be
 *      greppable/alertable — not a faceless "Audit log failed".
 *
 * The failure is induced for real: a tenant INSERT against a nonexistent org id
 * violates the audit_log → organizations FK, so tenantQuery rejects. Needs the
 * local DB (db.js defaults to flakey_app/flakey), but no HTTP server.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../db.js";
import { logAudit } from "../audit.js";

// An org id that can't exist (within int4 range, far past any seeded org), so
// the FK from audit_log.org_id → organizations.id is guaranteed to reject.
const MISSING_ORG = 2_000_000_000;

after(async () => {
  await pool.end().catch(() => {});
});

test("logAudit swallows a write failure and logs it with org/action/target context", async () => {
  const captured: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };

  try {
    // Must resolve, not reject — audit logging never breaks the audited op.
    await assert.doesNotReject(
      logAudit(MISSING_ORG, null, "test.audit.failure", "run", "42", { k: "v" }),
      "logAudit must not throw when the INSERT fails",
    );
  } finally {
    console.error = realError;
  }

  const line = captured.find((l) => l.includes("Audit log failed"));
  assert.ok(line, "a write failure must be logged");
  // The context an operator needs to diagnose a persistent failure.
  assert.match(line!, new RegExp(`org=${MISSING_ORG}`), "log must name the org");
  assert.match(line!, /action=test\.audit\.failure/, "log must name the action");
  assert.match(line!, /target=run\/42/, "log must name the target type/id");
});
