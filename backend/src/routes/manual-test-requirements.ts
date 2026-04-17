import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

// Attached to /manual-tests/:id/requirements — path-prefixed below so the
// outer router can mount it alongside the existing manual-tests router.
const router = Router({ mergeParams: true });

// With mergeParams Express copies parent path params in at runtime, but
// its static type only reflects the sub-router's own params. This helper
// narrows the cast to the one place we need it.
function parentTestId(req: { params: unknown }): string {
  return (req.params as { id: string }).id;
}

const PROVIDERS = ["jira", "github", "linear", "other"];

// Heuristically guess the provider from a pasted URL so users don't have
// to choose it. Falls back to 'other'.
function inferProvider(refUrl: string | undefined): string {
  if (!refUrl) return "other";
  const url = refUrl.toLowerCase();
  if (url.includes("atlassian.net") || url.includes("/jira/")) return "jira";
  if (url.includes("github.com")) return "github";
  if (url.includes("linear.app")) return "linear";
  return "other";
}

// GET /manual-tests/:id/requirements
router.get("/", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT r.id, r.ref_key, r.ref_url, r.ref_title, r.provider,
              r.added_at, u.email AS added_by_email
         FROM manual_test_requirements r
         LEFT JOIN users u ON u.id = r.added_by
        WHERE r.manual_test_id = $1
        ORDER BY r.added_at`,
      [parentTestId(req)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET requirements error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /manual-tests/:id/requirements — body: { ref_key, ref_url?, ref_title?, provider? }
router.post("/", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const { ref_key, ref_url, ref_title, provider } = req.body ?? {};
    if (!ref_key || typeof ref_key !== "string" || !ref_key.trim()) {
      res.status(400).json({ error: "ref_key required" });
      return;
    }
    const prov = PROVIDERS.includes(provider) ? provider : inferProvider(ref_url);
    const result = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO manual_test_requirements
          (org_id, manual_test_id, ref_key, ref_url, ref_title, provider, added_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (manual_test_id, ref_key) DO UPDATE
          SET ref_url = EXCLUDED.ref_url,
              ref_title = EXCLUDED.ref_title,
              provider = EXCLUDED.provider
        RETURNING id, ref_key, ref_url, ref_title, provider, added_at`,
      [
        req.user!.orgId,
        parentTestId(req),
        ref_key.trim(),
        ref_url ?? null,
        ref_title ?? null,
        prov,
        req.user!.id,
      ]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test.link_requirement",
      "manual_test",
      parentTestId(req),
      { ref_key: ref_key.trim(), provider: prov }
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST requirements error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /manual-tests/:id/requirements/:reqId
router.delete("/:reqId", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    await tenantQuery(
      req.user!.orgId,
      "DELETE FROM manual_test_requirements WHERE id = $1 AND manual_test_id = $2",
      [req.params.reqId, parentTestId(req)]
    );
    await logAudit(
      req.user!.orgId,
      req.user!.id,
      "manual_test.unlink_requirement",
      "manual_test",
      parentTestId(req),
      { requirement_id: req.params.reqId }
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE requirements error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
