import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const VALID_CADENCES = ["daily", "weekly"];
const VALID_CHANNELS = ["email", "webhook", "slack"];

// GET /reports — list scheduled reports
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT id, name, cadence, day_of_week, hour_utc, channel, destination,
              suite_filter, active, last_sent_at, created_at
       FROM scheduled_reports ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /reports error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /reports — create
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { name, cadence, day_of_week, hour_utc, channel, destination, suite_filter } = req.body;

    if (!name || !VALID_CADENCES.includes(cadence) || !VALID_CHANNELS.includes(channel) || !destination) {
      res.status(400).json({ error: "name, cadence (daily|weekly), channel (email|webhook|slack), destination are required" });
      return;
    }
    if (cadence === "weekly" && (day_of_week === undefined || day_of_week === null)) {
      res.status(400).json({ error: "day_of_week (0-6) required for weekly cadence" });
      return;
    }

    const hour = Number.isInteger(hour_utc) && hour_utc >= 0 && hour_utc <= 23 ? hour_utc : 9;
    const dow = cadence === "weekly" ? Math.max(0, Math.min(6, Number(day_of_week))) : null;

    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO scheduled_reports
        (org_id, name, cadence, day_of_week, hour_utc, channel, destination, suite_filter)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, cadence, day_of_week, hour_utc, channel, destination, suite_filter, active, last_sent_at, created_at`,
      [req.user!.orgId, name, cadence, dow, hour, channel, destination, suite_filter ?? null]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "scheduled_report.create",
      "scheduled_report",
      String(result.rows[0].id),
      { name, cadence, channel }
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /reports error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /reports/:id
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const fields = ["name", "destination", "suite_filter"];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = $${i++}`);
        params.push(req.body[f]);
      }
    }
    if (req.body.cadence !== undefined && VALID_CADENCES.includes(req.body.cadence)) {
      sets.push(`cadence = $${i++}`);
      params.push(req.body.cadence);
    }
    if (req.body.channel !== undefined && VALID_CHANNELS.includes(req.body.channel)) {
      sets.push(`channel = $${i++}`);
      params.push(req.body.channel);
    }
    if (req.body.day_of_week !== undefined) {
      const v = req.body.day_of_week === null ? null : Math.max(0, Math.min(6, Number(req.body.day_of_week)));
      sets.push(`day_of_week = $${i++}`);
      params.push(v);
    }
    if (req.body.hour_utc !== undefined) {
      const v = Math.max(0, Math.min(23, Number(req.body.hour_utc)));
      sets.push(`hour_utc = $${i++}`);
      params.push(v);
    }
    if (req.body.active !== undefined) {
      sets.push(`active = $${i++}`);
      params.push(!!req.body.active);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.id);
    await tenantQuery(
      req.user!.orgId,
      `UPDATE scheduled_reports SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "scheduled_report.update", "scheduled_report", req.params.id);
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /reports/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /reports/:id
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM scheduled_reports WHERE id = $1",
      [req.params.id]
    );
    await logAudit(req.user!.orgId, req.user!.id, "scheduled_report.delete", "scheduled_report", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /reports/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /reports/:id/run — trigger a one-off dispatch for testing
router.post("/:id/run", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    // Reset last_sent_at so scheduler picks it up next tick (or run it immediately).
    const { runScheduledReports } = await import("../scheduled-reports.js");
    await tenantQuery(
      req.user!.orgId,
      "UPDATE scheduled_reports SET last_sent_at = NULL WHERE id = $1",
      [req.params.id]
    );
    await runScheduledReports();
    res.json({ triggered: true });
  } catch (err) {
    console.error("POST /reports/:id/run error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
