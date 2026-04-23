import { Router } from "express";
import pool from "../db.js";

const router = Router();

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeBadge(label: string, message: string, color: string): string {
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

    const result = await pool.query(
      `SELECT total, passed, failed, skipped FROM runs
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

    const { total, passed, failed, skipped } = result.rows[0];

    let message: string;
    let color: string;

    if (failed > 0) {
      message = `${failed} failed`;
      color = "#e05d44"; // red
    } else if (passed === total) {
      message = `${passed} passed`;
      color = "#4c1"; // green
    } else {
      message = `${passed}/${total} passed`;
      color = skipped > 0 ? "#dfb317" : "#4c1"; // yellow if skipped, green otherwise
    }

    res.send(makeBadge("tests", message, color));
  } catch (err) {
    console.error("GET /badge/:suiteName error:", err);
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(makeBadge("tests", "error", "#9f9f9f"));
  }
});

export default router;
