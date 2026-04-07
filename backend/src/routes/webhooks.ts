import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { formatPayload, type WebhookRunFailedPayload } from "../webhook-formatters.js";

const router = Router();

const VALID_EVENTS = ["run.failed", "flaky.detected"];
const VALID_PLATFORMS = ["generic", "slack", "teams", "discord"];

// GET /webhooks
router.get("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const result = await tenantQuery(req.user!.orgId,
      "SELECT id, name, url, events, active, platform, created_at FROM webhooks ORDER BY created_at DESC"
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
    const { name, url, events, platform } = req.body;
    if (!url) {
      res.status(400).json({ error: "URL is required" });
      return;
    }
    const validEvents = (events ?? []).filter((e: string) => VALID_EVENTS.includes(e));
    const validPlatform = VALID_PLATFORMS.includes(platform) ? platform : "generic";
    const result = await tenantQuery(req.user!.orgId,
      "INSERT INTO webhooks (org_id, name, url, events, platform) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, url, events, active, platform",
      [req.user!.orgId, name ?? "", url, validEvents, validPlatform]
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
    const { name, url, events, active, platform } = req.body;
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (name !== undefined) { sets.push(`name = $${i++}`); params.push(name); }
    if (url !== undefined) { sets.push(`url = $${i++}`); params.push(url); }
    if (events !== undefined) { sets.push(`events = $${i++}`); params.push(events.filter((e: string) => VALID_EVENTS.includes(e))); }
    if (active !== undefined) { sets.push(`active = $${i++}`); params.push(active); }
    if (platform !== undefined && VALID_PLATFORMS.includes(platform)) { sets.push(`platform = $${i++}`); params.push(platform); }

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
    const wh = await tenantQuery(req.user!.orgId, "SELECT url, platform FROM webhooks WHERE id = $1", [req.params.id]);
    if (wh.rows.length === 0) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";
    const testPayload: WebhookRunFailedPayload = {
      event: "run.failed",
      run: {
        id: 42,
        suite_name: "example-suite",
        branch: "main",
        commit_sha: "abc1234def5678",
        duration_ms: 94200,
        total: 48,
        passed: 45,
        failed: 3,
        skipped: 0,
        pending: 0,
        url: `${frontendUrl}/runs/42`,
      },
      failed_tests: [
        { full_title: "Login > should redirect after auth", error_message: "Expected URL to include '/dashboard' but got '/login'", spec_file: "cypress/e2e/login.cy.ts" },
        { full_title: "Cart > should update total on quantity change", error_message: "Timed out retrying after 4000ms", spec_file: "cypress/e2e/cart.cy.ts" },
        { full_title: "API > POST /users should validate email", error_message: "expected 422 but got 500", spec_file: "cypress/e2e/api.cy.ts" },
      ],
      trend: "\u2705\u2705\u274c\u2705\u274c",
    };
    const body = formatPayload(wh.rows[0].platform, testPayload);
    const response = await fetch(wh.rows[0].url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    res.json({ status: response.status, ok: response.ok });
  } catch (err) {
    res.json({ status: 0, ok: false, error: "Connection failed" });
  }
});

export default router;
