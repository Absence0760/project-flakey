import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const VALID_EVENTS = ["run.failed", "flaky.detected"];

// GET /webhooks
router.get("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const result = await tenantQuery(req.user!.orgId,
      "SELECT id, name, url, events, active, created_at FROM webhooks ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /webhooks error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /webhooks
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { name, url, events } = req.body;
    if (!url) {
      res.status(400).json({ error: "URL is required" });
      return;
    }
    const validEvents = (events ?? []).filter((e: string) => VALID_EVENTS.includes(e));
    const result = await tenantQuery(req.user!.orgId,
      "INSERT INTO webhooks (org_id, name, url, events) VALUES ($1, $2, $3, $4) RETURNING id, name, url, events, active",
      [req.user!.orgId, name ?? "", url, validEvents]
    );
    await logAudit(req.user!.orgId, req.user!.id, "webhook.create", "webhook", String(result.rows[0].id), { name, url, events: validEvents });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /webhooks error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /webhooks/:id
router.patch("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { name, url, events, active } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(name); }
    if (url !== undefined) { sets.push(`url = $${i++}`); params.push(url); }
    if (events !== undefined) { sets.push(`events = $${i++}`); params.push(events.filter((e: string) => VALID_EVENTS.includes(e))); }
    if (active !== undefined) { sets.push(`active = $${i++}`); params.push(active); }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.id);
    await tenantQuery(req.user!.orgId,
      `UPDATE webhooks SET ${sets.join(", ")} WHERE id = $${i} RETURNING id`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "webhook.update", "webhook", req.params.id);
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /webhooks/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /webhooks/:id
router.delete("/:id", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(req.user!.orgId, "DELETE FROM webhooks WHERE id = $1", [req.params.id]);
    await logAudit(req.user!.orgId, req.user!.id, "webhook.delete", "webhook", req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /webhooks/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /webhooks/:id/test
router.post("/:id/test", async (req, res) => {
  try {
    const wh = await tenantQuery(req.user!.orgId, "SELECT url FROM webhooks WHERE id = $1", [req.params.id]);
    if (wh.rows.length === 0) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    const payload = {
      text: "Test notification from Flakey",
      event: "test",
      run: { id: 0, suite_name: "test-suite", failed: 1, total: 10, url: "" },
    };
    const response = await fetch(wh.rows[0].url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    res.json({ status: response.status, ok: response.ok });
  } catch (err) {
    res.json({ status: 0, ok: false, error: "Connection failed" });
  }
});

export default router;
