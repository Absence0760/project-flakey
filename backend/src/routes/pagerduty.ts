import { Router } from "express";
import pool from "../db.js";
import { logAudit } from "../audit.js";
import { triggerPagerDutyEvent } from "../integrations/pagerduty.js";
import { encryptSecret, decryptSecret } from "../crypto.js";

const router = Router();

// GET /pagerduty/settings
router.get("/settings", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pagerduty_integration_key IS NOT NULL AS has_key,
              pagerduty_severity, pagerduty_auto_trigger
       FROM organizations WHERE id = $1`,
      [req.user!.orgId]
    );
    res.json(result.rows[0] ?? {});
  } catch (err) {
    console.error("GET /pagerduty/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /pagerduty/settings
router.patch("/settings", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { integration_key, severity, auto_trigger } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (integration_key !== undefined) {
      sets.push(`pagerduty_integration_key = $${i++}`);
      params.push(integration_key ? encryptSecret(integration_key) : null);
    }
    if (severity !== undefined) {
      const sev = ["critical", "error", "warning", "info"].includes(severity) ? severity : "error";
      sets.push(`pagerduty_severity = $${i++}`);
      params.push(sev);
    }
    if (auto_trigger !== undefined) {
      sets.push(`pagerduty_auto_trigger = $${i++}`);
      params.push(!!auto_trigger);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.user!.orgId);
    await pool.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`, params);
    await logAudit(req.user!.orgId, req.user!.id, "pagerduty.settings.update", "settings", "pagerduty");
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /pagerduty/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /pagerduty/test — fire a test event
router.post("/test", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const result = await pool.query(
      "SELECT pagerduty_integration_key, pagerduty_severity FROM organizations WHERE id = $1",
      [req.user!.orgId]
    );
    const row = result.rows[0];
    if (!row?.pagerduty_integration_key) {
      res.status(400).json({ error: "PagerDuty not configured" });
      return;
    }
    const sev = ["critical", "error", "warning", "info"].includes(row.pagerduty_severity)
      ? row.pagerduty_severity
      : "error";

    const out = await triggerPagerDutyEvent(
      decryptSecret(row.pagerduty_integration_key)!,
      "Flakey test event from settings",
      sev,
      "flakey/test",
      `flakey-test-${req.user!.orgId}-${Date.now()}`,
      { note: "This is a test event triggered from the Flakey Settings page." }
    );
    res.json(out);
  } catch (err) {
    res.json({ ok: false, status: 0, error: (err as Error).message });
  }
});

export default router;
