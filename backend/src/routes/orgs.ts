import { Router } from "express";
import crypto from "crypto";
import pool from "../db.js";
import { requireAuth, signToken, normalizeEmail } from "../auth.js";
import { logAudit } from "../audit.js";
import { encryptSecret } from "../crypto.js";

const router = Router();

// GET /orgs — list user's orgs
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.slug, om.role,
        (SELECT COUNT(*)::int FROM org_members WHERE org_id = o.id) AS member_count
       FROM organizations o JOIN org_members om ON om.org_id = o.id
       WHERE om.user_id = $1 ORDER BY o.name`,
      [req.user!.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /orgs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /orgs — create org
router.post("/", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36);

    const org = await pool.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
      [name, slug]
    );
    const orgId = org.rows[0].id;

    await pool.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')",
      [orgId, req.user!.id]
    );

    // Issue new token with the new org
    const authUser = { ...req.user!, orgId, orgRole: "owner" };
    const token = signToken(authUser);

    res.status(201).json({ org: org.rows[0], token, user: authUser });
  } catch (err) {
    console.error("POST /orgs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /orgs/:id/members
router.get("/:id/members", async (req, res) => {
  try {
    const orgId = Number(req.params.id);

    // Verify membership
    const check = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, req.user!.id]
    );
    if (check.rows.length === 0) {
      res.status(403).json({ error: "Not a member" });
      return;
    }

    const members = await pool.query(
      `SELECT u.id, u.email, u.name, om.role, om.joined_at
       FROM org_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = $1 ORDER BY om.joined_at`,
      [orgId]
    );
    res.json(members.rows);
  } catch (err) {
    console.error("GET /orgs/:id/members error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /orgs/:id/invites — invite user by email
router.post("/:id/invites", async (req, res) => {
  try {
    const orgId = Number(req.params.id);
    const email = normalizeEmail(req.body?.email);
    const { role } = req.body ?? {};

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    // Verify caller is admin/owner
    const check = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, req.user!.id]
    );
    if (check.rows.length === 0 || check.rows[0].role === "viewer") {
      res.status(403).json({ error: "Admin or owner role required to invite" });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const inviteRole = role === "admin" ? "admin" : "viewer";

    await pool.query(
      "INSERT INTO org_invites (org_id, email, role, token, invited_by) VALUES ($1, $2, $3, $4, $5)",
      [orgId, email, inviteRole, token, req.user!.id]
    );

    // Get org name for the response
    const org = await pool.query("SELECT name FROM organizations WHERE id = $1", [orgId]);

    res.status(201).json({
      invite_token: token,
      org_name: org.rows[0]?.name,
      email,
      role: inviteRole,
    });
  } catch (err) {
    console.error("POST /orgs/:id/invites error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /orgs/invites/:token/accept — accept an invite
router.post("/invites/:token/accept", async (req, res) => {
  try {
    const invite = await pool.query(
      `SELECT i.id, i.org_id, i.role, i.email, o.name AS org_name
       FROM org_invites i JOIN organizations o ON o.id = i.org_id
       WHERE i.token = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()`,
      [req.params.token]
    );

    if (invite.rows.length === 0) {
      res.status(404).json({ error: "Invite not found or expired" });
      return;
    }

    const inv = invite.rows[0];

    // Verify the current user's email matches the invite. Compare
    // case-insensitively: in practice email-address case is ignored by
    // every mainstream provider, and admins routinely type a mixed-case
    // form ("Alice@Example.com") into the invite UI even though the
    // recipient registered as "alice@example.com". Strict !== rejected
    // the invite with a confusing 403 in that case.
    if (req.user!.email.toLowerCase() !== inv.email.toLowerCase()) {
      res.status(403).json({ error: "This invite is for a different email address" });
      return;
    }

    await pool.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING",
      [inv.org_id, req.user!.id, inv.role]
    );
    await pool.query("UPDATE org_invites SET accepted_at = NOW() WHERE id = $1", [inv.id]);

    // Issue new token scoped to the joined org
    const authUser = { ...req.user!, orgId: inv.org_id, orgRole: inv.role };
    const token = signToken(authUser);

    res.json({ token, user: authUser, org_name: inv.org_name });
  } catch (err) {
    console.error("POST /orgs/invites/:token/accept error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /orgs/:id/members/:userId — remove member
router.delete("/:id/members/:userId", async (req, res) => {
  try {
    const orgId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);

    const check = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, req.user!.id]
    );
    if (check.rows.length === 0 || check.rows[0].role === "viewer") {
      res.status(403).json({ error: "Admin or owner role required" });
      return;
    }

    // Can't remove the last owner
    if (targetUserId !== req.user!.id) {
      const targetRole = await pool.query(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, targetUserId]
      );
      if (targetRole.rows[0]?.role === "owner") {
        const ownerCount = await pool.query(
          "SELECT COUNT(*)::int AS c FROM org_members WHERE org_id = $1 AND role = 'owner'",
          [orgId]
        );
        if (ownerCount.rows[0].c <= 1) {
          res.status(400).json({ error: "Cannot remove the last owner" });
          return;
        }
      }
    }

    await pool.query(
      "DELETE FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, targetUserId]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /orgs/:id/members/:userId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /orgs/:id/members/:userId — change role
router.patch("/:id/members/:userId", async (req, res) => {
  try {
    const orgId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const { role } = req.body;

    if (!role || !["admin", "viewer"].includes(role)) {
      res.status(400).json({ error: "Role must be 'admin' or 'viewer'" });
      return;
    }

    // Only owner can change roles
    const check = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, req.user!.id]
    );
    if (check.rows.length === 0 || check.rows[0].role !== "owner") {
      res.status(403).json({ error: "Owner role required to change roles" });
      return;
    }

    // Can't change own role
    if (targetUserId === req.user!.id) {
      res.status(400).json({ error: "Cannot change your own role" });
      return;
    }

    // Can't change another owner's role
    const target = await pool.query(
      "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, targetUserId]
    );
    if (target.rows.length === 0) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (target.rows[0].role === "owner") {
      res.status(400).json({ error: "Cannot change an owner's role" });
      return;
    }

    await pool.query(
      "UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3",
      [role, orgId, targetUserId]
    );
    res.json({ updated: true, role });
  } catch (err) {
    console.error("PATCH /orgs/:id/members/:userId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /orgs/:id/settings
router.get("/:id/settings", async (req, res) => {
  try {
    if (Number(req.params.id) !== req.user!.orgId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const result = await pool.query(
      "SELECT retention_days, git_provider, git_repo, git_base_url, git_token IS NOT NULL AS has_git_token FROM organizations WHERE id = $1",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Org not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /orgs/:id/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /orgs/:id/settings
router.patch("/:id/settings", async (req, res) => {
  try {
    if (Number(req.params.id) !== req.user!.orgId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (req.user!.orgRole === "viewer") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (req.body.retention_days !== undefined) {
      const value = req.body.retention_days === null || req.body.retention_days === "" ? null : Number(req.body.retention_days);
      sets.push(`retention_days = $${i++}`);
      params.push(value);
    }
    if (req.body.git_provider !== undefined) {
      sets.push(`git_provider = $${i++}`);
      params.push(req.body.git_provider || null);
    }
    if (req.body.git_token !== undefined) {
      sets.push(`git_token = $${i++}`);
      params.push(req.body.git_token ? encryptSecret(req.body.git_token) : null);
    }
    if (req.body.git_repo !== undefined) {
      sets.push(`git_repo = $${i++}`);
      params.push(req.body.git_repo || null);
    }
    if (req.body.git_base_url !== undefined) {
      sets.push(`git_base_url = $${i++}`);
      params.push(req.body.git_base_url || null);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    params.push(req.params.id);
    await pool.query(
      `UPDATE organizations SET ${sets.join(", ")} WHERE id = $${i}`,
      params
    );
    await logAudit(req.user!.orgId, req.user!.id, "settings.update", "settings", "org", {});
    res.json({ updated: true });
  } catch (err) {
    console.error("PATCH /orgs/:id/settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
