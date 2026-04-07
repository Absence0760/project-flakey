import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const VALID_STATUSES = ["open", "investigating", "known", "fixed", "ignored"];

// GET /errors — aggregated error groups with status, first/last seen, affected test count
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const status = req.query.status as string | undefined;

    const conditions: string[] = ["t.status = 'failed'", "t.error_message IS NOT NULL"];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (suite) {
      conditions.push(`r.suite_name = $${paramIndex++}`);
      params.push(suite);
    }

    const where = conditions.join(" AND ");

    const result = await tenantQuery(req.user!.orgId,
      `SELECT
        md5(t.error_message || '|' || t.title || '|' || r.suite_name) AS fingerprint,
        t.error_message,
        t.title AS test_title,
        r.suite_name,
        COUNT(*)::int AS occurrence_count,
        COUNT(DISTINCT t.title)::int AS affected_tests,
        COUNT(DISTINCT r.id)::int AS affected_runs,
        MIN(r.created_at) AS first_seen,
        MAX(r.created_at) AS last_seen,
        MAX(r.id) AS latest_run_id,
        ARRAY_AGG(DISTINCT s.file_path) AS file_paths,
        (SELECT t2.id FROM tests t2
         JOIN specs s2 ON s2.id = t2.spec_id
         JOIN runs r2 ON r2.id = s2.run_id
         WHERE t2.error_message = t.error_message AND t2.title = t.title AND t2.status = 'failed'
         ORDER BY r2.created_at DESC LIMIT 1) AS latest_test_id,
        eg.id AS group_id,
        COALESCE(eg.status, 'open') AS status,
        (SELECT COUNT(*)::int FROM error_notes en WHERE en.error_group_id = eg.id) AS note_count
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      LEFT JOIN error_groups eg ON eg.fingerprint = md5(t.error_message || '|' || t.title || '|' || r.suite_name)
        AND eg.org_id = r.org_id
      WHERE ${where}
      GROUP BY t.error_message, t.title, r.suite_name, eg.id, eg.status
      ORDER BY last_seen DESC, occurrence_count DESC
      LIMIT 100`,
      params
    );

    let rows = result.rows;
    if (status && VALID_STATUSES.includes(status)) {
      rows = rows.filter((r) => r.status === status);
    }

    res.json(rows);
  } catch (err) {
    console.error("GET /errors error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /errors/:fingerprint/status — update error group status
router.patch("/:fingerprint/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
      return;
    }

    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    // Upsert the error group
    const result = await tenantQuery(orgId,
      `INSERT INTO error_groups (org_id, fingerprint, status, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (org_id, fingerprint) DO UPDATE SET status = $3, updated_at = NOW()
       RETURNING id`,
      [orgId, fingerprint, status]
    );

    await logAudit(orgId, req.user!.id, "error.status", "error_group", fingerprint, { status });
    res.json({ updated: true, group_id: result.rows[0].id, status });
  } catch (err) {
    console.error("PATCH /errors/:fingerprint/status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /errors/:fingerprint/notes — get notes for an error group
router.get("/:fingerprint/notes", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    const result = await tenantQuery(orgId,
      `SELECT en.id, en.body, en.created_at, u.name AS user_name, u.email AS user_email
       FROM error_notes en
       JOIN error_groups eg ON eg.id = en.error_group_id
       LEFT JOIN users u ON u.id = en.user_id
       WHERE eg.fingerprint = $1
       ORDER BY en.created_at ASC`,
      [fingerprint]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /errors/:fingerprint/notes error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /errors/:fingerprint/notes — add a note to an error group
router.post("/:fingerprint/notes", async (req, res) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) {
      res.status(400).json({ error: "Note body is required" });
      return;
    }

    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    // Ensure error group exists
    const groupResult = await tenantQuery(orgId,
      `INSERT INTO error_groups (org_id, fingerprint)
       VALUES ($1, $2)
       ON CONFLICT (org_id, fingerprint) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [orgId, fingerprint]
    );
    const groupId = groupResult.rows[0].id;

    const noteResult = await tenantQuery(orgId,
      `INSERT INTO error_notes (error_group_id, org_id, user_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [groupId, orgId, req.user!.id, body.trim()]
    );

    await logAudit(orgId, req.user!.id, "error.note", "error_group", fingerprint);

    res.status(201).json({
      id: noteResult.rows[0].id,
      body: body.trim(),
      created_at: noteResult.rows[0].created_at,
      user_name: req.user!.name,
      user_email: req.user!.email,
    });
  } catch (err) {
    console.error("POST /errors/:fingerprint/notes error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
