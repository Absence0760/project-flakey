import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { parseExpiresAt, isMd5Hex } from "../quarantine-lifecycle.js";

// Quarantine is an ADVISORY, reporter-side mechanism — it is NOT a server-side
// gate exemption. Nothing in the upload/stats path (run-merge.ts) or the gate
// signals (badge.ts, /runs summary, /runs/check) references quarantined_tests:
// a quarantined test that still fails counts as a failure everywhere. The only
// enforcement is a reporter calling GET /quarantine/check and skipping the
// listed tests itself before they run. Don't assume quarantining a test makes
// a run green — it doesn't, unless the reporter cooperates.
const router = Router();

// GET /quarantine — list quarantined tests
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    let query = `SELECT qt.*, u.name AS quarantined_by_name, u.email AS quarantined_by_email
       FROM quarantined_tests qt
       LEFT JOIN users u ON u.id = qt.quarantined_by`;
    const params: string[] = [];

    if (suite) {
      query += " WHERE qt.suite_name = $1";
      params.push(suite);
    }

    query += " ORDER BY qt.created_at DESC";

    const result = await tenantQuery(req.user!.orgId, query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /quarantine error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /quarantine/check — check if specific tests are quarantined (for CI integration)
// Query: ?suite=name&tests=title1,title2 or ?suite=name (returns all for suite)
router.get("/check", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    if (!suite) {
      res.status(400).json({ error: "suite is required" });
      return;
    }

    const result = await tenantQuery(req.user!.orgId,
      "SELECT full_title, file_path FROM quarantined_tests WHERE suite_name = $1",
      [suite]
    );

    res.json({
      quarantined: result.rows.map((r: any) => ({
        full_title: r.full_title,
        file_path: r.file_path,
      })),
    });
  } catch (err) {
    console.error("GET /quarantine/check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /quarantine — quarantine a test.
//
// Viewer-gated (a mutation): viewers read the quarantine list but can't mute a
// test — same gate as the /errors triage mutations. Phase 15.3 adds two optional
// lifecycle fields: `expires_at` (an auto-lift timestamp, must parse + be in the
// future) and `error_fingerprint` (md5-hex link to the triage error group).
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const { fullTitle, filePath, suiteName, reason, error_fingerprint } = req.body ?? {};
    if (!fullTitle || !suiteName) {
      res.status(400).json({ error: "fullTitle and suiteName are required" });
      return;
    }

    // Validate the optional expiry: present-but-bad (unparseable / not in the
    // future) is a 400 so the bad value never reaches the TIMESTAMPTZ column;
    // absent is the legal "no expiry" state.
    const parsedExpiry = parseExpiresAt(req.body?.expires_at, new Date());
    if (parsedExpiry.kind === "invalid") {
      res.status(400).json({ error: parsedExpiry.reason });
      return;
    }
    const expiresAt = parsedExpiry.kind === "valid" ? parsedExpiry.date.toISOString() : null;

    // Validate the optional triage link: if present it must be an md5 fingerprint
    // (the shape error_groups fingerprints take). Absent/null leaves it unlinked.
    let fingerprint: string | null = null;
    if (error_fingerprint != null && error_fingerprint !== "") {
      if (!isMd5Hex(error_fingerprint)) {
        res.status(400).json({ error: "error_fingerprint must be a 32-char md5 hex string" });
        return;
      }
      fingerprint = error_fingerprint;
    }

    const orgId = req.user!.orgId;
    const result = await tenantQuery(orgId,
      `INSERT INTO quarantined_tests (org_id, full_title, file_path, suite_name, reason, quarantined_by, expires_at, error_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, full_title, suite_name) DO UPDATE
         SET reason = $5, quarantined_by = $6, created_at = NOW(),
             expires_at = $7, error_fingerprint = $8
       RETURNING id`,
      [orgId, fullTitle, filePath ?? "", suiteName, reason ?? null, req.user!.id, expiresAt, fingerprint]
    );

    await logAudit(orgId, req.user!.id, "quarantine.add", "test", fullTitle, {
      suiteName, reason, expires_at: expiresAt, error_fingerprint: fingerprint,
    });
    res.status(201).json({ id: result.rows[0].id, quarantined: true });
  } catch (err) {
    console.error("POST /quarantine error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /quarantine — unquarantine a test (viewer-gated mutation, as POST).
router.delete("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const { fullTitle, suiteName } = req.body ?? {};
    if (!fullTitle || !suiteName) {
      res.status(400).json({ error: "fullTitle and suiteName are required" });
      return;
    }

    const orgId = req.user!.orgId;
    await tenantQuery(orgId,
      "DELETE FROM quarantined_tests WHERE full_title = $1 AND suite_name = $2",
      [fullTitle, suiteName]
    );

    await logAudit(orgId, req.user!.id, "quarantine.remove", "test", fullTitle, { suiteName });
    res.json({ quarantined: false });
  } catch (err) {
    console.error("DELETE /quarantine error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
