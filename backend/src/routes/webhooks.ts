import { Router } from "express";
import { BlockList, isIP } from "node:net";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";
import { formatPayload, type WebhookRunFailedPayload } from "../webhook-formatters.js";

const router = Router();

const VALID_EVENTS = ["run.failed", "run.passed", "run.completed", "new.failures", "flaky.detected"];
const VALID_PLATFORMS = ["generic", "slack", "teams", "discord"];

/**
 * Reject URLs we never want the backend to dispatch to. Two layers:
 *
 *   1. Always: anything that isn't http(s). file://, javascript:, data:,
 *      gopher:, etc. — the dispatcher hands the URL to Node's fetch()
 *      which is lenient on schemes our threat model doesn't include.
 *
 *   2. Default-on in production: loopback (127/8, ::1), link-local
 *      (169.254/16 — includes the AWS / GCP / Azure IMDS endpoint),
 *      RFC1918 private (10/8, 172.16/12, 192.168/16), CGNAT
 *      (100.64/10), and the "0.0.0.0" sentinel. Hostnames that resolve
 *      to those ranges (`localhost`, `metadata.google.internal`, etc.)
 *      are blocked by literal-string match before DNS — defense in
 *      depth against rebinding.
 *
 * In SaaS deployments, allowing private-IP webhooks is an SSRF vector
 * (a tenant admin can read IAM creds off IMDS via the dispatcher's
 * response logging). Self-hosted operators who legitimately need to
 * point webhooks at private addresses can opt out by setting
 * WEBHOOK_ALLOW_PRIVATE_TARGETS=true. The default tracks NODE_ENV:
 * production blocks, non-production allows (so dev against a local
 * webhook target — webhook.site is fine, but so is http://localhost:9000
 * — keeps working without env churn).
 *
 * The same gate is shared with the Jira base_url validator and any
 * other surface where a tenant configures a URL the backend later
 * dispatches to.
 */
const BLOCKED_LITERAL_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
  "metadata.tencentyun.com",
]);

// node:net.BlockList canonicalises addresses internally, so the v4-
// mapped IPv6 form (`::ffff:7f00:1`) is recognised as the embedded
// IPv4 the WHATWG URL parser collapses it to — string-prefix matching
// on the dotted-decimal form alone would miss it.
const PRIVATE_BLOCKLIST = (() => {
  const bl = new BlockList();
  // IPv4
  bl.addSubnet("0.0.0.0", 8); // unspecified / sentinel
  bl.addSubnet("10.0.0.0", 8); // RFC1918
  bl.addSubnet("100.64.0.0", 10); // CGNAT
  bl.addSubnet("127.0.0.0", 8); // loopback
  bl.addSubnet("169.254.0.0", 16); // link-local + IMDS
  bl.addSubnet("172.16.0.0", 12); // RFC1918
  bl.addSubnet("192.168.0.0", 16); // RFC1918
  bl.addSubnet("224.0.0.0", 4); // multicast
  bl.addSubnet("240.0.0.0", 4); // reserved
  // IPv6
  bl.addAddress("::", "ipv6"); // unspecified
  bl.addAddress("::1", "ipv6"); // loopback
  bl.addSubnet("fc00::", 7, "ipv6"); // ULA
  bl.addSubnet("fe80::", 10, "ipv6"); // link-local
  return bl;
})();

export function isPrivateOrReservedHost(host: string): boolean {
  // WHATWG URL.hostname keeps the surrounding `[...]` brackets on
  // IPv6 literals (different from RFC 3986 host parsing — strip them
  // before handing to net.isIP / BlockList.check).
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_LITERAL_HOSTS.has(h)) return true;
  const ipType = isIP(h);
  if (ipType === 4) return PRIVATE_BLOCKLIST.check(h);
  if (ipType === 6) {
    // Check the v6 ranges first. The v4-mapped form (::ffff:a.b.c.d
    // collapsed by URL to ::ffff:HHHH:HHHH) is caught here when the
    // embedded v4 falls in a private range — BlockList canonicalises
    // both the input AND the registered ranges for the comparison.
    if (PRIVATE_BLOCKLIST.check(h, "ipv6")) return true;
    // Belt-and-braces explicit v4-mapped check in case Node ever
    // changes the BlockList canonicalisation: parse the trailing hex
    // pair and feed it through the v4 blocklist.
    const v4mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (v4mapped) {
      const hi = parseInt(v4mapped[1], 16);
      const lo = parseInt(v4mapped[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return PRIVATE_BLOCKLIST.check(v4);
    }
    return false;
  }
  return false;
}

function shouldBlockPrivateTargets(): boolean {
  // Explicit opt-out wins over the env default (self-hosted operator
  // who genuinely needs internal webhook targets sets this once).
  const override = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  if (override === "true") return false;
  if (override === "false") return true;
  return process.env.NODE_ENV === "production";
}

export function validateWebhookUrl(url: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof url !== "string" || !url.trim()) {
    return { ok: false, error: "URL is required" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URL is not a valid absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported URL scheme '${parsed.protocol}'; webhooks must use http or https` };
  }
  if (shouldBlockPrivateTargets() && isPrivateOrReservedHost(parsed.hostname)) {
    return { ok: false, error: `URL host '${parsed.hostname}' resolves to a private / loopback / metadata address; webhooks must target a public host. Set WEBHOOK_ALLOW_PRIVATE_TARGETS=true if this is intentional.` };
  }
  return { ok: true };
}

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
    const urlCheck = validateWebhookUrl(url);
    if (!urlCheck.ok) {
      res.status(400).json({ error: urlCheck.error });
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
    if (url !== undefined) {
      const urlCheck = validateWebhookUrl(url);
      if (!urlCheck.ok) {
        res.status(400).json({ error: urlCheck.error });
        return;
      }
      sets.push(`url = $${i++}`);
      params.push(url);
    }
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
