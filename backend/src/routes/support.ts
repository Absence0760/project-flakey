import { Router } from "express";
import pool from "../db.js";
import { signSupportToken } from "../auth.js";
import { appendAuditEntry } from "../audit.js";

const router = Router();

/**
 * POST /support/orgs/:orgId/token
 *
 * A platform support user mints a short-lived, READ-ONLY "view as org" session
 * token scoped to one org, so a ticket can be triaged without joining the
 * customer's org as a member. Guarantees:
 *   - Only a support user (users.is_support) can mint one — a normal session,
 *     even an org owner, gets 403. is_support is set out-of-band by an operator
 *     (no self-serve grant), so there's no standing cross-tenant path by default.
 *   - The resulting token is read-only and clamped to a diagnostic read surface
 *     (enforced in requireAuth), never writes and never integration secrets.
 *   - Every issuance is recorded in the TARGET org's audit log, so the customer
 *     can see who accessed their data, when, and why. The token is NOT issued
 *     if that audit write fails — no unaudited access.
 */
router.post("/orgs/:orgId/token", async (req, res) => {
  try {
    const actor = req.user!;

    // A support "view as" session must not be able to mint further sessions.
    // (Belt-and-suspenders: /support isn't on the support read allow-list and
    // this is a POST, so requireAuth already blocks an isSupportRead caller.)
    if (actor.isSupportRead) {
      res.status(403).json({ error: "Support sessions cannot mint support tokens" });
      return;
    }

    const sup = await pool.query("SELECT is_support FROM users WHERE id = $1", [actor.id]);
    if (!sup.rows[0]?.is_support) {
      res.status(403).json({ error: "Support role required" });
      return;
    }

    const targetOrgId = Number(req.params.orgId);
    if (!Number.isInteger(targetOrgId) || targetOrgId <= 0) {
      res.status(400).json({ error: "Invalid org id" });
      return;
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (!reason) {
      res.status(400).json({ error: "A reason is required for support access" });
      return;
    }

    const org = await pool.query("SELECT id FROM organizations WHERE id = $1", [targetOrgId]);
    if (org.rows.length === 0) {
      res.status(404).json({ error: "Org not found" });
      return;
    }

    // Record the access in the TARGET org's trail BEFORE issuing the token.
    // appendAuditEntry (the throwing, hash-chained variant — NOT best-effort
    // logAudit) so a failed write aborts issuance: accountability is
    // non-negotiable here, and routing through the chain keeps this row hashed
    // + lock-serialized (a raw INSERT would leave a NULL-hash row mid-chain,
    // which verifyAuditChain flags as tampering, and skip the lock the export
    // cursor relies on). A throw is caught below → 500, no token issued.
    await appendAuditEntry(targetOrgId, actor.id, "support.session.start", "org",
      String(targetOrgId), { reason, actor_email: actor.email });

    const token = signSupportToken(actor, targetOrgId, reason);
    res.status(201).json({ token, orgId: targetOrgId, mode: "read-only", expiresInSeconds: 1800 });
  } catch (err) {
    console.error("POST /support/orgs/:orgId/token error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
