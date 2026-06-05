import { Router } from "express";
import pool, { tenantQuery } from "../db.js";

const router = Router();

export function escapeXml(str: string): string {
  // Quotes too — escapeXml is interpolated into XML attribute values
  // (e.g. aria-label="..."), so an unescaped " or ' would break out
  // of the attribute. CodeQL js/incomplete-html-attribute-sanitization.
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function makeBadge(label: string, message: string, color: string): string {
  const labelWidth = label.length * 6.5 + 12;
  const messageWidth = message.length * 6.5 + 12;
  const totalWidth = labelWidth + messageWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(message)}">
  <title>${escapeXml(label)}: ${escapeXml(message)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="14">${escapeXml(label)}</text>
    <text aria-hidden="true" x="${labelWidth + messageWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${escapeXml(message)}</text>
  </g>
</svg>`;
}

// GET /badge/:orgSlug/:suiteName
// orgSlug scopes the query to a single org so suite names do not leak across orgs.
router.get("/:orgSlug/:suiteName", async (req, res) => {
  try {
    const { orgSlug, suiteName } = req.params;

    const org = await pool.query(
      "SELECT id FROM organizations WHERE slug = $1",
      [orgSlug]
    );
    if (!org.rows[0]) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.send(makeBadge("tests", "not found", "#9f9f9f"));
      return;
    }

    // Run the runs query through tenantQuery so RLS sees the looked-up
    // org id.  Without this, the RLS policy on `runs` evaluates
    // `org_id = ''::integer` and errors, causing every badge to render
    // "error" even for valid suite names.  The explicit AND filter is
    // kept as defense-in-depth alongside RLS.
    // A badge is a ship-gate signal: a green badge means "safe to merge".
    // So it must reflect only a *completed, non-aborted* run. `finished_at`
    // is NULL for live/in-progress runs (POST /live/start inserts the row
    // before the suite finishes — migration 050) and for partially-merged
    // sharded runs where only some shards have uploaded; an `aborted` run is
    // one with a `run.aborted` live_events row (a CI kill / OOM / network
    // drop). Both states can carry `failed = 0`, so without these guards a
    // not-yet-finished or aborted run renders a false green.
    const result = await tenantQuery(
      org.rows[0].id,
      `SELECT total, passed, failed, skipped, finished_at,
              EXISTS (
                SELECT 1 FROM live_events le
                WHERE le.run_id = runs.id AND le.event_type = 'run.aborted'
              ) AS aborted
       FROM runs
       WHERE suite_name = $1 AND org_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [suiteName, org.rows[0].id]
    );

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    if (result.rows.length === 0) {
      res.send(makeBadge("tests", "no data", "#9f9f9f"));
      return;
    }

    const { total, passed, failed, skipped, finished_at, aborted } = result.rows[0];

    let message: string;
    let color: string;

    if (failed > 0) {
      message = `${failed} failed`;
      color = "#e05d44"; // red
    } else if (aborted) {
      // Aborted with no recorded failure is still not a pass — the run never
      // completed. Distinct orange so a gate doesn't read it as green.
      message = "aborted";
      color = "#fe7d37"; // orange
    } else if (finished_at === null) {
      // Live / partially-merged run: failed=0 only means "no failures yet".
      message = "in progress";
      color = "#9f9f9f"; // grey
    } else if (passed + skipped === total) {
      // Every test accounted for and none failed. Skipped tests are
      // intentional exclusions, not failures, so passed+skipped===total is
      // a clean run — render green, not yellow.
      message = skipped > 0 ? `${passed}/${total} passed` : `${passed} passed`;
      color = "#4c1"; // green
    } else {
      // Some tests neither passed, skipped, nor failed (e.g. pending) in a
      // finished run — surface it as yellow rather than implying all-clear.
      message = `${passed}/${total} passed`;
      color = "#dfb317"; // yellow
    }

    res.send(makeBadge("tests", message, color));
  } catch (err) {
    console.error("GET /badge/:suiteName error:", err);
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(makeBadge("tests", "error", "#9f9f9f"));
  }
});

export default router;
