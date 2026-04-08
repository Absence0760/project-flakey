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
      `WITH error_agg AS (
        SELECT
          md5(t.error_message || '|' || r.suite_name) AS fingerprint,
          t.error_message,
          r.suite_name,
          COUNT(*)::int AS occurrence_count,
          COUNT(DISTINCT t.full_title)::int AS affected_tests,
          COUNT(DISTINCT r.id)::int AS affected_runs,
          MIN(r.created_at) AS first_seen,
          MAX(r.created_at) AS last_seen,
          MAX(r.id) AS latest_run_id,
          ARRAY_AGG(DISTINCT s.file_path) AS file_paths,
          ARRAY_AGG(DISTINCT t.full_title) AS test_titles,
          MAX(t.id) AS latest_test_id
        FROM tests t
        JOIN specs s ON s.id = t.spec_id
        JOIN runs r ON r.id = s.run_id
        WHERE ${where}
        GROUP BY t.error_message, r.suite_name
        ORDER BY last_seen DESC, occurrence_count DESC
        LIMIT 100
      )
      SELECT ea.*,
        eg.id AS group_id,
        COALESCE(eg.status, 'open') AS status,
        COALESCE(nc.cnt, 0) AS note_count
      FROM error_agg ea
      LEFT JOIN error_groups eg ON eg.fingerprint = ea.fingerprint
        AND eg.org_id = (SELECT current_setting('app.current_org_id', true)::int)
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt FROM notes n
        WHERE n.target_type = 'error' AND n.target_key = ea.fingerprint
      ) nc ON TRUE
      ORDER BY ea.last_seen DESC, ea.occurrence_count DESC`,
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

// GET /errors/:fingerprint/tests — list affected tests for an error group
router.get("/:fingerprint/tests", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    const result = await tenantQuery(orgId,
      `SELECT
        t.full_title,
        t.title,
        s.file_path,
        r.suite_name,
        COUNT(*)::int AS occurrence_count,
        MAX(r.created_at) AS last_seen,
        MAX(t.id) AS latest_test_id,
        MAX(r.id) AS latest_run_id
      FROM tests t
      JOIN specs s ON s.id = t.spec_id
      JOIN runs r ON r.id = s.run_id
      WHERE t.status = 'failed'
        AND t.error_message IS NOT NULL
        AND md5(t.error_message || '|' || r.suite_name) = $1
      GROUP BY t.full_title, t.title, s.file_path, r.suite_name
      ORDER BY occurrence_count DESC, last_seen DESC
      LIMIT 50`,
      [fingerprint]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /errors/:fingerprint/tests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /errors/:fingerprint/notes — get notes for an error group (delegates to universal notes)
router.get("/:fingerprint/notes", async (req, res) => {
  try {
    const result = await tenantQuery(req.user!.orgId,
      `SELECT n.id, n.body, n.created_at, u.name AS user_name, u.email AS user_email
       FROM notes n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.target_type = 'error' AND n.target_key = $1
       ORDER BY n.created_at ASC`,
      [req.params.fingerprint]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /errors/:fingerprint/notes error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /errors/:fingerprint/notes — add a note to an error group (delegates to universal notes)
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
    await tenantQuery(orgId,
      `INSERT INTO error_groups (org_id, fingerprint)
       VALUES ($1, $2)
       ON CONFLICT (org_id, fingerprint) DO UPDATE SET updated_at = NOW()`,
      [orgId, fingerprint]
    );

    const noteResult = await tenantQuery(orgId,
      `INSERT INTO notes (org_id, user_id, target_type, target_key, body)
       VALUES ($1, $2, 'error', $3, $4)
       RETURNING id, created_at`,
      [orgId, req.user!.id, fingerprint, body.trim()]
    );

    await logAudit(orgId, req.user!.id, "note.create", "error", fingerprint);

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
