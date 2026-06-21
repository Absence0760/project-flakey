import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

const VALID_STATUSES = ["open", "investigating", "known", "fixed", "ignored"];
const VALID_PRIORITIES = ["low", "medium", "high", "critical"];

// Accept either a bare YYYY-MM-DD date or null/empty (un-set). Rejecting
// free-form strings keeps a malformed value from reaching the DATE column as a
// 500 — the route owns the contract the migration's column type implies.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /errors — aggregated error groups with status, first/last seen, affected test count
router.get("/", async (req, res) => {
  try {
    const suite = req.query.suite as string | undefined;
    const status = req.query.status as string | undefined;

    const conditions: string[] = ["t.status = 'failed'", "t.error_message IS NOT NULL"];
    const params: (string | number | null)[] = [];
    let paramIndex = 1;

    if (suite) {
      conditions.push(`r.suite_name = $${paramIndex++}`);
      params.push(suite);
    }

    const where = conditions.join(" AND ");

    // The status filter must be applied BEFORE the top-100 LIMIT, not after.
    // Status lives in error_groups (defaulting to 'open' for unstamped groups),
    // so we join + filter in the `ranked` CTE, then LIMIT — otherwise filtering
    // a status that's rarer than the 100 most-recent groups would silently
    // truncate matches that fall outside that window. An invalid/absent status
    // passes NULL, which the `$N IS NULL` guard turns into "no status filter"
    // (preserving the prior lenient behaviour for unknown values).
    const statusFilter = status && VALID_STATUSES.includes(status) ? status : null;
    const statusParam = paramIndex++;
    params.push(statusFilter);

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
      ),
      ranked AS (
        SELECT ea.*,
          eg.id AS group_id,
          COALESCE(eg.status, 'open') AS status,
          eg.assigned_to,
          eg.target_date,
          eg.priority
        FROM error_agg ea
        LEFT JOIN error_groups eg ON eg.fingerprint = ea.fingerprint
          AND eg.org_id = (SELECT current_setting('app.current_org_id', true)::int)
        WHERE $${statusParam}::text IS NULL
          OR COALESCE(eg.status, 'open') = $${statusParam}::text
        ORDER BY ea.last_seen DESC, ea.occurrence_count DESC
        LIMIT 100
      )
      SELECT ranked.*,
        asg.email AS assigned_to_email,
        COALESCE(nc.cnt, 0) AS note_count
      FROM ranked
      -- users has no RLS; safe to join because assigned_to is only ever an
      -- org member (enforced at write time in POST /errors/:fingerprint/assign).
      LEFT JOIN users asg ON asg.id = ranked.assigned_to
      LEFT JOIN LATERAL (
        -- Explicit org_id predicate alongside RLS. The notes_tenant
        -- policy already enforces this, but the explicit predicate
        -- keeps query intent legible at the call site and lets the
        -- planner use the org_id-leading composite index.
        SELECT COUNT(*)::int AS cnt FROM notes n
        WHERE n.org_id = (SELECT current_setting('app.current_org_id', true)::int)
          AND n.target_type = 'error' AND n.target_key = ranked.fingerprint
      ) nc ON TRUE
      ORDER BY ranked.last_seen DESC, ranked.occurrence_count DESC`,
      params
    );

    res.json(result.rows);
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

// PATCH /errors/:fingerprint — set triage metadata (target_date / priority) on
// an error group. Mirrors the assign route's shape: org-scoped via tenantQuery,
// viewer-gated (mutation), lazy upsert of the error_groups row. Status stays on
// its own PATCH .../status route. Either field may be sent on its own; sending
// neither is a no-op-but-touch (updates updated_at). null/"" clears a field.
router.patch("/:fingerprint", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;
    const body = req.body ?? {};
    const hasTargetDate = Object.prototype.hasOwnProperty.call(body, "target_date");
    const hasPriority = Object.prototype.hasOwnProperty.call(body, "priority");

    if (!hasTargetDate && !hasPriority) {
      res.status(400).json({ error: "Provide target_date and/or priority" });
      return;
    }

    // Normalise + validate each provided field. A field that's null or "" clears
    // the column; anything else must match the contract or we 400 (never let a
    // bad value hit the DATE column / CHECK as a 500).
    let targetDate: string | null | undefined;
    if (hasTargetDate) {
      const raw = body.target_date;
      if (raw === null || raw === "") {
        targetDate = null;
      } else if (typeof raw === "string" && DATE_RE.test(raw) && !Number.isNaN(Date.parse(raw))) {
        targetDate = raw;
      } else {
        res.status(400).json({ error: "target_date must be a YYYY-MM-DD date or null" });
        return;
      }
    }

    let priority: string | null | undefined;
    if (hasPriority) {
      const raw = body.priority;
      if (raw === null || raw === "") {
        priority = null;
      } else if (typeof raw === "string" && VALID_PRIORITIES.includes(raw)) {
        priority = raw;
      } else {
        res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` });
        return;
      }
    }

    // Build the upsert from only the fields that were sent, so a PATCH of just
    // `priority` doesn't clobber an existing target_date (and vice-versa).
    const cols = ["org_id", "fingerprint"];
    const vals: (string | number | null)[] = [orgId, fingerprint];
    const sets: string[] = [];
    if (hasTargetDate) {
      cols.push("target_date");
      vals.push(targetDate ?? null);
      sets.push(`target_date = $${vals.length}`);
    }
    if (hasPriority) {
      cols.push("priority");
      vals.push(priority ?? null);
      sets.push(`priority = $${vals.length}`);
    }
    sets.push("updated_at = NOW()");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

    const result = await tenantQuery(orgId,
      `INSERT INTO error_groups (${cols.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (org_id, fingerprint) DO UPDATE SET ${sets.join(", ")}
       RETURNING id, target_date, priority`,
      vals
    );

    const audit: Record<string, unknown> = {};
    if (hasTargetDate) audit.target_date = targetDate ?? null;
    if (hasPriority) audit.priority = priority ?? null;
    await logAudit(orgId, req.user!.id, "error.triage_update", "error_group", fingerprint, audit);

    res.json({
      updated: true,
      group_id: result.rows[0].id,
      target_date: result.rows[0].target_date,
      priority: result.rows[0].priority,
    });
  } catch (err) {
    console.error("PATCH /errors/:fingerprint error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /errors/:fingerprint/assign — assign (or un-assign) an owner to an error
// group. Body: { user_id: number | null }. This is lightweight triage ownership
// ("who's chasing this failure"), not a workflow — escalation to tracked work
// stays the Jira file-bug path. Viewers can't assign.
router.post("/:fingerprint/assign", async (req, res) => {
  try {
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;
    const userId = req.body?.user_id;
    const normalised = userId === null || userId === undefined
      ? null
      : Number.isInteger(Number(userId)) ? Number(userId) : null;

    // Only org members may be assigned. `users` has no RLS, and GET /errors
    // joins users to return assigned_to_email — so without this check an admin
    // could write any user id and read back a cross-org user's email (IDOR).
    // Mirrors the release session-result assign guard.
    if (normalised !== null) {
      const member = await tenantQuery(orgId,
        "SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, normalised]
      );
      if (member.rows.length === 0) {
        res.status(400).json({ error: "User is not a member of this org" });
        return;
      }
    }

    // Upsert the error group — it may not have a persisted row yet (same as
    // the status/notes endpoints, which also lazily create it).
    const result = await tenantQuery(orgId,
      `INSERT INTO error_groups (org_id, fingerprint, assigned_to, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (org_id, fingerprint) DO UPDATE SET assigned_to = $3, updated_at = NOW()
       RETURNING id`,
      [orgId, fingerprint, normalised]
    );

    await logAudit(orgId, req.user!.id, "error.assign", "error_group", fingerprint, { user_id: normalised });
    res.json({ assigned: true, group_id: result.rows[0].id, user_id: normalised });
  } catch (err) {
    console.error("POST /errors/:fingerprint/assign error:", err);
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
